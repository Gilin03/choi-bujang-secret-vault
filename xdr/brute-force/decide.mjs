import { readFileSync } from 'node:fs';
import { readAlert } from './read-alerts.mjs';

const PATTERNS = JSON.parse(readFileSync(new URL('./patterns.json', import.meta.url), 'utf8')).patterns;
const PATTERN_BY_ID = new Map(PATTERNS.map((pattern) => [pattern.id, pattern]));
const JEV_TIMEOUT_MS = 1000;

function objectOrEmpty(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
}

function hasT1110(alert) {
  const mitre = objectOrEmpty(alert?.rule).mitre;
  return Array.isArray(mitre) && mitre.includes('T1110');
}

function isFailure(summary) {
  return /fail|failure|failed|실패/iu.test(summary.description);
}

function isPasswordSpraying(alert, summary) {
  if (!/(?:same password|password spray|같은 비밀번호|공통 비밀번호)/iu.test(summary.description)) {
    return false;
  }

  const accounts = objectOrEmpty(alert?.data).accounts;
  const accountCount = Array.isArray(accounts)
    ? accounts.length
    : typeof accounts === 'string'
      ? accounts.split(/[,;\s]+/u).filter(Boolean).length
      : 0;
  const explicitSeveralAccounts = /(?:여러|복수|\b\d+\s+accounts?\b|\baccounts?\s+\d+\b|계정\s*\d+\s*개|\b\d+\s*개\s*계정)/iu.test(summary.description);
  return accountCount >= 2 || explicitSeveralAccounts;
}

function hasClearRepeatedFailures(alert, summary) {
  if (!hasT1110(alert) || summary.ruleLevel < 10) return false;
  if (isPasswordSpraying(alert, summary)) return true;
  if (!isFailure(summary)) return false;

  const count = Number(objectOrEmpty(alert?.data).count);
  return Number.isFinite(count) && count >= 15;
}

function patternFor(alert, summary) {
  return isPasswordSpraying(alert, summary)
    ? PATTERN_BY_ID.get('password_spraying')
    : PATTERN_BY_ID.get('rapid_same_source_failures');
}

async function askJev(summary) {
  const jev = globalThis.Jev;
  if (typeof jev !== 'function') return null;

  let timeout;
  try {
    const response = await Promise.race([
      Promise.resolve().then(() => jev(summary)),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve(null), JEV_TIMEOUT_MS);
      }),
    ]);
    const confidence = response?.confidence;
    return typeof confidence === 'number' && Number.isFinite(confidence) && confidence >= 0 && confidence <= 1
      ? confidence
      : null;
  } catch {
    return null;
  } finally {
    clearTimeout(timeout);
  }
}

function actionFor(confidence) {
  if (confidence >= 0.85) return 'block';
  if (confidence >= 0.5) return 'alert';
  return 'record';
}

function oneLine(value) {
  return value.replace(/[\r\n\t]+/gu, ' ').slice(0, 240);
}

export async function decide(alert) {
  const summary = readAlert(alert);
  const pattern = patternFor(alert, summary);
  const patternName = oneLine(pattern.name);

  if (hasClearRepeatedFailures(alert, summary)) {
    return {
      action: 'block',
      confidence: 0.95,
      reason: `${patternName}: 높은 수준의 T1110 반복 실패 신호`,
    };
  }

  if (hasT1110(alert) || (summary.ruleLevel >= 4 && isFailure(summary))) {
    const jevConfidence = await askJev(summary);
    if (jevConfidence === null) {
      return {
        action: 'alert',
        confidence: 0.5,
        reason: `${patternName}: Jev 미응답 또는 유효하지 않은 응답, alert fallback`,
      };
    }

    return {
      action: actionFor(jevConfidence),
      confidence: jevConfidence,
      reason: `${patternName}: Jev confidence ${jevConfidence.toFixed(2)}`,
    };
  }

  return {
    action: 'record',
    confidence: 0.1,
    reason: 'no_matching_bruteforce_pattern: 정상 이벤트 또는 무차별 대입 신호 없음',
  };
}
