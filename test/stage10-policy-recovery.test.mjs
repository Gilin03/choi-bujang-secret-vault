import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPolicyRestorePreview,
  restoreTestPolicy,
  verifyPolicySnapshotIntegrity,
} from '../src/stage10-policy-recovery.mjs';
import { classifyResourceRequest } from '../src/resource-zones.mjs';
import safePolicy from '../policy/verified-policy.json' with { type: 'json' };
import config from '../aleph.config.json' with { type: 'json' };

test('policy preview verifies the snapshot and lists the exact safe-policy delta', () => {
  const currentPolicy = {
    rules: [...safePolicy.rules, 'unexpected_rule'],
    routes: [
      ...safePolicy.routes.filter((route) => route.pathPattern !== '/api/my/notes'),
      { service: 'notes', method: 'GET', pathPattern: '/api/notes', zone: 'personal_notes' },
      { service: 'other', method: 'GET', pathPattern: '/api/status', zone: 'health' },
    ],
    auditHistory: [{ action: 'before' }],
  };

  const preview = createPolicyRestorePreview({ snapshot: safePolicy, currentPolicy });

  assert.equal(preview.policyRevision, safePolicy.policyRevision);
  assert.equal(preview.policySha256, safePolicy.sha256);
  assert.deepEqual(preview.addedRules, []);
  assert.deepEqual(preview.removedRules, ['unexpected_rule']);
  assert.deepEqual(preview.routeChanges, [
    { change: 'add', service: 'notes', method: 'GET', pathPattern: '/api/my/notes', zone: 'personal_notes' },
    { change: 'remove', service: 'notes', method: 'GET', pathPattern: '/api/notes', zone: 'personal_notes' },
  ]);
});

test('10단계 복구 POST는 구역으로 분류되고 검증한 정책 사본에 포함된다', () => {
  const request = {
    classId: 'class-a', projectId: 'project-a', subjectId: 'opaque-subject', deviceId: '0123456789abcdef',
    service: 'notes', method: 'POST', path: '/api/recovery/notes/abc_123',
    route: 'POST /api/recovery/notes/:id', queryLength: 0,
  };
  assert.deepEqual(classifyResourceRequest(request), {
    resourceId: 'student_notes', operation: 'restore',
  });
  assert.ok(safePolicy.routes.some((route) => route.service === 'notes'
    && route.method === 'POST' && route.pathPattern === '/api/recovery/notes/:id'));
});

test('submission restoreRoute is a URL path and matches the POST allow route', () => {
  assert.equal(config.restoreRoute, '/api/recovery/notes/:id');
  assert.ok(config.allowedRoutes.includes(`POST ${config.restoreRoute}`));
});

test('an invalid policy snapshot is rejected before a test policy can be restored', () => {
  const currentPolicy = { rules: [], routes: [], auditHistory: [] };
  const tampered = { ...safePolicy, sha256: '0'.repeat(64) };

  assert.throws(() => verifyPolicySnapshotIntegrity(tampered), /hash|검증|해시/iu);
  assert.throws(() => createPolicyRestorePreview({ snapshot: tampered, currentPolicy }), /hash|검증|해시/iu);
});

test('confirmed policy restore changes only the snapshotted services and appends audit history', () => {
  const currentPolicy = {
    rules: [...safePolicy.rules],
    routes: [
      ...safePolicy.routes.filter((route) => route.pathPattern !== '/api/my/notes'),
      { service: 'notes', method: 'GET', pathPattern: '/api/notes', zone: 'personal_notes' },
      { service: 'other', method: 'GET', pathPattern: '/api/status', zone: 'health' },
    ],
    auditHistory: [{ action: 'before' }],
  };
  const preview = createPolicyRestorePreview({ snapshot: safePolicy, currentPolicy });
  const restored = restoreTestPolicy({ snapshot: safePolicy, currentPolicy, confirmed: true, at: '2026-10-14T00:00:00.000Z' });

  assert.deepEqual(restored.routes.filter((route) => route.service === 'notes'), safePolicy.routes.filter((route) => route.service === 'notes'));
  assert.deepEqual(restored.routes.find((route) => route.service === 'other'), currentPolicy.routes.at(-1));
  assert.deepEqual(restored.auditHistory[0], { action: 'before' });
  assert.equal(restored.auditHistory.length, 2);
  assert.equal(restored.auditHistory[1].action, 'test_policy_restored');
  assert.equal(restored.auditHistory[1].policySha256, preview.policySha256);
});
