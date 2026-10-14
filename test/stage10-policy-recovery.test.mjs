import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  createPolicyRestorePreview,
  restoreTestPolicy,
  verifyPolicySnapshotIntegrity,
} from '../src/stage10-policy-recovery.mjs';
import safePolicy from '../policy/verified-policy.json' with { type: 'json' };

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

  assert.equal(preview.policyRevision, '7870df1452c9cd3a045c3edfa7171d452bc653da');
  assert.equal(preview.policySha256, safePolicy.sha256);
  assert.deepEqual(preview.addedRules, []);
  assert.deepEqual(preview.removedRules, ['unexpected_rule']);
  assert.deepEqual(preview.routeChanges, [
    { change: 'add', service: 'notes', method: 'GET', pathPattern: '/api/my/notes', zone: 'personal_notes' },
    { change: 'remove', service: 'notes', method: 'GET', pathPattern: '/api/notes', zone: 'personal_notes' },
  ]);
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
