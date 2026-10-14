import assert from 'node:assert/strict';
import { test } from 'node:test';
import * as notesApi from '../src/notes-api.mjs';

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const snapshotHash = '767dacdd852a486d8a7a9f316a4c93852c885ad4c3f1de5d7be4b40fe08de228';

const backupB = {
  note_id: noteB,
  owner_id: userB,
  title: 'B 메모',
  content: 'B 내용',
  content_sha256: snapshotHash,
};

function createDatabase(initialRows, backups = [backupB]) {
  const tables = {
    vault_notes: initialRows.map(row => ({ ...row })),
    vault_note_backups: backups.map(row => ({ ...row })),
    audit_events: [{ id: 'audit-1', action: 'note-created', subject: userB }],
  };
  const calls = [];

  const client = {
    from(table) {
      const query = { table, action: 'select', filters: [], columns: null, payload: null };
      const builder = {
        select(columns) { query.columns = columns; return this; },
        eq(field, value) { query.filters.push([field, value]); return this; },
        update(payload) { query.action = 'update'; query.payload = { ...payload }; return this; },
        insert(payload) { query.action = 'insert'; query.payload = { ...payload }; return this; },
        maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };

      async function execute(single) {
        calls.push({ ...query, filters: [...query.filters], payload: query.payload && { ...query.payload } });
        const rows = tables[table] ?? [];
        const key = table === 'vault_note_backups' ? 'note_id' : 'id';
        if (query.action === 'insert') {
          if (rows.some(row => row[key] === query.payload[key])) {
            return { data: null, error: { code: '23505' } };
          }
          if (table === 'vault_notes') {
            const sortOrder = Math.max(0, ...rows.map(row => row.sort_order ?? 0)) + 1;
            rows.push({ sort_order: sortOrder, ...query.payload });
          }
          else rows.push({ ...query.payload });
          return { data: null, error: null };
        }
        const selected = rows.filter(row => query.filters.every(([field, value]) => row[field] === value));
        if (query.action === 'update') {
          selected.forEach(row => Object.assign(row, query.payload));
          return { data: null, error: null };
        }
        const selectedRows = selected.map(row => {
          if (!query.columns) return { ...row };
          return Object.fromEntries(query.columns.split(',').map(field => [field, row[field]]));
        });
        return { data: single ? (selectedRows[0] ?? null) : selectedRows, error: null };
      }

      return builder;
    },
  };
  return { client, tables, calls };
}

function makeHandler({ rows, backups, identity = 'fixture-b' } = {}) {
  assert.equal(typeof notesApi.createNoteRestoreHandler, 'function',
    'notes API must expose the single-note restore handler');
  const database = createDatabase(rows ?? [], backups);
  const handler = notesApi.createNoteRestoreHandler({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'fixture-only-secret' },
    verifyLogin: async authorization => ({
      kind: 'student', userId: authorization === 'fixture-a' ? userA : userB,
    }),
    createClient: () => database.client,
  });
  return { handler, database, identity };
}

