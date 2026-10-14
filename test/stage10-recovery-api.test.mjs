import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import recoveryRoute from '../api/recovery/notes/[id].mjs';
import {
  contentSha256,
  createPrivateNoteRecoveryHandler,
  noteSnapshotSha256,
} from '../src/stage10-recovery-api.mjs';
import { policySnapshotSha256 } from '../src/stage10-policy-recovery.mjs';

const ownerA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const ownerB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noteB = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const noteA = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const baseEnv = {
  SUPABASE_URL: 'https://project.example.invalid',
  SUPABASE_SECRET_KEY: 'test-only-placeholder',
};
const policySnapshot = JSON.parse(await readFile(
  new URL('../recovery/policy-snapshots/stage9-safe-policy.json', import.meta.url), 'utf8',
));

function makeSnapshot({
  id = noteB,
  ownerId = ownerB,
  title = 'B 가상 복구 메모',
  content = '테스트에서 만든 정상 B 메모',
  version = '00000000-0000-4000-8000-000000000010',
} = {}) {
  const snapshot = {
    snapshot_schema: 'aleph.note-snapshot.v1',
    note_id: id,
    owner_id: ownerId,
    title,
    content,
    content_sha256: contentSha256(title, content),
    snapshot_version: version,
    captured_at: '2026-10-13T00:00:00.000Z',
  };
  return { ...snapshot, snapshot_sha256: noteSnapshotSha256(snapshot) };
}

function fakeDatabase({
  notes = [],
  snapshots = [makeSnapshot()],
  corruptAfterMutation = false,
} = {}) {
  const state = {
    tables: {
      vault_notes: structuredClone(notes),
      note_snapshots: structuredClone(snapshots),
      note_recovery_audit: [{ audit_id: 'audit-preserved', action: 'prior_event' }],
    },
    calls: [],
    corruptAfterMutation,
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
    then(resolve, reject) { return this.execute().then(resolve, reject); }
    async execute() {
      state.calls.push({ table: this.table, operation: this.operation });
      const rows = state.tables[this.table];
      if (!rows) return { data: null, error: { message: `unexpected table ${this.table}` } };
      const matches = rows.filter((row) => this.filters.every(([field, value]) => row[field] === value));
      if (this.operation === 'select') {
        return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
      }
      if (this.operation === 'update') {
        for (const row of matches) Object.assign(row, structuredClone(this.payload));
        if (state.corruptAfterMutation && matches[0]) {
          matches[0].content = 'database trigger changed content';
          state.corruptAfterMutation = false;
        }
        return { data: matches[0] ? structuredClone(matches[0]) : null, error: null };
      }
      if (this.operation === 'insert') {
        if ((this.payload.id && rows.some((row) => row.id === this.payload.id))
            || (this.payload.audit_id && rows.some((row) => row.audit_id === this.payload.audit_id))) {
          return { data: null, error: { message: 'duplicate' } };
        }
        const row = structuredClone(this.table === 'note_recovery_audit'
          ? { audit_id: `audit-${rows.length}`, ...this.payload }
          : this.payload);
        rows.push(row);
        return { data: structuredClone(row), error: null };
      }
      if (this.operation === 'delete') {
        const removed = matches.map((row) => structuredClone(row));
        state.tables[this.table] = rows.filter((row) => !matches.includes(row));
        return { data: removed[0] ?? null, error: null };
      }
      return { data: null, error: { message: 'unsupported operation' } };
    }
  }

  return { state, createClient: () => ({ from: (table) => new Query(table) }) };
}

function request(id, body = {}, token = 'b') {
  return new Request(`https://example.test/api/recovery/notes/${id}`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${token}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function handler({
  env = baseEnv,
  database = fakeDatabase(),
  tokenMap,
  policyReader = async () => policySnapshot,
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
      policyReader,
    }),
    database,
  };
}

function restoreConfirmation() {
  return { confirm: true };
}

