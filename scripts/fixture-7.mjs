import { createHash, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Local practice requests use the engine's public input shape. The judge sends and times its own events.
const request = (signals, recentEvents) => ({
  schema: 'aleph.decision.v1', requestId: randomUUID(), classId: 'class_fixture',
  projectId: 'project_fixture', subjectId: 'learner_fixture', deviceId: 'a'.repeat(16),
  service: 'notes', method: 'GET', path: '/notes/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', route: 'GET /notes/:id',
  queryLength: 0, querySha256: createHash('sha256').update('').digest('hex'),
  at: new Date().toISOString(), policyRevision: 1, deviceRegistered: true,
  stepUp: { verified: false, authAgeSeconds: null }, recentEvents, signals,
});
export function fixtureRequests() {
  return {
    normal: request({ source: 'judge_fixture', region: 'local', network: 'usual', hour: 14 }, []),
    suspicious: request({ source: 'judge_fixture', region: 'foreign', network: 'unusual', hour: 3 },
      [{ kind: 'bulk_read', ageSeconds: 60, count: 20 }]),
  };
}
const check = (input, output) => output && typeof output === 'object'
  && Object.keys(output).sort().join(',') === 'decision,reasonCode,requestId,ruleIds,schema'
  && output.schema === 'aleph.decision.v1' && output.requestId === input.requestId
  && ['allow', 'deny', 'step_up'].includes(output.decision)
  && typeof output.reasonCode === 'string' && Array.isArray(output.ruleIds);

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const { normal, suspicious } = fixtureRequests();
    const { decide } = await import('../src/decider.mjs');
    if (typeof decide !== 'function') throw new Error('src/decider.mjs에서 decide 함수를 내보내야 합니다.');
    const ordinary = await decide(normal);
    const unusual = await decide(suspicious);
    const rechecked = {
      ...suspicious,
      requestId: randomUUID(),
      stepUp: { verified: true, authAgeSeconds: 60 },
    };
    const confirmed = await decide(rechecked);
    if (!check(normal, ordinary) || !check(suspicious, unusual) || !check(rechecked, confirmed)) {
      throw new Error('판정기 응답 형식이 맞지 않습니다.');
    }
    process.stdout.write(`정상 사건: ${ordinary.decision}\n복합 이상 사건: ${unusual.decision}\n재확인 후 재판정: ${confirmed.decision}\n`);
    if (ordinary.decision !== 'allow' || unusual.decision !== 'step_up'
        || confirmed.decision !== 'allow') {
      throw new Error('정상은 allow, 복합 이상은 step_up, 엔진 확인 뒤 재판정은 allow여야 합니다.');
    }
  } catch (error) {
    process.stderr.write(`가상 사건 첫 오류: ${error.message}\n`);
    process.exitCode = 1;
  }
}
