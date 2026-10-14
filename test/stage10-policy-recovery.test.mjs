import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { test } from 'node:test';
import {
  createPolicyRestorePreview,
  policySnapshotSha256,
  restoreTestPolicy,
} from '../src/stage10-policy-recovery.mjs';

test('stage 10 config declares the recovery endpoint without widening decider routes', async () => {
  const config = JSON.parse(await readFile(new URL('../aleph.config.json', import.meta.url), 'utf8'));
  assert.ok(config.step >= 10);
  assert.equal(config.restoreRoute, 'POST /api/recovery/notes/:id');
  assert.ok(!config.allowedRoutes.includes(config.restoreRoute));
});

test('decider source uses only documented identity names, never role or browser identity fields', async () => {
  const sourceText = await readFile(new URL('../src/decider.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(sourceText, /request\??\.(?:role|userRole|roles|identity|device)\b/u);
});

const source = {
  commit: '1'.repeat(40),
  path: 'src/decider.mjs',
  gitBlob: '2'.repeat(40),
  ruleIds: ['device_registered', 'step_up_required', 'resource_zone'],
};
const snapshotPayload = {
  schema: 'aleph.stage10.policy-snapshot.v1',
  snapshotId: 'stage9-safe-policy',
  source,
  scope: { service: 'notes', property: 'rules' },
  safeRules: ['device_registered', 'step_up_required', 'resource_zone'],
};
const snapshot = { ...snapshotPayload, sha256: policySnapshotSha256(snapshotPayload) };

function changedPolicy() {
  return {
    schema: 'aleph.stage10.test-policy.v1',
    revision: 'lab-current',
    services: {
      notes: { rules: ['device_registered', 'public_note_export'] },
      announcements: { rules: ['read_announcements'] },
      instructor_materials: { rules: ['read_materials'] },
    },
    auditHistory: [{ eventId: 'audit-before-restore', action: 'test_policy_changed' }],
  };
}

test('policy restore refuses a missing or unverified safe snapshot', () => {
  assert.throws(() => createPolicyRestorePreview({
    snapshot: null,
    currentPolicy: changedPolicy(),
    verifiedSource: source,
  }), /안전 정책 사본/u);
  assert.throws(() => createPolicyRestorePreview({
    snapshot,
    currentPolicy: changedPolicy(),
    verifiedSource: { ...source, gitBlob: '3'.repeat(40) },
  }), /Git 출처/u);
  assert.throws(() => createPolicyRestorePreview({
    snapshot: { ...snapshot, sha256: '0'.repeat(64) },
    currentPolicy: changedPolicy(),
    verifiedSource: source,
  }), /해시/u);
});

test('preview shows the exact notes rule delta without changing policy', () => {
  const current = changedPolicy();
  const before = structuredClone(current);
  const preview = createPolicyRestorePreview({ snapshot, currentPolicy: current, verifiedSource: source });

  assert.equal(preview.scope, 'services.notes.rules');
  assert.equal(preview.policyRevision, snapshot.source.commit);
  assert.equal(preview.policySha256, snapshot.sha256);
  assert.deepEqual(preview.currentRules, ['device_registered', 'public_note_export']);
  assert.deepEqual(preview.safeRules, snapshot.safeRules);
  assert.deepEqual(preview.removedRules, ['public_note_export']);
  assert.deepEqual(preview.addedRules, ['resource_zone', 'step_up_required']);
  assert.deepEqual(current, before);
});

test('restore requires an explicit apply flag and preserves unrelated rules and audit history', () => {
  const current = changedPolicy();

  assert.throws(() => restoreTestPolicy({
    snapshot, currentPolicy: current, verifiedSource: source,
    at: '2026-10-14T00:00:00.000Z',
  }), /--apply/u);

  const restored = restoreTestPolicy({
    snapshot, currentPolicy: current, verifiedSource: source,
    confirmed: true, at: '2026-10-14T00:00:00.000Z',
  });

  assert.deepEqual(restored.services.notes.rules, snapshot.safeRules);
  assert.deepEqual(restored.services.announcements, current.services.announcements);
  assert.deepEqual(restored.services.instructor_materials, current.services.instructor_materials);
  assert.deepEqual(restored.auditHistory[0], current.auditHistory[0]);
  assert.equal(restored.auditHistory.length, 2);
  assert.equal(restored.auditHistory[1].action, 'test_policy_restored');
  assert.equal(restored.auditHistory[1].snapshotId, snapshot.snapshotId);
});