test('Stage 10 SQL keeps snapshots server-read-only, captures only future first inserts, and makes audit append-only', async () => {
  const sql = await readFile(new URL('../supabase/stage10-note-snapshots.sql', import.meta.url), 'utf8');
  assert.match(sql, /create table if not exists public\.note_snapshots/u);
  assert.match(sql, /alter table public\.note_snapshots enable row level security/u);
  assert.match(sql, /revoke all privileges on table public\.note_snapshots from public, anon, authenticated, service_role/u);
  assert.match(sql, /grant select on table public\.note_snapshots to service_role/u);
  assert.doesNotMatch(sql, /grant\s+(?:insert|update|delete|all)[\s\S]{0,100}note_snapshots[\s\S]{0,60}to\s+(?:anon|authenticated|service_role)/iu);
  assert.match(sql, /after insert on public\.vault_notes/u);
  assert.match(sql, /on conflict \(note_id\) do nothing/u);
  assert.doesNotMatch(sql, /insert into public\.note_snapshots[\s\S]{0,400}select[\s\S]{0,200}from public\.vault_notes/iu);
  assert.match(sql, /revoke all privileges on table public\.note_recovery_audit from public, anon, authenticated, service_role/u);
  assert.match(sql, /grant insert on table public\.note_recovery_audit to service_role/u);
  assert.doesNotMatch(sql, /grant\s+(?:select|update|delete|all)[\s\S]{0,100}note_recovery_audit[\s\S]{0,60}to\s+(?:anon|authenticated|service_role)/iu);
  assert.doesNotMatch(sql, /^\s*(?:drop|delete|truncate|update)\b/gimu);
  assert.match(sql, /if not exists\s*\([\s\S]*?from pg_catalog\.pg_trigger[\s\S]*?create trigger vault_notes_capture_first_snapshot/iu);
});

test('Vercel recovery entrypoint exports the private recovery handler', () => {
  assert.equal(typeof recoveryRoute.fetch, 'function');
});

test('preview reads the database snapshot and policy again, reports fingerprints, and does not mutate notes', async () => {
  let policyReads = 0;
  const database = fakeDatabase({ notes: [
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ] });
  const { api } = handler({
    database,
    policyReader: async () => { policyReads += 1; return policySnapshot; },
  });

  const response = await api.fetch(request(noteB));
  assert.equal(response.status, 200);
  const preview = await response.json();
  assert.equal(preview.operation, 'preview');
  assert.equal(preview.id, noteB);
  assert.equal(preview.before, 'modified');
  assert.deepEqual(preview.changes, ['title', 'content']);
  assert.equal(preview.version.policyRevision, policySnapshot.source.commit);
  assert.equal(preview.version.policySha256, policySnapshot.sha256);
  assert.equal(preview.version.snapshotVersion, database.state.tables.note_snapshots[0].snapshot_version);
  assert.equal(preview.version.snapshotSha256, database.state.tables.note_snapshots[0].snapshot_sha256);
  assert.equal(JSON.stringify(preview).includes(database.state.tables.note_snapshots[0].content), false);
  assert.equal(database.state.tables.vault_notes.find((row) => row.id === noteB).title, 'B altered');
  assert.equal(policyReads, 1);
  assert.deepEqual(database.state.calls.filter((call) => call.table === 'vault_notes').map((call) => call.operation), ['select']);
  assert.equal(database.state.calls.some((call) => call.table === 'note_snapshots' && call.operation !== 'select'), false);
});

test('confirm rereads policy and snapshot, restores one B row, verifies it, and preserves audit rows', async () => {
  const initialRows = [
    { id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' },
    { id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered test content' },
  ];
  const database = fakeDatabase({ notes: initialRows });
  let policyReads = 0;
  const { api } = handler({
    database,
    policyReader: async () => { policyReads += 1; return policySnapshot; },
  });
  const previewResponse = await api.fetch(request(noteB));
  const preview = await previewResponse.json();
  assert.equal(previewResponse.status, 200);
  assert.equal((await api.fetch(request(noteB, restoreConfirmation(preview)))).status, 200);

  const restored = database.state.tables.vault_notes.find((row) => row.id === noteB);
  const snapshot = database.state.tables.note_snapshots[0];
  assert.equal(restored.id, snapshot.note_id);
  assert.equal(restored.owner_id, snapshot.owner_id);
  assert.equal(contentSha256(restored.title, restored.content), snapshot.content_sha256);
  assert.deepEqual(database.state.tables.vault_notes.find((row) => row.id === noteA), initialRows[0]);
  assert.deepEqual(database.state.tables.note_recovery_audit, [{ audit_id: 'audit-preserved', action: 'prior_event' }]);
  assert.equal(policyReads, 2);
  assert.equal(database.state.calls.filter((call) => call.table === 'note_snapshots' && call.operation === 'select').length, 2);
  assert.ok(database.state.calls.some((call) => call.table === 'vault_notes' && call.operation === 'update'));
  assert.ok(database.state.calls.filter((call) => call.table === 'vault_notes' && call.operation === 'select').length >= 3);
  assert.equal(database.state.calls.some((call) => call.table === 'note_snapshots' && call.operation !== 'select'), false);
});

test('deleted B note is restored with the same id and owner and other rows remain unchanged', async () => {
  const initialRows = [{ id: noteA, owner_id: ownerA, title: 'A stays', content: 'A content' }];
  const database = fakeDatabase({ notes: initialRows });
  const { api } = handler({ database });
  const previewResponse = await api.fetch(request(noteB));
  const preview = await previewResponse.json();
  assert.equal(preview.before, 'deleted');
  assert.deepEqual(preview.changes, ['id', 'owner_id', 'title', 'content']);

  const response = await api.fetch(request(noteB, restoreConfirmation(preview)));
  assert.equal(response.status, 201);
  const restored = database.state.tables.vault_notes.find((row) => row.id === noteB);
  const snapshot = database.state.tables.note_snapshots[0];
  assert.equal(restored.id, snapshot.note_id);
  assert.equal(restored.owner_id, snapshot.owner_id);
  assert.equal(contentSha256(restored.title, restored.content), snapshot.content_sha256);
  assert.deepEqual(database.state.tables.vault_notes[0], initialRows[0]);
  assert.deepEqual(database.state.tables.note_recovery_audit, [{ audit_id: 'audit-preserved', action: 'prior_event' }]);
});

test('missing snapshot fails without changing the note table', async () => {
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }], snapshots: [] });
  const { api } = handler({ database });
  const response = await api.fetch(request(noteB));
  assert.equal(response.status, 404);
  assert.equal(database.state.tables.vault_notes[0].content, 'altered');
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
});

