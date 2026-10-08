import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { readAlerts } from '../xdr/brute-force/read-alerts.mjs';
import { createDecider, decide } from '../xdr/brute-force/decide.mjs';
import { checkZtnaDenyRules, createDenyRules, isSourceDenied } from '../xdr/brute-force/deny-rules.mjs';
import { decideWithXdr } from '../src/decider-xdr.mjs';
import * as xdrAdapter from '../src/decider-xdr.mjs';

const stamp = '2026-10-07T00:00:00.000Z';

test('readAlerts returns one allow-listed row per Wazuh alert and redacts secret-shaped description text', () => {
  const rows = readAlerts([{
    timestamp: stamp,
    rule: { level: 5, description: 'login failed password=HIDDEN' },
    data: { srcip: '192.0.2.10', srcuser: 'alice_fixture', password: 'DO_NOT_COPY' },
    full_log: 'DO_NOT_COPY',
  }]);

  assert.equal(rows.length, 1);
  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.equal(rows[0].description, 'login failed password=[REDACTED]');
  assert.doesNotMatch(JSON.stringify(rows), /DO_NOT_COPY|HIDDEN/u);
});

test('decide blocks a repeated credential fingerprint across accounts', async () => {
  const result = await createDecider().decide({
    timestamp: stamp,
    ruleLevel: 5,
    patternSignals: {
      isLoginFailure: true,
      sameSourceFailures: 3,
      sameAccountFailures: 1,
      sameCredentialAccountCount: 3,
    },
  });

  assert.deepEqual(result, {
    action: 'block',
    confidence: 0.98,
    reason: 'credential-spray',
  });
});

test('decide blocks a five-failure same-account burst when no normal login shares the source', async () => {
  const result = await createDecider().decide({
    timestamp: stamp,
    ruleLevel: 5,
    patternSignals: {
      isLoginFailure: true,
      sameSourceFailures: 5,
      sameAccountFailures: 5,
      sameCredentialAccountCount: 0,
      sourceHasNormalLogin: false,
    },
  });

  assert.deepEqual(result, {
    action: 'block',
    confidence: 0.95,
    reason: 'same-account-failure-burst',
  });
});

test('decide alerts on an ambiguous source burst when Jev is unavailable', async () => {
  const oldReviewUrl = process.env.JEV_REVIEW_URL;
  delete process.env.JEV_REVIEW_URL;
  try {
    const result = await createDecider().decide({
      timestamp: stamp,
      ruleLevel: 5,
      patternSignals: {
        isLoginFailure: true,
        sameSourceFailures: 8,
        sameAccountFailures: 1,
        sameCredentialAccountCount: 1,
        sourceHasNormalLogin: true,
      },
    });

    assert.deepEqual(result, {
      action: 'alert',
      confidence: 0.5,
      reason: 'same-source-failure-burst',
    });
  } finally {
    if (oldReviewUrl === undefined) delete process.env.JEV_REVIEW_URL;
    else process.env.JEV_REVIEW_URL = oldReviewUrl;
  }
});

test('decide asks Jev only for ambiguous signals and applies the confidence thresholds', async () => {
  const oldReviewUrl = process.env.JEV_REVIEW_URL;
  const oldFetch = globalThis.fetch;
  const confidences = [0.85, 0.5, 0.49];
  const sentBodies = [];
  process.env.JEV_REVIEW_URL = 'https://jev-fixture.invalid/review';
  globalThis.fetch = async (_url, options) => {
    sentBodies.push(JSON.parse(options.body));
    return { ok: true, json: async () => ({ confidence: confidences[sentBodies.length - 1] }) };
  };

  try {
    const ambiguous = {
      timestamp: stamp,
      sourceAddress: '198.51.100.35',
      account: 'user_fixture',
      ruleLevel: 5,
      patternSignals: {
        isLoginFailure: true,
        sameSourceFailures: 8,
        sameAccountFailures: 1,
        sameCredentialAccountCount: 1,
      },
    };
    const decider = createDecider();
    assert.equal((await decider.decide(ambiguous)).action, 'block');
    assert.equal((await decider.decide(ambiguous)).action, 'alert');
    assert.equal((await decider.decide(ambiguous)).action, 'record');
    assert.equal((await decider.decide({ ...ambiguous, patternSignals: { ...ambiguous.patternSignals, isLoginFailure: false } })).action, 'record');
    assert.equal(sentBodies.length, 3);
    assert.doesNotMatch(JSON.stringify(sentBodies), /198\.51\.100\.35|user_fixture/u);
  } finally {
    globalThis.fetch = oldFetch;
    if (oldReviewUrl === undefined) delete process.env.JEV_REVIEW_URL;
    else process.env.JEV_REVIEW_URL = oldReviewUrl;
  }
});

