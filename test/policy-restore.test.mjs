import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';
import { applyPolicyRestore } from '../src/policy-restore.mjs';

const commit = 'e34c7b95ced93f13cc5abeb2bac720e70a85ad2b';
const safePolicy = {
  RULE_IDS: ['device_registered', 'step_up_required', 'resource_zone'],
  allowedRoutes: [
    'GET /api/my/notes',
    'POST /api/notes',
    'GET /api/notes/:id',
    'PUT /api/notes/:id',
    'DELETE /api/notes/:id',
    'GET /api/announcements',
    'GET /api/announcements/:id',
    'PUT /api/announcements/:id',
  ],
};
const currentPolicy = {
  RULE_IDS: [...safePolicy.RULE_IDS, 'unexpected_rule'],
  allowedRoutes: [...safePolicy.allowedRoutes, 'GET /api/notes/bulk'],
};

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function makeSnapshot() {
  const payload = {
    schema: 'aleph.policy-snapshot.payload.v1',
    policyVersion: 9,
    policyRevision: commit,
    capturedFromCommit: commit,
    sourceBlobs: {
      'src/decider.mjs': 'c03f86ab003ead5a29d325d16b2dbdcb68e3ffd0',
      'aleph.config.json': 'a1b838385ceeef5c3e5b53250da117d0c0168d45',
    },
    policy: safePolicy,
  };
  const document = { ...payload, sha256: sha256(Buffer.from(JSON.stringify(payload))) };
  const bytes = Buffer.from(`${JSON.stringify(document, null, 2)}\n`);
  return { bytes, fileHash: sha256(bytes) };
}

function extractCurrentRules(source) {
  const match = /export const RULE_IDS = Object\.freeze\((\[[\s\S]*?\])\);/u.exec(source);
  assert.ok(match);
  return JSON.parse(match[1].replaceAll("'", '"'));
}

async function createFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'aleph-policy-restore-'));
  const snapshotPath = join(directory, 'safe-policy.json');
  const deciderPath = join(directory, 'src', 'decider.mjs');
  const configPath = join(directory, 'aleph.config.json');
  const deciderBefore = [
    '// Keep this function body unchanged.',
    "export const RULE_IDS = Object.freeze(['device_registered', 'step_up_required', 'resource_zone', 'unexpected_rule']);",
    'export async function decide(request) { return request; }',
    '',
  ].join('\n');
  const configBefore = JSON.stringify({
    step: 9,
    repoUrl: 'https://example.invalid/student',
    allowedRoutes: currentPolicy.allowedRoutes,
    judgeIssuer: 'https://example.invalid/judge',
    originalApiUrl: 'https://example.invalid/rest/v1/vault_notes',
    otherServiceRules: ['preserve-me'],
    restoreRoute: null,
  }, null, 2) + '\n';
  const { bytes, fileHash } = makeSnapshot();
  await mkdir(join(directory, 'src'));
  await writeFile(snapshotPath, bytes);
  await writeFile(deciderPath, deciderBefore);
  await writeFile(configPath, configBefore);

  return {
    directory,
    snapshotPath,
    deciderPath,
    configPath,
    deciderBefore,
    configBefore,
    previewOptions: {
      snapshotPath,
      expectedFileSha256: fileHash,
      repositoryRoot: directory,
      verifySource: async () => true,
      loadCurrentPolicy: async () => ({
        RULE_IDS: extractCurrentRules(await readFile(deciderPath, 'utf8')),
        allowedRoutes: JSON.parse(await readFile(configPath, 'utf8')).allowedRoutes,
      }),
    },
  };
}

test('preview without explicit apply and revision confirmation leaves policy files unchanged', async () => {
  const fixture = await createFixture();
  try {
    const result = await applyPolicyRestore({
      confirmRevision: commit,
      previewOptions: fixture.previewOptions,
      deciderPath: fixture.deciderPath,
      configPath: fixture.configPath,
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'explicit_apply_required');
    assert.deepEqual(result.modifiedFiles, []);
    assert.equal(await readFile(fixture.deciderPath, 'utf8'), fixture.deciderBefore);
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBefore);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('wrong revision confirmation leaves policy files unchanged', async () => {
  const fixture = await createFixture();
  try {
    const result = await applyPolicyRestore({
      apply: true,
      confirmRevision: 'wrong-revision',
      previewOptions: fixture.previewOptions,
      deciderPath: fixture.deciderPath,
      configPath: fixture.configPath,
    });

    assert.equal(result.applied, false);
    assert.equal(result.reason, 'confirmation_mismatch');
    assert.deepEqual(result.modifiedFiles, []);
    assert.equal(await readFile(fixture.deciderPath, 'utf8'), fixture.deciderBefore);
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBefore);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('explicit apply restores only RULE_IDS and allowedRoutes while preserving other file content', async () => {
  const fixture = await createFixture();
  try {
    const result = await applyPolicyRestore({
      apply: true,
      confirmRevision: commit,
      previewOptions: fixture.previewOptions,
      deciderPath: fixture.deciderPath,
      configPath: fixture.configPath,
    });

    const deciderAfter = await readFile(fixture.deciderPath, 'utf8');
    const configAfter = JSON.parse(await readFile(fixture.configPath, 'utf8'));
    assert.equal(result.applied, true);
    assert.deepEqual(result.modifiedFiles, ['src/decider.mjs', 'aleph.config.json']);
    assert.deepEqual(extractCurrentRules(deciderAfter), safePolicy.RULE_IDS);
    assert.equal(deciderAfter.replace(/export const RULE_IDS = Object\.freeze\(\[[\s\S]*?\]\);/u, ''),
      fixture.deciderBefore.replace(/export const RULE_IDS = Object\.freeze\(\[[\s\S]*?\]\);/u, ''));
    assert.deepEqual(configAfter.allowedRoutes, safePolicy.allowedRoutes);
    assert.equal(configAfter.step, 9);
    assert.equal(configAfter.repoUrl, 'https://example.invalid/student');
    assert.equal(configAfter.judgeIssuer, 'https://example.invalid/judge');
    assert.equal(configAfter.originalApiUrl, 'https://example.invalid/rest/v1/vault_notes');
    assert.deepEqual(configAfter.otherServiceRules, ['preserve-me']);
    assert.equal(configAfter.restoreRoute, null);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test('failed safe-copy verification leaves policy files unchanged', async () => {
  const fixture = await createFixture();
  try {
    const options = {
      ...fixture.previewOptions,
      verifySource: async () => false,
    };
    await assert.rejects(applyPolicyRestore({
      apply: true,
      confirmRevision: commit,
      previewOptions: options,
      deciderPath: fixture.deciderPath,
      configPath: fixture.configPath,
    }), /safe_policy_source_verification_failed/u);

    assert.equal(await readFile(fixture.deciderPath, 'utf8'), fixture.deciderBefore);
    assert.equal(await readFile(fixture.configPath, 'utf8'), fixture.configBefore);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
