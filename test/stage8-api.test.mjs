import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createMyNotesHandler, createNoteItemHandler, createNotesHandler } from '../src/notes-api.mjs';
import { createAnnouncementHandler, createAnnouncementItemHandler } from '../src/announcements-api.mjs';
import { decide } from '../src/decider.mjs';
import { RESOURCE_IDS } from '../src/resource-zones.mjs';

const userA = '11111111-1111-4111-8111-111111111111';
const userB = '22222222-2222-4222-8222-222222222222';
const teacherUser = '33333333-3333-4333-8333-333333333333';
const noteA = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noteB = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const noticeA = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function createDatabase({ ignoreOwnerFilters = false, includeOtherOwnerNote = false } = {}) {
  const tables = {
    vault_notes: [
      { id: noteA, owner_id: userA, title: 'A memo', content: 'A body' },
      ...(includeOtherOwnerNote
        ? [{ id: noteB, owner_id: userB,
          title: 'B memo', content: 'B body' }]
        : []),
    ],
    vault_announcements: [{ id: noticeA, title: 'Class notice', content: 'Original',
      updated_by: teacherUser, updated_at: '2026-10-01T00:00:00.000Z' }],
    vault_instructor_access: [{ user_id: teacherUser, active: true }],
  };
  const calls = [];
  const client = {
    from(table) {
      const query = { table, action: 'select', filters: [], payload: null };
      const builder = {
        select() { return this; },
        order() { return this; },
        eq(field, value) { query.filters.push([field, value]); return this; },
        update(payload) { query.action = 'update'; query.payload = payload; return this; },
        delete() { query.action = 'delete'; return this; },
        async maybeSingle() { return execute(true); },
        then(resolve, reject) { return execute(false).then(resolve, reject); },
      };
      async function execute(single) {
        calls.push({ table, action: query.action, filters: [...query.filters], payload: query.payload });
        const rows = tables[table] ?? [];
        const selected = rows.filter(row => query.filters.every(([field, value]) =>
          (ignoreOwnerFilters && field === 'owner_id') || row[field] === value));
        if (query.action === 'update') {
          for (const row of selected) Object.assign(row, query.payload);
        } else if (query.action === 'delete') {
          for (const row of selected) rows.splice(rows.indexOf(row), 1);
        }
        return { data: single ? (selected[0] ?? null) : selected, error: null };
      }
      return builder;
    },
  };
  return { client, tables, calls };
}

const principals = new Map([
  ['fixture-a', { kind: 'student', userId: userA }],
  ['fixture-b', { kind: 'student', userId: userB }],
  ['fixture-teacher', { kind: 'student', userId: teacherUser }],
  ['fixture-judge', { kind: 'judge', userId: userA }],
]);

function makeHandlers({ ignoreOwnerFilters = false, includeOtherOwnerNote = false } = {}) {
  const database = createDatabase({ ignoreOwnerFilters, includeOtherOwnerNote });
  const options = {
    env: { SUPABASE_URL: 'https://project.supabase.co', SUPABASE_SECRET_KEY: 'fixture-only-secret' },
    verifyLogin: async authorization => principals.get(authorization) ?? null,
    createClient: (_url, secret) => {
      assert.equal(secret, 'fixture-only-secret');
      return database.client;
    },
  };
  return {
    database,
    notes: createNotesHandler(options),
    myNotes: createMyNotesHandler(options),
    note: createNoteItemHandler(options),
    announcements: createAnnouncementHandler(options),
    announcement: createAnnouncementItemHandler(options),
  };
}

