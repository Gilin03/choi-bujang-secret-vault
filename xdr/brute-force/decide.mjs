import { readFileSync } from 'node:fs';

const patterns = JSON.parse(readFileSync(new URL('./patterns.json', import.meta.url), 'utf8'));
const patternByName = new Map(patterns.map((pattern) => [pattern.name, pattern]));

function outcome(action, confidence, reason) {
  return { action, confidence, reason };
}

function actionFromConfidence(confidence) {
  if (confidence >= 0.85) return 'block';
  if (confidence >= 0.5) return 'alert';
  return 'record';
}

async function askJev(alert, patternName) {
  const endpoint = process.env.JEV_REVIEW_URL;
  if (!endpoint) return null;

  let url;
  try {
    url = new URL(endpoint);
    if (url.protocol !== 'https:' && url.hostname !== 'localhost' && url.hostname !== '127.0.0.1') return null;
  } catch {
    return null;
  }

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        pattern: patternName,
        ruleLevel: alert.ruleLevel,
        signals: {
          sameSourceFailures: alert.patternSignals.sameSourceFailures,
          sameAccountFailures: alert.patternSignals.sameAccountFailures,
          sameCredentialAccountCount: alert.patternSignals.sameCredentialAccountCount,
        },
      }),
      signal: AbortSignal.timeout(2500),
    });
    if (!response.ok) return null;
    const body = await response.json();
    const confidence = body?.confidence;
    return typeof confidence === 'number' && Number.isFinite(confidence)
      && confidence >= 0 && confidence <= 1 ? confidence : null;
  } catch {
    return null;
  }
}

export async function decide(alert) {
  const signals = alert?.patternSignals;
  if (!signals || typeof signals !== 'object') {
    return outcome('record', 0.1, 'no-brute-force-pattern');
  }
  if (signals.isLoginFailure !== true) {
    return outcome('record', 0.1, 'no-brute-force-pattern');
  }

  const sameSourceFailures = Number(signals.sameSourceFailures) || 0;
  const sameAccountFailures = Number(signals.sameAccountFailures) || 0;
  const sameCredentialAccountCount = Number(signals.sameCredentialAccountCount) || 0;
  const spray = patternByName.get('credential-spray');
  const sameAccount = patternByName.get('same-account-failure-burst');
  const sameSource = patternByName.get('same-source-failure-burst');

  if (sameCredentialAccountCount >= spray.minimumCount) {
    if (signals.sourceHasNormalLogin === true) return outcome('alert', 0.72, spray.name);
    return outcome('block', 0.98, spray.name);
  }
  if (sameAccountFailures >= sameAccount.minimumCount && signals.sourceHasNormalLogin === false) {
    return outcome('block', 0.95, sameAccount.name);
  }
  const matchedPattern = sameAccountFailures >= sameAccount.minimumCount ? sameAccount
    : sameSourceFailures >= sameSource.minimumCount ? sameSource : null;
  if (matchedPattern) {
    const confidence = await askJev({
      ...alert,
      patternSignals: { sameSourceFailures, sameAccountFailures, sameCredentialAccountCount },
    }, matchedPattern.name);
    if (confidence === null) return outcome('alert', 0.5, matchedPattern.name);
    if (confidence >= 0.85 && signals.sourceHasNormalLogin === true) {
      return outcome('alert', 0.72, matchedPattern.name);
    }
    return outcome(actionFromConfidence(confidence), confidence, matchedPattern.name);
  }
  return outcome('record', 0.1, 'no-brute-force-pattern');
}
