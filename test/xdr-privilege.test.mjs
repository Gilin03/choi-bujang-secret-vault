import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureUrl = new URL('../xdr/fixtures/privilege.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('privilege reader returns one five-field row per alert and masks secret-like text', async () => {
  const { readAlert, readAlerts } = await import('../xdr/privilege/read-alerts.mjs');
  const fixture = await loadFixture();
  const rows = readAlerts(fixture);

  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 26);
  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.deepEqual(rows[0], {
    timestamp: fixture.alerts[0].timestamp,
    sourceAddress: fixture.alerts[0].data.srcip,
    account: fixture.alerts[0].data.srcuser,
    ruleLevel: fixture.alerts[0].rule.level,
    description: fixture.alerts[0].rule.description,
  });
  const redacted = readAlert({
    timestamp: '2026-10-07T00:00:00.000Z',
    rule: { level: 5, description: 'token=privilege-secret-sentinel' },
    data: { srcip: '192.0.2.9', srcuser: 'learner@example.invalid', token: 'token-sentinel' },
    raw: 'privilege-secret-sentinel',
  });
  assert.deepEqual(Object.keys(redacted), Object.keys(rows[0]));
  assert.doesNotMatch(JSON.stringify(redacted), /privilege-secret-sentinel|token-sentinel|learner@example\.invalid/);
});

test('privilege patterns document only the three requested signals with MITRE evidence', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/privilege/patterns.json', import.meta.url), 'utf8'));
  const decisionSource = await readFile(new URL('../xdr/privilege/decide.mjs', import.meta.url), 'utf8');
  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.moduleKey, 'privilege');
  assert.equal(patterns.patterns.length, 3);
  assert.match(patterns.patterns.map(item => `${item.name} ${item.condition}`).join('\n'), /관리자 그룹/u);
  assert.match(patterns.patterns.map(item => `${item.name} ${item.condition}`).join('\n'), /관리자 명령/u);
  assert.match(patterns.patterns.map(item => `${item.name} ${item.condition}`).join('\n'), /업무 시간 밖|업무 외/u);
  for (const pattern of patterns.patterns) {
    assert.ok(pattern.name);
    assert.ok(pattern.condition);
    assert.ok(pattern.evidence);
    assert.match(pattern.evidence, /T1068|T1078/u);
    assert.match(pattern.source, /^https:\/\/attack\.mitre\.org\/techniques\/T10(?:68|78)\/$/u);
    for (const field of ['id', 'name', 'condition', 'evidence', 'source']) {
      assert.ok(decisionSource.includes(`${field}: '${pattern[field]}'`), `decide.mjs must contain ${field} from ${pattern.id}`);
    }
  }
});

