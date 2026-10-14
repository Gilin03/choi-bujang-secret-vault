import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createPrivateNoteRecoveryHandler, contentSha256, noteSnapshotSha256 } from '../src/stage10-recovery-api.mjs';
import policySnapshot from '../policy/verified-policy.json' with { type: 'json' };

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const noteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function snapshotRow({ id = noteB, owner = userB, title = 'B before', content = 'Original B note' } = {}) {
  const row = {
    snapshot_schema: 'aleph.note-snapshot.v1',
    note_id: id,
    owner_id: owner,
    title,
    content,
    content_sha256: contentSha256(title, content),
    snapshot_version: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    captured_at: '2026-10-13T00:00:00.000Z',
  };
  return { ...row, snapshot_sha256: noteSnapshotSha256(row) };
}

function createDatabase({ snapshots = [snapshotRow()], notes, auditRows } = {}) {
  const tables = {
    note_snapshots: structuredClone(snapshots),
    vault_notes: structuredClone(notes ?? [
      { id: noteA, owner_id: userA, title: 'A unchanged', content: 'A body' },
      { id: noteB, owner_id: userB, title: 'B hacked', content: 'Tampered content' },
    ]),
    note_recovery_audit: structuredClone(auditRows ?? [
      { audit_id: 'existing-audit', action: 'restore_note', note_id: noteA },
    ]),
  };
  const calls = [];
  let nextAuditId = 1;

  const client = {
    from(table) {
      const query = { table, operation: 'select', filters: [], payload: null };
      const builder = {
        select() { return this; },
        eq(field, value) { query.filters.push([field, value]); return this; },
        update(payload) { query.operation = 'update'; query.payload = structuredClone(payload); return this; },
        insert(payload) { query.operation = 'insert'; query.payload = structuredClone(payload); return this; },
        async maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };

      async function execute(single) {
        calls.push({ ...query, filters: [...query.filters] });
        const rows = tables[table] ?? [];
        const selected = rows.filter((row) => query.filters.every(([field, value]) => row[field] === value));
        if (query.operation === 'update') {
          for (const row of selected) Object.assign(row, query.payload);
        } else if (query.operation === 'insert') {
          const inserted = Array.isArray(query.payload) ? query.payload : [query.payload];
          for (const row of inserted) rows.push({ audit_id: `new-audit-${nextAuditId++}`, ...row });
          return { data: single ? rows.at(-1) : inserted, error: null };
        }
        return { data: single ? (selected[0] ?? null) : selected, error: null };
      }
      return builder;
    },
  };
  return { client, tables, calls };
}

const principals = new Map([
  ['Bearer fixture-a', { kind: 'student', userId: userA }],
  ['Bearer fixture-b', { kind: 'student', userId: userB }],
  ['Bearer judge-b', { kind: 'judge', userId: userB, identity: 'b' }],
]);