test('snapshot content hash mismatch fails before note mutation', async () => {
  const snapshot = makeSnapshot();
  snapshot.content = 'tampered snapshot content';
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }], snapshots: [snapshot] });
  const { api } = handler({ database });
  const response = await api.fetch(request(noteB));
  assert.equal(response.status, 503);
  assert.equal(database.state.tables.vault_notes[0].content, 'altered');
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
});

test('snapshot envelope hash mismatch fails before note mutation', async () => {
  const snapshot = makeSnapshot();
  snapshot.snapshot_sha256 = '0'.repeat(64);
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }], snapshots: [snapshot] });
  const { api } = handler({ database });
  const response = await api.fetch(request(noteB));
  assert.equal(response.status, 503);
  assert.equal(database.state.tables.vault_notes[0].content, 'altered');
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
});

test('snapshot with another owner or note id is not disclosed and cannot be restored', async () => {
  for (const snapshot of [makeSnapshot({ ownerId: ownerA }), makeSnapshot({ id: noteA, ownerId: ownerB })]) {
    const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }], snapshots: [snapshot] });
    const { api } = handler({ database });
    const response = await api.fetch(request(noteB));
    assert.equal(response.status, 404);
    assert.equal(database.state.tables.vault_notes[0].content, 'altered');
    assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
  }
});

test('confirm rereads the snapshot and restores from the currently verified version', async () => {
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }] });
  const { api } = handler({ database });
  assert.equal((await api.fetch(request(noteB))).status, 200);
  const changedSnapshot = makeSnapshot({ version: '00000000-0000-4000-8000-000000000011', content: 'verified current source' });
  database.state.tables.note_snapshots[0] = changedSnapshot;

  const response = await api.fetch(request(noteB, restoreConfirmation()));
  assert.equal(response.status, 200);
  assert.equal(database.state.tables.vault_notes[0].content, changedSnapshot.content);
  assert.equal(contentSha256(database.state.tables.vault_notes[0].title, changedSnapshot.content), changedSnapshot.content_sha256);
  assert.equal(database.state.calls.filter((call) => call.table === 'note_snapshots' && call.operation === 'select').length, 2);
});