function request(path, method = 'GET', authorization, body) {
  return new Request(`https://vault.example${path}`, {
    method,
    headers: {
      ...(authorization ? { Authorization: authorization } : {}),
      ...(body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
}

function vercelNoteRequest(path, id, method = 'GET', authorization, body) {
  const value = request(path, method, authorization, body);
  Object.defineProperty(value, 'query', { value: { id }, configurable: true });
  return value;
}

test('note item GET uses Vercel request.query.id before its pathname fallback', async () => {
  const { note, database } = makeHandlers({ includeOtherOwnerNote: true });

  const response = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteB}?source=vercel`, noteA, 'GET', 'fixture-a'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: noteA, title: 'A memo', body: 'A body' });
  assert.ok(database.calls.some(call => call.table === 'vault_notes'
    && call.filters.some(([field, value]) => field === 'id' && value === noteA)));
});

test('note item GET keeps the pathname fallback when Vercel query ID is absent', async () => {
  const { note } = makeHandlers();

  const response = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-a'));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { id: noteA, title: 'A memo', body: 'A body' });
});

test('note item query ID is UUID-validated and cannot make another pathname valid', async () => {
  const { note, database } = makeHandlers();
  const invalid = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteA}?source=vercel`, 'not-a-uuid', 'GET', 'fixture-a'));
  const unrelated = await note.fetch(vercelNoteRequest(
    `/api/other/${noteA}?source=vercel`, noteA, 'GET', 'fixture-a'));

  assert.equal(invalid.status, 400);
  assert.equal(unrelated.status, 404);
  assert.equal(database.calls.length, 0);
});

test('Vercel item GET retains B own-note access and denies B access to A note', async () => {
  const { note } = makeHandlers({ includeOtherOwnerNote: true });

  const own = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteB}?source=vercel`, noteB,
    'GET', 'fixture-b'));
  const crossAccount = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteA}?source=vercel`, noteA, 'GET', 'fixture-b'));

  assert.equal(own.status, 200);
  assert.deepEqual(await own.json(), {
    id: noteB, title: 'B memo', body: 'B body',
  });
  assert.equal(crossAccount.status, 404);
  assert.deepEqual(await crossAccount.json(), { error: 'Note not found' });
});