function makeHandler({ database = createDatabase(), policyReader = async () => policySnapshot } = {}) {
  let policyReads = 0;
  const handler = createPrivateNoteRecoveryHandler({
    env: { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-placeholder' },
    verifyLogin: async (authorization) => principals.get(authorization) ?? null,
    createClient: () => database.client,
    policyReader: async () => { policyReads += 1; return policyReader(); },
  });
  return { handler, database, get policyReads() { return policyReads; } };
}

function request(id, { authorization, body } = {}) {
  return new Request(`https://vault.example/api/recovery/notes/${id}`, {
    method: 'POST',
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

test('preview is read-only, shows policy and snapshot versions, and restore appends one audit row', async () => {
  const fixture = makeHandler();
  const beforeNotes = structuredClone(fixture.database.tables.vault_notes);
  const beforeAudit = structuredClone(fixture.database.tables.note_recovery_audit);

  const previewResponse = await fixture.handler.fetch(request(noteB, { authorization: 'Bearer fixture-b' }));
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.operation, 'preview');
  assert.equal(preview.before, 'modified');
  assert.deepEqual(preview.changes, ['title', 'content']);
  assert.equal(preview.version.policyRevision, policySnapshot.policyRevision);
  assert.equal(preview.version.policySha256, policySnapshot.sha256);
  assert.equal(preview.version.snapshotSha256, fixture.database.tables.note_snapshots[0].snapshot_sha256);
  assert.deepEqual(fixture.database.tables.vault_notes, beforeNotes);
  assert.deepEqual(fixture.database.tables.note_recovery_audit, beforeAudit);

  const restoreResponse = await fixture.handler.fetch(request(noteB, {
    authorization: 'Bearer fixture-b', body: { confirm: true },
  }));
  const restored = await restoreResponse.json();

  assert.equal(restoreResponse.status, 200);
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.matches, { id: true, owner: true, contentSha256: true });
  assert.deepEqual(fixture.database.tables.vault_notes.find((row) => row.id === noteA), beforeNotes[0]);
  assert.equal(fixture.database.tables.vault_notes.find((row) => row.id === noteB).title, 'B before');
  assert.equal(fixture.database.tables.note_recovery_audit[0].audit_id, 'existing-audit');
  assert.equal(fixture.database.tables.note_recovery_audit.length, beforeAudit.length + 1);
  assert.equal(fixture.database.tables.note_recovery_audit.at(-1).action, 'restore_note');
  assert.equal(fixture.policyReads, 2);
});

test('the verified judge B principal can preview and restore only its owned note', async () => {
  const fixture = makeHandler();
  const previewResponse = await fixture.handler.fetch(request(noteB, { authorization: 'Bearer judge-b' }));
  const preview = await previewResponse.json();

  assert.equal(previewResponse.status, 200, JSON.stringify(preview));
  assert.equal(preview.operation, 'preview');
  assert.equal(preview.id, noteB);

  const restoreResponse = await fixture.handler.fetch(request(noteB, {
    authorization: 'Bearer judge-b', body: { confirm: true },
  }));
  const restored = await restoreResponse.json();

  assert.equal(restoreResponse.status, 200, JSON.stringify(restored));
  assert.equal(restored.restored, true);
  assert.deepEqual(restored.matches, { id: true, owner: true, contentSha256: true });
  assert.equal(fixture.database.tables.vault_notes.find((row) => row.id === noteB).owner_id, userB);
});

test('unauthenticated and unknown-note restore requests are rejected without writes', async () => {
  const fixture = makeHandler();
  const noAuth = await fixture.handler.fetch(request(noteB, { body: { confirm: true } }));
  const missing = await fixture.handler.fetch(request('dddddddd-dddd-4ddd-8ddd-dddddddddddd', {
    authorization: 'Bearer fixture-b', body: { confirm: true },
  }));

  assert.equal(noAuth.status, 401);
  assert.equal(missing.status, 404);
  assert.equal(fixture.database.calls.some((call) => ['update', 'insert'].includes(call.operation)), false);
});

test('missing or corrupted policy/snapshot evidence stops before note or audit writes', async (t) => {
  const invalidPolicy = { ...policySnapshot, sha256: '0'.repeat(64) };
  const missingSnapshotDb = createDatabase({ snapshots: [] });
  const contentTamperedSnapshot = snapshotRow();
  contentTamperedSnapshot.content = 'changed after capture';
  contentTamperedSnapshot.snapshot_sha256 = noteSnapshotSha256(contentTamperedSnapshot);
  const cases = [
    ['missing policy snapshot', createDatabase(), async () => null, 503],
    ['invalid policy hash', createDatabase(), async () => invalidPolicy, 503],
    ['missing note snapshot', missingSnapshotDb, async () => policySnapshot, 404],
    ['invalid content hash', createDatabase({ snapshots: [contentTamperedSnapshot] }), async () => policySnapshot, 503],
    ['invalid note snapshot hash', createDatabase({ snapshots: [{ ...snapshotRow(), snapshot_sha256: '0'.repeat(64) }] }), async () => policySnapshot, 503],
  ];
  for (const [name, database, policyReader, expectedStatus] of cases) {
    await t.test(name, async () => {
      const fixture = makeHandler({ database, policyReader });
      const beforeNotes = structuredClone(database.tables.vault_notes);
      const beforeAudit = structuredClone(database.tables.note_recovery_audit);
      const response = await fixture.handler.fetch(request(noteB, {
        authorization: 'Bearer fixture-b', body: { confirm: true },
      }));

      assert.equal(response.status, expectedStatus);
      assert.deepEqual(database.tables.vault_notes, beforeNotes);
      assert.deepEqual(database.tables.note_recovery_audit, beforeAudit);
      assert.equal(database.calls.some((call) => ['update', 'insert'].includes(call.operation)), false);
    });
  }
});

test('a snapshot owned by another account is rejected before writes', async () => {
  const database = createDatabase({ snapshots: [snapshotRow({ owner: userA })] });
  const fixture = makeHandler({ database });
  const before = structuredClone(database.tables.vault_notes);
  const response = await fixture.handler.fetch(request(noteB, {
    authorization: 'Bearer fixture-b', body: { confirm: true },
  }));

  assert.equal(response.status, 404);
  assert.deepEqual(database.tables.vault_notes, before);
  assert.equal(database.tables.note_recovery_audit.length, 1);
  assert.equal(database.calls.some((call) => ['update', 'insert'].includes(call.operation)), false);
});

test('a deleted B note is restored with the snapshot id and owner', async () => {
  const database = createDatabase({ notes: [
    { id: noteA, owner_id: userA, title: 'A unchanged', content: 'A body' },
  ] });
  const fixture = makeHandler({ database });
  const response = await fixture.handler.fetch(request(noteB, {
    authorization: 'Bearer fixture-b', body: { confirm: true },
  }));
  const restored = await response.json();

  assert.equal(response.status, 200);
  assert.equal(restored.before, 'deleted');
  assert.deepEqual(restored.matches, { id: true, owner: true, contentSha256: true });
  assert.deepEqual(database.tables.vault_notes.find((row) => row.id === noteA), {
    id: noteA, owner_id: userA, title: 'A unchanged', content: 'A body',
  });
  assert.equal(database.tables.vault_notes.find((row) => row.id === noteB).owner_id, userB);
  assert.equal(database.tables.note_recovery_audit.length, 2);
});

test('policy snapshot is read again for the confirm request', async () => {
  let currentSnapshot = policySnapshot;
  const fixture = makeHandler({ policyReader: async () => currentSnapshot });
  const previewResponse = await fixture.handler.fetch(request(noteB, { authorization: 'Bearer fixture-b' }));
  assert.equal(previewResponse.status, 200);

  currentSnapshot = { ...policySnapshot, sha256: '0'.repeat(64) };
  const before = structuredClone(fixture.database.tables.vault_notes);
  const restoreResponse = await fixture.handler.fetch(request(noteB, {
    authorization: 'Bearer fixture-b', body: { confirm: true },
  }));

  assert.equal(restoreResponse.status, 503);
  assert.deepEqual(fixture.database.tables.vault_notes, before);
  assert.equal(fixture.policyReads, 2);
  assert.equal(fixture.database.calls.some((call) => ['update', 'insert'].includes(call.operation)), false);
});

test('the deployed handler can read the private policy snapshot file for each request', async () => {
  const database = createDatabase();
  const handler = createPrivateNoteRecoveryHandler({
    env: { SUPABASE_URL: 'https://fixture.supabase.co', SUPABASE_SECRET_KEY: 'server-only-test-placeholder' },
    verifyLogin: async (authorization) => principals.get(authorization) ?? null,
    createClient: () => database.client,
  });
  const response = await handler.fetch(request(noteB, { authorization: 'Bearer fixture-b' }));
  const preview = await response.json();

  assert.equal(response.status, 200);
  assert.equal(preview.operation, 'preview');
  assert.equal(preview.version.policySha256, policySnapshot.sha256);
  assert.deepEqual(database.tables.vault_notes[1], {
    id: noteB, owner_id: userB, title: 'B hacked', content: 'Tampered content',
  });
});
