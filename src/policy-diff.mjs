import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';

const SAFE_POLICY_SHA256 = 'e3850dd65a8150829385b582c44e213f7af912842ab64dc7e0ea84e5da211b8b';
const SNAPSHOT_PATH = new URL('../policies/stage9-safe-policy.json', import.meta.url);
const CONFIG_PATH = fileURLToPath(new URL('../aleph.config.json', import.meta.url));
const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const SOURCE_PATHS = ['aleph.config.json', 'src/decider.mjs'];
const HEX_SHA256 = /^[a-f0-9]{64}$/u;
const HEX_GIT_OBJECT = /^[a-f0-9]{40}$/u;

function fail(code) {
  throw new Error(code);
}

function sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function validateSnapshotPayload(payload) {
  if (!isRecord(payload) || payload.schema !== 'aleph.policy-snapshot.payload.v1'
      || !Number.isInteger(payload.policyVersion) || payload.policyVersion < 1
      || typeof payload.policyRevision !== 'string' || !HEX_GIT_OBJECT.test(payload.policyRevision)
      || typeof payload.capturedFromCommit !== 'string' || !HEX_GIT_OBJECT.test(payload.capturedFromCommit)
      || !isRecord(payload.sourceBlobs) || !isRecord(payload.policy)
      || !validStringArray(payload.policy.RULE_IDS)
      || !validStringArray(payload.policy.allowedRoutes)) {
    fail('safe_policy_snapshot_invalid');
  }

  const sourcePaths = Object.keys(payload.sourceBlobs).sort();
  if (!isDeepStrictEqual(sourcePaths, [...SOURCE_PATHS].sort())
      || SOURCE_PATHS.some(path => !HEX_GIT_OBJECT.test(payload.sourceBlobs[path]))) {
    fail('safe_policy_source_verification_failed');
  }
}

function verifyGitSource(payload, repositoryRoot) {
  try {
    const commit = execFileSync('git', ['rev-parse', '--verify', `${payload.capturedFromCommit}^{commit}`], {
      cwd: repositoryRoot,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (commit !== payload.capturedFromCommit || payload.policyRevision !== commit) return false;

    return SOURCE_PATHS.every(path => {
      const blob = execFileSync('git', ['rev-parse', `${commit}:${path}`], {
        cwd: repositoryRoot,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return blob === payload.sourceBlobs[path];
    });
  } catch {
    return false;
  }
}

export async function readVerifiedSnapshot({
  snapshotPath = SNAPSHOT_PATH,
  expectedFileSha256 = SAFE_POLICY_SHA256,
  repositoryRoot = REPOSITORY_ROOT,
  verifySource = verifyGitSource,
} = {}) {
  let bytes;
  try {
    bytes = await readFile(snapshotPath);
  } catch (error) {
    if (error?.code === 'ENOENT') fail('safe_policy_snapshot_missing');
    fail('safe_policy_snapshot_unreadable');
  }

  if (typeof expectedFileSha256 !== 'string' || !HEX_SHA256.test(expectedFileSha256)
      || sha256(bytes) !== expectedFileSha256) {
    fail('safe_policy_integrity_failed');
  }

  let document;
  try {
    document = JSON.parse(bytes.toString('utf8'));
  } catch {
    fail('safe_policy_snapshot_invalid');
  }

  if (!isRecord(document) || typeof document.sha256 !== 'string' || !HEX_SHA256.test(document.sha256)) {
    fail('safe_policy_integrity_failed');
  }
  const { sha256: embeddedHash, ...payload } = document;
  if (sha256(Buffer.from(JSON.stringify(payload))) !== embeddedHash) {
    fail('safe_policy_integrity_failed');
  }

  validateSnapshotPayload(payload);
  let sourceVerified = false;
  try {
    sourceVerified = await verifySource(payload, repositoryRoot);
  } catch {
    sourceVerified = false;
  }
  if (sourceVerified !== true) fail('safe_policy_source_verification_failed');

  return payload;
}

async function readCurrentTestPolicy() {
  const [{ RULE_IDS }, configText] = await Promise.all([
    import('./decider.mjs'),
    readFile(CONFIG_PATH, 'utf8'),
  ]);
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    fail('current_test_policy_invalid');
  }
  if (!validStringArray(RULE_IDS) || !validStringArray(config?.allowedRoutes)) {
    fail('current_test_policy_invalid');
  }
  return { RULE_IDS: [...RULE_IDS], allowedRoutes: [...config.allowedRoutes] };
}

export async function comparePolicy(options = {}) {
  const snapshot = await readVerifiedSnapshot(options);
  const currentPolicy = await (options.loadCurrentPolicy ?? readCurrentTestPolicy)();
  if (!isRecord(currentPolicy) || !validStringArray(currentPolicy.RULE_IDS)
      || !validStringArray(currentPolicy.allowedRoutes)) {
    fail('current_test_policy_invalid');
  }

  const changes = [];
  for (const field of ['RULE_IDS', 'allowedRoutes']) {
    if (!isDeepStrictEqual(currentPolicy[field], snapshot.policy[field])) {
      changes.push({
        field,
        current: [...currentPolicy[field]],
        safeCopy: [...snapshot.policy[field]],
      });
    }
  }

  return {
    targetPolicy: { version: snapshot.policyVersion, revision: snapshot.policyRevision },
    targetEnvironment: 'test',
    changes,
  };
}
