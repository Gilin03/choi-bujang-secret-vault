import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNotesHandler, createNoteItemHandler } from '../src/notes-api.mjs';

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function makeDatabase(initialRows = []) {
  const rows = structuredClone(initialRows);
  const calls = [];
  let nextOrder = Math.max(0, ...rows.map(row => row.sort_order ?? 0));
  const client = {
    from(table) {
      const query = { table, action: 'select', filters: [], payload: null };
      const builder = {
        select() { return this; },
        order() { return this; },
        eq(field, value) { query.filters.push([field, value]); return this; },
        is(field, value) { query.filters.push([field, value]); return this; },
        insert(payload) { query.action = 'insert'; query.payload = payload; return this; },
        update(payload) { query.action = 'update'; query.payload = payload; return this; },
        delete() { query.action = 'delete'; return this; },
        async maybeSingle() { return execute(true); },
        async single() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };
      async function execute(single) {
        calls.push({ ...query, filters: [...query.filters], payload: query.payload && { ...query.payload } });
        let selected = rows.filter(row => row.table === table && query.filters.every(([field, value]) => {
          if (value === null) return row[field] === null;
          return row[field] === value;
        }));
        if (query.action === 'insert') {
          const row = { ...query.payload, table, sort_order: ++nextOrder };
          rows.push(row);
          selected = [row];
        } else if (query.action === 'update') {
          for (const row of selected) Object.assign(row, query.payload);
        } else if (query.action === 'delete') {
          for (const row of selected) rows.splice(rows.indexOf(row), 1);
        }
        return { data: single ? (selected[0] ?? null) : selected, error: null };
      }
      return builder;
    },
  };
  return { client, rows, calls };
}

const verifiedStudent = async authorization => {
  if (authorization === 'Bearer token-a') return { kind: 'student', userId: userA };
  if (authorization === 'Bearer token-b') return { kind: 'student', userId: userB };
  if (authorization === 'Bearer judge-token') return { kind: 'judge', userId: userA };
  return null;
};

function makeHandlers({ rows = [] } = {}) {
  const database = makeDatabase(rows);
  const options = {
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'fixture-only-secret' },
    verifyLogin: verifiedStudent,
    createClient: (_url, secret) => {
      assert.equal(secret, 'fixture-only-secret');
      return database.client;
    },
  };
  return {
    database,
    list: createNotesHandler(options),
    item: createNoteItemHandler(options),
  };
}

const req = (path, method = 'GET', authorization, body) => new Request(`https://vault.example${path}`, {
  method,
  headers: {
    ...(authorization ? { Authorization: authorization } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  ...(body ? { body: JSON.stringify(body) } : {}),
});

test('notes API rejects missing, invalid, and non-student tokens before database access', async () => {
  const { list, item, database } = makeHandlers();
  for (const authorization of [undefined, 'Bearer invalid-token', 'Bearer judge-token']) {
    const response = await list.fetch(req('/api/notes', 'GET', authorization));
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { error: 'Authentication required' });
  }
  const itemResponse = await item.fetch(req(`/api/notes/${noteA}`, 'DELETE'));
  assert.equal(itemResponse.status, 401);
  assert.equal(database.calls.length, 0);
});

test('list exposes only notes owned by the verified student', async () => {
  const { list, database } = makeHandlers({ rows: [
    { table: 'vault_notes', id: 'seed-1', sort_order: 1, owner_id: null, title: '공유 가상 메모', content: '공개 샘플' },
    { table: 'vault_notes', id: noteA, sort_order: 5, owner_id: userA, title: 'A 메모', content: 'A 내용' },
    { table: 'vault_notes', id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', sort_order: 6, owner_id: userB, title: 'B 메모', content: 'B 내용' },
  ] });
  const response = await list.fetch(req('/api/notes', 'GET', 'Bearer token-a'));
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('cache-control'), 'no-store');
  assert.deepEqual(await response.json(), {
    samples: [],
    notes: [{ id: noteA, title: 'A 메모', body: 'A 내용' }],
  });
  assert.ok(database.calls.some(call => call.filters.some(([field, value]) => field === 'owner_id' && value === userA)));
  assert.ok(database.calls.every(call => !call.filters.some(([field, value]) => field === 'owner_id' && value === null)));
});

test('create stores only the verified owner and returns its generated UUID', async () => {
  const { list, database } = makeHandlers();
  const response = await list.fetch(req('/api/notes', 'POST', 'Bearer token-a', {
    title: '새 가상 메모', body: '새 본문', userId: userB, owner_id: userB,
  }));
  assert.equal(response.status, 201);
  const { id } = await response.json();
  assert.match(id, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu);
  assert.deepEqual(database.rows.at(-1), {
    id, owner_id: userA, title: '새 가상 메모', content: '새 본문',
    table: 'vault_notes', sort_order: 1,
  });
});

test('a student can read, update, and delete their own note without changing its owner', async () => {
  const { item, database } = makeHandlers({ rows: [
    { table: 'vault_notes', id: noteA, sort_order: 5, owner_id: userA, title: 'A 메모', content: 'A 내용' },
  ] });
  const get = await item.fetch(req(`/api/notes/${noteA}`, 'GET', 'Bearer token-a'));
  assert.equal(get.status, 200);
  assert.deepEqual(await get.json(), { id: noteA, title: 'A 메모', body: 'A 내용' });

  const put = await item.fetch(req(`/api/notes/${noteA}`, 'PUT', 'Bearer token-a', {
    title: '수정한 제목', body: '수정한 본문', owner_id: userB,
  }));
  assert.equal(put.status, 200);
  assert.deepEqual(await put.json(), { id: noteA });
  assert.equal(database.rows[0].owner_id, userA);
  assert.equal(database.rows[0].title, '수정한 제목');

  const deleted = await item.fetch(req(`/api/notes/${noteA}`, 'DELETE', 'Bearer token-a'));
  assert.equal(deleted.status, 204);
  const missing = await item.fetch(req(`/api/notes/${noteA}`, 'GET', 'Bearer token-a'));
  assert.equal(missing.status, 404);
});

test('a student cannot read, update, or delete another student’s note by guessing its UUID', async () => {
  const original = {
    table: 'vault_notes', id: noteA, sort_order: 5, owner_id: userA,
    title: 'A 메모', content: 'A 내용',
  };
  const { item, database } = makeHandlers({ rows: [original] });

  const get = await item.fetch(req(`/api/notes/${noteA}`, 'GET', 'Bearer token-b'));
  assert.equal(get.status, 404);
  assert.deepEqual(await get.json(), { error: 'Note not found' });

  const put = await item.fetch(req(`/api/notes/${noteA}`, 'PUT', 'Bearer token-b', {
    title: 'B가 바꾼 제목', body: 'B가 바꾼 본문', owner_id: userB,
  }));
  assert.equal(put.status, 404);

  const deleted = await item.fetch(req(`/api/notes/${noteA}`, 'DELETE', 'Bearer token-b'));
  assert.equal(deleted.status, 404);
  assert.deepEqual(database.rows, [original]);
});

test('item API rejects malformed UUIDs and unsupported methods', async () => {
  const { item } = makeHandlers();
  const malformed = await item.fetch(req('/api/notes/not-a-uuid', 'GET', 'Bearer token-a'));
  assert.equal(malformed.status, 400);
  const unsupported = await item.fetch(req(`/api/notes/${noteA}`, 'POST', 'Bearer token-a'));
  assert.equal(unsupported.status, 405);
});
