import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import recoveryRoute from '../api/recovery/notes/[id].mjs';
import { createPrivateNoteRecoveryHandler } from '../src/stage10-recovery-api.mjs';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noteB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const noteA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const sha256 = (value) => createHash('sha256').update(value).digest('hex');

test('Vercel recovery entrypoint exports the private recovery handler', () => {
  assert.equal(typeof recoveryRoute.fetch, 'function');
});

function backupEnv() {
  const note = {
    id: noteB,
    ownerId: ownerB,
    title: 'B 가상 복구 메모',
    body: '복구 시험 전용 가상 본문',
  };
  const raw = JSON.stringify({
    schema: 'aleph.private-note-backup.v1',
    note: { ...note, contentSha256: sha256(JSON.stringify(note)) },
  });
  return {
    SUPABASE_URL: 'https://project.example.invalid',
    SUPABASE_SECRET_KEY: 'test-only-placeholder',
    STAGE10_B_NOTE_BACKUP_JSON: raw,
    STAGE10_B_NOTE_BACKUP_SHA256: sha256(raw),
  };
}

function fakeDatabase(initialRows = []) {
  const state = {
    rows: structuredClone(initialRows),
    auditHistory: [{ id: 'audit-preserved', action: 'prior_event' }],
    tablesReadOrWritten: [],
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
    async maybeSingle() { return this.execute(); }
    async single() { return this.execute(); }
    async execute() {
      state.tablesReadOrWritten.push({ table: this.table, operation: this.operation });
      if (this.table !== 'vault_notes') return { data: null, error: { message: 'unexpected table' } };
      const matches = state.rows.filter((row) => this.filters.every(([field, value]) => row[field] === value));
      if (this.operation === 'select') return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
      if (this.operation === 'update') {
        for (const row of matches) Object.assign(row, structuredClone(this.payload));
        return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
      }
      if (this.operation === 'insert') {
        if (state.rows.some((row) => row.id === this.payload.id)) return { data: null, error: { message: 'duplicate' } };
        const row = structuredClone(this.payload);
        state.rows.push(row);
        return { data: structuredClone(row), error: null };
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

function handler({ env = backupEnv(), database = fakeDatabase(), tokenMap } = {}) {
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
    }),
    database,
  };
}

test('private recovery fails closed when backup config is absent or invalid', async () => {
  const missing = handler({ env: { SUPABASE_URL: 'https://project.example.invalid', SUPABASE_SECRET_KEY: 'test-only' } });
  const unavailable = await missing.api.fetch(request(noteB, 'preview'));
  assert.equal(unavailable.status, 503);
  assert.deepEqual(await unavailable.json(), { error: 'Recovery backup unavailable' });
  assert.equal(missing.database.state.tablesReadOrWritten.length, 0);

  const invalidEnv = backupEnv();
  invalidEnv.STAGE10_B_NOTE_BACKUP_SHA256 = '0'.repeat(64);
  const invalid = handler({ env: invalidEnv });
  assert.equal((await invalid.api.fetch(request(noteB, 'preview'))).status, 503);
  assert.equal(invalid.database.state.tablesReadOrWritten.length, 0);

  const corruptContentEnv = backupEnv();
  const corruptBackup = JSON.parse(corruptContentEnv.STAGE10_B_NOTE_BACKUP_JSON);
  corruptBackup.note.contentSha256 = 'f'.repeat(64);
  corruptContentEnv.STAGE10_B_NOTE_BACKUP_JSON = JSON.stringify(corruptBackup);
  corruptContentEnv.STAGE10_B_NOTE_BACKUP_SHA256 = sha256(corruptContentEnv.STAGE10_B_NOTE_BACKUP_JSON);
  const corruptContent = handler({ env: corruptContentEnv });
  assert.equal((await corruptContent.api.fetch(request(noteB, 'preview'))).status, 503);
  assert.equal(corruptContent.database.state.tablesReadOrWritten.length, 0);
});

test('recovery requires a verified student whose server identity matches the private backup owner', async () => {
  const { api, database } = handler();
  assert.equal((await api.fetch(request(noteB, 'preview', 'missing'))).status, 401);
  assert.equal((await api.fetch(request(noteB, 'preview', 'judge'))).status, 401);
  assert.equal((await api.fetch(request(noteB, 'preview', 'a'))).status, 404);
  assert.equal(database.state.tablesReadOrWritten.length, 0);
});

test('recovery will not overwrite a target row owned by someone else', async () => {
  const { api, database } = handler({ database: fakeDatabase([
    { id: noteB, owner_id: ownerA, title: 'A-owned', content: 'must remain' },
  ]) });
  const response = await api.fetch(request(noteB, 'preview'));
  assert.equal(response.status, 404);
  assert.deepEqual(database.state.rows, [{ id: noteB, owner_id: ownerA, title: 'A-owned', content: 'must remain' }]);
});

test('B previews and restores exactly the backed up row after confirming both hashes', async () => {
  const initialRows = [
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ];
  const { api, database } = handler({ database: fakeDatabase(initialRows) });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  assert.equal(previewResponse.status, 200);
  const preview = await previewResponse.json();
  assert.equal(preview.id, noteB);
  assert.equal(preview.ownerMatched, true);
  assert.equal(preview.action, 'update');
  assert.equal(typeof preview.backupSha256, 'string');
  assert.equal(typeof preview.contentSha256, 'string');
  assert.equal(preview.contentSha256, JSON.parse(backupEnv().STAGE10_B_NOTE_BACKUP_JSON).note.contentSha256);
  assert.equal(JSON.stringify(preview).includes('복구 시험 전용 가상 본문'), false);

  const restoreResponse = await api.fetch(request(noteB, 'restore', 'b', {
    backupSha256: preview.backupSha256,
    currentContentSha256: preview.currentContentSha256,
  }));
  assert.equal(restoreResponse.status, 200);
  const restored = await restoreResponse.json();
  assert.equal(restored.id, noteB);
  assert.equal(restored.ownerMatched, true);
  assert.equal(restored.contentSha256, preview.contentSha256);
  assert.deepEqual(database.state.rows.find((row) => row.id === noteA), initialRows[0]);
  assert.equal(database.state.rows.length, 2);
  assert.equal(database.state.rows.find((row) => row.id === noteB).title, 'B 가상 복구 메모');
  assert.equal(database.state.rows.find((row) => row.id === noteB).content, '복구 시험 전용 가상 본문');
  assert.deepEqual(database.state.auditHistory, [{ id: 'audit-preserved', action: 'prior_event' }]);
  assert.deepEqual(new Set(database.state.tablesReadOrWritten.map((entry) => entry.table)), new Set(['vault_notes']));
});

test('recovery inserts only the target when absent and rejects stale or mismatched confirmations', async () => {
  const { api, database } = handler({ database: fakeDatabase([{ id: noteA, owner_id: ownerA, title: 'A', content: 'keep' }]) });
  const previewResponse = await api.fetch(request(noteB, 'preview'));
  const preview = await previewResponse.json();
  assert.equal(preview.action, 'insert');
  assert.equal(preview.currentContentSha256, null);

  const rejected = await api.fetch(request(noteB, 'restore', 'b', {
    backupSha256: preview.backupSha256,
    currentContentSha256: 'f'.repeat(64),
  }));
  assert.equal(rejected.status, 409);
  assert.equal(database.state.rows.some((row) => row.id === noteB), false);

  const restored = await api.fetch(request(noteB, 'restore', 'b', {
    backupSha256: preview.backupSha256,
    currentContentSha256: null,
  }));
  assert.equal(restored.status, 201);
  assert.equal(database.state.rows.length, 2);
  assert.equal(database.state.rows[0].id, noteA);
});

test('route, method, and request fields are narrow and never accept a body owner', async () => {
  const { api, database } = handler();
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}?x=1`, { method: 'POST' }))).status, 404);
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}`, { method: 'GET' }))).status, 405);
  const forgedOwner = await api.fetch(request(noteB, 'preview', 'b', { ownerId: ownerA }));
  assert.equal(forgedOwner.status, 400);
  const oversizedBody = new Request(`https://example.test/api/recovery/notes/${noteB}`, {
    method: 'POST',
    headers: { authorization: 'Bearer b', 'content-type': 'application/json' },
    body: JSON.stringify({ operation: 'preview', padding: 'x'.repeat(3000) }),
  });
  assert.equal((await api.fetch(oversizedBody)).status, 400);
  assert.deepEqual(database.state.tablesReadOrWritten, []);
});