test('Vercel item PUT and DELETE use the dynamic query ID', async () => {
  const { note, database } = makeHandlers({ includeOtherOwnerNote: true });
  const bNote = noteB;

  const updated = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteA}?source=vercel`, bNote, 'PUT', 'fixture-b',
    { title: 'Updated B', body: 'Updated B body' }));
  const deleted = await note.fetch(vercelNoteRequest(
    `/api/notes/${noteA}?source=vercel`, bNote, 'DELETE', 'fixture-b'));

  assert.equal(updated.status, 200);
  assert.deepEqual(await updated.json(), { id: bNote });
  assert.equal(deleted.status, 204);
  assert.equal(database.tables.vault_notes.some(row => row.id === bNote), false);
  assert.equal(database.tables.vault_notes.find(row => row.id === noteA).content, 'A body');
});

function engineNoteRequest(subjectId, method = 'GET') {
  return {
    schema: 'aleph.decision.v1',
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    classId: 'class_fixture',
    projectId: 'project_fixture',
    subjectId,
    deviceId: '0123456789abcdef',
    service: 'notes',
    method,
    path: `/api/notes/${noteA}`,
    route: `${method} /api/notes/:id`,
    queryLength: 0,
    querySha256: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    at: '2026-10-13T00:00:00.000Z',
    policyRevision: 8,
    deviceRegistered: true,
    stepUp: { verified: false, authAgeSeconds: null },
    recentEvents: [],
    signals: { source: 'none', region: 'unknown', network: 'unknown', hour: null },
  };
}

test('personal note item API keeps the stored owner check for a direct cross-zone request', async () => {
  const { note, database } = makeHandlers();
  const ownerRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-a'));
  assert.equal(ownerRead.status, 200);
  assert.equal(ownerRead.headers.get('x-aleph-resource-id'), RESOURCE_IDS.personalNotes);

  const outsiderRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-b'));
  const outsiderUpdate = await note.fetch(request(`/api/notes/${noteA}`, 'PUT', 'fixture-b', {
    title: 'forged', body: 'forged', owner_id: userB,
  }));
  const outsiderDelete = await note.fetch(request(`/api/notes/${noteA}`, 'DELETE', 'fixture-b'));

  assert.deepEqual([outsiderRead.status, outsiderUpdate.status, outsiderDelete.status], [404, 404, 404]);
  assert.equal(database.tables.vault_notes[0].owner_id, userA);
  assert.equal(database.tables.vault_notes[0].content, 'A body');
  assert.ok(database.calls.filter(call => call.table === 'vault_notes').some(call =>
    call.filters.some(([field, value]) => field === 'owner_id' && value === userB)));
});

test('personal note GET checks the stored owner before returning a row', async () => {
  const { note, database } = makeHandlers({ ignoreOwnerFilters: true });

  const ownerRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-a'));
  const outsiderRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-b'));
  const outsiderUpdate = await note.fetch(request(`/api/notes/${noteA}`, 'PUT', 'fixture-b', {
    title: 'forged', body: 'forged', owner_id: userB,
  }));
  const outsiderDelete = await note.fetch(request(`/api/notes/${noteA}`, 'DELETE', 'fixture-b'));

  assert.equal(ownerRead.status, 200);
  assert.deepEqual(await ownerRead.json(), { id: noteA, title: 'A memo', body: 'A body' });
  assert.deepEqual([outsiderRead.status, outsiderUpdate.status, outsiderDelete.status], [404, 404, 404]);
  assert.equal(database.tables.vault_notes.length, 1);
  assert.equal(database.tables.vault_notes[0].owner_id, userA);
  assert.equal(database.tables.vault_notes[0].content, 'A body');
});

test('decider scopes note paths and the API enforces stored ownership for the same item ID', async () => {
  const { note, myNotes, database } = makeHandlers({
    ignoreOwnerFilters: true,
    includeOtherOwnerNote: true,
  });

  const ownerDecision = await decide(engineNoteRequest('opaque-engine-subject-a'));
  const otherSubjectDecision = await decide(engineNoteRequest('opaque-engine-subject-b'));
  // subjectId is opaque and has no owner mapping in the contract, so this is
  // a route gate only; the verified-user/API owner check decides item access.
  assert.equal(ownerDecision.decision, 'allow');
  assert.equal(otherSubjectDecision.decision, 'allow');
  assert.ok(ownerDecision.ruleIds.includes('resource_zone'));
  assert.ok(otherSubjectDecision.ruleIds.includes('resource_zone'));

  const ownerRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-a'));
  const otherRead = await note.fetch(request(`/api/notes/${noteA}`, 'GET', 'fixture-b'));
  const otherUpdate = await note.fetch(request(`/api/notes/${noteA}`, 'PUT', 'fixture-b', {
    title: 'forged', body: 'forged', owner_id: userB,
  }));
  const ownerList = await myNotes.fetch(request('/api/my/notes', 'GET', 'fixture-a'));
  const otherOwnerList = await myNotes.fetch(request('/api/my/notes', 'GET', 'fixture-b'));

  assert.equal(ownerRead.status, 200);
  assert.deepEqual(await ownerRead.json(), { id: noteA, title: 'A memo', body: 'A body' });
  assert.deepEqual([otherRead.status, otherUpdate.status], [404, 404]);
  assert.equal(ownerList.status, 200);
  assert.deepEqual((await ownerList.json()).notes, [
    { id: noteA, title: 'A memo', body: 'A body' },
  ]);
  assert.equal(otherOwnerList.status, 200);
  assert.equal((await otherOwnerList.json()).notes.some(row => row.id === noteA), false);
  assert.equal(database.tables.vault_notes.find(row => row.id === noteA).owner_id, userA);
  assert.equal(database.tables.vault_notes.find(row => row.id === noteA).content, 'A body');
});

test('personal note list removes rows whose stored owner differs from the verified user', async () => {
  const { notes } = makeHandlers({ ignoreOwnerFilters: true, includeOtherOwnerNote: true });

  const response = await notes.fetch(request('/api/notes', 'GET', 'fixture-a'));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).notes, [
    { id: noteA, title: 'A memo', body: 'A body' },
  ]);
});

test('explicit self-list API uses the verified user owner filter and does not accept writes', async () => {
  const { myNotes, database } = makeHandlers({ ignoreOwnerFilters: true, includeOtherOwnerNote: true });

  const response = await myNotes.fetch(request('/api/my/notes', 'GET', 'fixture-a'));
  const forbiddenWrite = await myNotes.fetch(request('/api/my/notes', 'POST', 'fixture-a', {
    title: 'Not allowed here', body: 'Self-list endpoint is read-only',
  }));

  assert.equal(response.status, 200);
  assert.deepEqual((await response.json()).notes, [
    { id: noteA, title: 'A memo', body: 'A body' },
  ]);
  assert.equal(forbiddenWrite.status, 405);
  assert.ok(database.calls.some(call => call.table === 'vault_notes'
    && call.filters.some(([field, value]) => field === 'owner_id' && value === userA)));
  assert.equal(database.tables.vault_notes.length, 2);
});

test('announcement resource has a distinct id, is readable by students, and is writable only by stored instructors', async () => {
  assert.notEqual(RESOURCE_IDS.personalNotes, RESOURCE_IDS.instructorAnnouncements);
  const { announcements, announcement, database } = makeHandlers();

  const list = await announcements.fetch(request('/api/announcements', 'GET', 'fixture-b'));
  assert.equal(list.status, 200);
  assert.deepEqual(await list.json(), {
    resourceId: RESOURCE_IDS.instructorAnnouncements,
    announcements: [{ id: noticeA, title: 'Class notice', body: 'Original' }],
  });

  const forgedRoleUpdate = await announcement.fetch(request(
    `/api/announcements/${noticeA}`, 'PUT', 'fixture-b',
    { title: 'forged', body: 'forged', role: 'instructor', userId: teacherUser },
  ));
  assert.equal(forgedRoleUpdate.status, 403);
  assert.deepEqual(await forgedRoleUpdate.json(), { error: 'Access denied' });
  assert.equal(database.tables.vault_announcements[0].content, 'Original');

  const teacherUpdate = await announcement.fetch(request(
    `/api/announcements/${noticeA}`, 'PUT', 'fixture-teacher',
    { title: 'Updated notice', body: 'Updated text', role: 'student', updated_by: userB },
  ));
  assert.equal(teacherUpdate.status, 200);
  assert.deepEqual(await teacherUpdate.json(), { id: noticeA, resourceId: RESOURCE_IDS.instructorAnnouncements });
  assert.equal(database.tables.vault_announcements[0].content, 'Updated text');
  assert.equal(database.tables.vault_announcements[0].updated_by, teacherUser);
  assert.ok(database.calls.some(call => call.table === 'vault_instructor_access'
    && call.filters.some(([field, value]) => field === 'user_id' && value === userB)));
});

test('anonymous, judge, query-selected, and deeper announcement routes do not reach announcement rows', async () => {
  const { announcements, announcement, database } = makeHandlers();
  const anon = await announcements.fetch(request('/api/announcements'));
  const judge = await announcements.fetch(request('/api/announcements', 'GET', 'fixture-judge'));
  assert.equal(anon.status, 401);
  assert.equal(judge.status, 401);

  const callsBeforeInvalidPaths = database.calls.length;
  const queryRoute = await announcements.fetch(request('/api/announcements?mode=export', 'GET', 'Bearer token-a'));
  const deepRoute = await announcement.fetch(request(`/api/announcements/${noticeA}/export`, 'GET', 'Bearer token-a'));
  assert.equal(queryRoute.status, 404);
  assert.equal(deepRoute.status, 404);
  assert.equal(database.calls.length, callsBeforeInvalidPaths);
});

test('note item API rejects query selection and paths outside its exact resource depth', async () => {
  const { note, database } = makeHandlers();
  const before = database.calls.length;
  const wrongPrefix = await note.fetch(request(`/api/other/${noteA}`, 'GET', 'fixture-a'));
  const deeper = await note.fetch(request(`/api/notes/${noteA}/export`, 'GET', 'fixture-a'));
  const query = await note.fetch(request(`/api/notes/${noteA}?mode=export`, 'GET', 'fixture-a'));
  assert.deepEqual([wrongPrefix.status, deeper.status, query.status], [404, 404, 404]);
  assert.equal(database.calls.length, before);
});
