import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationsHandler } from '../src/operations-api.mjs';
import { recordOperationResult, operationRoute } from '../src/operations-log.mjs';
import { createSessionApprovalHandlers } from '../src/session-approval.mjs';
import { createSessionApprovalApiHandler } from '../api/session-approval/[...path].mjs';
import { runOperationChecks, CHECK_PLAN } from '../public/operation-checks.js';

const user = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const other = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const session = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const principal = { kind: 'student', userId: user, sessionId: session };
const env = { SUPABASE_URL: 'https://db.example', SUPABASE_SECRET_KEY: 'test-server-only', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) };
const verified = async () => principal;

function dbFixture(tables, failure) {
  const inserted = [];
  return { inserted, client: {
    from(table) {
      const filters = [];
      let limit = Infinity;
      const query = {
        select() { return query; },
        eq(key, value) { filters.push([key, value]); return query; },
        order() { return query; },
        limit(value) { limit = value; return query; },
        insert(value) { inserted.push({ table, value }); return Promise.resolve({ error: failure ? { message: 'secret failure' } : null }); },
        maybeSingle() { return query.then(result => ({ ...result, data: result.data?.[0] ?? null })); },
        then(resolve, reject) {
          const data = (tables[table] ?? []).filter(row => filters.every(([k, v]) => row[k] === v)).slice(0, limit);
          return Promise.resolve({ data, error: failure ? { message: 'private upstream error' } : null }).then(resolve, reject);
        },
      };
      return query;
    },
  } };
}
const req = () => new Request('https://vault.example/api/session-approval/operations');

test('operations returns only owner metadata and counts exactly the returned server records', async () => {
  const fixture = dbFixture({
    vault_operation_events: [
      { owner_id: user, request_id: '11111111-1111-4111-8111-111111111111', checked_at: '2026-10-14T01:00:00Z', method: 'GET', route: '/api/my/notes', status: 200, commit_sha: 'a'.repeat(40), content: 'must not return', session_id: session },
      { owner_id: user, request_id: '22222222-2222-4222-8222-222222222222', checked_at: '2026-10-14T01:01:00Z', method: 'GET', route: '/api/notes/:id', status: 404, commit_sha: 'a'.repeat(40) },
      { owner_id: other, request_id: '33333333-3333-4333-8333-333333333333', status: 200 },
    ],
    vault_note_backups: [
      { owner_id: user, note_id: session, content_sha256: 'd'.repeat(64), captured_at: '2026-10-14T00:00:00Z', title: 'private title', content: 'private body' },
      { owner_id: other, note_id: other, captured_at: '2026-10-13T00:00:00Z' },
    ],
  });
  const response = await createOperationsHandler({ env, verifyLogin: verified, createClient: () => fixture.client }).fetch(req());
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  const data = await response.json();
  assert.deepEqual(data.api.summary, { total: 2, allowed: 1, rejected: 1, errors: 0 });
  assert.equal(data.api.records.length, 2);
  assert.equal(data.recovery.backups.length, 1);
  assert.equal(data.recovery.executedRestores, 0);
  assert.deepEqual(data.finalAssault, { total: 41, executed: 0, unexecuted: 41, passed: null, source: 'not_connected' });
  assert.equal(data.engine.detection.status, 'unexecuted');
  assert.equal(data.engine.revocation.status, 'unexecuted');
  assert.equal(data.engine.decisions.status, 'unexecuted');
  assert.deepEqual(data.rules, ['device_registered', 'step_up_required', 'resource_zone']);
  const text = JSON.stringify(data);
  for (const privateValue of [user, other, session, 'private title', 'private body', 'must not return']) assert.ok(!text.includes(privateValue));
});

test('DB failure does not fabricate zero successes or disclose errors', async () => {
  const fixture = dbFixture({}, true);
  const response = await createOperationsHandler({ env, verifyLogin: verified, createClient: () => fixture.client }).fetch(req());
  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: 'Operations evidence unavailable' });
});

