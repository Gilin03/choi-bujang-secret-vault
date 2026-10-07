import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { readAlerts, redactText } from '../xdr/brute-force/read-alerts.mjs';
import { decide } from '../xdr/brute-force/decide.mjs';
import { checkZtnaDenyRules, createDenyRules, normalizeSourceAddress } from '../xdr/brute-force/deny-rules.mjs';
import { decideWithXdr } from '../src/decider-xdr.mjs';
import { fixtureRequests } from './fixture-7.mjs';
import patterns from '../xdr/brute-force/patterns.json' with { type: 'json' };

const root = resolve(import.meta.dirname, '..');
const fixturePath = resolve(root, 'xdr', 'fixtures', 'brute-force.json');
const outputPath = resolve(root, 'xdr', 'brute-force', 'result.json');
const rulesPath = resolve(root, 'xdr', 'brute-force', 'deny-rules.json');
const logPath = resolve(root, 'xdr', 'alerts.log');
const patternByName = new Map(patterns.map((pattern) => [pattern.name, pattern]));

function eventType(alert) {
  const groups = Array.isArray(alert?.rule?.groups) ? alert.rule.groups : [];
  if (groups.includes('authentication_failed')) return 'login_failure';
  if (groups.includes('authentication_success')) return 'normal';
  const description = String(alert?.rule?.description ?? '');
  if (/\b(?:authentication|login|logon)\s*(?::\s*)?(?:failure|failed|invalid|denied)\b|\bfailed\s+(?:login|logon|password|authentication)\b|\bsshd:.*\binvalid user\b/iu.test(description)) return 'login_failure';
  if (/\b(?:authentication|login|logon)\s*(?::\s*)?(?:accepted|success(?:ful)?|succeeded)\b|\bsshd:.*\baccepted (?:password|publickey)\b/iu.test(description)) return 'normal';
  return 'other';
}

function inWindow(events, current, seconds, match) {
  const currentTime = Date.parse(current.timestamp ?? current['@timestamp']);
  if (!Number.isFinite(currentTime)) return [];
  const start = currentTime - seconds * 1000;
  return events.filter((event) => {
    const eventTime = Date.parse(event.timestamp ?? event['@timestamp']);
    return eventTime >= start && eventTime <= currentTime && match(event);
  });
}

function deriveSignals(rawAlerts, index, normalized) {
  const current = rawAlerts[index];
  const currentTime = Date.parse(normalized.timestamp);
  const sourceAddress = normalizeSourceAddress(normalized.sourceAddress);
  const validSource = sourceAddress !== null;
  const sourceMatches = inWindow(rawAlerts, current, patternByName.get('same-source-failure-burst').windowSeconds,
    (event) => validSource && normalizeSourceAddress(event.data?.srcip) === sourceAddress && eventType(event) === 'login_failure');
  const accountMatches = inWindow(rawAlerts, current, patternByName.get('same-account-failure-burst').windowSeconds,
    (event) => validSource && Boolean(current.data?.srcuser) && normalizeSourceAddress(event.data?.srcip) === sourceAddress
      && event.data?.srcuser === current.data?.srcuser && eventType(event) === 'login_failure');
  const fingerprint = current.data?.credential_fingerprint;
  const credentialMatches = inWindow(rawAlerts, current, patternByName.get('credential-spray').windowSeconds,
    (event) => validSource && typeof fingerprint === 'string' && Boolean(fingerprint.trim())
      && normalizeSourceAddress(event.data?.srcip) === sourceAddress
      && event.data?.credential_fingerprint === fingerprint
      && eventType(event) === 'login_failure');

  return {
    isLoginFailure: eventType(current) === 'login_failure',
    sourceHasNormalLogin: rawAlerts.some((event) => validSource
      && normalizeSourceAddress(event.data?.srcip) === sourceAddress && eventType(event) === 'normal'
      && Number.isFinite(Date.parse(event.timestamp ?? event['@timestamp']))),
    sameSourceFailures: sourceMatches.length,
    sameAccountFailures: accountMatches.length,
    sameCredentialAccountCount: new Set(credentialMatches.map((event) => event.data?.srcuser).filter(Boolean)).size,
    timestampMs: currentTime,
  };
}

async function readJson(path, fallback) {
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    if (error.code === 'ENOENT') return fallback;
    if (error instanceof SyntaxError) throw new Error('invalid_xdr_json');
    throw error;
  }
}