test('standalone privilege decision separates clear, ambiguous, and normal fixture alerts', async () => {
  const source = await readFile(new URL('../xdr/privilege/decide.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|['"]|[\w*{])|\bfrom\s*['"]|node:|\brequire\s*\(|\bfetch\s*\(|readFile|writeFile/iu);
  const { decide } = await import('../xdr/privilege/decide.mjs');
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const actions = Object.fromEntries(['block', 'alert', 'record'].map(action => [
    action,
    decisions.flatMap((decision, index) => decision.action === action ? [fixture.alerts[index].id] : []),
  ]));

  assert.deepEqual(actions, {
    block: ['pv-01', 'pv-02', 'pv-03', 'pv-04', 'pv-05', 'pv-06', 'pv-07', 'pv-08', 'pv-09'],
    alert: ['pv-10', 'pv-11', 'pv-12', 'pv-13', 'pv-14', 'pv-15', 'pv-16', 'pv-17'],
    record: ['pv-18', 'pv-19', 'pv-20', 'pv-21', 'pv-22', 'pv-23', 'pv-24', 'pv-25', 'pv-26'],
  });
  assert.match(decisions[0].reason, /^관리자 그룹 추가:/u);
  assert.match(decisions[1].reason, /^처음 보는 관리자 명령:/u);
  assert.match(decisions[2].reason, /^업무 시간 밖 권한 사용:/u);
  assert.match(decisions[6].reason, /^업무 시간 밖 권한 사용:/u);
  assert.equal(decisions[11].confidence, 0.65, 'a low-confidence T1068 admin command remains an alert');
  assert.ok(decisions.every(decision => Object.keys(decision).sort().join(',') === 'action,confidence,reason'));
  assert.ok(decisions.every(decision => ['block', 'alert', 'record'].includes(decision.action)
    && Number.isFinite(decision.confidence) && decision.confidence >= 0 && decision.confidence <= 1
    && !/[\r\n]/u.test(decision.reason)));
  assert.ok(decisions.filter(decision => decision.action === 'block').every(decision => decision.confidence >= 0.85));
  assert.ok(decisions.filter(decision => decision.action === 'alert').every(decision => decision.confidence >= 0.5 && decision.confidence < 0.85));
});

test('privilege response writes expiring evidence rules and deduplicated safe alert metadata', async () => {
  const { decide } = await import('../xdr/privilege/decide.mjs');
  const { createDenyRules, writeResponseArtifacts } = await import('../xdr/privilege/respond.mjs');
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });

  assert.equal(rules.length, 9);
  assert.deepEqual(rules.map(rule => rule.evidenceAlertId), fixture.alerts.slice(0, 9).map(alert => alert.id));
  assert.ok(rules.every(rule => rule.action === 'deny' && rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  const forgedNormal = decisions.slice();
  forgedNormal[20] = { action: 'block', confidence: 0.99, reason: '관리자 그룹 추가: forged' };
  assert.equal(createDenyRules({ alerts: fixture.alerts, decisions: forgedNormal, now }).length, 9);

  const tempRoot = await mkdtemp(join(tmpdir(), 'xdr-privilege-respond-'));
  try {
    const staleDecisions = decisions.slice();
    staleDecisions[17] = { action: 'alert', confidence: 0.65, reason: '관리자 그룹 추가: 이전 분류' };
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions: staleDecisions, now });
    const written = await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now });
    assert.equal(written.length, 9);
    const logPath = join(tempRoot, 'xdr', 'alerts.log');
    const firstLog = await readFile(logPath, 'utf8');
    assert.equal(firstLog.trim().split(/\r?\n/u).length, 17);
    assert.doesNotMatch(firstLog, /"alertId":"pv-18"/u);
    const logged = firstLog.trim().split(/\r?\n/u).map(line => JSON.parse(line));
    assert.deepEqual(logged.map(item => item.alertId), [
      'pv-01', 'pv-02', 'pv-03', 'pv-04', 'pv-05', 'pv-06', 'pv-07', 'pv-08', 'pv-09',
      'pv-10', 'pv-11', 'pv-12', 'pv-13', 'pv-14', 'pv-15', 'pv-16', 'pv-17',
    ]);
    assert.doesNotMatch(firstLog, /user01|203\.0\.113\.11|관리자 그룹에 추가|privilege-secret/);
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now });
    assert.equal(await readFile(logPath, 'utf8'), firstLog);
    const saved = JSON.parse(await readFile(join(tempRoot, 'xdr', 'privilege', 'deny-rules.json'), 'utf8'));
    assert.equal(saved.rules.length, 9);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('privilege runner feeds deny candidates through the existing ZTNA gate and leaves normal events allowed', async () => {
  const { runXdr, evaluatePrivilegeGate } = await import('../scripts/xdr-run.mjs');
  const { fixtureRequests } = await import('../scripts/fixture-7.mjs');
  const tempRoot = await mkdtemp(join(tmpdir(), 'xdr-privilege-run-'));
  try {
    await mkdir(join(tempRoot, 'xdr', 'fixtures'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'privilege'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'brute-force'), { recursive: true });
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(tempRoot, 'scripts'), { recursive: true });
    await cp(fixtureUrl, join(tempRoot, 'xdr', 'fixtures', 'privilege.json'));
    await cp(join(root, 'xdr', 'brute-force', 'deny-rules.mjs'), join(tempRoot, 'xdr', 'brute-force', 'deny-rules.mjs'));
    for (const name of ['decide.mjs', 'respond.mjs']) {
      await cp(join(root, 'xdr', 'privilege', name), join(tempRoot, 'xdr', 'privilege', name));
    }
    for (const name of ['decider.mjs', 'resource-zones.mjs', 'decider-with-xdr.mjs']) {
      await cp(join(root, 'src', name), join(tempRoot, 'src', name));
    }
    await cp(join(root, 'scripts', 'fixture-7.mjs'), join(tempRoot, 'scripts', 'fixture-7.mjs'));

    const result = await runXdr({ root: tempRoot, moduleKey: 'privilege' });
    assert.deepEqual(result.counts, { block: 9, alert: 8, record: 9 });
    const gate = await evaluatePrivilegeGate({ root: tempRoot, now: new Date() });
    assert.deepEqual(gate, { deny: 9, continue: 17, normalDenied: 0 });

    const ruleSet = JSON.parse(await readFile(join(tempRoot, 'xdr', 'privilege', 'deny-rules.json'), 'utf8'));
    const normal = await import('../src/decider-with-xdr.mjs');
    const passed = await normal.decideWithXdr(fixtureRequests().normal, {
      sourceAddress: '192.0.2.76', denyRules: ruleSet.rules, now: new Date(),
    });
    assert.equal(passed.gate.action, 'continue');
    assert.equal(passed.policyDecision.decision, 'allow');
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