test('missing verified session refuses operations without querying the DB', async () => {
  let called = false;
  const response = await createOperationsHandler({ env, verifyLogin: async () => ({ kind: 'student', userId: user }), createClient: () => { called = true; } }).fetch(req());
  assert.equal(response.status, 403);
  assert.equal(called, false);
});

test('server recording excludes request bodies, headers, query strings and identifiers from displayed paths', async () => {
  const fixture = dbFixture({});
  const requestId = '11111111-1111-4111-8111-111111111111';
  const route = operationRoute(`https://vault.example/api/notes/${session}?token=secret`);
  assert.equal(route, '/api/notes/:id');
  const result = await recordOperationResult({ principal, requestId, checkedAt: '2026-10-14T01:00:00Z', method: 'GET', route, status: 404, body: 'private', authorization: 'secret' }, { env, createClient: () => fixture.client });
  assert.equal(result, true);
  assert.deepEqual(fixture.inserted[0].value, { owner_id: user, request_id: requestId, checked_at: '2026-10-14T01:00:00Z', method: 'GET', route: '/api/notes/:id', status: 404, commit_sha: 'a'.repeat(40) });
  assert.equal(await recordOperationResult({ principal: null, requestId, route, status: 401 }, { env, createClient: () => fixture.client }), false);
  assert.equal(fixture.inserted.length, 1);
});

test('unapproved sessions get correlated refusal without invoking the material handler', async () => {
  const fixture = dbFixture({});
  let event;
  let accessed = false;
  const handler = createSessionApprovalHandlers({ env, verifyLogin: verified, createClient: () => fixture.client, recordResult: async value => { event = value; return true; } }).protect({ fetch: async () => { accessed = true; return Response.json({ body: 'private' }); } });
  const response = await handler.fetch(new Request(`https://vault.example/api/notes/${session}?secret=hidden`));
  assert.equal(response.status, 403);
  assert.equal(accessed, false);
  assert.match(response.headers.get('x-request-id'), /^[a-f0-9-]{36}$/);
  assert.equal(response.headers.get('x-audit-recorded'), 'true');
  assert.equal(event.requestId, response.headers.get('x-request-id'));
  assert.equal(event.route, '/api/notes/:id');
  assert.equal(event.status, 403);
});

test('audit failure preserves protected API result and exposes recording unavailability', async () => {
  const fixture = dbFixture({ vault_session_approvals: [{ owner_id: user, session_id: session, status: 'approved' }] });
  const handler = createSessionApprovalHandlers({ env, verifyLogin: verified, createClient: () => fixture.client, recordResult: async () => { throw new Error('DB error'); } }).protect({ fetch: async () => Response.json({ id: 'test' }) });
  const response = await handler.fetch(new Request('https://vault.example/api/my/notes'));
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: 'test' });
  assert.equal(response.headers.get('x-audit-recorded'), 'false');
});

test('check runner measures real HTTP status and retains missing prerequisites and network failures', async () => {
  const plan = [
    { id: 'normal', stage: 2, kind: 'normal', method: 'GET', path: '/api/my/notes', authenticated: true, expectedStatus: 200 },
    { id: 'forbidden', stage: 3, kind: 'forbidden', method: 'GET', path: '/api/my/notes', expectedStatus: 401 },
    { id: 'engine', stage: 6, kind: 'normal', unavailable: 'engine_not_connected' },
    { id: 'offline', stage: 1, kind: 'normal', method: 'GET', path: '/', expectedStatus: 200 },
  ];
  const calls = [];
  const results = await runOperationChecks({ plan, token: 'test-memory-session', fetchImpl: async (path, options) => {
    calls.push({ path, options });
    if (path === '/') throw new Error('private raw network failure');
    const status = options.headers.get('authorization') ? 200 : 401;
    return new Response('do not read body', { status, headers: { 'x-request-id': '11111111-1111-4111-8111-111111111111', 'x-checked-at': '2026-10-14T01:00:00Z' } });
  } });
  assert.deepEqual(results.map(row => row.state), ['matched', 'matched', 'unexecuted', 'error']);
  assert.equal(results[0].actualStatus, 200);
  assert.equal(results[1].actualStatus, 401);
  assert.equal(results[2].requestId, null);
  assert.equal(results[3].actualStatus, null);
  assert.equal(calls[1].options.headers.has('authorization'), false);
  assert.equal(JSON.stringify(results).includes('private raw network failure'), false);
  assert.equal(JSON.stringify(results).includes('do not read body'), false);
  const unauthed = await runOperationChecks({ plan: [plan[0]], fetchImpl: () => assert.fail('must not call') });
  assert.equal(unauthed[0].state, 'unexecuted');
});

