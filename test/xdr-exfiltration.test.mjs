import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureUrl = new URL('../xdr/fixtures/exfiltration.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('exfiltration reader returns one redacted five-field row per alert', async () => {
  const { readAlert, readAlerts } = await import('../xdr/exfiltration/read-alerts.mjs');
  const fixture = await loadFixture();
  const rows = readAlerts(fixture);

  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 30);
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
    rule: { level: 5, description: 'token=exfil-secret-sentinel' },
    data: { srcip: '192.0.2.9', srcuser: 'learner@example.invalid', token: 'token-sentinel' },
    raw: 'exfil-secret-sentinel',
  });
  assert.doesNotMatch(JSON.stringify(redacted), /exfil-secret-sentinel|token-sentinel|learner@example\.invalid/u);
  assert.throws(() => readAlerts({ ...fixture, moduleKey: 'privilege' }), /invalid_xdr_fixture/u);
});

test('exfiltration patterns document only the requested T1041 and T1048 signals', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/exfiltration/patterns.json', import.meta.url), 'utf8'));
  const decisionSource = await readFile(new URL('../xdr/exfiltration/decide.mjs', import.meta.url), 'utf8');
  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.moduleKey, 'exfiltration');
  assert.equal(patterns.patterns.length, 2);
  assert.match(patterns.patterns.map(item => `${item.name} ${item.condition}`).join('\n'), /처음 보는 목적지.*대용량/u);
  assert.match(patterns.patterns.map(item => `${item.name} ${item.condition}`).join('\n'), /업무 시간 밖.*압축/u);
  for (const pattern of patterns.patterns) {
    assert.ok(pattern.name && pattern.condition && pattern.evidence);
    assert.match(pattern.evidence, /T1041|T1048/u);
    assert.match(pattern.source, /^https:\/\/attack\.mitre\.org\/techniques\/T10(?:41|48)\/$/u);
    for (const field of ['id', 'name', 'condition', 'evidence', 'source']) {
      assert.ok(decisionSource.includes(`${field}: '${pattern[field]}'`), `decide.mjs must contain ${field} from ${pattern.id}`);
    }
  }
});

test('standalone exfiltration decision separates clear, ambiguous, and normal fixture alerts', async () => {
  const source = await readFile(new URL('../xdr/exfiltration/decide.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|['"]|[\w*{])|\bfrom\s*['"]|node:|\brequire\s*\(|\bfetch\s*\(|readFile|writeFile/iu);
  const { decide } = await import('../xdr/exfiltration/decide.mjs');
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const actions = Object.fromEntries(['block', 'alert', 'record'].map(action => [
    action,
    decisions.flatMap((decision, index) => decision.action === action ? [fixture.alerts[index].id] : []),
  ]));

  assert.deepEqual(actions, {
    block: ['ex-01', 'ex-02', 'ex-03', 'ex-04', 'ex-05', 'ex-06', 'ex-07', 'ex-08', 'ex-09', 'ex-10'],
    alert: ['ex-11', 'ex-12', 'ex-14', 'ex-15', 'ex-16', 'ex-17', 'ex-19', 'ex-20'],
    record: ['ex-13', 'ex-18', 'ex-21', 'ex-22', 'ex-23', 'ex-24', 'ex-25', 'ex-26', 'ex-27', 'ex-28', 'ex-29', 'ex-30'],
  });
  assert.match(decisions[0].reason, /^처음 보는 목적지의 대용량 전송:/u);
  assert.match(decisions[1].reason, /^업무 시간 밖 압축 파일 반출:/u);
  assert.ok(decisions.every(decision => Object.keys(decision).sort().join(',') === 'action,confidence,reason'));
  assert.ok(decisions.filter(decision => decision.action === 'block').every(decision => decision.confidence >= 0.85));
  assert.ok(decisions.filter(decision => decision.action === 'alert').every(decision => decision.confidence >= 0.5 && decision.confidence < 0.85));
});

test('exfiltration responder writes only validated expiring deny rules and safe alert metadata', async () => {
  const { decide } = await import('../xdr/exfiltration/decide.mjs');
  const { createDenyRules, writeResponseArtifacts } = await import('../xdr/exfiltration/respond.mjs');
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });

  assert.equal(rules.length, 10);
  assert.deepEqual(rules.map(rule => rule.evidenceAlertId), fixture.alerts.slice(0, 10).map(alert => alert.id));
  assert.deepEqual(rules.map(rule => rule.destinationAddress), fixture.alerts.slice(0, 10).map(alert => alert.data.dstip));
  assert.ok(rules.every(rule => rule.action === 'deny' && rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  const forged = decisions.slice();
  forged[20] = { action: 'block', confidence: 0.99, reason: '처음 보는 목적지의 대용량 전송: forged' };
  assert.equal(createDenyRules({ alerts: fixture.alerts, decisions: forged, now }).length, 10);

  const tempRoot = await mkdtemp(join(tmpdir(), 'xdr-exfiltration-respond-'));
  try {
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now });
    const logPath = join(tempRoot, 'xdr', 'alerts.log');
    const firstLog = await readFile(logPath, 'utf8');
    assert.equal(firstLog.trim().split(/\r?\n/u).length, 18);
    assert.doesNotMatch(firstLog, /"alertId":"ex-13"|"alertId":"ex-18"/u);
    assert.doesNotMatch(firstLog, /user01|203\.0\.113\.50|자료 200건/u);
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now });
    assert.equal(await readFile(logPath, 'utf8'), firstLog);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('exfiltration runner checks the existing ZTNA gate without denying normal alerts', async () => {
  const { runXdr, evaluateExfiltrationGate } = await import('../scripts/xdr-run.mjs');
  const tempRoot = await mkdtemp(join(tmpdir(), 'xdr-exfiltration-run-'));
  try {
    await mkdir(join(tempRoot, 'xdr', 'fixtures'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'exfiltration'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'brute-force'), { recursive: true });
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(tempRoot, 'scripts'), { recursive: true });
    await cp(fixtureUrl, join(tempRoot, 'xdr', 'fixtures', 'exfiltration.json'));
    await cp(join(root, 'xdr', 'brute-force', 'deny-rules.mjs'), join(tempRoot, 'xdr', 'brute-force', 'deny-rules.mjs'));
    for (const name of ['decide.mjs', 'respond.mjs']) {
      await cp(join(root, 'xdr', 'exfiltration', name), join(tempRoot, 'xdr', 'exfiltration', name));
    }
    for (const name of ['decider.mjs', 'resource-zones.mjs', 'decider-with-xdr.mjs']) {
      await cp(join(root, 'src', name), join(tempRoot, 'src', name));
    }
    await cp(join(root, 'scripts', 'fixture-7.mjs'), join(tempRoot, 'scripts', 'fixture-7.mjs'));

    const result = await runXdr({ root: tempRoot, moduleKey: 'exfiltration' });
    assert.deepEqual(result.counts, { block: 10, alert: 8, record: 12 });
    const gate = await evaluateExfiltrationGate({ root: tempRoot, now: new Date() });
    assert.deepEqual(gate, { deny: 10, continue: 20, normalDenied: 0 });
    const saved = JSON.parse(await readFile(join(tempRoot, 'xdr', 'exfiltration', 'deny-rules.json'), 'utf8'));
    assert.equal(saved.rules.length, 10);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
