import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decide } from './decide.mjs';

const ALERTS_LOG = join('xdr', 'alerts.log');
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;
const PATTERN_NAMES = [
  '서명 없는 신규·미등록 서비스 지속성',
  '낯선 예약 작업 지속성',
  '시작 폴더·프로그램 지속성',
];

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function isBlockCandidate(alert, decision) {
  const level = alert?.rule?.level;
  const patternName = PATTERN_NAMES.find((name) => typeof decision?.reason === 'string'
    && decision.reason.startsWith(`${name}:`));
  const computed = decide(alert);
  return decision?.action === 'block'
    && Number.isFinite(decision.confidence)
    && decision.confidence >= 0.85 && decision.confidence <= 1
    && Number.isFinite(level) && level >= 10
    && validIpv4(alert?.data?.srcip)
    && typeof alert?.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(alert.id)
    && Boolean(patternName)
    && computed.action === 'block'
    && computed.confidence === decision.confidence
    && computed.reason === decision.reason;
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
    return [{
      id: `xdr-persistence-${alert.id}`,
      action: 'deny',
      sourceAddress: alert.data.srcip,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      evidenceAlertId: alert.id,
      confidence: decision.confidence,
      reason: `${decision.reason.split(':', 1)[0]}: temporary persistence response`,
    }];
  });
}

export async function writeResponseArtifacts({ root, alerts, decisions, now = new Date() }) {
  const rules = createDenyRules({ alerts, decisions, now });
  const generatedAt = parseDate(now).toISOString();
  const outDir = join(root, 'xdr', 'persistence');
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'deny-rules.json'), `${JSON.stringify({
    schema: 'aleph.xdr.deny-rules.v1',
    generatedAt,
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
      if (item.moduleKey === 'persistence' && typeof item.alertId === 'string'
          && ['block', 'alert'].includes(item.action)) {
        known.add(`${item.alertId}:${item.action}`);
      }
    } catch {
      // Preserve malformed prior lines without echoing or interpreting them.
    }
  }

  const additions = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    const decision = decisions[index];
    const alertId = typeof alert?.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(alert.id)
      ? alert.id
      : '';
    if (!alertId || !['block', 'alert'].includes(decision?.action)) continue;
    const key = `${alertId}:${decision.action}`;
    if (known.has(key)) continue;
    const timestamp = typeof alert.timestamp === 'string' && Number.isFinite(Date.parse(alert.timestamp))
      ? new Date(alert.timestamp).toISOString()
      : '';
    additions.push(JSON.stringify({
      schema: 'aleph.xdr.alert.v1',
      moduleKey: 'persistence',
      timestamp,
      alertId,
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.action === 'block'
        ? 'high-confidence persistence signal; temporary response candidate'
        : 'persistence signal requires review',
    }));
    known.add(key);
  }

  const lines = [existing.trimEnd(), ...additions].filter(Boolean);
  await mkdir(join(root, 'xdr'), { recursive: true });
  await writeFile(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
