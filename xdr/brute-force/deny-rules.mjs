import { isIP } from 'node:net';
import patterns from './patterns.json' with { type: 'json' };

const RULE_TTL_MS = 15 * 60 * 1000;
const patternNames = new Set(patterns.map((pattern) => pattern.name));

export function normalizeSourceAddress(value) {
  if (typeof value !== 'string') return null;
  const version = isIP(value);
  if (version === 4) return value;
  if (version !== 6) return null;
  try {
    return new URL(`http://[${value}]/`).hostname.slice(1, -1);
  } catch {
    return null;
  }
}

export function validateDenyRules(rules) {
  if (!Array.isArray(rules) || rules.some((rule) => !rule || typeof rule !== 'object'
    || normalizeSourceAddress(rule.sourceAddress) === null
    || typeof rule.expiresAt !== 'string' || !Number.isFinite(Date.parse(rule.expiresAt))
    || typeof rule.evidenceAlertId !== 'string' || !/^[a-zA-Z0-9_.:-]{1,120}$/u.test(rule.evidenceAlertId)
    || rule.id !== `xdr.brute-force:${rule.evidenceAlertId}`
    || !patternNames.has(rule.reasonPattern))) {
    throw new TypeError('invalid_xdr_deny_rules');
  }
}

export function createDenyRules(decisions, now = new Date()) {
  if (!Array.isArray(decisions)) throw new TypeError('invalid_xdr_decisions');
  const expiresAt = new Date(now.getTime() + RULE_TTL_MS).toISOString();
  const rulesBySource = new Map();
  const protectedSources = new Set(decisions.filter((item) => item?.eventType === 'normal')
    .map((item) => normalizeSourceAddress(item.sourceAddress)));

  for (const item of decisions) {
    const sourceAddress = normalizeSourceAddress(item?.sourceAddress);
    if (item?.action !== 'block' || sourceAddress === null || !item.alertId || protectedSources.has(sourceAddress)) continue;
    rulesBySource.set(sourceAddress, {
      id: `xdr.brute-force:${String(item.alertId)}`,
      sourceAddress,
      expiresAt,
      evidenceAlertId: String(item.alertId),
      reasonPattern: String(item.reason),
    });
  }
  return [...rulesBySource.values()];
}

export function isSourceDenied(sourceAddress, rules, now = new Date()) {
  if (normalizeSourceAddress(sourceAddress) === null) return false;
  return checkZtnaDenyRules(sourceAddress, rules, now).action === 'deny';
}

export function checkZtnaDenyRules(sourceAddress, rules, now = new Date()) {
  validateDenyRules(rules);
  const normalizedSource = normalizeSourceAddress(sourceAddress);
  const rule = normalizedSource === null ? undefined : rules.find((candidate) =>
    normalizeSourceAddress(candidate.sourceAddress) === normalizedSource
    && Date.parse(candidate.expiresAt) > now.getTime());

  return rule
    ? { action: 'deny', evidenceAlertId: rule.evidenceAlertId, expiresAt: rule.expiresAt }
    : { action: 'continue' };
}
