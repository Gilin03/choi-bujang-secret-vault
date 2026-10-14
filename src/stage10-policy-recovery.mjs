import { createHash } from 'node:crypto';

const SNAPSHOT_SCHEMA = 'aleph.stage10.policy-snapshot.v1';
const COMMIT = /^[0-9a-f]{40}$/iu;
const BLOB = /^[0-9a-f]{40}$/iu;
export const VERIFIED_POLICY_SHA256 = '076831225abcc08c063a61536d3532343c779ea8aa1e786a5f0caef260d5c37a';

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (!isRecord(value)) return value;
  return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]));
}

function sortedRoutes(routes) {
  return [...routes].map(({ service, method, pathPattern, zone }) => ({ service, method, pathPattern, zone }))
    .sort((a, b) => `${a.service} ${a.method} ${a.pathPattern}`.localeCompare(`${b.service} ${b.method} ${b.pathPattern}`));
}

function policyPayload(snapshot) {
  return {
    schema: snapshot.schema,
    snapshotId: snapshot.snapshotId,
    source: snapshot.source,
    rules: [...snapshot.rules].sort(),
    routes: sortedRoutes(snapshot.routes),
  };
}

export function policySnapshotSha256(snapshot) {
  if (!isRecord(snapshot) || !Array.isArray(snapshot.rules) || !Array.isArray(snapshot.routes)) return null;
  return createHash('sha256').update(JSON.stringify(canonical(policyPayload(snapshot))), 'utf8').digest('hex');
}

export function verifyPolicySnapshotIntegrity(snapshot) {
  if (!isRecord(snapshot) || snapshot.schema !== SNAPSHOT_SCHEMA
      || snapshot.snapshotId !== 'stage9-safe-policy'
      || !isRecord(snapshot.source) || !COMMIT.test(snapshot.source.commit ?? '')
      || snapshot.source.path !== 'src/decider.mjs' || !BLOB.test(snapshot.source.gitBlob ?? '')
      || snapshot.source.configPath !== 'aleph.config.json' || !BLOB.test(snapshot.source.configGitBlob ?? '')
      || !Array.isArray(snapshot.rules) || snapshot.rules.length === 0
      || snapshot.rules.some((rule) => typeof rule !== 'string' || !/^[a-z][a-z0-9_.-]{0,79}$/u.test(rule))
      || !Array.isArray(snapshot.routes) || snapshot.routes.length === 0
      || snapshot.routes.some((route) => !isRecord(route)
        || typeof route.service !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/u.test(route.service)
        || typeof route.method !== 'string' || !/^(GET|POST|PUT|PATCH|DELETE)$/u.test(route.method)
        || typeof route.pathPattern !== 'string' || !route.pathPattern.startsWith('/')
        || typeof route.zone !== 'string' || !/^[a-z][a-z0-9_-]{0,39}$/u.test(route.zone))
      || typeof snapshot.sha256 !== 'string' || !/^[0-9a-f]{64}$/iu.test(snapshot.sha256)
      || policySnapshotSha256(snapshot) !== snapshot.sha256.toLowerCase()
      || snapshot.sha256.toLowerCase() !== VERIFIED_POLICY_SHA256) {
    throw new Error('검증된 안전 정책 사본이 없거나 해시가 맞지 않습니다. 복원을 중단합니다.');
  }
  return snapshot;
}

function routeKey(route) {
  return `${route.service} ${route.method} ${route.pathPattern}`;
}

function routeDiff(snapshot, currentPolicy) {
  const services = new Set(snapshot.routes.map((route) => route.service));
  const expected = new Map(snapshot.routes.map((route) => [routeKey(route), route]));
  const current = new Map(currentPolicy.routes.filter((route) => services.has(route.service))
    .map((route) => [routeKey(route), route]));
  const changes = [];
  for (const [key, route] of expected) {
    if (!current.has(key)) changes.push({ change: 'add', ...route });
    else if (current.get(key).zone !== route.zone) {
      changes.push({ change: 'zone', ...route, from: current.get(key).zone });
    }
  }
  for (const [key, route] of current) {
    if (!expected.has(key)) changes.push({ change: 'remove', ...route });
  }
  return changes.sort((a, b) => routeKey(a).localeCompare(routeKey(b)));
}

export function createPolicyRestorePreview({ snapshot, currentPolicy }) {
  verifyPolicySnapshotIntegrity(snapshot);
  if (!isRecord(currentPolicy) || !Array.isArray(currentPolicy.rules) || !Array.isArray(currentPolicy.routes)) {
    throw new Error('현재 시험 정책의 형식이 올바르지 않아 복원을 중단합니다.');
  }
  const addedRules = snapshot.rules.filter((rule) => !currentPolicy.rules.includes(rule)).sort();
  const removedRules = currentPolicy.rules.filter((rule) => !snapshot.rules.includes(rule)).sort();
  const routeChanges = routeDiff(snapshot, currentPolicy);
  return {
    policyRevision: snapshot.source.commit,
    policySha256: snapshot.sha256.toLowerCase(),
    currentRules: [...currentPolicy.rules],
    safeRules: [...snapshot.rules],
    addedRules,
    removedRules,
    routeChanges,
    clean: addedRules.length === 0 && removedRules.length === 0 && routeChanges.length === 0,
  };
}

export function restoreTestPolicy({ snapshot, currentPolicy, confirmed = false, at = new Date().toISOString() }) {
  if (confirmed !== true) throw new Error('미리보기 후 명시적으로 확인해야 시험 정책을 복원합니다.');
  const preview = createPolicyRestorePreview({ snapshot, currentPolicy });
  if (preview.addedRules.length || preview.removedRules.length) {
    throw new Error('규칙 코드가 안전 정책 사본과 달라 자동 복원을 중단합니다.');
  }
  if (!Number.isFinite(Date.parse(at))) throw new Error('복원 감사 시각이 올바르지 않습니다.');

  const services = new Set(snapshot.routes.map((route) => route.service));
  const routes = currentPolicy.routes.filter((route) => !services.has(route.service));
  const restored = structuredClone(currentPolicy);
  restored.routes = sortedRoutes([...routes, ...snapshot.routes]);
  restored.auditHistory = [...(currentPolicy.auditHistory ?? []), {
    action: 'test_policy_restored',
    snapshotId: snapshot.snapshotId,
    sourceCommit: snapshot.source.commit,
    policySha256: snapshot.sha256.toLowerCase(),
    at,
    changedRoutes: preview.routeChanges.length,
  }];
  return restored;
}