test('decide records a normal event', async () => {
  assert.deepEqual(await createDecider().decide({
    timestamp: stamp,
    ruleLevel: 3,
    patternSignals: {
      isLoginFailure: false,
      sameSourceFailures: 0,
      sameAccountFailures: 0,
      sameCredentialAccountCount: 0,
    },
  }), {
    action: 'record',
    confidence: 0.1,
    reason: 'no-brute-force-pattern',
  });
});

test('createDenyRules keeps only block decisions and gives each rule expiry and evidence', () => {
  const now = new Date(stamp);
  const rules = createDenyRules([
    { alertId: 'wazuh-1', sourceAddress: '203.0.113.7', action: 'block', reason: 'credential-spray' },
    { alertId: 'wazuh-2', sourceAddress: '198.51.100.8', action: 'alert', reason: 'same-source-failure-burst' },
    { alertId: 'wazuh-3', sourceAddress: '192.0.2.3', action: 'record', reason: 'no-brute-force-pattern' },
  ], now);

  assert.equal(rules.length, 1);
  assert.equal(rules[0].sourceAddress, '203.0.113.7');
  assert.equal(rules[0].evidenceAlertId, 'wazuh-1');
  assert.equal(rules[0].expiresAt, '2026-10-07T00:15:00.000Z');
  assert.equal(isSourceDenied('203.0.113.7', rules, now), true);
  assert.equal(isSourceDenied('198.51.100.8', rules, now), false);
  assert.equal(isSourceDenied('203.0.113.7', rules, new Date('2026-10-07T00:16:00.000Z')), false);
  assert.deepEqual(checkZtnaDenyRules('203.0.113.7', rules, now), {
    action: 'deny', evidenceAlertId: 'wazuh-1', expiresAt: '2026-10-07T00:15:00.000Z',
  });
  assert.deepEqual(checkZtnaDenyRules('192.0.2.2', rules, now), { action: 'continue' });
});

test('decideWithXdr denies a matching source before the existing decider and delegates other requests unchanged', async () => {
  const now = new Date(stamp);
  const request = { requestId: 'request_fixture' };
  const rules = [{
    id: 'xdr.brute-force:wazuh-1',
    sourceAddress: '203.0.113.7',
    expiresAt: '2026-10-07T00:15:00.000Z',
    evidenceAlertId: 'wazuh-1',
    reasonPattern: 'credential-spray',
  }];
  const denied = await decideWithXdr(request, '203.0.113.7', { rules, now });
  assert.deepEqual(denied, {
    xdr: { action: 'deny', evidenceAlertId: 'wazuh-1', expiresAt: '2026-10-07T00:15:00.000Z' },
    decision: null,
  });

  const continued = await decideWithXdr(request, '192.0.2.3', { rules, now });
  assert.deepEqual(continued.xdr, { action: 'continue' });
  assert.equal(continued.decision.requestId, request.requestId);
  assert.deepEqual(Object.keys(continued.decision), ['schema', 'requestId', 'decision', 'reasonCode', 'ruleIds']);
});