async function appendUniqueLogLines(entries) {
  let existing = '';
  try {
    existing = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  const entryKey = (entry) => JSON.stringify([entry.alertId, entry.timestamp, entry.sourceAddress,
    entry.action, entry.confidence, entry.reason]);
  const existingKeys = new Set(existing.split(/\r?\n/u).filter(Boolean).flatMap((line) => {
    try { return [entryKey(JSON.parse(line))]; } catch { return []; }
  }));
  const newLines = entries.filter((entry) => {
    if (entry.action !== 'alert' && entry.action !== 'block') return false;
    const key = entryKey(entry);
    if (existingKeys.has(key)) return false;
    existingKeys.add(key);
    return true;
  });
  if (newLines.length) await appendFile(logPath, `${newLines.map((entry) => JSON.stringify(entry)).join('\n')}\n`, 'utf8');
}

export async function runBruteForce() {
  const rawAlerts = await readJson(fixturePath, null);
  if (!Array.isArray(rawAlerts)) throw new TypeError('invalid_brute_force_fixture');
  const normalizedAlerts = readAlerts(rawAlerts);
  if (normalizedAlerts.length !== rawAlerts.length) throw new Error('alert_count_mismatch');

  const records = [];
  for (let index = 0; index < rawAlerts.length; index += 1) {
    const alert = normalizedAlerts[index];
    const signals = deriveSignals(rawAlerts, index, alert);
    const decision = await decide({ ...alert, patternSignals: signals });
    const rawId = String(rawAlerts[index].id ?? `alert-${index + 1}`);
    const alertId = redactText(rawId) === rawId ? rawId : `alert-${index + 1}`;
    records.push({
      alertId,
      timestamp: alert.timestamp,
      sourceAddress: normalizeSourceAddress(alert.sourceAddress) ?? alert.sourceAddress,
      account: alert.account,
      ruleLevel: alert.ruleLevel,
      description: alert.description,
      eventType: eventType(rawAlerts[index]),
      action: decision.action,
      confidence: decision.confidence,
      reason: decision.reason,
    });
  }

  const runStartedAt = new Date();
  const denyRules = createDenyRules(records, runStartedAt);
  await mkdir(resolve(root, 'xdr', 'brute-force'), { recursive: true });
  await writeFile(rulesPath, `${JSON.stringify(denyRules, null, 2)}\n`, 'utf8');

  const counts = { block: 0, alert: 0, record: 0 };
  for (const item of records) counts[item.action] += 1;
  const request = fixtureRequests().normal;
  const gateResults = await Promise.all(records.map((item) =>
    decideWithXdr(request, item.sourceAddress, { rules: denyRules, now: runStartedAt })));
  const normalEvents = records.filter((item) => item.eventType === 'normal');
  const normalBlockedEvents = normalEvents.filter((item) =>
    checkZtnaDenyRules(item.sourceAddress, denyRules, runStartedAt).action === 'deny');
  const normalEventIndex = records.findIndex((item) => item.eventType === 'normal');
  const normalGateResult = normalEventIndex === -1 ? null : gateResults[normalEventIndex];
  const blockedGateCount = gateResults.filter((item) => item.xdr.action === 'deny').length;
  const result = {
    source: 'virtual Wazuh fixture; local practice only',
    alertCount: rawAlerts.length,
    extractedLineCount: normalizedAlerts.length,
    counts,
    normalEventCount: normalEvents.length,
    normalBlockedCount: normalBlockedEvents.length,
    denyRuleCount: denyRules.length,
    ztnaPrecheck: {
      deniedEventCount: blockedGateCount,
      normalEventAction: normalGateResult?.xdr.action ?? 'not_present',
      normalPolicyDecision: normalGateResult?.decision?.decision ?? null,
      normalRequestAllowed: normalEvents.length > 0 && gateResults.every((gate, index) =>
        records[index].eventType !== 'normal' || (gate.xdr.action === 'continue' && gate.decision?.decision === 'allow')),
      engineConnection: 'not_connected_in_this_repository',
    },
    decisions: records,
  };
  await writeFile(outputPath, `${JSON.stringify(result, null, 2)}\n`, 'utf8');
  await appendUniqueLogLines(records);

  process.stdout.write(`경보 ${result.alertCount}건 / 추출 ${result.extractedLineCount}줄\n`);
  process.stdout.write(`block ${counts.block} · alert ${counts.alert} · record ${counts.record}\n`);
  process.stdout.write(`정상 이벤트 차단 ${result.normalBlockedCount}건 · 차단 규칙 ${denyRules.length}개\n`);
  process.stdout.write(`ZTNA 사전 검사: 공격 주소 ${blockedGateCount}건 거부 · 정상 이벤트 ${result.ztnaPrecheck.normalEventAction}\n`);
  process.stdout.write(`기존 판정기: 정상 요청 ${result.ztnaPrecheck.normalPolicyDecision ?? '시험 대상 없음'}\n`);
  process.stdout.write('가상 경보 연습 결과이며 운영 Wazuh 연결이나 심판 판정이 아닙니다.\n');
  return result;
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== 'brute-force') {
    process.stderr.write('사용법: npm run xdr:run -- brute-force\n');
    process.exitCode = 2;
  } else {
    runBruteForce().catch((error) => {
      const safeCodes = new Set(['invalid_brute_force_fixture', 'invalid_xdr_json',
        'invalid_xdr_deny_rules', 'invalid_verified_source_address', 'alert_count_mismatch']);
      const code = safeCodes.has(error.message) ? error.message : 'xdr_run_failed';
      process.stderr.write(`XDR 연습 첫 오류: ${code}\n`);
      process.exitCode = 1;
    });
  }
}
