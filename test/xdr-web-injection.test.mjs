import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { readAlert, readAlerts } from '../xdr/web-injection/read-alerts.mjs';
import { decide } from '../xdr/web-injection/decide.mjs';
import { createDenyRules, writeResponseArtifacts } from '../xdr/web-injection/respond.mjs';

const fixtureUrl = new URL('../xdr/fixtures/web-injection.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('웹 주입 경보 읽기는 허용된 다섯 필드만 각 경보에서 추출한다', async () => {
  const fixture = await loadFixture();
  const rows = readAlerts(fixture);

  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 26);
  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.deepEqual(rows[0], {
    timestamp: fixture.alerts[0].timestamp,
    sourceAddress: fixture.alerts[0].data.srcip,
    account: '',
    ruleLevel: fixture.alerts[0].rule.level,
    description: fixture.alerts[0].rule.description,
  });
});

test('웹 주입 경보 읽기는 임의 필드를 버리고 비밀값처럼 보이는 내용을 가린다', () => {
  const row = readAlert({
    timestamp: '2026-10-07T00:00:00.000Z',
    rule: { level: 5, description: 'request password=training-secret-sentinel' },
    data: { srcip: '192.0.2.9', srcuser: 'learner@example.invalid', token: 'token-sentinel' },
    raw_request: 'training-secret-sentinel',
  });

  assert.deepEqual(Object.keys(row), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.doesNotMatch(JSON.stringify(row), /training-secret-sentinel|token-sentinel|learner@example\.invalid/);
});

test('patterns.json documents the three requested signals and T1190 review fallback with evidence', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/web-injection/patterns.json', import.meta.url), 'utf8'));
  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.patterns.length, 4);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /SQL|데이터베이스/i);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /script|스크립트/i);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /\.\.\//);
  for (const pattern of patterns.patterns) {
    assert.ok(pattern.name);
    assert.ok(pattern.evidence.includes('T1190'));
    assert.equal(pattern.source, 'https://attack.mitre.org/techniques/T1190/');
  }
});

test('standalone decide classifies clear attacks, T1190 review alerts, and normal events', async () => {
  const source = await readFile(new URL('../xdr/web-injection/decide.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|['"]|[\w*{])|\bfrom\s*['"]|node:|\brequire\s*\(|\bfetch\s*\(|readFile|writeFile/iu);
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const counts = Object.fromEntries(['block', 'alert', 'record'].map((action) => [
    action,
    decisions.filter((decision) => decision.action === action).length,
  ]));

  assert.deepEqual(counts, { block: 8, alert: 9, record: 9 });
  assert.ok(decisions.slice(0, 8).every((decision) => decision.confidence >= 0.85));
  assert.match(decisions[0].reason, /^요청 인자 안의 SQL 구문:/u);
  assert.match(decisions[1].reason, /^요청 인자 안의 스크립트 태그:/u);
  assert.match(decisions[2].reason, /^반복 경로 거슬러 올라가기\(\.\.\/\):/u);
  assert.ok(decisions.slice(8, 17).every((decision) => decision.action === 'alert'));
  assert.ok(decisions.slice(17).every((decision) => decision.action === 'record'));
  assert.ok(decisions.every((decision) => ['block', 'alert', 'record'].includes(decision.action)));
  assert.ok(decisions.every((decision) => Number.isFinite(decision.confidence)
    && decision.confidence >= 0 && decision.confidence <= 1
    && !/[\r\n]/u.test(decision.reason)));
  const patternNames = JSON.parse(await readFile(new URL('../xdr/web-injection/patterns.json', import.meta.url), 'utf8'))
    .patterns.map((pattern) => pattern.name);
  assert.ok(decisions.slice(0, 17).every((decision) => patternNames.some((name) => decision.reason.startsWith(`${name}:`))));
});

test('only repeated high-confidence request-parameter injection is blocked', () => {
  const base = {
    id: 'synthetic-clear',
    rule: { level: 12, description: 'web input matched', mitre: ['T1190'] },
    data: { srcip: '203.0.113.8', url: '/search?q=%27%20UNION%20SELECT%20name%20FROM%20users', count: 8 },
  };
  assert.equal(decide(base).action, 'block');
  assert.equal(decide({ ...base, data: { ...base.data, count: 1 } }).action, 'alert');
  assert.equal(decide({ ...base, rule: { ...base.rule, level: 5 } }).action, 'alert');
  assert.equal(decide({ ...base, rule: { level: 12, mitre: [] } }).action, 'block');
  assert.equal(decide({
    ...base,
    rule: { level: 12, description: 'normal class search', mitre: [] },
    data: { srcip: '203.0.113.8', url: '/search?q=select-course', count: 20 },
  }).action, 'record');

  for (const url of [
    '/search?q=%3Cscript%3Ealert(1)%3C%2Fscript%3E',
    '/files?name=../../../../etc/passwd',
  ]) {
    assert.equal(decide({
      ...base,
      rule: { level: 11, description: 'web request matched', mitre: ['T1190'] },
      data: { srcip: '198.51.100.8', url, count: 8 },
    }).action, 'block');
  }
});

test('web-injection deny rules carry expiry and evidence ids only for block decisions', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });
  assert.equal(rules.length, 8);
  assert.ok(rules.every((rule) => rule.action === 'deny'));
  assert.ok(rules.every((rule) => rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  assert.deepEqual(rules.map((rule) => rule.evidenceAlertId), fixture.alerts.slice(0, 8).map((alert) => alert.id));
});

test('respond appends only block/alert metadata and does not duplicate existing alerts', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  decisions[8] = { ...decisions[8], reason: `${decisions[8].reason} secret-marker-not-for-logs` };
  const root = await mkdtemp(join(tmpdir(), 'web-injection-respond-'));
  try {
    await writeResponseArtifacts({ root, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    const firstLog = await readFile(join(root, 'xdr', 'alerts.log'), 'utf8');
    assert.equal(firstLog.trim().split(/\r?\n/u).length, 17);
    assert.doesNotMatch(firstLog, /doc-sql|doc-script|doc-up-repeat|choi-bujang|secret-marker/);
    await writeResponseArtifacts({ root, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    assert.equal(await readFile(join(root, 'xdr', 'alerts.log'), 'utf8'), firstLog);
    const saved = JSON.parse(await readFile(join(root, 'xdr', 'web-injection', 'deny-rules.json'), 'utf8'));
    assert.equal(saved.rules.length, 8);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
