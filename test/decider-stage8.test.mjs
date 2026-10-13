import assert from 'node:assert/strict';
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

test('resource zoning keeps a registered student on the personal note read/update routes', async () => {
  const read = await decide(request());
  const update = await decide(request({ method: 'PUT', route: 'PUT /notes/:id' }));

  assert.deepEqual(RULE_IDS, ['device_registered', 'step_up_required', 'resource_zone']);
  assert.equal(read.decision, 'allow');
  assert.equal(update.decision, 'allow');
  assert.ok(read.ruleIds.includes('resource_zone'));
  assert.ok(update.ruleIds.includes('resource_zone'));
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

test('only the engine-mapped instructor fixture can update announcement resources', async () => {
  const instructor = await decide(request({
    subjectId: 'instructor_fixture',
    service: 'announcements',
    method: 'PUT',
    path: `/announcements/${noticeId}`,
    route: 'PUT /announcements/:id',
  }));
  assert.equal(instructor.decision, 'allow');

  const student = await decide(request({
    role: 'instructor',
    service: 'announcements',
    method: 'PUT',
    path: `/announcements/${noticeId}`,
    route: 'PUT /announcements/:id',
  }));
  assert.equal(student.decision, 'deny');
  assert.equal(student.reasonCode, 'resource_not_authorized');
  assert.ok(student.ruleIds.includes('resource_zone'));
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
    assert.equal(result.reasonCode, 'resource_not_authorized');
    assert.ok(result.ruleIds.includes('resource_zone'));
  }
  assert.equal(unregistered.decision, 'deny');
  assert.equal(unregistered.reasonCode, 'device_not_registered');
});