function restoreRequest(id = noteB, authorization = 'fixture-b', body = {}) {
  return new Request(`https://vault.example/api/notes/${id}/restore`, {
    method: 'POST',
    headers: { Authorization: authorization, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

function noteRequest(id, authorization) {
  return new Request(`https://vault.example/api/notes/${id}`, {
    method: 'GET',
    headers: { Authorization: authorization },
  });
}

function vercelRestoreRequest(id, { pathId = id, search = '' } = {}) {
  const request = new Request(`https://vault.example/api/notes/${pathId}/restore${search}`, {
    method: 'POST',
    headers: { Authorization: 'fixture-b', 'Content-Type': 'application/json' },
    body: '{}',
  });
  Object.defineProperty(request, 'query', { value: { id }, configurable: true });
  return request;
}

const expectedRestoredNote = {
  id: noteB,
  sort_order: 4,
  owner_id: userB,
  title: 'B 메모',
  content: 'B 내용',
};

test('B restores one tampered note from its DB backup without changing other notes or audit rows', async () => {
  const aNote = { id: noteA, sort_order: 3, owner_id: userA, title: 'A 메모', content: 'A 내용' };
  const bNote = {
    ...expectedRestoredNote,
    owner_id: userA,
    title: '변조된 제목',
    content: '변조된 내용',
  };
  const { handler, database } = makeHandler({ rows: [aNote, bNote] });

  const response = await handler.fetch(restoreRequest(noteB, 'fixture-b', {
    id: noteA,
    owner_id: userA,
    role: 'admin',
    backup: { note_id: noteA, owner_id: userA, content: '요청 본문은 backup으로 쓰지 않음' },
  }));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: noteB,
    owner_id: userB,
    contentSha256: snapshotHash,
  });
  assert.deepEqual(database.tables.vault_notes, [aNote, expectedRestoredNote]);
  assert.deepEqual(database.tables.audit_events, [
    { id: 'audit-1', action: 'note-created', subject: userB },
  ]);
  assert.deepEqual(database.tables.vault_note_backups, [backupB]);
  assert.deepEqual(database.calls.find(call => call.table === 'vault_note_backups'), {
    table: 'vault_note_backups',
    action: 'select',
    filters: [['note_id', noteB]],
    columns: 'note_id,owner_id,title,content,content_sha256',
    payload: null,
  });
  assert.equal(database.calls.filter(call => call.action === 'update').length, 1);
  const update = database.calls.find(call => call.action === 'update');
  assert.equal(update.table, 'vault_notes');
  assert.deepEqual(update.filters, [['id', noteB]]);
  assert.deepEqual(update.payload, {
    owner_id: userB,
    title: 'B 메모',
    content: 'B 내용',
  });
  assert.ok(database.calls.some(call => call.table === 'vault_notes'
    && call.action === 'select'
    && call.columns === 'id,owner_id,content'
    && JSON.stringify(call.filters) === JSON.stringify([['id', noteB]])));
});

test('B restores a deleted note with the backup ID and owner', async () => {
  const aNote = { id: noteA, sort_order: 3, owner_id: userA, title: 'A 메모', content: 'A 내용' };
  const { handler, database } = makeHandler({ rows: [aNote] });

  const response = await handler.fetch(restoreRequest());

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    id: noteB,
    owner_id: userB,
    contentSha256: snapshotHash,
  });
  assert.deepEqual(database.tables.vault_notes, [aNote, expectedRestoredNote]);
  assert.deepEqual(database.tables.audit_events, [
    { id: 'audit-1', action: 'note-created', subject: userB },
  ]);
  assert.deepEqual(database.tables.vault_note_backups, [backupB]);
  const insert = database.calls.find(call => call.action === 'insert');
  assert.equal(insert.table, 'vault_notes');
  assert.deepEqual(insert.payload, {
    id: noteB,
    owner_id: userB,
    title: 'B 메모',
    content: 'B 내용',
  });
  assert.ok(database.calls.some(call => call.table === 'vault_notes'
    && call.action === 'select'
    && call.columns === 'id,owner_id,content'
    && JSON.stringify(call.filters) === JSON.stringify([['id', noteB]])));
});

test('restore requires an existing backup for the URL ID and the authenticated owner', async () => {
  const wrongOwner = makeHandler({ rows: [] });
  const deniedOwner = await wrongOwner.handler.fetch(restoreRequest(noteB, 'fixture-a'));
  assert.equal(deniedOwner.status, 404);
  assert.equal(wrongOwner.database.calls.filter(call => call.action !== 'select').length, 0);
  assert.equal(wrongOwner.database.calls.some(call => call.table === 'vault_notes'), false);

  const noBackup = makeHandler({ rows: [], backups: [] });
  const missing = await noBackup.handler.fetch(restoreRequest());
  assert.equal(missing.status, 404);
  assert.equal(noBackup.database.calls.some(call => call.table === 'vault_notes'), false);

  const wrongId = makeHandler({ rows: [] });
  const idMismatch = await wrongId.handler.fetch(restoreRequest(noteA));
  assert.equal(idMismatch.status, 404);
  assert.deepEqual(wrongId.database.calls[0].filters, [['note_id', noteA]]);
  assert.equal(wrongId.database.calls.some(call => call.table === 'vault_notes'), false);
});

