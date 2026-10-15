import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { decide } from './decide.mjs';

const ALERTS_LOG = join('xdr', 'alerts.log');
const MODULE_KEY = 'exfiltration';
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

function validAlertId(value) {
  return typeof value === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(value);
}

function isCurrentDecision(alert, decision) {
  const computed = decide(alert);
  return computed.action === decision?.action
    && computed.confidence === decision.confidence
    && computed.reason === decision.reason;
}

function isBlockCandidate(alert, decision) {
  return decision?.action === 'block'
    && Number.isFinite(decision.confidence)
    && decision.confidence >= 0.85 && decision.confidence <= 1
    && Number.isFinite(alert?.rule?.level) && alert.rule.level >= 10
    && Array.isArray(alert?.rule?.mitre)
    && alert.rule.mitre.some(id => id === 'T1041' || id === 'T1048')
    && validAlertId(alert?.id)
    && validIpv4(alert?.data?.srcip)
    && validIpv4(alert?.data?.dstip)
    && isCurrentDecision(alert, decision);
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
      id: `xdr-exfiltration-${alert.id}`,
      action: 'deny',
      destinationAddress: alert.data.dstip,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      evidenceAlertId: alert.id,
      confidence: decision.confidence,
      reason: 'validated high-confidence exfiltration signal',
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
  const currentActions = new Map();
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    const decision = decisions[index];
    if (validAlertId(alert?.id) && ['block', 'alert'].includes(decision?.action)
        && isCurrentDecision(alert, decision)) {
      currentActions.set(alert.id, decision.action);
    }
  }

  let existing = '';
  try {
    existing = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const preserved = [];
  for (const line of existing.split(/\r?\n/u)) {
    try {
      const item = JSON.parse(line);
      if (item.moduleKey === MODULE_KEY && currentActions.has(item.alertId)) continue;
      preserved.push(line);
    } catch {
      preserved.push(line);
    }
  }

  const additions = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    const decision = decisions[index];
    if (!validAlertId(alert?.id) || !['block', 'alert'].includes(decision?.action)
        || !isCurrentDecision(alert, decision)) continue;
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
      reason: decision.action === 'block'
        ? 'high-confidence external transfer signal'
        : 'external transfer signal requires review',
    }));
  }

  const lines = [preserved.join('\n').trimEnd(), ...additions].filter(Boolean);
  await mkdir(join(root, 'xdr'), { recursive: true });
  await writeFile(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}
