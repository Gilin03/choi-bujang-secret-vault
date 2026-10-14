import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import { decide, RULE_IDS } from '../src/decider.mjs';

const emptyQuerySha256 = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const noticeId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';

function request(overrides = {}) {
  return {
    schema: 'aleph.decision.v1',
    requestId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    classId: 'class_fixture',
    projectId: 'project_fixture',
    subjectId: 'learner_fixture',
    deviceId: '0123456789abcdef',
    service: 'notes',
    method: 'GET',
    path: `/notes/${noteId}`,
    route: 'GET /notes/:id',
    queryLength: 0,
    querySha256: emptyQuerySha256,
    at: '2026-10-13T00:00:00.000Z',
    policyRevision: 8,
    deviceRegistered: true,
    stepUp: { verified: false, authAgeSeconds: null },
    recentEvents: [],
    signals: { source: 'judge_fixture', region: 'local', network: 'usual', hour: 14 },
    ...overrides,
  };
}

test('resource zoning allows the dedicated self-list and exact note CRUD routes', async () => {
  const read = await decide(request());
  const ownList = await decide(request({ path: '/api/my/notes', route: 'GET /api/my/notes' }));
  const create = await decide(request({ method: 'POST', path: '/api/notes', route: 'POST /api/notes' }));
  const update = await decide(request({ method: 'PUT', path: `/api/notes/${noteId}`, route: 'PUT /api/notes/:id' }));
  const remove = await decide(request({ method: 'DELETE', path: `/api/notes/${noteId}`, route: 'DELETE /api/notes/:id' }));

  assert.deepEqual(RULE_IDS, ['device_registered', 'step_up_required', 'resource_zone']);
  assert.equal(read.decision, 'allow');
  assert.equal(ownList.decision, 'allow');
  assert.equal(create.decision, 'allow');
  assert.equal(update.decision, 'allow');
  assert.equal(remove.decision, 'allow');
  assert.ok(read.ruleIds.includes('resource_zone'));
  assert.ok(ownList.ruleIds.includes('resource_zone'));
  assert.ok(create.ruleIds.includes('resource_zone'));
  assert.ok(update.ruleIds.includes('resource_zone'));
  assert.ok(remove.ruleIds.includes('resource_zone'));
});

test('the ambiguous shared notes list is denied while the explicit self-list route is allowed', async () => {
  const ownList = await decide(request({ path: '/api/my/notes', route: 'GET /api/my/notes' }));
  const ambiguousApiList = await decide(request({ path: '/api/notes', route: 'GET /api/notes' }));
  const ambiguousLegacyList = await decide(request({ path: '/notes', route: 'GET /notes' }));

  assert.equal(ownList.decision, 'allow');
  for (const result of [ambiguousApiList, ambiguousLegacyList]) {
    assert.equal(result.decision, 'deny');
    assert.equal(result.reasonCode, 'route_not_allowed');
  }
});

test('safe opaque note IDs pass while reserved function IDs and announcement access are denied', async () => {
  const safeOpaqueId = await decide(request({
    path: '/api/notes/SAMPLE_NOTE_1',
    route: 'GET /api/notes/:id',
  }));
  assert.equal(safeOpaqueId.decision, 'allow');

  for (const id of ['export', 'all', 'list', 'search', 'bulk', 'shared', 'admin', 'backup']) {
    const result = await decide(request({
      path: `/api/notes/${id}`,
      route: 'GET /api/notes/:id',
    }));
    assert.equal(result.decision, 'deny', `function-like ID must be denied: ${id}`);
  }

  const noteWrite = await decide(request({ method: 'POST', path: '/api/notes', route: 'POST /api/notes' }));
  const instructorWrite = await decide(request({
    subjectId: 'instructor_fixture',
    service: 'announcements',
    method: 'PUT',
    path: `/announcements/${noticeId}`,
    route: 'PUT /announcements/:id',
  }));

  const announcementRead = await decide(request({
    service: 'announcements', method: 'GET', path: '/api/announcements', route: 'GET /api/announcements',
  }));

  assert.equal(noteWrite.decision, 'allow');
  assert.equal(instructorWrite.decision, 'deny');
  assert.equal(announcementRead.decision, 'deny');
});

