import { createHash } from 'node:crypto';

const SNAPSHOT_SCHEMA = 'aleph.stage10.policy-snapshot.v1';
const TEST_POLICY_SCHEMA = 'aleph.stage10.test-policy.v1';
const RULE_ID = /^[a-z][a-z0-9_.-]{0,79}$/u;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function fail(message) {
  throw new Error(message);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

function sameStrings(left, right) {
  return Array.isArray(left) && Array.isArray(right)
    && left.length === right.length && left.every((value, index) => value === right[index]);
}

function validateSnapshot(snapshot, verifiedSource) {
  if (!isRecord(snapshot) || snapshot.schema !== SNAPSHOT_SCHEMA
      || snapshot.snapshotId !== 'stage9-safe-policy'
      || !isRecord(snapshot.source) || !isRecord(snapshot.scope)
      || snapshot.scope.service !== 'notes' || snapshot.scope.property !== 'rules'
      || !Array.isArray(snapshot.safeRules) || snapshot.safeRules.length === 0
      || snapshot.safeRules.some((rule) => typeof rule !== 'string' || !RULE_ID.test(rule))) {
    fail('검증된 안전 정책 사본이 없거나 형식이 올바르지 않습니다. 복원을 중단합니다.');
  }
  if (!isRecord(verifiedSource)
      || snapshot.source.commit !== verifiedSource.commit
      || snapshot.source.path !== verifiedSource.path
      || snapshot.source.gitBlob !== verifiedSource.gitBlob
      || !sameStrings(snapshot.safeRules, verifiedSource.ruleIds)) {
    fail('안전 정책 사본의 Git 출처 또는 규칙 지문을 확인할 수 없습니다. 복원을 중단합니다.');
  }
}

function validateTestPolicy(policy) {
  if (!isRecord(policy) || policy.schema !== TEST_POLICY_SCHEMA
      || !isRecord(policy.services) || !isRecord(policy.services.notes)
      || !Array.isArray(policy.services.notes.rules)
      || policy.services.notes.rules.some((rule) => typeof rule !== 'string' || !RULE_ID.test(rule))
      || !Array.isArray(policy.auditHistory)) {
    fail('시험 정책이 없거나 형식이 올바르지 않습니다. 복원을 중단합니다.');
  }
}

function confirmationFor(snapshot, currentPolicy) {
  return digest(JSON.stringify({
    snapshotId: snapshot.snapshotId,
    sourceCommit: snapshot.source.commit,
    sourceBlob: snapshot.source.gitBlob,
    currentPolicy: digest(JSON.stringify(currentPolicy)),
    target: 'services.notes.rules',
  }));
}

export function createPolicyRestorePreview({ snapshot, currentPolicy, verifiedSource }) {
  validateSnapshot(snapshot, verifiedSource);
  validateTestPolicy(currentPolicy);
  const currentRules = currentPolicy.services.notes.rules;
  const safeRules = snapshot.safeRules;
  return {
    scope: 'services.notes.rules',
    sourceCommit: snapshot.source.commit,
    currentRules: [...currentRules],
    safeRules: [...safeRules],
    addedRules: safeRules.filter((rule) => !currentRules.includes(rule)).sort(),
    removedRules: currentRules.filter((rule) => !safeRules.includes(rule)).sort(),
    confirmationToken: confirmationFor(snapshot, currentPolicy),
  };
}

export function restoreTestPolicy({ snapshot, currentPolicy, verifiedSource,
  confirmationToken, at = new Date().toISOString() }) {
  const preview = createPolicyRestorePreview({ snapshot, currentPolicy, verifiedSource });
  if (typeof confirmationToken !== 'string' || confirmationToken !== preview.confirmationToken) {
    fail('미리보기 확인값이 일치하지 않습니다. 정책은 변경하지 않았습니다.');
  }
  if (!Number.isFinite(Date.parse(at))) fail('복원 감사 시각이 올바르지 않습니다.');

  const restored = structuredClone(currentPolicy);
  restored.services.notes.rules = [...snapshot.safeRules];
  restored.auditHistory.push({
    action: 'test_policy_restored',
    snapshotId: snapshot.snapshotId,
    sourceCommit: snapshot.source.commit,
    at,
    addedRules: preview.addedRules,
    removedRules: preview.removedRules,
  });
  return restored;
}
