const IPV4 = /^(?:\d{1,3}\.){3}\d{1,3}$/u;

function isIpv4(value) {
  return typeof value === 'string'
    && IPV4.test(value)
    && value.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255);
}

function parseDate(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

export function createDenyRules({ alerts, decisions, now = new Date(), ttlMs = 15 * 60 * 1000 }) {
  if (!Array.isArray(alerts) || !Array.isArray(decisions) || alerts.length !== decisions.length) {
    throw new Error('invalid_decision_alignment');
  }
  const createdAt = parseDate(now);
  if (!createdAt || !Number.isFinite(ttlMs) || ttlMs <= 0) throw new Error('invalid_deny_rule_lifetime');

  return alerts.flatMap((alert, index) => {
    const decision = decisions[index];
    const alertId = typeof alert?.id === 'string' ? alert.id : '';
    const sourceAddress = alert?.data?.srcip;
    const hasBruteForceEvidence = Array.isArray(alert?.rule?.mitre) && alert.rule.mitre.includes('T1110');
    if (decision?.action !== 'block' || !Number.isFinite(decision.confidence)
        || decision.confidence < 0.85 || decision.confidence > 1
        || !hasBruteForceEvidence || !isIpv4(sourceAddress)
        || !/^[A-Za-z0-9._-]{1,80}$/u.test(alertId)) return [];

    return [{
      id: `xdr-bruteforce-${alertId}`,
      action: 'deny',
      sourceAddress,
      createdAt: createdAt.toISOString(),
      expiresAt: new Date(createdAt.getTime() + ttlMs).toISOString(),
      evidenceAlertId: alertId,
      confidence: decision.confidence,
      reason: 'T1110 clear repeated-login-failure signal',
    }];
  });
}

export function matchActiveDenyRule(sourceAddress, rules, now = new Date()) {
  const current = parseDate(now);
  if (!current || !isIpv4(sourceAddress) || !Array.isArray(rules)) return null;
  return rules.find((rule) => rule?.action === 'deny'
    && rule.sourceAddress === sourceAddress
    && isIpv4(rule.sourceAddress)
    && /^[A-Za-z0-9._-]{1,80}$/u.test(rule.evidenceAlertId ?? '')
    && Number.isFinite(rule.confidence)
    && rule.confidence >= 0.85 && rule.confidence <= 1
    && (parseDate(rule.expiresAt)?.getTime() ?? 0) > current.getTime()) ?? null;
}
