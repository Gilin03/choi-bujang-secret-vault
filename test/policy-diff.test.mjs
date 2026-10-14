import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { comparePolicy, readVerifiedSnapshot } from '../src/policy-diff.mjs';

test('checked-out pinned Stage 9 copy validates against real Git provenance on this platform', async () => {
  const snapshot = await readVerifiedSnapshot();
  assert.equal(snapshot.policyRevision, 'e34c7b95ced93f13cc5abeb2bac720e70a85ad2b');
});

const commit = 'e34c7b95ced93f13cc5abeb2bac720e70a85ad2b';
const payload = {
  schema: 'aleph.policy-snapshot.payload.v1',
  policyVersion: 9,
  policyRevision: commit,
  capturedFromCommit: commit,
  sourceBlobs: {
    'src/decider.mjs': 'c03f86ab003ead5a29d325d16b2dbdcb68e3ffd0',
    'aleph.config.json': 'a1b838385ceeef5c3e5b53250da117d0c0168d45',
  },
  policy: {
    RULE_IDS: ['device_registered', 'step_up_required', 'resource_zone'],
    allowedRoutes: ['GET /api/my/notes', 'POST /api/notes'],
  },
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeSnapshot(overrides = {}) {
  const content = { ...payload, ...overrides };
  const embeddedHash = sha256(Buffer.from(JSON.stringify(content)));
  const bytes = Buffer.from(`${JSON.stringify({ ...content, sha256: embeddedHash }, null, 2)}\n`);
  return { bytes, fileHash: sha256(bytes) };
}

async function withSnapshot(bytes, run) {
  const directory = await mkdtemp(join(tmpdir(), 'aleph-policy-diff-'));
  const snapshotPath = join(directory, 'safe-policy.json');
  try {
    await writeFile(snapshotPath, bytes);
    await run(snapshotPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test('comparison rereads and verifies the snapshot before returning a read-only change preview', async () => {
  const { bytes, fileHash } = makeSnapshot();
  await withSnapshot(bytes, async snapshotPath => {
    const options = {
      snapshotPath,
      expectedFileSha256: fileHash,
      verifySource: async () => true,
      loadCurrentPolicy: async () => ({
        RULE_IDS: ['device_registered', 'step_up_required', 'resource_zone'],
        allowedRoutes: ['GET /api/my/notes', 'POST /api/notes', 'DELETE /api/notes/:id'],
      }),
    };

    const first = await comparePolicy(options);
    assert.deepEqual(first, {
      targetPolicy: { version: 9, revision: commit },
      targetEnvironment: 'test',
      changes: [{
        field: 'allowedRoutes',
        current: ['GET /api/my/notes', 'POST /api/notes', 'DELETE /api/notes/:id'],
        safeCopy: ['GET /api/my/notes', 'POST /api/notes'],
      }],
    });

    await writeFile(snapshotPath, Buffer.from(`${bytes.toString()} `));
    await assert.rejects(comparePolicy(options), /safe_policy_integrity_failed/u);
  });
});

test('a missing safe policy copy stops comparison', async () => {
  const missingPath = join(tmpdir(), 'aleph-policy-diff-missing', 'safe-policy.json');
  await assert.rejects(readVerifiedSnapshot({
    snapshotPath: missingPath,
    expectedFileSha256: '0'.repeat(64),
    verifySource: async () => true,
  }), /safe_policy_snapshot_missing/u);
});

test('a policy copy with a changed file hash stops before source verification', async () => {
  const { bytes } = makeSnapshot();
  await withSnapshot(bytes, async snapshotPath => {
    let sourceChecked = false;
    await assert.rejects(readVerifiedSnapshot({
      snapshotPath,
      expectedFileSha256: '0'.repeat(64),
      verifySource: async () => { sourceChecked = true; return true; },
    }), /safe_policy_integrity_failed/u);
    assert.equal(sourceChecked, false);
  });
});

test('a policy copy whose Git provenance does not verify stops comparison', async () => {
  const { bytes, fileHash } = makeSnapshot();
  await withSnapshot(bytes, async snapshotPath => {
    await assert.rejects(readVerifiedSnapshot({
      snapshotPath,
      expectedFileSha256: fileHash,
      verifySource: async () => false,
    }), /safe_policy_source_verification_failed/u);
  });
});

test('a valid checksum cannot hide a stale embedded SHA-256 value', async () => {
  const { bytes } = makeSnapshot({
    policy: { ...payload.policy, RULE_IDS: ['tampered_rule'] },
  });
  const staleEmbeddedHash = Buffer.from(bytes.toString().replace(
    /"sha256": "[a-f0-9]{64}"/u,
    `"sha256": "${'0'.repeat(64)}"`,
  ));

  await withSnapshot(staleEmbeddedHash, async snapshotPath => {
    await assert.rejects(readVerifiedSnapshot({
      snapshotPath,
      expectedFileSha256: sha256(staleEmbeddedHash),
      verifySource: async () => true,
    }), /safe_policy_integrity_failed/u);
  });
});
