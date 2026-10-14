import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import recoveryRoute from '../api/recovery/notes/[id].mjs';
import { createPrivateNoteRecoveryHandler } from '../src/stage10-recovery-api.mjs';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noteB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const noteA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const backupVersion = 'stage10-b-note-v1';
const backupFile = new URL('../recovery/private/stage10-b-note-backup.json', import.meta.url);
const backupRaw = await readFile(backupFile, 'utf8');
const backupFixture = JSON.parse(backupRaw);
const sha256 = (value) => createHash('sha256').update(value).digest('hex');
const baseEnv = {
  SUPABASE_URL: 'https://project.example.invalid',
  SUPABASE_SECRET_KEY: 'test-only-placeholder',
};

function makeBackup({
  id = noteB,
  ownerId = ownerB,
  title = 'B 가상 복구 메모',
  body = '복구 시험 전용 가상 본문',
  version = backupVersion,
  contentSha256,
} = {}) {
  const noteCore = { id, ownerId, title, body };
  const note = {
    ...noteCore,
    contentSha256: contentSha256 ?? sha256(JSON.stringify(noteCore)),
  };
  const payload = { schema: 'aleph.private-note-backup.v1', version, note };
  return JSON.stringify({ ...payload, backupSha256: sha256(JSON.stringify(payload)) });
}

function fakeDatabase(initialRows = [], { corruptNextMutationResponse = false } = {}) {
  const state = {
    rows: structuredClone(initialRows),
    auditHistory: [{ id: 'audit-preserved', action: 'prior_event' }],
    tablesReadOrWritten: [],
    corruptNextMutationResponse,
  };

  class Query {
    constructor(table) {
      this.table = table;
      this.operation = 'select';
      this.filters = [];
      this.payload = null;
    }
    select() { return this; }
    eq(field, value) { this.filters.push([field, value]); return this; }
    update(payload) { this.operation = 'update'; this.payload = payload; return this; }
    insert(payload) { this.operation = 'insert'; this.payload = payload; return this; }
    delete() { this.operation = 'delete'; return this; }
    async maybeSingle() { return this.execute(); }
    async single() { return this.execute(); }
    async execute() {
      state.tablesReadOrWritten.push({ table: this.table, operation: this.operation });
      if (this.table !== 'vault_notes') return { data: null, error: { message: 'unexpected table' } };
      const matches = state.rows.filter((row) => this.filters.every(([field, value]) => row[field] === value));
      if (this.operation === 'select') return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
      if (this.operation === 'update') {
        for (const row of matches) Object.assign(row, structuredClone(this.payload));
        const data = matches[0] ? structuredClone(matches[0]) : null;
        if (state.corruptNextMutationResponse && data) {
          state.corruptNextMutationResponse = false;
          data.title = 'unexpected returned row';
        }
        return { data, error: null };
      }
      if (this.operation === 'insert') {
        if (state.rows.some((row) => row.id === this.payload.id)) return { data: null, error: { message: 'duplicate' } };
        const row = structuredClone(this.payload);
        state.rows.push(row);
        const data = structuredClone(row);
        if (state.corruptNextMutationResponse) {
          state.corruptNextMutationResponse = false;
          data.title = 'unexpected returned row';
        }
        return { data, error: null };
      }
      if (this.operation === 'delete') {
        const removed = matches.map((row) => structuredClone(row));
        state.rows = state.rows.filter((row) => !matches.includes(row));
        return { data: removed[0] ?? null, error: null };
      }
      return { data: null, error: { message: 'unsupported operation' } };
    }
  }

  return {
    state,
    createClient: () => ({ from: (table) => new Query(table) }),
  };
}

