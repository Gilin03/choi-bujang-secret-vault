import { constants, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createPolicyRestorePreview, restoreTestPolicy } from '../src/stage10-policy-recovery.mjs';

const root = resolve(import.meta.dirname, '..');
const snapshotFile = join(root, 'recovery', 'policy-snapshots', 'stage9-safe-policy.json');
const policyFixture = join(root, 'recovery', 'fixtures', 'stage10-test-policy-drift.json');
const sandboxPolicy = join(root, 'artifacts', 'stage10', 'test-policy.json');

function git(...args) {
  return execFileSync('git', ['-C', root, ...args], {
    encoding: 'utf8', timeout: 5000, maxBuffer: 512 * 1024, windowsHide: true,
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_OPTIONAL_LOCKS: '0' },
  }).trim();
}

function verifiedSnapshot() {
  const snapshot = JSON.parse(readFileSync(snapshotFile, 'utf8'));
  let sourceText;
  let gitBlob;
  try {
    git('merge-base', '--is-ancestor', snapshot.source.commit, 'HEAD');
    gitBlob = git('rev-parse', `${snapshot.source.commit}:${snapshot.source.path}`);
    sourceText = git('show', `${snapshot.source.commit}:${snapshot.source.path}`);
  } catch {
    throw new Error('안전 정책 사본의 원본 Git 커밋을 확인할 수 없습니다. 복원을 중단합니다.');
  }
  const match = /export const RULE_IDS = Object\.freeze\(\[([\s\S]*?)\]\);/u.exec(sourceText);
  if (!match) throw new Error('안전 정책 원본에서 규칙 목록을 읽지 못했습니다. 복원을 중단합니다.');
  const ruleIds = [...match[1].matchAll(/'([^']+)'/gu)].map((entry) => entry[1]);
  return {
    snapshot,
    verifiedSource: {
      commit: snapshot.source.commit,
      path: snapshot.source.path,
      gitBlob,
      ruleIds,
    },
  };
}

function readSandboxPolicy() {
  if (!existsSync(sandboxPolicy)) {
    throw new Error('시험 정책 사본이 없습니다. 먼저 `npm run recovery:policy -- init`을 실행하세요.');
  }
  return JSON.parse(readFileSync(sandboxPolicy, 'utf8'));
}

export function runStage10PolicyCommand(args = process.argv.slice(2)) {
  if (args[0] !== 'policy') {
    throw new Error('사용법: npm run recovery:policy -- init | preview | restore [--apply]');
  }
  const action = args[1];
  const { snapshot, verifiedSource } = verifiedSnapshot();

  if (action === 'init') {
    if (existsSync(sandboxPolicy)) throw new Error('시험 정책 사본이 이미 있습니다. 기존 자료를 덮어쓰지 않았습니다.');
    mkdirSync(dirname(sandboxPolicy), { recursive: true });
    copyFileSync(policyFixture, sandboxPolicy, constants.COPYFILE_EXCL);
    return { state: 'initialized', scope: 'test-only sandbox', target: 'artifacts/stage10/test-policy.json' };
  }

  const currentPolicy = readSandboxPolicy();
  if (action === 'preview') {
    const preview = createPolicyRestorePreview({ snapshot, currentPolicy, verifiedSource });
    return { state: 'preview', testOnly: true, ...preview };
  }
  if (action === 'restore') {
    const preview = createPolicyRestorePreview({ snapshot, currentPolicy, verifiedSource });
    if (!args.includes('--apply')) {
      return { state: 'preview', testOnly: true, applyRequired: true, ...preview };
    }
    const restored = restoreTestPolicy({
      snapshot, currentPolicy, verifiedSource, confirmed: true,
    });
    const temporaryFile = `${sandboxPolicy}.tmp`;
    writeFileSync(temporaryFile, `${JSON.stringify(restored, null, 2)}\n`, { flag: 'wx', encoding: 'utf8' });
    renameSync(temporaryFile, sandboxPolicy);
    return {
      state: 'restored', testOnly: true, scope: 'services.notes.rules',
      auditEntriesPreserved: currentPolicy.auditHistory.length,
      auditEntriesAfterRestore: restored.auditHistory.length,
      sourceCommit: snapshot.source.commit,
    };
  }
  throw new Error('사용법: npm run recovery:policy -- init | preview | restore [--apply]');
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.stdout.write(`${JSON.stringify(runStage10PolicyCommand(), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`시험 정책 복원 중단: ${error.message}\n`);
    process.exitCode = 1;
  }
}