function syntheticAlert(index, seconds, { spray = false, description = 'login failed', account = `user_fixture_${index}` } = {}) {
  return {
    id: `audit-${index}`,
    timestamp: new Date(Date.parse(stamp) + seconds * 1000).toISOString(),
    rule: { level: 5, description },
    data: { srcip: '192.0.2.40', srcuser: account,
      ...(spray ? { credential_fingerprint: 'synthetic-correlation-only' } : {}) },
  };
}

// Exercise the actual command and files, without replacing the student's fixture or outputs.
function runIsolated(t, alerts) {
  const tempRoot = resolve(tmpdir());
  const directory = mkdtempSync(join(tempRoot, 'xdr-regression-'));
  t.after(() => {
    assert.equal(dirname(resolve(directory)), tempRoot);
    assert.ok(directory.startsWith(join(tempRoot, 'xdr-regression-')));
    rmSync(directory, { recursive: true, force: true });
  });
  const repo = resolve(import.meta.dirname, '..');
  for (const file of ['scripts/xdr-run.mjs', 'scripts/fixture-7.mjs', 'src/decider.mjs', 'src/decider-xdr.mjs',
    'xdr/brute-force/read-alerts.mjs', 'xdr/brute-force/decide.mjs', 'xdr/brute-force/private-signals.mjs',
    'xdr/brute-force/patterns.json', 'xdr/brute-force/deny-rules.mjs']) {
    const target = join(directory, file);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(join(repo, file), target);
  }
  const fixture = join(directory, 'xdr/fixtures/brute-force.json');
  mkdirSync(dirname(fixture), { recursive: true });
  const original = JSON.stringify(alerts);
  writeFileSync(fixture, original);
  const env = { ...process.env };
  delete env.JEV_REVIEW_URL;
  const run = () => execFileSync(process.execPath, [join(directory, 'scripts/xdr-run.mjs'), 'brute-force'],
    { env, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  const stdout = run();
  assert.equal(readFileSync(fixture, 'utf8'), original);
  return {
    result: JSON.parse(readFileSync(join(directory, 'xdr/brute-force/result.json'), 'utf8')),
    rules: JSON.parse(readFileSync(join(directory, 'xdr/brute-force/deny-rules.json'), 'utf8')),
    logs: () => readFileSync(join(directory, 'xdr/alerts.log'), 'utf8').trim().split(/\r?\n/u).filter(Boolean).map(JSON.parse),
    run, stdout, fixturePath: fixture,
  };
}

test('hour-separated failures do not count as a short source burst', (t) => {
  const { result } = runIsolated(t, Array.from({ length: 8 }, (_, i) => syntheticAlert(i, i * 3600)));
  assert.deepEqual(result.counts, { block: 0, alert: 0, record: 8 });
});

test('hour-separated credential attempts do not create a deny rule', (t) => {
  const { result, rules } = runIsolated(t, Array.from({ length: 3 }, (_, i) => syntheticAlert(i, i * 3600, { spray: true })));
  assert.deepEqual(result.counts, { block: 0, alert: 0, record: 3 });
  assert.equal(rules.length, 0);
});

for (const [lastSecond, expectedBlocks] of [[120, 1], [121, 0]]) {
  test(`same-account window ends at 120 seconds: last attempt at ${lastSecond}`, (t) => {
    const { result } = runIsolated(t, [0, 1, 2, 3, lastSecond].map((s, i) =>
      syntheticAlert(i, s, { account: 'same_user_fixture' })));
    assert.equal(result.counts.block, expectedBlocks);
    assert.equal(result.counts.alert, 0);
  });
}

for (const [lastSecond, expectedBlocks] of [[300, 1], [301, 0]]) {
  test(`credential-spray window ends at 300 seconds: last attempt at ${lastSecond}`, (t) => {
    const { result } = runIsolated(t, [0, 1, lastSecond].map((s, i) => syntheticAlert(i, s, { spray: true })));
    assert.equal(result.counts.block, expectedBlocks);
  });
}

test('non-login failures do not produce a brute-force alert or rule', (t) => {
  const { result, rules } = runIsolated(t, Array.from({ length: 3 }, (_, i) =>
    syntheticAlert(i, i * 10, { spray: true, description: 'file transfer failed' })));
  assert.deepEqual(result.counts, { block: 0, alert: 0, record: 3 });
  assert.equal(result.normalEventCount, 0);
  assert.equal(rules.length, 0);
});

test('a known normal login sharing an address suppresses address-wide blocking', (t) => {
  const alerts = [...Array.from({ length: 3 }, (_, i) => syntheticAlert(i, i * 10, { spray: true })),
    syntheticAlert(3, 30, { description: 'login successful', account: 'normal_user_fixture' })];
  const { result, rules } = runIsolated(t, alerts);
  assert.deepEqual(result.counts, { block: 0, alert: 1, record: 3 });
  assert.equal(result.normalBlockedCount, 0);
  assert.equal(result.normalEventCount, 1);
  assert.equal(result.ztnaPrecheck.normalEventAction, 'continue');
  assert.equal(rules.length, 0);
  assert.equal(result.decisions[2].reason, 'credential-spray');
});

test('alerts.log only appends alerts and block candidates, and replay does not duplicate entries', (t) => {
  const { logs, run } = runIsolated(t, [0, 10, 20].map((s, i) => syntheticAlert(i, s, { spray: true })));
  assert.equal(logs().length, 1);
  assert.equal(logs()[0].action, 'block');
  run();
  assert.equal(logs().length, 1);
});

test('runner distinguishes an XDR pass from a deny by the existing policy', (t) => {
  const { result, stdout } = runIsolated(t, [syntheticAlert(0, 0, { description: 'login successful' })]);
  assert.equal(result.ztnaPrecheck.normalEventAction, 'continue');
  assert.equal(result.ztnaPrecheck.normalPolicyDecision, 'deny');
  assert.equal(result.ztnaPrecheck.normalRequestAllowed, false);
  assert.match(stdout, /기존 판정기.*deny/u);
});

test('secret-shaped JSON and escaped descriptions are redacted in every output field', () => {
  const marker = 'SYNTHETIC_REDACTION_CANARY';
  for (const description of [JSON.stringify({ password: marker }), JSON.stringify({ access_token: marker }),
    `password=${marker}`, `password=first-word ${marker}`, `password="first\\"${marker}"`,
    String.raw`{\\\"api_key\\\":\\\"${marker}\\\"}`, String.raw`{\"api_key\":\"${marker}\"}`,
    `-----BEGIN PRIVATE KEY----- ${marker} -----END PRIVATE KEY-----`]) {
    const rows = readAlerts([{ timestamp: stamp, rule: { level: 5, description }, data: { srcip: '192.0.2.1', srcuser: `token=${marker}` } }]);
    assert.ok(!JSON.stringify(rows).includes(marker));
  }
});

test('result, log and deny rules do not copy secret-shaped alert IDs or descriptions', (t) => {
  const marker = 'SYNTHETIC_OUTPUT_CANARY';
  const alerts = [0, 10, 20].map((s, i) => syntheticAlert(i, s, { spray: true,
    description: `login failed password=first-word ${marker}` }));
  alerts[2].id = `token=${marker}`;
  const { result, rules, logs } = runIsolated(t, alerts);
  assert.equal(result.counts.block, 1);
  assert.ok(!JSON.stringify({ result, rules, logs: logs() }).includes(marker));
});

test('malformed Jev confidence falls back to alert instead of becoming zero', async () => {
  const oldUrl = process.env.JEV_REVIEW_URL;
  const oldFetch = globalThis.fetch;
  process.env.JEV_REVIEW_URL = 'https://jev-fixture.invalid/review';
  try {
    for (const confidence of [null, '', false, '0.9', {}, -1, 1.01]) {
      globalThis.fetch = async () => ({ ok: true, json: async () => ({ confidence }) });
      const result = await createDecider().decide({ ruleLevel: 5,
        patternSignals: { isLoginFailure: true, sameSourceFailures: 8, sameAccountFailures: 1, sameCredentialAccountCount: 0 } });
      assert.equal(result.action, 'alert');
      assert.equal(result.confidence, 0.5);
    }
  } finally {
    globalThis.fetch = oldFetch;
    if (oldUrl === undefined) delete process.env.JEV_REVIEW_URL;
    else process.env.JEV_REVIEW_URL = oldUrl;
  }
});

test('an unavailable Jev also falls back to alert for a same-account burst', async () => {
  const oldUrl = process.env.JEV_REVIEW_URL;
  delete process.env.JEV_REVIEW_URL;
  try {
    const result = await createDecider().decide({ ruleLevel: 5,
      patternSignals: { isLoginFailure: true, sameSourceFailures: 5, sameAccountFailures: 5, sameCredentialAccountCount: 0 } });
    assert.deepEqual(result, { action: 'alert', confidence: 0.5, reason: 'same-account-failure-burst' });
  } finally {
    if (oldUrl !== undefined) process.env.JEV_REVIEW_URL = oldUrl;
  }
});

test('the XDR gate preserves an allow by a supplied policy and denies attack sources before calling it', async () => {
  assert.equal(typeof xdrAdapter.createXdrGate, 'function');
  const request = { schema: 'aleph.decision.v1', requestId: 'request_fixture' };
  const approved = { schema: request.schema, requestId: request.requestId,
    decision: 'allow', reasonCode: 'approved', ruleIds: [] };
  let calls = 0;
  const gate = xdrAdapter.createXdrGate(async (received) => {
    assert.equal(received, request);
    calls += 1;
    return approved;
  });
  const now = new Date(stamp);
  const rules = createDenyRules([{ alertId: 'wazuh-1', sourceAddress: '192.0.2.40', action: 'block', reason: 'credential-spray' }], now);
  const normal = await gate(request, '192.0.2.41', { rules, now });
  assert.equal(normal.decision, approved);
  assert.equal(normal.xdr.action, 'continue');
  const attack = await gate(request, '192.0.2.40', { rules, now });
  assert.equal(attack.xdr.action, 'deny');
  assert.equal(attack.decision, null);
  assert.equal(calls, 1);
});

test('the gate rejects missing trusted addresses and malformed rules', async () => {
  await assert.rejects(decideWithXdr({ requestId: 'request_fixture' }, undefined, { rules: [] }), /invalid_verified_source_address/u);
  await assert.rejects(decideWithXdr({ requestId: 'request_fixture' }, '192.0.2.40', { rules: {} }), /invalid_xdr_deny_rules/u);
});

test('normal sources cannot receive an address-wide deny rule even from a supplied block candidate', () => {
  const rules = createDenyRules([
    { alertId: 'wazuh-1', sourceAddress: '192.0.2.40', action: 'block', reason: 'credential-spray' },
    { alertId: 'wazuh-2', sourceAddress: '192.0.2.40', action: 'record', eventType: 'normal' },
  ], new Date(stamp));
  assert.equal(rules.length, 0);
});

test('malformed fixture JSON never appears in the runner error message', (t) => {
  const marker = 'SYNTHETIC_PARSE_CANARY';
  const { fixturePath, run } = runIsolated(t, []);
  writeFileSync(fixturePath, `{"password":${marker}}`);
  let failure;
  try { run(); } catch (error) { failure = error; }
  assert.ok(failure);
  assert.equal(failure.status, 1);
  assert.ok(!String(failure.stderr).includes(marker));
  assert.match(String(failure.stderr), /invalid_xdr_json/u);
});

test('invalid rule entries fail explicitly before calling the existing policy', async () => {
  for (const rule of [null, {}, { sourceAddress: '192.0.2.40', expiresAt: '2026-10-07T00:15:00.000Z' },
    { id: 'xdr.brute-force:wazuh-1', sourceAddress: '192.0.2.40', expiresAt: 'invalid', evidenceAlertId: 'wazuh-1', reasonPattern: 'credential-spray' }]) {
    await assert.rejects(decideWithXdr({ requestId: 'request_fixture' }, '192.0.2.40',
      { rules: [rule], now: new Date(stamp) }), /invalid_xdr_deny_rules/u);
  }
});

test('equivalent IPv6 spellings match the same deny rule', () => {
  const now = new Date(stamp);
  const rules = createDenyRules([{ alertId: 'wazuh-1', sourceAddress: '2001:0db8:0:0:0:0:0:1',
    action: 'block', reason: 'credential-spray' }], now);
  assert.equal(checkZtnaDenyRules('2001:db8::1', rules, now).action, 'deny');
  assert.equal(isSourceDenied('2001:db8::1', rules, now), true);
});

test('decide blocks a high-volume source-only burst only when no normal login shares the address', async () => {
  const decider = createDecider();
  const blocked = await decider.decide({ ruleLevel: 5,
    patternSignals: { isLoginFailure: true, sameSourceFailures: 8, sameAccountFailures: 1,
      sameCredentialAccountCount: 0, sourceHasNormalLogin: false } });
  assert.deepEqual(blocked, { action: 'block', confidence: 0.9, reason: 'same-source-failure-burst' });

  const shared = await createDecider().decide({ ruleLevel: 5,
    patternSignals: { isLoginFailure: true, sameSourceFailures: 8, sameAccountFailures: 1,
      sameCredentialAccountCount: 0, sourceHasNormalLogin: true } });
  assert.equal(shared.action, 'alert');
});

test('the public decide(alert) entry point correlates raw Wazuh alerts without private patternSignals', async () => {
  const rawAlerts = JSON.parse(readFileSync(join(import.meta.dirname, '../xdr/fixtures/brute-force.json'), 'utf8'));
  const counts = { block: 0, alert: 0, record: 0 };
  for (const alert of rawAlerts) counts[(await decide(alert)).action] += 1;
  assert.deepEqual(counts, { block: 3, alert: 0, record: 14 });
});

test('a decider instance correlates the five-field readAlerts rows as a stream', async () => {
  const rawAlerts = JSON.parse(readFileSync(join(import.meta.dirname, '../xdr/fixtures/brute-force.json'), 'utf8'));
  const decider = createDecider();
  const counts = { block: 0, alert: 0, record: 0 };
  for (const alert of readAlerts(rawAlerts)) counts[(await decider.decide(alert)).action] += 1;
  assert.deepEqual(counts, { block: 3, alert: 0, record: 14 });
});

test('readAlerts keeps a private hashed credential signal for decide without exposing it in output', async () => {
  const fingerprint = 'SYNTHETIC_FINGERPRINT_CANARY';
  const rows = readAlerts([0, 10, 20].map((seconds, index) => {
    const alert = syntheticAlert(index, seconds, { spray: true });
    alert.data.credential_fingerprint = fingerprint;
    return alert;
  }));

  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.doesNotMatch(JSON.stringify(rows), new RegExp(fingerprint, 'u'));
  const decider = createDecider();
  const actions = [];
  for (const row of rows) actions.push((await decider.decide(row)).action);
  assert.deepEqual(actions, ['record', 'record', 'block']);
});

test('IPv6 variants correlate and a success on the same IPv6 protects the whole address', (t) => {
  const addresses = ['2001:0db8:0:0:0:0:0:1', '2001:db8::1', '2001:db8:0::1'];
  const failures = [0, 10, 20].map((s, i) => {
    const alert = syntheticAlert(i, s, { spray: true });
    alert.data.srcip = addresses[i];
    return alert;
  });
  const attack = runIsolated(t, failures);
  assert.equal(attack.result.counts.block, 1);
  const success = syntheticAlert(3, 30, { description: 'login successful' });
  success.data.srcip = '2001:db8::1';
  const shared = runIsolated(t, [...failures, success]);
  assert.deepEqual(shared.result.counts, { block: 0, alert: 1, record: 3 });
  assert.equal(shared.result.normalBlockedCount, 0);
  assert.equal(shared.rules.length, 0);
});
