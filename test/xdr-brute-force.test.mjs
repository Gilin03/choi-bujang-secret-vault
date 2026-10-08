import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { readAlert, readAlerts } from '../xdr/brute-force/read-alerts.mjs';
import { decide } from '../xdr/brute-force/decide.mjs';
import { createDenyRules, matchActiveDenyRule } from '../xdr/brute-force/deny-rules.mjs';
import { decideWithXdr } from '../src/decider-with-xdr.mjs';

const fixtureUrl = new URL('../xdr/fixtures/brute-force.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

async function withoutJev(run) {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'Jev');
  delete globalThis.Jev;
  try {
    return await run();
  } finally {
    if (previous) Object.defineProperty(globalThis, 'Jev', previous);
  }
}

test('readAlerts extracts one five-field row for every source alert', async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, 'utf8'));
  const rows = readAlerts(fixture);

  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 28);
  assert.deepEqual(Object.keys(rows[0]), [
    'timestamp',
    'sourceAddress',
    'account',
    'ruleLevel',
    'description',
  ]);
  assert.deepEqual(rows[0], {
    timestamp: fixture.alerts[0].timestamp,
    sourceAddress: fixture.alerts[0].data.srcip,
    account: fixture.alerts[0].data.srcuser,
    ruleLevel: fixture.alerts[0].rule.level,
    description: fixture.alerts[0].rule.description,
  });
});

test('readAlert drops unapproved fields and redacts secret-like values', () => {
  const row = readAlert({
    timestamp: '2026-10-07T00:00:00.000Z',
    rule: { level: 5, description: 'login failed password=training-secret-sentinel' },
    data: {
      srcip: '192.0.2.99',
      srcuser: 'student@example.invalid',
      password: 'training-secret-sentinel',
      token: 'token-sentinel-should-not-leak',
    },
    api_key: 'training-secret-sentinel',
  });

  assert.deepEqual(Object.keys(row), [
    'timestamp',
    'sourceAddress',
    'account',
    'ruleLevel',
    'description',
  ]);
  assert.doesNotMatch(JSON.stringify(row), /training-secret-sentinel|token-sentinel|student@example\.invalid/);
});

test('readAlerts rejects an invalid fixture without echoing its input', () => {
  assert.throws(() => readAlerts({ schema: 'wrong', alerts: ['secret-marker'] }), /invalid_xdr_fixture/);
});

test('decide runtime imports only local modules and no Node built-ins or packages', async () => {
  const pending = [new URL('../xdr/brute-force/decide.mjs', import.meta.url)];
  const visited = new Set();
  while (pending.length) {
    const moduleUrl = pending.pop();
    if (visited.has(moduleUrl.href)) continue;
    visited.add(moduleUrl.href);
    const source = await readFile(moduleUrl, 'utf8');
    const specifiers = [...source.matchAll(/(?:\bfrom\s*|\bimport\s*\(\s*|\bimport\s*)['"]([^'"]+)['"]/gu)]
      .map((match) => match[1]);
    for (const specifier of specifiers) {
      assert.ok(specifier.startsWith('.'), `${moduleUrl.pathname} imports non-local module ${specifier}`);
      const importedUrl = new URL(specifier, moduleUrl);
      assert.equal(importedUrl.protocol, 'file:');
      pending.push(importedUrl);
    }
  }
});

test('patterns document only repeated-source failures and password spraying with evidence', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/brute-force/patterns.json', import.meta.url), 'utf8'));

  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.patterns.length, 2);
  assert.deepEqual(patterns.patterns.map((pattern) => pattern.id), [
    'rapid_same_source_failures',
    'password_spraying',
  ]);
  for (const pattern of patterns.patterns) {
    assert.equal(typeof pattern.name, 'string');
    assert.ok(pattern.name.length > 0);
    assert.equal(typeof pattern.condition, 'string');
    assert.ok(pattern.condition.length > 0);
    assert.equal(typeof pattern.evidence, 'string');
    assert.ok(pattern.evidence.length > 0);
    assert.equal(pattern.source, 'https://attack.mitre.org/techniques/T1110/');
    assert.match(pattern.evidence, /T1110/);
  }
  assert.match(patterns.patterns[0].condition, /same source|same address|동일 출발지|같은 주소|같은 data\.srcip/i);
  assert.match(patterns.patterns[0].condition, /failure|failed|실패/i);
  assert.match(patterns.patterns[1].condition, /multiple accounts|여러 계정/i);
  assert.match(patterns.patterns[1].condition, /same password|같은 비밀번호/i);
});

