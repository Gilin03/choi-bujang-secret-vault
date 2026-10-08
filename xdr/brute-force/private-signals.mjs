import { createHash } from 'node:crypto';

const fingerprintsByAlert = new WeakMap();

function digestFingerprint(value) {
  if (typeof value !== 'string' || !value.trim()) return '';
  return createHash('sha256').update(value.trim(), 'utf8').digest('hex');
}

export function retainCredentialFingerprint(alert, value) {
  if (!alert || typeof alert !== 'object') return;
  const digest = digestFingerprint(value);
  if (digest) fingerprintsByAlert.set(alert, digest);
}

export function getCredentialFingerprint(alert) {
  return fingerprintsByAlert.get(alert) || digestFingerprint(alert?.data?.credential_fingerprint);
}
