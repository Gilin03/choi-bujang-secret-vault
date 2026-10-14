import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test } from 'node:test';

const root = fileURLToPath(new URL('..', import.meta.url));

test('10단계 정책 미리보기는 Git 메타데이터 없는 제출 소스에서도 사본을 검증한다', async (t) => {
  const checkout = await mkdtemp(join(tmpdir(), 'stage10-policy-no-git-'));
  t.after(() => rm(checkout, { recursive: true, force: true }));

  const files = [
    'scripts/policy.mjs',
    'src/decider.mjs',
    'src/resource-zones.mjs',
    'src/stage10-policy-recovery.mjs',
    'aleph.config.json',
    'policy/verified-policy.json',
  ];
  for (const file of files) {
    const destination = join(checkout, file);
    await mkdir(dirname(destination), { recursive: true });
    await copyFile(join(root, file), destination);
  }

  const result = spawnSync(process.execPath, ['scripts/policy.mjs', 'preview'], {
    cwd: checkout,
    encoding: 'utf8',
    windowsHide: true,
  });

  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /정책 SHA-256:/u);
});
