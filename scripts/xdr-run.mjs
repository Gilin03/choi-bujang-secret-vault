import { randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MODULE_KEYS = ['brute-force', 'web-injection', 'known-cve', 'persistence', 'privilege', 'exfiltration'];
const ACTIONS = new Set(['block', 'alert', 'record']);
const ALERTS_LOG = join('xdr', 'alerts.log');

export function isDecision(value) {
  return Boolean(value)
    && typeof value === 'object'
    && !Array.isArray(value)
    && ACTIONS.has(value.action)
    && typeof value.confidence === 'number'
    && Number.isFinite(value.confidence)
    && value.confidence >= 0
    && value.confidence <= 1
    && typeof value.reason === 'string';
}

export async function runXdr({ root, moduleKey, writeError = (line) => console.error(line) }) {
  if (!MODULE_KEYS.includes(moduleKey)) {
    throw new Error('moduleKey 가 없습니다. brute-force, web-injection, known-cve, persistence, privilege, exfiltration 중 하나를 넣습니다.');
  }
  const fixture = JSON.parse(await readFile(join(root, 'xdr', 'fixtures', `${moduleKey}.json`), 'utf8'));
  if (fixture?.schema !== 'aleph.xdr.fixture.v1' || fixture.moduleKey !== moduleKey || !Array.isArray(fixture.alerts)) {
    throw new Error('경보 묶음 형식이 아닙니다.');
  }
  const loaded = await import(pathToFileURL(join(root, 'xdr', moduleKey, 'decide.mjs')).href);
  if (typeof loaded.decide !== 'function') throw new Error('decide 함수를 내보내지 않았습니다.');

  const decisions = [];
  const counts = { block: 0, alert: 0, record: 0 };
  for (const alert of fixture.alerts) {
    const alertId = alert && typeof alert.id === 'string' ? alert.id : '';
    let action = 'record';
    let confidence = 0;
    let reason = '반환 형식이 아닙니다';
    try {
      const out = await loaded.decide(alert);
      if (isDecision(out)) {
        action = out.action;
        confidence = out.confidence;
        reason = out.reason;
      } else {
        writeError(`형식 오류: ${alertId || '(id 없음)'}`);
      }
    } catch {
      writeError(`형식 오류: ${alertId || '(id 없음)'}`);
    }
    decisions.push({ alertId, action, confidence, reason });
    counts[action] += 1;
  }

  const result = { schema: 'aleph.xdr.result.v1', moduleKey, decisions, counts };
  const outDir = join(root, 'xdr', moduleKey);
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, 'result.json'), `${JSON.stringify(result, null, 2)}\n`, 'utf8');

  if (moduleKey === 'brute-force') {
    const effects = await import(pathToFileURL(join(root, 'xdr', moduleKey, 'deny-rules.mjs')).href);
    const denyRules = effects.createDenyRules({ alerts: fixture.alerts, decisions });
    await writeFile(join(outDir, 'deny-rules.json'), `${JSON.stringify({
      schema: 'aleph.xdr.deny-rules.v1',
      generatedAt: new Date().toISOString(),
      rules: denyRules,
    }, null, 2)}\n`, 'utf8');
    await updateAlertLog(root, fixture.alerts, decisions);
  }
  return result;
}

export async function evaluateBruteForceGate({ root, now = new Date() }) {
  const fixture = JSON.parse(await readFile(join(root, 'xdr', 'fixtures', 'brute-force.json'), 'utf8'));
  const ruleSet = JSON.parse(await readFile(join(root, 'xdr', 'brute-force', 'deny-rules.json'), 'utf8'));
  if (ruleSet.schema !== 'aleph.xdr.deny-rules.v1' || !Array.isArray(ruleSet.rules)) {
    throw new Error('XDR 거부 규칙 형식이 아닙니다.');
  }
  const [{ decideWithXdr }, { fixtureRequests }] = await Promise.all([
    import(pathToFileURL(join(root, 'src', 'decider-with-xdr.mjs')).href),
    import(pathToFileURL(join(root, 'scripts', 'fixture-7.mjs')).href),
  ]);
  const baseRequest = fixtureRequests().normal;
  const counts = { deny: 0, continue: 0, normalDenied: 0 };

  for (const alert of fixture.alerts) {
    const result = await decideWithXdr({ ...baseRequest, requestId: randomUUID() }, {
      sourceAddress: alert?.data?.srcip,
      denyRules: ruleSet.rules,
      now,
    });
    counts[result.gate.action] += 1;
    const isNormal = !Array.isArray(alert?.rule?.mitre) || !alert.rule.mitre.includes('T1110');
    if (isNormal && result.gate.action === 'deny') counts.normalDenied += 1;
  }
  return counts;
}

async function updateAlertLog(root, alerts, decisions) {
  const logPath = join(root, ALERTS_LOG);
  let existing = '';
  try {
    existing = await readFile(logPath, 'utf8');
  } catch (error) {
    if (error?.code !== 'ENOENT') throw error;
  }
  const known = new Set();
  for (const line of existing.split(/\r?\n/u)) {
    try {
      const item = JSON.parse(line);
      if (typeof item.alertId === 'string' && ['block', 'alert'].includes(item.action)) {
        known.add(`${item.alertId}:${item.action}`);
      }
    } catch {
      // Preserve prior log lines without trusting or echoing them.
    }
  }
  const additions = [];
  for (let index = 0; index < alerts.length; index += 1) {
    const alert = alerts[index];
    const decision = decisions[index];
    const alertId = typeof alert?.id === 'string' && /^[A-Za-z0-9._-]{1,80}$/u.test(alert.id)
      ? alert.id
      : '';
    if (!alertId || !['block', 'alert'].includes(decision.action)) continue;
    const key = `${alertId}:${decision.action}`;
    if (known.has(key)) continue;
    const timestamp = typeof alert.timestamp === 'string' && Number.isFinite(Date.parse(alert.timestamp))
      ? new Date(alert.timestamp).toISOString()
      : '';
    additions.push(JSON.stringify({
      schema: 'aleph.xdr.alert.v1',
      timestamp,
      alertId,
      action: decision.action,
      confidence: decision.confidence,
    }));
    known.add(key);
  }
  const lines = [existing.trimEnd(), ...additions].filter(Boolean);
  await mkdir(join(root, 'xdr'), { recursive: true });
  await writeFile(logPath, lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
}

const isMain = process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url));
if (isMain) {
  const root = join(dirname(fileURLToPath(import.meta.url)), '..');
  try {
    await runXdr({ root, moduleKey: process.argv[2] });
    if (process.argv[2] === 'brute-force') {
      const result = JSON.parse(await readFile(join(root, 'xdr', 'brute-force', 'result.json'), 'utf8'));
      const gate = await evaluateBruteForceGate({ root });
      console.log(`block ${result.counts.block} · alert ${result.counts.alert} · record ${result.counts.record} · XDR gate deny ${gate.deny} · continue ${gate.continue} · 정상 XDR 차단 ${gate.normalDenied}건`);
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : '실행 오류');
    process.exitCode = 1;
  }
}