test('invalid or drifted policy snapshot blocks before reading or changing note data', async () => {
  const invalidPolicy = { ...policySnapshot, sha256: '0'.repeat(64) };
  for (const candidate of [invalidPolicy, null]) {
    const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }] });
    const { api } = handler({ database, policyReader: async () => candidate });
    const response = await api.fetch(request(noteB));
    assert.equal(response.status, 503);
    assert.deepEqual(database.state.calls, []);
    assert.equal(database.state.tables.vault_notes[0].content, 'altered');
  }

  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }] });
  const drift = structuredClone(policySnapshot);
  drift.safeRules = [...drift.safeRules, 'unsafe_test_rule'];
  drift.sha256 = policySnapshotSha256(drift);
  const { api } = handler({ database, policyReader: async () => drift });
  assert.equal((await api.fetch(request(noteB))).status, 409);
  assert.deepEqual(database.state.calls, []);
});

test('confirm rereads the policy snapshot and stops if it is no longer verified', async () => {
  let policyReads = 0;
  const invalidPolicy = { ...policySnapshot, sha256: '0'.repeat(64) };
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }] });
  const { api } = handler({ database, policyReader: async () => (++policyReads === 1 ? policySnapshot : invalidPolicy) });
  assert.equal((await api.fetch(request(noteB))).status, 200);
  const response = await api.fetch(request(noteB, restoreConfirmation()));
  assert.equal(response.status, 503);
  assert.equal(policyReads, 2);
  assert.equal(database.state.tables.vault_notes[0].content, 'altered');
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
});

test('confirm compares the latest memo before state and restores only the target row', async () => {
  const database = fakeDatabase({ notes: [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }] });
  const { api } = handler({ database });
  assert.equal((await api.fetch(request(noteB))).status, 200);
  database.state.tables.vault_notes[0].content = 'changed after preview';
  const response = await api.fetch(request(noteB, restoreConfirmation()));
  assert.equal(response.status, 200);
  const result = await response.json();
  assert.equal(result.before, 'modified');
  assert.equal(database.state.tables.vault_notes[0].content, database.state.tables.note_snapshots[0].content);
});

test('post-write mismatch is detected by rereading the restored note', async () => {
  const initialRows = [{ id: noteB, owner_id: ownerB, title: 'B altered', content: 'altered' }];
  const database = fakeDatabase({ notes: initialRows, corruptAfterMutation: true });
  const { api } = handler({ database });
  const preview = await (await api.fetch(request(noteB))).json();
  const response = await api.fetch(request(noteB, restoreConfirmation(preview)));
  assert.equal(response.status, 500);
  const result = await response.json();
  assert.equal(result.error, 'RESTORE_MISMATCH');
  assert.equal(result.matches.id, true);
  assert.equal(result.matches.owner, true);
  assert.equal(result.matches.contentSha256, false);
  assert.equal(database.state.tables.vault_notes[0].content, 'database trigger changed content');
  assert.equal(database.state.calls.filter((call) => call.table === 'vault_notes' && call.operation === 'update').length, 1);
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && call.operation === 'delete'), false);
  assert.equal(database.state.calls.filter((call) => call.table === 'vault_notes' && call.operation === 'select').length, 3);
  assert.equal(database.state.tables.note_recovery_audit.length, 1);
});

test('request body cannot supply a note snapshot, owner, or policy', async () => {
  const database = fakeDatabase();
  const { api } = handler({ database });
  for (const body of [
    { ownerId: ownerA },
    { note: { id: noteA, owner_id: ownerA } },
    { backup: { id: noteA } },
    { policy: { rules: [] } },
  ]) {
    assert.equal((await api.fetch(request(noteB, body))).status, 400);
  }
  assert.deepEqual(database.state.calls, []);
});

test('route, method, authentication, and current-owner checks stay narrow', async () => {
  const { api, database } = handler({ database: fakeDatabase({ notes: [
    { id: noteB, owner_id: ownerA, title: 'wrong owner', content: 'private' },
  ] }) });
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}?x=1`, { method: 'POST' }))).status, 404);
  assert.equal((await api.fetch(new Request(`https://example.test/api/recovery/notes/${noteB}`, { method: 'GET' }))).status, 405);
  assert.equal((await api.fetch(request(noteB, {}, 'judge'))).status, 401);
  assert.equal((await api.fetch(request(noteB, {}, 'a'))).status, 404);
  assert.equal(database.state.calls.some((call) => call.table === 'vault_notes' && ['update', 'insert', 'delete'].includes(call.operation)), false);
});
