import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALERTS_LOG = join('xdr', 'alerts.log');
const MODULE_KEY = 'privilege';
const PATTERN_NAMES = [
  '관리자 그룹 추가',
  '처음 보는 관리자 명령',
  '업무 시간 밖 권한 사용',
];
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every(part => Number(part) >= 0 && Number(part) <= 255);
}

function patternFor(reason) {
  return PATTERN_NAMES.find(name => typeof reason === 'string' && reason.startsWith(`${name}:`)) ?? null;
}

function isStrongSignal(alert, patternName) {
  const rule = alert?.rule;
  const data = alert?.data;
  if (!rule || !data || !Array.isArray(rule.mitre) || !Number.isFinite(rule.level) || rule.level < 10) return false;
  const description = typeof rule.description === 'string' ? rule.description : '';
  if (patternName === PATTERN_NAMES[0]) {
    return rule.mitre.includes('T1078')
      && (data.group === 'administrators' || /관리자\s*그룹/u.test(description))
      && /(?:관리자\s*그룹.{0,40}(?:추가|들어)|다시\s*관리자(?:로|\s*그룹).{0,20}(?:들어|추가|복귀))/u.test(description);
  }
  if (patternName === PATTERN_NAMES[1]) {
    const unfamiliar = /처음\s*(?:보|봅|본)|낯선|다른\s*계정의\s*권한|방금\s*관리자가\s*된/u.test(description);
    const adminUse = /(?:관리자|권한)\s*명령|권한\s*상승|관리자\s*권한.{0,12}(?:바뀌|변경|전환)|세션이\s*관리자\s*권한으로\s*바뀌/u.test(description);
    return rule.mitre.includes('T1068') && unfamiliar && adminUse;
  }
  if (patternName === PATTERN_NAMES[2]) {
    const outsideHours = /(?:수업|업무|근무)(?:\s*시간)?\s*밖|업무처럼\s*보이지\s*않는\s*시각/u.test(description);
    const adminUse = /관리자\s*그룹|(?:관리자|권한)\s*명령|권한\s*상승|관리자\s*권한/u.test(description);
    return (rule.mitre.includes('T1068') || rule.mitre.includes('T1078')) && outsideHours && adminUse;
  }
  return false;
}

function validAlertId(alert) {
  return typeof alert?.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(alert.id);
}

function isBlockCandidate(alert, decision) {
  const name = patternFor(decision?.reason);
  return decision?.action === 'block'
    && Number.isFinite(decision.confidence)
    && decision.confidence >= 0.85 && decision.confidence <= 1
    && validAlertId(alert)
    && validIpv4(alert?.data?.srcip)
    && name !== null
    && isStrongSignal(alert, name);
}

export function createDenyRules({ alerts, decisions, now = new Date(), ttlMs = 15 * 60 * 1000 }) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions) || alerts.length !== decisions.length) {
    throw new Error('invalid_decision_alignment');
  }
  const createdAt = parseDate(now);
  if (!createdAt || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid_deny_rule_lifetime');

  return alerts.flatMap((alert, index) => {
    const decision = decisions[index];
    if (!isBlockCandidate(alert, decision)) return [];
    const pattern = patternFor(decision.reason);
    return [{
      id: `xdr-privilege-${alert.id}`,
      action: 'deny',
      sourceAddress: alert.data.srcip,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      evidenceAlertId: alert.id,
      confidence: decision.confidence,
      reason: `${pattern}: privilege-escalation signal`,
    }];
  });
}

export async function writeResponseArtifacts({ root, alerts, decisions, now = new Date() }) {
  const generatedAt = parseDate(now);
  if (!generatedAt) throw new Error('invalid_deny_rule_lifetime');
  const rules = createDenyRules({ alerts, decisions, now: generatedAt });
  const outDir = join(root, 'xdr', MODULE_KEY);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'deny-rules.json'), `${JSON.stringify({
    schema: 'aleph.xdr.deny-rules.v1',
    generatedAt: generatedAt.toISOString(),
    rules,
  }, null, 2)}\n`, 'utf8');
  await appendAlertLog(root, alerts, decisions);
  return rules;
}

async function appendAlertLog(root, alerts, decisions) {
  const logPath = join(root, ALERTS_LOG);
  let existing = '';
  try {
    existing = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const known = new Set();
  for (const line of existing.split(/\r?\n/u)) {
    try {
      const item = JSON.parse(line);
      if (item.moduleKey === MODULE_KEY && typeof item.alertId === 'string'
          && ['block', 'alert'].includes(item.action)) {
        known.add(`${item.alertId}:${item.action}`);
      }
    } catch {
      // Keep existing lines without interpreting their contents.
    }
  }

  const additions = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    const decision = decisions[index];
    const name = patternFor(decision?.reason);
    if (!validAlertId(alert) || !name || !['block', 'alert'].includes(decision?.action)) continue;
    const key = `${alert.id}:${decision.action}`;
    if (known.has(key)) continue;
    const timestamp = typeof alert.timestamp === 'string' && Number.isFinite(Date.parse(alert.timestamp))
      ? new Date(alert.timestamp).toISOString()
      : '';
    additions.push(JSON.stringify({
      schema: 'aleph.xdr.alert.v1',
      moduleKey: MODULE_KEY,
      timestamp,
      alertId: alert.id,
      action: decision.action,
      confidence: decision.confidence,
      reason: `${name}: privilege signal reviewed`,
    }));
    known.add(key);
  }

  const lines = [existing.trimEnd(), ...additions].filter(Boolean);
  await mkdir(join(root, 'xdr'), { recursive: true });
  await writeFile(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
