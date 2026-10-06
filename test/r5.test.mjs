import assert from 'node:assert/strict';
import { test } from 'node:test';
import { deploymentIdentity } from '../scripts/deployment-identity.mjs';
import { runAttackChecks } from '../src/attack-check.mjs';
import { createNotesHandler } from '../api/notes.mjs';

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

test('stage 2 attack checks read the anonymous API and verify static JSON is gone', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  try {
    globalThis.fetch = async (url, init) => {
      const requestUrl = new URL(String(url));
      requests.push({ url: requestUrl.toString(), init });
      if (requestUrl.pathname === '/api/notes') {
        if (init.method === 'POST') return new Response('', { status: 405 });
        return Response.json({
          notes: Array.from({ length: 4 }, () => ({ title: 'fixture-only-title', content: '' })),
        }, { status: 200 });
      }
      return new Response('', { status: 404 });
    };
    const results = await runAttackChecks(config);
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
    assert.equal(results[0].expected, '비로그인 GET /api/notes에서 가상 메모 네 건을 읽을 수 있음');
    assert.equal(results[1].expected, '정적 /data.json에서 메모 본문을 찾을 수 없음');
    assert.equal(results[2].expected, '비로그인 POST /api/notes는 405로 거부됨');
    assert.match(results[0].observed, /HTTP 200.*4/u);
    assert.match(results[1].observed, /HTTP 404/u);
    assert.match(results[2].observed, /HTTP 405/u);
    assert.doesNotMatch(JSON.stringify(results), /fixture-only-title/u);

    globalThis.fetch = async () => new Response('<html>not the data</html>', { status: 200 });
    const [malformed] = await runAttackChecks(config);
    assert.match(malformed.observed, /HTTP 200/u);
    assert.doesNotMatch(malformed.observed, /4/u);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test('notes API returns only display fields without caching', async () => {
  const handler = createNotesHandler({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'test-only-placeholder' },
    createClient: () => ({
      from: () => ({
        select: () => ({
          order: async () => ({
            data: [{ id: 'row-id', sort_order: 1, owner_id: null, title: 'fixture-only-title', content: '' }],
            error: null,
          }),
        }),
      }),
    }),
  });
  const response = await handler.fetch(new Request('https://student-defense.vercel.app/api/notes'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), { notes: [{ title: 'fixture-only-title', content: '' }] });
});

test('notes API rejects non-GET requests before accessing Supabase', async () => {
  const handler = createNotesHandler({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'test-only-placeholder' },
    createClient: () => { throw new Error('must not reach the database'); },
  });
  const response = await handler.fetch(new Request('https://student-defense.vercel.app/api/notes', { method: 'POST' }));
  assert.equal(response.status, 405);
  assert.equal(response.headers.get('cache-control'), 'no-store');
});

test('notes API hides database failures and does not log them', async () => {
  const originalError = console.error;
  const logged = [];
  console.error = (...values) => logged.push(values);
  try {
    const handler = createNotesHandler({
      env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'test-only-placeholder' },
      createClient: () => ({
        from: () => ({ select: () => ({ order: async () => ({ data: null, error: { message: 'fixture database detail' } }) }) }),
      }),
    });
    const response = await handler.fetch(new Request('https://student-defense.vercel.app/api/notes'));
    assert.equal(response.status, 500);
    assert.deepEqual(await response.json(), { error: 'Unable to load notes' });
    assert.deepEqual(logged, []);
  } finally {
    console.error = originalError;
  }
});