test('decide classifies the authoritative fixture into clear, ambiguous, and normal events', async () => {
  await withoutJev(async () => {
    const fixture = await loadFixture();
    const decisions = await Promise.all(fixture.alerts.map((alert) => decide(alert)));
    const counts = Object.fromEntries(['block', 'alert', 'record'].map((action) => [
      action,
      decisions.filter((decision) => decision.action === action).length,
    ]));

    assert.deepEqual(counts, { block: 10, alert: 9, record: 9 });
    assert.ok(decisions.slice(0, 10).every((decision) => decision.confidence >= 0.85));
    assert.ok(decisions.slice(10, 19).every((decision) => decision.action === 'alert'));
    assert.ok(decisions.slice(19).every((decision) => decision.action === 'record'));
    const patternNames = JSON.parse(await readFile(new URL('../xdr/brute-force/patterns.json', import.meta.url), 'utf8'))
      .patterns.map((pattern) => pattern.name);
    for (const decision of decisions) {
      assert.deepEqual(Object.keys(decision), ['action', 'confidence', 'reason']);
      assert.ok(decision.reason.length > 0);
      assert.doesNotMatch(decision.reason, /\r|\n/u);
    }
    for (const decision of decisions.slice(0, 19)) {
      assert.ok(patternNames.some((name) => decision.reason.startsWith(`${name}:`)));
    }
  });
});

test('decide asks Jev only for ambiguous signals and applies the confidence thresholds', async () => {
  const fixture = await loadFixture();
  const calls = [];
  globalThis.Jev = async (summary) => {
    calls.push(summary);
    return { confidence: 0.5 };
  };
  try {
    await decide(fixture.alerts[0]);
    await decide(fixture.alerts[10]);
    await decide(fixture.alerts[19]);
    assert.equal(calls.length, 1);
    assert.deepEqual(Object.keys(calls[0]), [
      'timestamp',
      'sourceAddress',
      'account',
      'ruleLevel',
      'description',
    ]);

    for (const [confidence, action] of [[0.85, 'block'], [0.5, 'alert'], [0.49, 'record']]) {
      globalThis.Jev = async () => ({ confidence });
      assert.equal((await decide(fixture.alerts[10])).action, action);
    }
  } finally {
    delete globalThis.Jev;
  }
});

test('decide falls back to alert when Jev rejects or does not answer', async () => {
  const fixture = await loadFixture();
  globalThis.Jev = async () => { throw new Error('unavailable'); };
  try {
    const decision = await decide(fixture.alerts[10]);
    assert.equal(decision.action, 'alert');
    assert.equal(decision.confidence, 0.5);
  } finally {
    delete globalThis.Jev;
  }
});

test('deny rules contain only clear block candidates with expiry and evidence alert id', async () => {
  const fixture = await loadFixture();
  const decisions = await withoutJev(() => Promise.all(fixture.alerts.map((alert) => decide(alert))));
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });

  assert.equal(rules.length, 10);
  assert.ok(rules.every((rule) => rule.action === 'deny'));
  assert.ok(rules.every((rule) => rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  assert.deepEqual(rules.map((rule) => rule.evidenceAlertId), fixture.alerts.slice(0, 10).map((alert) => alert.id));
  assert.ok(rules.every((rule) => /^\d{1,3}(?:\.\d{1,3}){3}$/u.test(rule.sourceAddress)));
  assert.ok(rules.every((rule) => rule.confidence >= 0.85));
  assert.ok(rules.every((rule) => !Object.hasOwn(rule, 'account')));
  assert.deepEqual(createDenyRules({
    alerts: [fixture.alerts[0]],
    decisions: [{ action: 'block', confidence: Number.NaN }],
    now,
  }), []);
});

test('deny rule matches only its source before expiry and never a normal fixture source', async () => {
  const fixture = await loadFixture();
  const decisions = await withoutJev(() => Promise.all(fixture.alerts.map((alert) => decide(alert))));
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });

  assert.equal(matchActiveDenyRule(fixture.alerts[0].data.srcip, rules, new Date('2026-10-08T00:14:59.999Z'))?.evidenceAlertId, 'bf-01');
  assert.equal(matchActiveDenyRule(fixture.alerts[0].data.srcip, rules, new Date('2026-10-08T00:15:00.000Z')), null);
  assert.equal(matchActiveDenyRule(fixture.alerts[19].data.srcip, rules, new Date('2026-10-08T00:01:00.000Z')), null);
});

test('XDR pre-decision gate denies a trusted blocked source and otherwise preserves the base decider', async () => {
  const fixture = await loadFixture();
  const decisions = await withoutJev(() => Promise.all(fixture.alerts.map((alert) => decide(alert))));
  const denyRules = createDenyRules({ alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
  const request = { schema: 'aleph.decision.v1', requestId: 'fixture-request' };
  const blocked = await decideWithXdr(request, {
    sourceAddress: fixture.alerts[0].data.srcip,
    denyRules,
    now: new Date('2026-10-08T00:01:00.000Z'),
  });
  assert.equal(blocked.gate.action, 'deny');
  assert.equal(blocked.gate.evidenceAlertId, 'bf-01');
  assert.equal(blocked.policyDecision, null);

  const continued = await decideWithXdr({ ...request, sourceAddress: fixture.alerts[0].data.srcip }, {
    sourceAddress: fixture.alerts[19].data.srcip,
    denyRules,
    now: new Date('2026-10-08T00:01:00.000Z'),
  });
  assert.equal(continued.gate.action, 'continue');
  assert.equal(continued.policyDecision.decision, 'deny');
  assert.equal(continued.policyDecision.reasonCode, 'starter_not_ready');
});
