import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

const ALERTS_LOG = join('xdr', 'alerts.log');
const PATTERN_NAMES = [
  '요청 인자 안의 SQL 구문',
  '요청 인자 안의 스크립트 태그',
  '반복 경로 거슬러 올라가기(../)',
  'MITRE T1190 외부 공개 앱 악용 검토',
];
const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function validIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function safeReason(value) {
  const name = PATTERN_NAMES.find((patternName) => typeof value === 'string'
    && value.startsWith(`${patternName}:`));
  return name ? `${name}: web-injection signal reviewed` : 'web-injection signal reviewed';
}

function isBlockCandidate(alert, decision) {
  const level = alert?.rule?.level;
  const count = Number(alert?.data?.count);
  const alertId = alert?.id;
  return decision?.action === 'block'
    && Number.isFinite(decision.confidence)
    && decision.confidence >= 0.85 && decision.confidence <= 1
    && Number.isFinite(level) && level >= 10
    && Number.isFinite(count) && count >= 8
    && validIpv4(alert?.data?.srcip)
    && typeof alertId === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(alertId)
    && PATTERN_NAMES.some((name) => typeof decision.reason === 'string' && decision.reason.startsWith(`${name}:`));
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
    const alertId = alert.id;
    return [{
      id: `xdr-web-injection-${alertId}`,
      action: 'deny',
      sourceAddress: alert.data.srcip,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      evidenceAlertId: alertId,
      confidence: decision.confidence,
      reason: `${safeReason(decision.reason).split(':', 1)[0]}: repeated high-confidence web injection`,
    }];
  });
}

export async function writeResponseArtifacts({ root, alerts, decisions, now = new Date() }) {
  const rules = createDenyRules({ alerts, decisions, now });
  const generatedAt = parseDate(now).toISOString();
  const outDir = join(root, 'xdr', 'web-injection');
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
      if (typeof item.moduleKey === 'string' && typeof item.alertId === 'string'
          && ['block', 'alert'].includes(item.action)) {
        known.add(`${item.moduleKey}:${item.alertId}:${item.action}`);
      }
    } catch {
      // Preserve existing lines without echoing or interpreting malformed content.
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
    const key = `web-injection:${alertId}:${decision.action}`;
    if (known.has(key)) continue;
    const timestamp = typeof alert.timestamp === 'string' && Number.isFinite(Date.parse(alert.timestamp))
      ? new Date(alert.timestamp).toISOString()
      : '';
    additions.push(JSON.stringify({
      schema: 'aleph.xdr.alert.v1',
      moduleKey: 'web-injection',
      timestamp,
      alertId,
      action: decision.action,
      confidence: decision.confidence,
      reason: safeReason(decision.reason),
    }));
    known.add(key);
  }

  const lines = [existing.trimEnd(), ...additions].filter(Boolean);
  await mkdir(join(root, 'xdr'), { recursive: true });
  await writeFile(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
