import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { createSessionApprovalApiHandler } from '../api/session-approval/[...path].mjs';
import { createSessionApprovalHandlers } from '../src/session-approval.mjs';

const env = { SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEY: 'server-only' };
const userA = '11111111-1111-4111-8111-111111111111';
const userB = '44444444-4444-4444-8444-444444444444';
const sessionA = '22222222-2222-4222-8222-222222222222';
const sessionA2 = '33333333-3333-4333-8333-333333333333';

function makeDatabase(seed = []) {
  const rows = seed.map(row => ({ ...row }));
  const calls = [];
  const client = {
    from(table) {
      assert.equal(table, 'vault_session_approvals');
      return {
        select() {
          const filters = [];
          const query = {
            eq(column, value) { filters.push([column, value]); return query; },
            async maybeSingle() {
              calls.push({ action: 'select', filters: [...filters] });
              return { data: rows.find(row => filters.every(([key, value]) => row[key] === value)) ?? null,
                error: null };
            },
          };
          return query;
        },
        update(values) {
          const filters = [];
          const query = {
            eq(column, value) { filters.push([column, value]); return query; },
            select() {
              return {
                async maybeSingle() {
                  calls.push({ action: 'update', values: { ...values }, filters: [...filters] });
                  const row = rows.find(row => filters.every(([key, value]) => row[key] === value));
                  if (!row) return { data: null, error: null };
                  Object.assign(row, values);
                  return { data: row, error: null };
                },
              };
            },
          };
          return query;
        },
        insert(values) {
          return {
            select() {
              return {
                async maybeSingle() {
                  calls.push({ action: 'insert', values: { ...values } });
                  if (rows.some(row => row.session_id === values.session_id)) {
                    return { data: null, error: { code: '23505' } };
                  }
                  const row = { ...values, created_at: '2026-10-14T00:00:00.000Z' };
                  rows.push(row);
                  return { data: row, error: null };
                },
              };
            },
          };
        },
      };
    },
  };
  return { client, rows, calls };
}

function handlersFor({ principal, database }) {
  return createSessionApprovalHandlers({
    env,
    createClient: () => database.client,
    verifyLogin: async () => principal,
  });
}

const request = (path, method = 'GET', body, authorization = 'Bearer test-session') => new Request(
  `https://vault.example${path}`,
  { method, headers: { Authorization: authorization, ...(body ? { 'Content-Type': 'application/json' } : {}) },
    ...(body ? { body: JSON.stringify(body) } : {}) },
);

test('approval status and protected materials reject a missing or malformed verified session before DB access', async t => {
  for (const sessionId of [undefined, 'bad-session-id']) {
    await t.test(String(sessionId), async () => {
      const database = makeDatabase();
      const handlers = handlersFor({ principal: { kind: 'student', userId: userA, sessionId }, database });
      const status = await handlers.status.fetch(request('/api/session-approval/status'));
      let protectedCalls = 0;
      const protectedHandler = handlers.protect({ fetch: async () => {
        protectedCalls += 1;
        return Response.json({ notes: [] });
      } });
      const notes = await protectedHandler.fetch(request('/api/notes'));

      assert.ok([401, 403].includes(status.status));
      assert.ok([401, 403].includes(notes.status));
      assert.equal(database.calls.length, 0);
      assert.equal(protectedCalls, 0);
    });
  }
});

