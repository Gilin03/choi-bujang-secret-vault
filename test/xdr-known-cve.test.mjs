import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { cp, mkdtemp, readFile, rm, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';
import { readAlert, readAlerts } from '../xdr/known-cve/read-alerts.mjs';
import { decide } from '../xdr/known-cve/decide.mjs';
import { createDenyRules, writeResponseArtifacts } from '../xdr/known-cve/respond.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureUrl = new URL('../xdr/fixtures/known-cve.json', import.meta.url);

async function loadFixture() {
  return JSON.parse(await readFile(fixtureUrl, 'utf8'));
}

test('known-cve reader extracts only the five allowed fields from every alert', async () => {
  const fixture = await loadFixture();
  const rows = readAlerts(fixture);

  assert.equal(rows.length, fixture.alerts.length);
  assert.equal(rows.length, 24);
  assert.deepEqual(Object.keys(rows[0]), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.deepEqual(rows[0], {
    timestamp: fixture.alerts[0].timestamp,
    sourceAddress: fixture.alerts[0].data.srcip,
    account: '',
    ruleLevel: fixture.alerts[0].rule.level,
    description: fixture.alerts[0].rule.description,
  });
});

test('known-cve reader discards extra fields and redacts secret-like values', () => {
  const row = readAlert({
    timestamp: '2026-10-07T00:00:00.000Z',
    rule: { level: 8, description: 'token=reader-secret-sentinel' },
    data: { srcip: '192.0.2.9', srcuser: 'learner@example.invalid', useragent: 'private-key-sentinel' },
    raw_request: 'reader-secret-sentinel',
  });

  assert.deepEqual(Object.keys(row), ['timestamp', 'sourceAddress', 'account', 'ruleLevel', 'description']);
  assert.doesNotMatch(JSON.stringify(row), /reader-secret-sentinel|private-key-sentinel|learner@example\.invalid/);
});

test('known-cve patterns document JNDI, scanner traces, and T1190 review with evidence', async () => {
  const patterns = JSON.parse(await readFile(new URL('../xdr/known-cve/patterns.json', import.meta.url), 'utf8'));
  assert.equal(patterns.schema, 'aleph.xdr.patterns.v1');
  assert.equal(patterns.patterns.length, 3);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /JNDI|jndi/u);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /log4j-scan|Log4Shell|Nuclei/i);
  assert.match(patterns.patterns.map((item) => item.condition).join('\n'), /T1190/);
  for (const pattern of patterns.patterns) {
    assert.ok(pattern.name);
    assert.ok(pattern.condition);
    assert.ok(pattern.evidence);
    const sources = Array.isArray(pattern.source) ? pattern.source : [pattern.source];
    assert.ok(sources.some((source) => source.includes('nvd.nist.gov') || source.includes('attack.mitre.org')));
  }
});

