import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readAlert, readAlerts } from '../xdr/persistence/read-alerts.mjs';
import { decide } from '../xdr/persistence/decide.mjs';
import { createDenyRules, writeResponseArtifacts } from '../xdr/persistence/respond.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureUrl = new URL('../xdr/fixtures/persistence.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('persistence reader extracts five allowed fields for every alert and redacts secret-like values', async () => {
  const fixture = await loadFixture();
  const rows = readAlerts(fixture);
  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 24);
  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.deepEqual(rows[0], {
    timestamp: fixture.alerts[0].timestamp,
    sourceAddress: fixture.alerts[0].data.srcip,
    account: fixture.alerts[0].data.srcuser,
    ruleLevel: fixture.alerts[0].rule.level,
    description: fixture.alerts[0].rule.description,
  });

  const row = readAlert({
    timestamp: '2026-10-07T00:00:00.000Z',
    rule: { level: 8, description: 'token=reader-secret-sentinel' },
    data: { srcip: '192.0.2.9', srcuser: 'learner@example.invalid', path: 'private-path-sentinel' },
    raw: 'reader-secret-sentinel',
  });
  assert.deepEqual(Object.keys(row), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.doesNotMatch(JSON.stringify(row), /reader-secret-sentinel|private-path-sentinel|learner@example\.invalid/u);
  assert.throws(() => readAlerts({ schema: 'wrong', moduleKey: 'persistence', alerts: [] }), /invalid_xdr_fixture/u);
});

test('persistence patterns document T1543 service/startup and T1053 scheduled-task signals with evidence', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/persistence/patterns.json', import.meta.url), 'utf8'));
  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.patterns.length, 3);
  const conditionText = patterns.patterns.map((item) => item.condition).join('\n');
  assert.match(conditionText, /서명 없는 새 서비스|unsigned.*service/iu);
  assert.match(conditionText, /예약 작업|scheduled task/iu);
  assert.match(conditionText, /시작 폴더|startup folder/iu);
  for (const pattern of patterns.patterns) {
    assert.ok(pattern.name);
    assert.ok(pattern.condition);
    assert.ok(pattern.evidence);
    assert.match(pattern.evidence, /T1543|T1053/u);
    assert.match(pattern.source, /attack\.mitre\.org\/techniques\/T(?:1543|1053)/u);
  }
});