test('route and path are normalized independently but otherwise must match exactly', async () => {
  const independentlyNormalized = await decide(request({
    path: `/api/notes/${noteId}`,
    route: 'GET /notes/:id',
  }));
  const mismatchedTemplate = await decide(request({
    path: `/api/notes/${noteId}`,
    route: 'GET /notes/:other',
  }));
  const mismatchedMethod = await decide(request({
    path: `/api/notes/${noteId}`,
    route: 'PUT /api/notes/:id',
  }));

  assert.equal(independentlyNormalized.decision, 'allow');
  assert.equal(mismatchedTemplate.decision, 'deny');
  assert.equal(mismatchedMethod.decision, 'deny');
});

test('resource zoning treats the deployed /api/notes item route as the same note resource', async () => {
  const canonical = await decide(request());
  const deployed = await decide(request({
    path: `/api/notes/${noteId}`,
    route: 'GET /api/notes/:id',
  }));

  assert.equal(deployed.decision, canonical.decision);
  assert.equal(deployed.reasonCode, canonical.reasonCode);
  assert.ok(deployed.ruleIds.includes('resource_zone'));

  const mismatchedRoute = await decide(request({
    path: `/api/notes/${noteId}`,
    route: 'GET /notes/:other',
  }));
  assert.equal(mismatchedRoute.decision, 'deny');
  assert.equal(mismatchedRoute.reasonCode, 'route_not_allowed');
});

test('the live no-signal contract does not block a normal personal-note request', async () => {
  const liveRequest = request({
    signals: { source: 'none', region: 'unknown', network: 'unknown', hour: null },
    recentEvents: [],
  });

  const result = await decide(liveRequest);

  assert.equal(result.decision, 'allow');
  assert.equal(result.reasonCode, 'approved');
});

test('announcement writes are denied regardless of a supplied role or subject name', async () => {
  const instructor = await decide(request({
    subjectId: 'instructor_fixture',
    service: 'announcements',
    method: 'PUT',
    path: `/announcements/${noticeId}`,
    route: 'PUT /announcements/:id',
  }));
  assert.equal(instructor.decision, 'deny');

  const student = await decide(request({
    role: 'instructor',
    service: 'announcements',
    method: 'PUT',
    path: `/announcements/${noticeId}`,
    route: 'PUT /announcements/:id',
  }));
  assert.equal(student.decision, 'deny');
  assert.equal(student.reasonCode, 'route_not_allowed');
  assert.ok(student.ruleIds.includes('resource_zone'));
});

test('allowedRoutes uses this project string schema for deployed Stage 8 API routes', async () => {
  const config = JSON.parse(await readFile(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  const routes = config.allowedRoutes;

  assert.deepEqual(routes, [
    'GET /api/my/notes',
    'POST /api/notes',
    'GET /api/notes/:id',
    'PUT /api/notes/:id',
    'DELETE /api/notes/:id',
    'POST /api/recovery/notes/:id',
    'GET /api/announcements',
    'GET /api/announcements/:id',
    'PUT /api/announcements/:id',
  ]);

  for (const route of [
    'GET /api/notes',
    'GET /notes/:id',
    'POST /api/auth-proxy/token',
    'GET /api/auth-proxy/user',
    'POST /api/auth-proxy/logout',
  ]) assert.ok(!routes.includes(route), `unexpected allowed route: ${route}`);
});

test('unknown paths, methods, services, query-selected actions, and unregistered devices are denied', async () => {
  const unknownPath = await decide(request({
    path: `/notes/${noteId}/export`,
    route: 'GET /notes/:id/export',
  }));
  const unknownMethod = await decide(request({ method: 'PATCH', route: 'PATCH /notes/:id' }));
  const unknownService = await decide(request({ service: 'unknown' }));
  const queryOperation = await decide(request({ queryLength: 8 }));
  const unregistered = await decide(request({ deviceRegistered: false }));

  for (const result of [unknownPath, unknownMethod, unknownService, queryOperation]) {
    assert.equal(result.decision, 'deny');
    assert.equal(result.reasonCode, 'route_not_allowed');
    assert.ok(result.ruleIds.includes('resource_zone'));
  }
  assert.equal(unregistered.decision, 'deny');
  assert.equal(unregistered.reasonCode, 'device_not_registered');
});
