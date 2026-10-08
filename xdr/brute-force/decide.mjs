import { readFileSync } from 'node:fs';
import { normalizeSourceAddress } from './deny-rules.mjs';

const patterns = JSON.parse(readFileSync(new URL('./patterns.json', import.meta.url), 'utf8'));
const patternByName = new Map(patterns.map((pattern) => [pattern.name, pattern]));
const MAX_WINDOW_SECONDS = Math.max(...patterns.map((pattern) => pattern.windowSeconds));

function outcome(action, confidence, reason) {
  return { action, confidence, reason };
}

function actionFromConfidence(confidence) {
  if (confidence >= 0.85) return 'block';
  if (confidence >= 0.5) return 'alert';
  return 'record';
}

export function getEventType(alert) {
  const groups = Array.isArray(alert?.rule?.groups) ? alert.rule.groups : [];
  if (groups.includes('authentication_failed')) return 'login_failure';
  if (groups.includes('authentication_success')) return 'normal';
  const description = String(alert?.rule?.description ?? alert?.description ?? '');
  if (/\b(?:authentication|login|logon)\s*(?::\s*)?(?:failure|failed|invalid|denied)\b|\bfailed\s+(?:login|logon|password|authentication)\b|\bsshd:.*\binvalid user\b/iu.test(description)) return 'login_failure';
  if (/\b(?:authentication|login|logon)\s*(?::\s*)?(?:accepted|success(?:ful)?|succeeded)\b|\bsshd:.*\baccepted (?:password|publickey)\b/iu.test(description)) return 'normal';
  return 'other';
}

function eventDetails(alert) {
  const timestamp = alert?.timestamp ?? alert?.['@timestamp'];
  const sourceAddress = alert?.data?.srcip ?? alert?.sourceAddress;
  const account = alert?.data?.srcuser ?? alert?.account;
  const timestampMs = Date.parse(timestamp);
  return {
    timestampMs,
    sourceAddress: normalizeSourceAddress(sourceAddress),
    account: typeof account === 'string' ? account : '',
    fingerprint: typeof alert?.data?.credential_fingerprint === 'string'
      ? alert.data.credential_fingerprint.trim() : '',
    eventType: getEventType(alert),
  };
}

async function askJev(alert, patternName, signals) {
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
        ruleLevel: alert?.rule?.level ?? alert?.ruleLevel ?? null,
        signals: {
          sameSourceFailures: signals.sameSourceFailures,
          sameAccountFailures: signals.sameAccountFailures,
          sameCredentialAccountCount: signals.sameCredentialAccountCount,
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

async function decideWithSignals(alert, signals) {
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
    const confidence = await askJev(alert, matchedPattern.name, signals);
    if (confidence === null) return outcome('alert', 0.5, matchedPattern.name);
    if (confidence >= 0.85 && signals.sourceHasNormalLogin === true) {
      return outcome('alert', 0.72, matchedPattern.name);
    }
    return outcome(actionFromConfidence(confidence), confidence, matchedPattern.name);
  }
  return outcome('record', 0.1, 'no-brute-force-pattern');
}

// A decider instance represents one ordered alert stream. It accepts either raw
// Wazuh alerts or the five-field rows returned by readAlerts().
export function createDecider({ knownNormalSourceAddresses = [] } = {}) {
  const knownNormalSources = new Set(knownNormalSourceAddresses
    .map(normalizeSourceAddress).filter(Boolean));
  const history = [];

  return {
    async decide(alert) {
      const suppliedSignals = alert?.patternSignals;
      if (suppliedSignals && typeof suppliedSignals === 'object') {
        if (suppliedSignals.isLoginFailure !== true) {
          return outcome('record', 0.1, 'no-brute-force-pattern');
        }
        return decideWithSignals(alert, suppliedSignals);
      }

      const current = eventDetails(alert);
      if (current.eventType === 'normal' && current.sourceAddress) {
        knownNormalSources.add(current.sourceAddress);
        if (Number.isFinite(current.timestampMs)) history.push(current);
        return outcome('record', 0.1, 'no-brute-force-pattern');
      }
      if (current.eventType !== 'login_failure' || !current.sourceAddress
        || !Number.isFinite(current.timestampMs)) {
        return outcome('record', 0.1, 'no-brute-force-pattern');
      }

      history.push(current);
      const oldest = current.timestampMs - MAX_WINDOW_SECONDS * 1000;
      for (let index = history.length - 1; index >= 0; index -= 1) {
        if (history[index].timestampMs < oldest) history.splice(index, 1);
      }
      const inWindow = (seconds) => history.filter((event) => event.sourceAddress === current.sourceAddress
        && event.timestampMs >= current.timestampMs - seconds * 1000
        && event.timestampMs <= current.timestampMs);
      const sourceFailures = inWindow(patternByName.get('same-source-failure-burst').windowSeconds)
        .filter((event) => event.eventType === 'login_failure');
      const accountFailures = inWindow(patternByName.get('same-account-failure-burst').windowSeconds)
        .filter((event) => event.eventType === 'login_failure' && current.account
          && event.account === current.account);
      const fingerprintFailures = inWindow(patternByName.get('credential-spray').windowSeconds)
        .filter((event) => event.eventType === 'login_failure' && current.fingerprint
          && event.fingerprint === current.fingerprint && event.account);
      const signals = {
        isLoginFailure: true,
        sourceHasNormalLogin: knownNormalSources.has(current.sourceAddress)
          || history.some((event) => event.sourceAddress === current.sourceAddress && event.eventType === 'normal'),
        sameSourceFailures: sourceFailures.length,
        sameAccountFailures: accountFailures.length,
        sameCredentialAccountCount: new Set(fingerprintFailures.map((event) => event.account)).size,
      };
      return decideWithSignals(alert, signals);
    },
  };
}

const defaultDecider = createDecider();

export async function decide(alert) {
  return defaultDecider.decide(alert);
}
