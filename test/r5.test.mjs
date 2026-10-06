import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';
import { createNotesHandler } from '../src/notes-api.mjs';

const config = {
  step: 2,
  judgeIssuer: 'https://aleph-judge-production.up.railway.app/defense/judge',
  sampleMarker: 'SAMPLE_NOTE_1',
  publicAppUrl: 'https://student-defense.vercel.app',
};
const env = {
  VERCEL_GIT_PROVIDER: 'github',
  VERCEL_GIT_REPO_OWNER: 'Student-A',
  VERCEL_GIT_REPO_SLUG: 'aleph-defense',
  VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40),
  VERCEL_URL: 'student-defense-123.vercel.app',
};

test('build identity uses Vercel Git and deployment metadata', () => {
  assert.deepEqual(deploymentIdentity(env, config), {
    schema: 'aleph.defense.deployment.v1',
    step: 2,
    repoUrl: 'https://github.com/student-a/aleph-defense',
    commit: 'a'.repeat(40),
    publicAppUrl: 'https://student-defense-123.vercel.app',
    judgeIssuer: config.judgeIssuer,
    sampleMarker: config.sampleMarker,
  });
  assert.throws(() => deploymentIdentity({ ...env, VERCEL_GIT_PROVIDER: undefined }, config));
  assert.throws(() => deploymentIdentity({ ...env, VERCEL_GIT_COMMIT_SHA: 'short' }, config));
});

test('stage 3 attack checks verify anonymous API access is denied and static JSON is gone', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      requests.push({ url: requestUrl.toString(), init });
      if (requestUrl.pathname === '/api/notes') {
        return Response.json({ error: 'Authentication required' }, { status: 401 });
      }
      return new Response('', { status: 404 });
    };
    const results = await runAttackChecks({ ...config, step: 3 });
    assert.deepEqual(requests.map(({ url, init }) => ({
      url,
      method: init.method,
      redirect: init.redirect,
      authorization: init.headers?.authorization,
    })), [
      {
        url: 'https://student-defense.vercel.app/api/notes',
        method: 'GET',
        redirect: 'error',
        authorization: undefined,
      },
      {
        url: 'https://student-defense.vercel.app/data.json',
        method: 'GET',
        redirect: 'error',
        authorization: undefined,
      },
      {
        url: 'https://student-defense.vercel.app/api/notes',
        method: 'POST',
        redirect: 'error',
        authorization: undefined,
      },
    ]);
    assert.equal(results.length, 3);
    assert.equal(results[0].expected, '비로그인 GET /api/notes는 401로 거부됨');
    assert.equal(results[1].expected, '정적 /data.json에서 메모 본문을 찾을 수 없음');
    assert.equal(results[2].expected, '비로그인 POST /api/notes는 401로 거부됨');
    assert.match(results[0].observed, /HTTP 401.*인증 거부/u);
    assert.match(results[1].observed, /HTTP 404/u);
    assert.match(results[2].observed, /HTTP 401/u);
    assert.doesNotMatch(JSON.stringify(results), /fixture-only-title/u);

    globalThis.fetch = async () => new Response('<html>not the data</html>', { status: 200 });
    const [malformed] = await runAttackChecks({ ...config, step: 3 });
    assert.match(malformed.observed, /HTTP 200/u);
    assert.doesNotMatch(malformed.observed, /4/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notes API rejects anonymous list and write requests without accessing Supabase', async () => {
  const handler = createNotesHandler({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'test-only-placeholder' },
    verifyLogin: async () => null,
    createClient: () => { throw new Error('must not reach the database'); },
  });
  for (const request of [
    new Request('https://student-defense.vercel.app/api/notes'),
    new Request('https://student-defense.vercel.app/api/notes', { method: 'POST' }),
  ]) {
    const response = await handler.fetch(request);
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Authentication required' });
    assert.equal(response.headers.get('cache-control'), 'no-store');
  }
});