test('a backup content hash mismatch stops before any note read or write', async () => {
  const badBackup = { ...backupB, content_sha256: '0'.repeat(64) };
  const { handler, database } = makeHandler({ rows: [expectedRestoredNote], backups: [badBackup] });

  const response = await handler.fetch(restoreRequest());

  assert.equal(response.status, 500);
  assert.deepEqual(database.tables.vault_notes, [expectedRestoredNote]);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].table, 'vault_note_backups');
  assert.equal(database.calls[0].action, 'select');
});

test('malformed backup metadata is rejected before touching notes', async () => {
  const malformedBackup = { ...backupB, title: null };
  const { handler, database } = makeHandler({ rows: [], backups: [malformedBackup] });

  const response = await handler.fetch(restoreRequest());

  assert.equal(response.status, 500);
  assert.deepEqual(database.tables.vault_notes, []);
  assert.equal(database.calls.length, 1);
  assert.equal(database.calls[0].table, 'vault_note_backups');
});

test('Vercel dynamic [id] route parameter in request.query.id selects its backup', async () => {
  const { handler, database } = makeHandler({ rows: [] });
  const response = await handler.fetch(vercelRestoreRequest(noteB));

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].filters, [['note_id', noteB]]);
});

test('request.query.id takes priority over the pathname ID', async () => {
  const { handler, database } = makeHandler({ rows: [] });
  const response = await handler.fetch(vercelRestoreRequest(noteB, { pathId: noteA }));

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].filters, [['note_id', noteB]]);
});

test('a valid pathname ID remains usable when the URL has unrelated query parameters', async () => {
  const { handler, database } = makeHandler({ rows: [] });
  const response = await handler.fetch(vercelRestoreRequest(noteB, { search: '?source=production' }));

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].filters, [['note_id', noteB]]);
});

test('an invalid dynamic route UUID is rejected before database access', async () => {
  const { handler, database } = makeHandler({ rows: [] });
  const response = await handler.fetch(vercelRestoreRequest('not-a-uuid'));

  assert.equal(response.status, 400);
  assert.equal(database.calls.length, 0);
});

test('Vercel internal restore URL uses request.query.id without pathname matching', async () => {
  const { handler, database } = makeHandler({ rows: [] });
  const request = new Request('https://vault.example/_vercel/functions/api/notes/[id]/restore.mjs', {
    method: 'POST',
    headers: { Authorization: 'fixture-b' },
  });
  Object.defineProperty(request, 'query', { value: { id: noteB }, configurable: true });

  const response = await handler.fetch(request);

  assert.equal(response.status, 200);
  assert.deepEqual(database.calls[0].filters, [['note_id', noteB]]);
});

test('post-restore retest preserves owner reads and denies B access to A note', async () => {
  const aNote = { id: noteA, sort_order: 3, owner_id: userA, title: 'A 메모', content: 'A 내용' };
  const tamperedB = {
    ...expectedRestoredNote,
    owner_id: userA,
    title: '변조된 제목',
    content: '변조된 내용',
  };
  const { handler, database } = makeHandler({ rows: [aNote, tamperedB] });
  const restored = await handler.fetch(restoreRequest());
  assert.equal(restored.status, 200);

  const noteHandler = notesApi.createNoteItemHandler({
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'fixture-only-secret' },
    verifyLogin: async authorization => ({
      kind: 'student', userId: authorization === 'fixture-a' ? userA : userB,
    }),
    createClient: () => database.client,
  });

  const aOwnRead = await noteHandler.fetch(noteRequest(noteA, 'fixture-a'));
  const bRestoredRead = await noteHandler.fetch(noteRequest(noteB, 'fixture-b'));
  const bCrossAccountRead = await noteHandler.fetch(noteRequest(noteA, 'fixture-b'));

  assert.equal(aOwnRead.status, 200);
  assert.equal(bRestoredRead.status, 200);
  assert.deepEqual(await bRestoredRead.json(), { id: noteB, title: 'B 메모', body: 'B 내용' });
  assert.equal(bCrossAccountRead.status, 404);
  assert.deepEqual(database.tables.vault_notes, [aNote, expectedRestoredNote]);
});