test('check plan covers stages 1 to 11 but does not invent judge attack names or execute authenticated mutations', () => {
  for (let stage = 1; stage <= 11; stage += 1) {
    assert.ok(CHECK_PLAN.some(row => row.stage === stage && row.kind === 'normal'));
    assert.ok(CHECK_PLAN.some(row => row.stage === stage && row.kind === 'forbidden'));
  }
  assert.ok(CHECK_PLAN.every(row => row.unavailable || row.method === 'GET' || row.authenticated !== true));
});

test('HTTP 200 with pending approval is not counted as approved-session success', async () => {
  const results = await runOperationChecks({ token: 'memory-only', plan: [{
    id: 'approved', stage: 11, kind: 'normal', method: 'GET', path: '/api/session-approval/status',
    expectedStatus: 200, authenticated: true, expectedJson: { status: 'approved' },
  }], fetchImpl: async () => Response.json({ status: 'pending', token: 'do not record' }) });
  assert.equal(results[0].state, 'mismatch');
  assert.equal(JSON.stringify(results).includes('do not record'), false);
});

test('deployed operations route gates unapproved and new sessions before returning evidence', async () => {
  const fixture = dbFixture({ vault_session_approvals: [{ owner_id: user, session_id: session, status: 'approved' }] });
  for (const sessionId of ['dddddddd-dddd-4ddd-8ddd-dddddddddddd', undefined]) {
    const api = createSessionApprovalApiHandler({ env, createClient: () => fixture.client,
      verifyLogin: async () => ({ kind: 'student', userId: user, sessionId }) });
    const response = await api.fetch(req());
    assert.equal(response.status, 403);
    assert.equal((await response.json()).api, undefined);
  }
  const api = createSessionApprovalApiHandler({ env, createClient: () => fixture.client, verifyLogin: verified });
  const allowed = await api.fetch(req());
  assert.equal(allowed.status, 200);
  assert.equal((await allowed.json()).schema, 'byteback.operations.v1');
  const write = await api.fetch(new Request(req().url, { method: 'PUT', body: JSON.stringify({ approved: true }) }));
  assert.equal(write.status, 404);
});

test('operations route accepts Vercel catch-all path metadata but rejects client queries', async () => {
  const fixture = dbFixture({
    vault_session_approvals: [{ owner_id: user, session_id: session, status: 'approved' }],
    vault_operation_events: [],
    vault_note_backups: [],
  });
  const api = createSessionApprovalApiHandler({ env, createClient: () => fixture.client, verifyLogin: verified });
  const response = await api.fetch(new Request(`${req().url}?path=operations`));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).api.summary, { total: 0, allowed: 0, rejected: 0, errors: 0 });

  const unexpected = await api.fetch(new Request(`${req().url}?path=operations&scope=all`));
  assert.equal(unexpected.status, 404);
  assert.deepEqual(await unexpected.json(), { error: 'Resource not found' });
});

test('response from another deployment is not attributed to the checked commit', async () => {
  const results = await runOperationChecks({ expectedCommit: 'a'.repeat(40), plan: [{
    id: 'normal', stage: 2, kind: 'normal', method: 'GET', path: '/api/my/notes', expectedStatus: 200,
  }], fetchImpl: async () => new Response(null, { status: 200, headers: { 'X-Deployment-Commit': 'b'.repeat(40) } }) });
  assert.equal(results[0].state, 'mismatch');
  assert.equal(results[0].commit, 'b'.repeat(40));
});
