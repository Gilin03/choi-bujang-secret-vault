const FIXTURE_SCHEMA = 'aleph.xdr.fixture.v1';

const REDACTIONS = [
  [/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----[\s\S]*?-----END (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/giu, '[REDACTED_PRIVATE_KEY]'],
  [/\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED_TOKEN]'],
  [/\bsb_(?:secret|service_role)_[A-Za-z0-9_-]{12,}\b/giu, '[REDACTED_KEY]'],
  [/\b(password|passwd|pwd|token|secret|api[_-]?key|authorization)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu, '$1$2[REDACTED]'],
  [/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/giu, '[REDACTED_EMAIL]'],
];

function redact(value) {
  if (typeof value !== 'string') return '';
  return REDACTIONS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);
}

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

export function readAlert(alert) {
  const source = objectOrEmpty(alert);
  const rule = objectOrEmpty(source.rule);
  const data = objectOrEmpty(source.data);

  return {
    timestamp: redact(source.timestamp),
    sourceAddress: redact(data.srcip),
    account: redact(data.srcuser),
    ruleLevel: Number.isFinite(rule.level) ? rule.level : null,
    description: redact(rule.description),
  };
}

export function readAlerts(fixture) {
  if (fixture?.schema !== FIXTURE_SCHEMA
      || fixture.moduleKey !== 'brute-force'
      || !Array.isArray(fixture.alerts)) {
    throw new Error('invalid_xdr_fixture');
  }

  return fixture.alerts.map(readAlert);
}