test('standalone persistence decide separates clear attacks, uncertain changes, and normal events', async () => {
  const source = await readFile(new URL('../xdr/persistence/decide.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|['"]|[\w*{])|\bfrom\s*['"]|node:|\brequire\s*\(|\bfetch\s*\(|readFile|writeFile/iu);
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const counts = Object.fromEntries(['block', 'alert', 'record'].map((action) => [
    action,
    decisions.filter((decision) => decision.action === action).length,
  ]));

  assert.deepEqual(counts, { block: 8, alert: 8, record: 8 });
  assert.ok(decisions.slice(0, 8).every((decision) => decision.action === 'block' && decision.confidence >= 0.85));
  assert.ok(decisions.slice(8, 16).every((decision) => decision.action === 'alert' && decision.confidence >= 0.5));
  assert.ok(decisions.slice(16).every((decision) => decision.action === 'record' && decision.confidence < 0.5));
  assert.ok(decisions.every((decision) => ['block', 'alert', 'record'].includes(decision.action)
    && Number.isFinite(decision.confidence) && decision.confidence >= 0 && decision.confidence <= 1
    && typeof decision.reason === 'string' && !/[\r\n]/u.test(decision.reason)));
  const patternNames = JSON.parse(await readFile(new URL('../xdr/persistence/patterns.json', import.meta.url), 'utf8'))
    .patterns.map((pattern) => pattern.name);
  assert.ok(decisions.slice(0, 16).every((decision) => patternNames.some((name) => decision.reason.startsWith(`${name}:`))));
});

test('clear-looking persistence alert without a valid source address is alert-only', () => {
  const fixtureAttack = {
    rule: { level: 12, mitre: ['T1543'], description: '서명 없는 새 서비스가 임시 폴더에서 실행됩니다.' },
    data: { srcip: 'not-an-ip', path: 'C:\\Temp\\service.exe' },
  };
  assert.equal(decide(fixtureAttack).action, 'alert');
  assert.ok(decide(fixtureAttack).confidence < 0.85);
});

test('persistence deny rules include expiry and evidence ids only for clear block candidates', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });
  assert.equal(rules.length, 8);
  assert.ok(rules.every((rule) => rule.action === 'deny'));
  assert.ok(rules.every((rule) => rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  assert.deepEqual(rules.map((rule) => rule.evidenceAlertId), fixture.alerts.slice(0, 8).map((alert) => alert.id));
});

test('persistence responder writes safe deduplicated block/alert metadata', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  decisions[8] = { ...decisions[8], reason: `${decisions[8].reason} private-reason-sentinel` };
  const tempRoot = await mkdtemp(join(tmpdir(), 'persistence-respond-'));
  try {
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    const logPath = join(tempRoot, 'xdr', 'alerts.log');
    const firstLog = await readFile(logPath, 'utf8');
    assert.equal(firstLog.trim().split(/\r?\n/u).length, 16);
    assert.doesNotMatch(firstLog, /user0[1-7]|203\.0\.113|198\.51\.100|C:\\|private-reason-sentinel|임시 폴더/u);
    assert.ok(firstLog.trim().split(/\r?\n/u).every((line) => JSON.parse(line).moduleKey === 'persistence'));
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    assert.equal(await readFile(logPath, 'utf8'), firstLog);
    const saved = JSON.parse(await readFile(join(tempRoot, 'xdr', 'persistence', 'deny-rules.json'), 'utf8'));
    assert.equal(saved.rules.length, 8);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('persistence runner generates results, response artifacts, and gates only clear attacks', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'persistence-run-'));
  try {
    await mkdir(join(tempRoot, 'scripts'), { recursive: true });
    await mkdir(join(tempRoot, 'src'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'fixtures'), { recursive: true });
    await mkdir(join(tempRoot, 'xdr', 'brute-force'), { recursive: true });
    await cp(join(root, 'scripts', 'xdr-run.mjs'), join(tempRoot, 'scripts', 'xdr-run.mjs'));
    await cp(join(root, 'scripts', 'fixture-7.mjs'), join(tempRoot, 'scripts', 'fixture-7.mjs'));
    await cp(join(root, 'src', 'decider.mjs'), join(tempRoot, 'src', 'decider.mjs'));
    await cp(join(root, 'src', 'resource-zones.mjs'), join(tempRoot, 'src', 'resource-zones.mjs'));
    await cp(join(root, 'src', 'decider-with-xdr.mjs'), join(tempRoot, 'src', 'decider-with-xdr.mjs'));
    await cp(join(root, 'xdr', 'brute-force', 'deny-rules.mjs'), join(tempRoot, 'xdr', 'brute-force', 'deny-rules.mjs'));
    await cp(join(root, 'xdr', 'fixtures', 'persistence.json'), join(tempRoot, 'xdr', 'fixtures', 'persistence.json'));
    await cp(join(root, 'xdr', 'persistence'), join(tempRoot, 'xdr', 'persistence'), { recursive: true });

    const child = spawn(process.execPath, ['scripts/xdr-run.mjs', 'persistence'], { cwd: tempRoot, windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    const code = await new Promise((resolve, reject) => {
      child.on('error', reject);
      child.on('exit', resolve);
    });

    assert.equal(code, 0, stderr);
    assert.match(stdout, /block 8 · alert 8 · record 8 · XDR gate deny 8 · continue 16 · 정상 XDR 차단 0건/u);
    const result = JSON.parse(await readFile(join(tempRoot, 'xdr', 'persistence', 'result.json'), 'utf8'));
    assert.deepEqual(result.counts, { block: 8, alert: 8, record: 8 });
    const rules = JSON.parse(await readFile(join(tempRoot, 'xdr', 'persistence', 'deny-rules.json'), 'utf8'));
    assert.equal(rules.rules.length, 8);
    assert.equal((await readFile(join(tempRoot, 'xdr', 'alerts.log'), 'utf8')).trim().split(/\r?\n/u).length, 16);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