function request(id, operation, token = 'b', extra = {}) {
  return new Request(`https://example.test/api/recovery/notes/${id}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ operation, ...extra }),
  });
}

function handler({
  env = baseEnv,
  database = fakeDatabase(),
  tokenMap,
  backupReader,
} = {}) {
  const identities = tokenMap ?? {
    a: { kind: 'student', userId: ownerA },
    b: { kind: 'student', userId: ownerB },
    judge: { kind: 'judge', userId: ownerB },
  };
  return {
    api: createPrivateNoteRecoveryHandler({
      env,
      createClient: database.createClient,
      verifyLogin: async (authorization) => identities[authorization?.slice('Bearer '.length)] ?? null,
      backupReader,
    }),
    database,
  };
}

function restoreConfirmation(preview) {
  return {
    backupVersion: preview.backupVersion,
    backupSha256: preview.backupSha256,
    currentContentSha256: preview.currentContentSha256,
  };
}

test('Vercel recovery entrypoint exports the private recovery handler', () => {
  assert.equal(typeof recoveryRoute.fetch, 'function');
});

test('private backup file previews version, target, and changed fields without modifying data', async () => {
  const { api, database } = handler({ database: fakeDatabase([
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ]) });

  const response = await api.fetch(request(noteB, 'preview'));
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.operation, 'preview');
  assert.equal(preview.backupVersion, backupVersion);
  assert.equal(preview.id, noteB);
  assert.deepEqual(preview.changes, ['title', 'content']);
  assert.equal(preview.backupSha256, backupFixture.backupSha256);
  assert.equal(JSON.stringify(preview).includes(backupFixture.note.body), false);
  assert.equal(database.state.rows.find((row) => row.id === noteB).title, 'B altered');
  assert.deepEqual(database.state.tablesReadOrWritten.map((entry) => entry.operation), ['select']);
});

test('verified private backup restores only B note and preserves A note and audit history', async () => {
  const initialRows = [
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ];
  const { api, database } = handler({ database: fakeDatabase(initialRows) });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);

  const response = await api.fetch(request(noteB, 'restore', 'b', restoreConfirmation(preview)));
  assert.equal(response.status, 200);
  const restored = await response.json();
  assert.equal(restored.id, noteB);
  assert.equal(restored.backupVersion, backupVersion);
  assert.equal(restored.contentSha256, backupFixture.note.contentSha256);
  assert.deepEqual(database.state.rows.find((row) => row.id === noteA), initialRows[0]);
  assert.deepEqual(database.state.rows.find((row) => row.id === noteB), {
    id: noteB,
    owner_id: ownerB,
    title: backupFixture.note.title,
    content: backupFixture.note.body,
  });
  assert.deepEqual(database.state.auditHistory, [{ id: 'audit-preserved', action: 'prior_event' }]);
  assert.deepEqual(new Set(database.state.tablesReadOrWritten.map((entry) => entry.table)), new Set(['vault_notes']));
});

test('missing backup fails before any database access or mutation', async () => {
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => null });
  const response = await api.fetch(request(noteB, 'restore', 'b', {
    backupVersion,
    backupSha256: backupFixture.backupSha256,
    currentContentSha256: null,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('backup schema mismatch fails before any database access or mutation', async () => {
  const parsed = JSON.parse(makeBackup());
  parsed.schema = 'aleph.unknown-backup.v1';
  const payload = { schema: parsed.schema, version: parsed.version, note: parsed.note };
  parsed.backupSha256 = sha256(JSON.stringify(payload));
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => JSON.stringify(parsed) });
  const response = await api.fetch(request(noteB, 'restore', 'b', {
    backupVersion,
    backupSha256: parsed.backupSha256,
    currentContentSha256: null,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('backup whole-file hash mismatch fails before any database access or mutation', async () => {
  const parsed = JSON.parse(backupRaw);
  parsed.backupSha256 = '0'.repeat(64);
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => JSON.stringify(parsed) });
  const response = await api.fetch(request(noteB, 'restore', 'b', {
    backupVersion,
    backupSha256: parsed.backupSha256,
    currentContentSha256: null,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('backup content hash mismatch fails even when the outer backup hash was recomputed', async () => {
  const parsed = JSON.parse(makeBackup());
  parsed.note.contentSha256 = 'f'.repeat(64);
  const payload = { schema: parsed.schema, version: parsed.version, note: parsed.note };
  parsed.backupSha256 = sha256(JSON.stringify(payload));
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => JSON.stringify(parsed) });
  const response = await api.fetch(request(noteB, 'restore', 'b', {
    backupVersion,
    backupSha256: parsed.backupSha256,
    currentContentSha256: null,
  }));
  assert.equal(response.status, 503);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('backup owner mismatch fails before any database access or mutation', async () => {
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => makeBackup({ ownerId: ownerA }) });
  const response = await api.fetch(request(noteB, 'preview'));
  assert.equal(response.status, 404);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('backup note ID mismatch fails before any database access or mutation', async () => {
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database, backupReader: async () => makeBackup({ id: noteA }) });
  const response = await api.fetch(request(noteB, 'preview'));
  assert.equal(response.status, 404);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
  assert.equal(database.state.rows[0].content, 'altered');
});

test('restore rereads backup and rejects a different valid version confirmed by an earlier preview', async () => {
  const secondBackup = makeBackup({ version: 'stage10-b-note-v2', body: 'changed virtual snapshot' });
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  let reads = 0;
  const { api } = handler({
    database,
    backupReader: async () => (++reads === 1 ? backupRaw : secondBackup),
  });

  const previewResponse = await api.fetch(request(noteB, 'preview'));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  const response = await api.fetch(request(noteB, 'restore', 'b', restoreConfirmation(preview)));
  assert.equal(response.status, 409);
  assert.equal(reads, 2);
  assert.deepEqual(database.state.rows[0], { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' });
  assert.deepEqual(database.state.tablesReadOrWritten.map((entry) => entry.operation), ['select']);
});

test('restore request cannot supply or override the server-only backup fixture', async () => {
  const database = fakeDatabase();
  const { api } = handler({ database });
  const response = await api.fetch(request(noteB, 'preview', 'b', { backup: backupFixture }));
  assert.equal(response.status, 400);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
});

test('B preview confirmation rejects a changed current row without modifying it', async () => {
  const database = fakeDatabase([{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }]);
  const { api } = handler({ database });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  const preview = await previewResponse.json();
  database.state.rows[0].content = 'changed after preview';
  const response = await api.fetch(request(noteB, 'restore', 'b', restoreConfirmation(preview)));
  assert.equal(response.status, 409);
  assert.equal(database.state.rows[0].content, 'changed after preview');
  assert.equal(database.state.tablesReadOrWritten.some((entry) => entry.operation === 'update'), false);
});

test('post-write response verification failure conditionally rolls the row back', async () => {
  const initialRows = [
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ];
  const database = fakeDatabase(initialRows, { corruptNextMutationResponse: true });
  const { api } = handler({ database });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  const preview = await previewResponse.json();
  const response = await api.fetch(request(noteB, 'restore', 'b', restoreConfirmation(preview)));
  assert.equal(response.status, 500);
  assert.deepEqual(database.state.rows, initialRows);
  assert.deepEqual(database.state.auditHistory, [{ id: 'audit-preserved', action: 'prior_event' }]);
});

test('restore inserts only B target when absent and preserves other rows and audit history', async () => {
  const initialRows = [{ id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' }];
  const { api, database } = handler({ database: fakeDatabase(initialRows) });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  const preview = await previewResponse.json();
  assert.equal(preview.action, 'insert');
  assert.deepEqual(preview.changes, ['id', 'owner_id', 'title', 'content']);

  const response = await api.fetch(request(noteB, 'restore', 'b', restoreConfirmation(preview)));
  assert.equal(response.status, 201);
  assert.equal(database.state.rows.length, 2);
  assert.deepEqual(database.state.rows[0], initialRows[0]);
  assert.equal(database.state.rows[1].id, noteB);
  assert.equal(database.state.rows[1].owner_id, ownerB);
  assert.deepEqual(database.state.auditHistory, [{ id: 'audit-preserved', action: 'prior_event' }]);
});

test('route, method, and request fields stay narrow', async () => {
  const { api, database } = handler();
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}?x=1`, { method: 'POST' }))).status, 404);
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}`, { method: 'GET' }))).status, 405);
  const forgedOwner = await api.fetch(request(noteB, 'preview', 'b', { ownerId: ownerA }));
  assert.equal(forgedOwner.status, 400);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
});