test('approval request records approved only for the verified session and ignores client claims', async () => {
  const database = makeDatabase();
  const principal = { kind: 'student', userId: userA, sessionId: sessionA };
  let verificationCount = 0;
  const handlers = createSessionApprovalHandlers({
    env,
    createClient: () => database.client,
    verifyLogin: async () => { verificationCount += 1; return principal; },
  });

  const response = await handlers.request.fetch(request('/api/session-approval/request', 'POST', {
    session_id: sessionA2,
    owner_id: userB,
    status: 'approved',
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'approved' });
  assert.equal(verificationCount, 1);
  assert.equal(database.rows.length, 1);
  assert.equal(database.rows[0].session_id, sessionA);
  assert.equal(database.rows[0].owner_id, userA);
  assert.equal(database.rows[0].status, 'approved');
  assert.equal(typeof database.rows[0].approved_at, 'string');
  const insert = database.calls.find(call => call.action === 'insert');
  assert.equal(insert.values.status, 'approved');
  assert.equal(insert.values.session_id, sessionA);
  assert.equal(typeof insert.values.approved_at, 'string');
  assert.equal(database.calls.some(call => call.action === 'update'), false);
});

test('a previously pending session is approved by the server for that exact session', async () => {
  const database = makeDatabase([{ session_id: sessionA, owner_id: userA, status: 'pending' }]);
  let verificationCount = 0;
  const handlers = createSessionApprovalHandlers({
    env,
    createClient: () => database.client,
    verifyLogin: async () => { verificationCount += 1; return { kind: 'student', userId: userA, sessionId: sessionA }; },
  });

  const response = await handlers.request.fetch(request('/api/session-approval/request', 'POST'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'approved' });
  assert.equal(verificationCount, 1);
  assert.equal(database.calls.some(call => call.action === 'insert'), false);
  assert.equal(database.rows[0].status, 'approved');
  const update = database.calls.find(call => call.action === 'update');
  assert.deepEqual(update.filters, [
    ['session_id', sessionA], ['owner_id', userA], ['status', 'pending'],
  ]);
  assert.equal(update.values.status, 'approved');
});

test('new session and other account never inherit another session approval', async () => {
  const database = makeDatabase([{ session_id: sessionA, owner_id: userA, status: 'approved' }]);
  const handlers = handlersFor({ principal: { kind: 'student', userId: userA, sessionId: sessionA2 }, database });

  const response = await handlers.status.fetch(request('/api/session-approval/status'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'not_registered' });
  assert.deepEqual(database.calls[0].filters, [
    ['session_id', sessionA2], ['owner_id', userA],
  ]);
});

test('pending session is denied and only its approved session_id reaches protected material', async t => {
  const database = makeDatabase([
    { session_id: sessionA, owner_id: userA, status: 'pending' },
    { session_id: sessionA2, owner_id: userA, status: 'approved' },
  ]);
  let principal = { kind: 'student', userId: userA, sessionId: sessionA };
  const handlers = createSessionApprovalHandlers({
    env,
    createClient: () => database.client,
    verifyLogin: async () => principal,
  });
  let protectedCalls = 0;
  const protectedHandler = handlers.protect({ fetch: async () => {
    protectedCalls += 1;
    return Response.json({ notes: ['existing vault'] });
  } });

  const pending = await protectedHandler.fetch(request('/api/my/notes'));
  assert.equal(pending.status, 403);
  assert.equal(protectedCalls, 0);

  principal = { kind: 'student', userId: userA, sessionId: sessionA2 };
  const approved = await protectedHandler.fetch(request('/api/my/notes'));
  assert.equal(approved.status, 200);
  assert.deepEqual(await approved.json(), { notes: ['existing vault'] });
  assert.equal(protectedCalls, 1);

  await t.test('wrong owner cannot reuse approved session id', async () => {
    principal = { kind: 'student', userId: userB, sessionId: sessionA2 };
    const denied = await protectedHandler.fetch(request('/api/my/notes'));
    assert.equal(denied.status, 403);
    assert.equal(protectedCalls, 1);
  });
});

test('approval request cannot downgrade an already approved session', async () => {
  const database = makeDatabase([{ session_id: sessionA, owner_id: userA, status: 'approved' }]);
  const handlers = handlersFor({ principal: { kind: 'student', userId: userA, sessionId: sessionA }, database });

  const response = await handlers.request.fetch(request('/api/session-approval/request', 'POST', { status: 'pending' }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { status: 'approved' });
  assert.equal(database.calls.some(call => call.action === 'insert'), false);
  assert.equal(database.rows[0].status, 'approved');
});

test('approval API exposes status and request only; clients cannot set approval state', async () => {
  const database = makeDatabase();
  const api = createSessionApprovalApiHandler({
    env,
    createClient: () => database.client,
    verifyLogin: async () => ({ kind: 'student', userId: userA, sessionId: sessionA }),
  });

  const status = await api.fetch(request('/api/session-approval/status'));
  const requestApproval = await api.fetch(request('/api/session-approval/request', 'POST'));
  const statusAfterRequest = await api.fetch(request('/api/session-approval/status'));
  const forbiddenApprove = await api.fetch(request('/api/session-approval/approve', 'POST', {
    session_id: sessionA,
    status: 'approved',
  }));

  assert.deepEqual(await status.json(), { status: 'not_registered' });
  assert.deepEqual(await requestApproval.json(), { status: 'approved' });
  assert.deepEqual(await statusAfterRequest.json(), { status: 'approved' });
  assert.equal(requestApproval.status, 200);
  assert.equal(forbiddenApprove.status, 404);
  assert.equal(database.rows[0].status, 'approved');
});

test('every protected notes and announcement entrypoint checks session approval first', () => {
  const paths = [
    '../api/notes.mjs',
    '../api/my/notes.mjs',
    '../api/notes/[id].mjs',
    '../api/notes/[id]/restore.mjs',
    '../api/announcements.mjs',
    '../api/announcements/[id].mjs',
  ];
  for (const path of paths) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.match(source, /createSessionProtectedHandler/u, path);
  }
});

test('session approval schema isolates server access and contains no operator approval SQL', () => {
  const sql = readFileSync(new URL('../supabase/stage11-session-approval.sql', import.meta.url), 'utf8');
  const readme = readFileSync(new URL('../README.md', import.meta.url), 'utf8');

  assert.match(sql, /create table if not exists public\.vault_session_approvals/u);
  assert.match(sql, /session_id uuid primary key/u);
  assert.match(sql, /status in \('pending', 'approved'\)/u);
  assert.match(sql, /enable row level security/u);
  assert.match(sql, /revoke all .* from public, anon, authenticated/u);
  assert.match(sql, /grant select, insert, update, delete .* to service_role/u);
  assert.doesNotMatch(sql, /server-side operator flow|update public\.vault_session_approvals/iu);
  assert.doesNotMatch(readme, /update public\.vault_session_approvals|서버 운영자가 해당 대기 행을 승인/iu);
  assert.doesNotMatch(sql, /deviceRegistered|webauthn|passkey/iu);
});