test('known-cve decide is standalone and separates clear exploit attempts, uncertain probes, and normal events', async () => {
  const source = await readFile(new URL('../xdr/known-cve/decide.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /\bimport\s*(?:\(|['"]|[\w*{])|\bfrom\s*['"]|node:|\brequire\s*\(|\bfetch\s*\(|readFile|writeFile/iu);
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const counts = Object.fromEntries(['block', 'alert', 'record'].map((action) => [
    action,
    decisions.filter((decision) => decision.action === action).length,
  ]));

  assert.deepEqual(counts, { block: 8, alert: 8, record: 8 });
  assert.ok(decisions.slice(0, 8).every((decision) => decision.confidence >= 0.85));
  assert.ok(decisions.slice(8, 16).every((decision) => decision.action === 'alert'));
  assert.ok(decisions.slice(16).every((decision) => decision.action === 'record'));
  assert.ok(decisions.every((decision) => ['block', 'alert', 'record'].includes(decision.action)));
  assert.ok(decisions.every((decision) => Number.isFinite(decision.confidence)
    && decision.confidence >= 0 && decision.confidence <= 1
    && typeof decision.reason === 'string' && !/[\r\n]/u.test(decision.reason)));
  const patternNames = JSON.parse(await readFile(new URL('../xdr/known-cve/patterns.json', import.meta.url), 'utf8'))
    .patterns.map((pattern) => pattern.name);
  assert.ok(decisions.slice(0, 16).every((decision) => patternNames.some((name) => decision.reason.startsWith(`${name}:`))));
});

test('known-cve decide does not block a mention, a scanner trace alone, or an invalid source', () => {
  const base = {
    id: 'synthetic-jndi',
    rule: { level: 12, description: 'request matched', mitre: ['T1190'] },
    data: { srcip: '203.0.113.8', url: '/search?q=%24%7Bjndi%3Aldap%3A%2F%2Fexample.invalid%2Fx%7D' },
  };
  assert.equal(decide(base).action, 'block');
  assert.equal(decide({ ...base, rule: { ...base.rule, level: 6 } }).action, 'alert');
  assert.equal(decide({ ...base, data: { ...base.data, srcip: 'not-an-ip' } }).action, 'alert');
  assert.equal(decide({
    ...base,
    data: { srcip: '203.0.113.8', useragent: 'Nuclei Log4Shell template' },
  }).action, 'alert');
  assert.equal(decide({
    ...base,
    data: { srcip: '203.0.113.8', url: '/search?q=CVE-2021-44228' },
  }).action, 'alert');
  assert.equal(decide({
    ...base,
    rule: { level: 3, description: 'normal request', mitre: [] },
    data: { srcip: '203.0.113.8', url: '/health' },
  }).action, 'record');
});

test('known-cve deny rules require a clear block candidate and include expiry and evidence id', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  const now = new Date('2026-10-08T00:00:00.000Z');
  const rules = createDenyRules({ alerts: fixture.alerts, decisions, now });

  assert.equal(rules.length, 8);
  assert.ok(rules.every((rule) => rule.action === 'deny'));
  assert.ok(rules.every((rule) => rule.expiresAt === '2026-10-08T00:15:00.000Z'));
  assert.deepEqual(rules.map((rule) => rule.evidenceAlertId), fixture.alerts.slice(0, 8).map((alert) => alert.id));
});

test('known-cve responder writes deny rules and safe, deduplicated alert metadata', async () => {
  const fixture = await loadFixture();
  const decisions = fixture.alerts.map(decide);
  decisions[8] = { ...decisions[8], reason: `${decisions[8].reason} reader-secret-sentinel` };
  const tempRoot = await mkdtemp(join(tmpdir(), 'known-cve-respond-'));
  try {
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    const logPath = join(tempRoot, 'xdr', 'alerts.log');
    const firstLog = await readFile(logPath, 'utf8');
    assert.equal(firstLog.trim().split(/\r?\n/u).length, 16);
    assert.doesNotMatch(firstLog, /jndi|203\.0\.113|reader-secret|Nuclei|ldap/u);
    assert.ok(firstLog.trim().split(/\r?\n/u).every((line) => JSON.parse(line).moduleKey === 'known-cve'));
    await writeResponseArtifacts({ root: tempRoot, alerts: fixture.alerts, decisions, now: new Date('2026-10-08T00:00:00.000Z') });
    assert.equal(await readFile(logPath, 'utf8'), firstLog);
    const saved = JSON.parse(await readFile(join(tempRoot, 'xdr', 'known-cve', 'deny-rules.json'), 'utf8'));
    assert.equal(saved.rules.length, 8);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test('known-cve runner invokes decide and responder to produce result and response artifacts', async () => {
  const tempRoot = await mkdtemp(join(tmpdir(), 'known-cve-run-'));
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
    await cp(join(root, 'xdr', 'fixtures', 'known-cve.json'), join(tempRoot, 'xdr', 'fixtures', 'known-cve.json'));
    await cp(join(root, 'xdr', 'known-cve'), join(tempRoot, 'xdr', 'known-cve'), { recursive: true });

    const child = spawn(process.execPath, ['scripts/xdr-run.mjs', 'known-cve'], { cwd: tempRoot, windowsHide: true });
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
    const result = JSON.parse(await readFile(join(tempRoot, 'xdr', 'known-cve', 'result.json'), 'utf8'));
    assert.deepEqual(result.counts, { block: 8, alert: 8, record: 8 });
    const rules = JSON.parse(await readFile(join(tempRoot, 'xdr', 'known-cve', 'deny-rules.json'), 'utf8'));
    assert.equal(rules.rules.length, 8);
    assert.equal((await readFile(join(tempRoot, 'xdr', 'alerts.log'), 'utf8')).trim().split(/\r?\n/u).length, 16);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});
