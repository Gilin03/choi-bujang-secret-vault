import { comparePolicy } from '../src/policy-diff.mjs';

try {
  const preview = await comparePolicy();
  process.stdout.write('안전 정책 복원 대상 및 변경 범위 미리보기 (비교 전용)\n');
  process.stdout.write(`대상 환경: ${preview.targetEnvironment}\n`);
  process.stdout.write(`복원 대상 버전: ${preview.targetPolicy.version} / revision ${preview.targetPolicy.revision}\n`);

  if (preview.changes.length === 0) {
    process.stdout.write('변경 범위: 없음 (현재 시험 정책과 동일)\n');
  } else {
    process.stdout.write(`변경 범위: ${preview.changes.map(change => change.field).join(', ')}\n`);
    for (const change of preview.changes) {
      process.stdout.write(`- ${change.field}\n`);
      process.stdout.write(`  현재 시험 정책: ${JSON.stringify(change.current)}\n`);
      process.stdout.write(`  검증된 안전 사본: ${JSON.stringify(change.safeCopy)}\n`);
    }
  }
  process.stdout.write('이 명령은 미리보기만 하며 정책을 적용하지 않습니다.\n');
} catch (error) {
  process.stderr.write(`정책 비교 중단: ${error.message}\n`);
  process.exitCode = 1;
}
