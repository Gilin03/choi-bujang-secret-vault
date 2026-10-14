import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createPolicyRestorePreview, restoreTestPolicy, verifyPolicySnapshotIntegrity } from '../src/stage10-policy-recovery.mjs';

const root = resolve(import.meta.dirname, '..');
const snapshotPath = join(root, 'policy', 'verified-policy.json');
const configPath = join(root, 'aleph.config.json');
const auditPath = join(root, 'policy', 'audit.jsonl');
const routePattern = /^(GET|POST|PUT|PATCH|DELETE) (\/[^?#]*)$/u;

function git(...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', windowsHide: true, timeout: 5000,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function readJson(path, label) {
  try { return JSON.parse(readFileSync(path, 'utf8')); }
  catch { throw new Error(`${label}이 없거나 JSON을 읽을 수 없어 중단합니다.`); }
}

function verifyGitSource(snapshot) {
  for (const [path, expected] of [
    [snapshot.source.path, snapshot.source.gitBlob],
    [snapshot.source.configPath, snapshot.source.configGitBlob],
  ]) {
    let actual;
    try { actual = git('rev-parse', `${snapshot.source.commit}:${path}`); }
    catch { throw new Error(`안전 사본의 기준 Git 파일을 찾을 수 없어 중단합니다: ${path}`); }
    if (actual !== expected) throw new Error(`안전 사본의 기준 Git 파일 해시가 맞지 않아 중단합니다: ${path}`);
  }
}

function routeService(path) {
  if (path === '/api/notes' || path.startsWith('/api/notes/')
      || path === '/api/my/notes' || path.startsWith('/notes/')) return 'notes';
  if (path === '/api/announcements' || path.startsWith('/api/announcements/')) return 'announcements';
  return 'other';
}

function currentRoutes(config) {
  if (!Array.isArray(config.allowedRoutes)) throw new Error('시험 정책의 allowedRoutes 형식이 올바르지 않습니다.');
  return config.allowedRoutes.map((entry) => {
    if (typeof entry !== 'string') throw new Error('시험 정책 경로가 문자열이 아닙니다.');
    const match = routePattern.exec(entry);
    if (!match) throw new Error(`시험 정책 경로 형식이 올바르지 않습니다: ${entry}`);
    const [, method, pathPattern] = match;
    const service = routeService(pathPattern);
    return {
      service,
      method,
      pathPattern,
      zone: service === 'notes' ? 'personal_notes'
        : service === 'announcements' ? 'instructor_announcements' : 'other',
    };
  });
}

async function currentRules() {
  const imported = await import(pathToFileURL(join(root, 'src', 'decider.mjs')).href);
  if (!Array.isArray(imported.RULE_IDS)) throw new Error('RULE_IDS 목록을 읽을 수 없습니다.');
  return [...imported.RULE_IDS];
}

function printPreview(snapshot, diff) {
  process.stdout.write(`복원할 정책 버전: ${snapshot.source.commit}\n`);
  process.stdout.write(`정책 SHA-256: ${snapshot.sha256}\n`);
  if (diff.clean) {
    process.stdout.write('변경 항목: 없음. 현재 시험 정책이 검증된 사본과 같습니다.\n');
    return;
  }
  for (const route of diff.routeChanges) {
    const verb = route.change === 'add' ? '복원' : route.change === 'remove' ? '제거' : '구역 변경';
    process.stdout.write(`- ${verb}: ${route.method} ${route.pathPattern}\n`);
  }
  if (diff.addedRules.length) process.stdout.write(`- 현재 정책에만 있는 규칙: ${diff.addedRules.join(', ')}\n`);
  if (diff.removedRules.length) process.stdout.write(`- 사본에서 빠진 규칙: ${diff.removedRules.join(', ')}\n`);
}

async function run(command, args) {
  if (!['preview', 'restore'].includes(command)) throw new Error('사용법: npm run recovery:policy -- preview | restore [--apply]');

  // 매 실행마다 사본 파일을 다시 읽고 본문 해시와 기준 Git blob을 확인합니다.
  const snapshot = verifyPolicySnapshotIntegrity(readJson(snapshotPath, '안전 정책 사본'));
  verifyGitSource(snapshot);
  const config = readJson(configPath, '시험 정책');
  const rules = await currentRules();
  const policy = { rules, routes: currentRoutes(config) };
  const diff = createPolicyRestorePreview({ snapshot, currentPolicy: policy });
  printPreview(snapshot, diff);
  if (command === 'preview' || diff.clean) return;
  if (diff.addedRules.length || diff.removedRules.length) {
    throw new Error('판정기 규칙 코드가 안전 사본과 달라 자동 복원을 멈춥니다.');
  }
  if (!args.includes('--apply')) {
    process.stdout.write('위 경로만 복원하려면 `npm run recovery:policy -- restore --apply`를 실행하세요.\n');
    return;
  }

  const restored = restoreTestPolicy({ snapshot, currentPolicy: { ...policy, auditHistory: [] }, confirmed: true });
  const nextConfig = {
    ...config,
    allowedRoutes: restored.routes.map((route) => `${route.method} ${route.pathPattern}`),
  };
  writeFileSync(configPath, `${JSON.stringify(nextConfig, null, 2)}\n`, 'utf8');
  appendFileSync(auditPath, `${JSON.stringify({
    at: new Date().toISOString(), action: 'test_policy_restored',
    policyRevision: snapshot.source.commit, sha256: snapshot.sha256,
    changedRoutes: diff.routeChanges.length,
  })}\n`, 'utf8');
  process.stdout.write('시험 정책 경로를 복원했고 감사 기록에 한 줄을 추가했습니다. 운영 정책은 변경하지 않았습니다.\n');
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try { await run(process.argv[2], process.argv.slice(3)); }
  catch (error) {
    process.stderr.write(`정책 복구 중단: ${error.message}\n`);
    process.exitCode = 1;
  }
}
