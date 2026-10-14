import { comparePolicy } from '../src/policy-diff.mjs';
import { applyPolicyRestore } from '../src/policy-restore.mjs';

function parseArguments(args) {
  let apply = false;
  let confirmRevision;
  for (let index = 0; index < args.length; index += 1) {
    if (args[index] === '--apply' && !apply) {
      apply = true;
    } else if (args[index] === '--confirm' && confirmRevision === undefined && args[index + 1]) {
      confirmRevision = args[index + 1];
      index += 1;
    } else {
      return { apply, confirmRevision, error: 'invalid_confirmation_arguments' };
    }
  }
  return { apply, confirmRevision };
}

function printPreview(preview) {
  process.stdout.write('안전 정책 복원 대상 및 변경 범위 미리보기\n');
  process.stdout.write(`대상 환경: ${preview.targetEnvironment}\n`);
  process.stdout.write(`복원 대상 버전: ${preview.targetPolicy.version} / revision ${preview.targetPolicy.revision}\n`);
  if (preview.changes.length === 0) {
    process.stdout.write('변경 범위: 없음 (현재 시험 정책과 동일)\n');
    return;
  }
  process.stdout.write(`변경 범위: ${preview.changes.map(change => change.field).join(', ')}\n`);
  for (const change of preview.changes) {
    process.stdout.write(`- ${change.field}\n`);
    process.stdout.write(`  현재 시험 정책: ${JSON.stringify(change.current)}\n`);
    process.stdout.write(`  검증된 안전 사본: ${JSON.stringify(change.safeCopy)}\n`);
  }
}

const args = parseArguments(process.argv.slice(2));
try {
  // The verified preview is shown before the apply/confirm gate is evaluated.
  const preview = await comparePolicy();
  printPreview(preview);
  await new Promise(resolve => process.stdout.write('', resolve));

  if (args.error) {
    process.stderr.write('확인 인자가 올바르지 않습니다. 파일은 변경하지 않았습니다.\n');
    process.exitCode = 1;
  } else if (!args.apply) {
    process.stdout.write('미리보기만 실행했습니다. 적용하려면 --apply와 --confirm <revision>을 함께 지정하세요.\n');
  } else {
    const result = await applyPolicyRestore({
      apply: true,
      confirmRevision: args.confirmRevision,
      expectedPreview: preview,
    });
    if (!result.applied) {
      process.stderr.write(`정책 복구 중단: ${result.reason}. 파일은 변경하지 않았습니다.\n`);
      process.exitCode = 1;
    } else if (result.modifiedFiles.length === 0) {
      process.stdout.write('현재 시험 정책이 사본과 같아 파일을 변경하지 않았습니다.\n');
    } else {
      process.stdout.write(`복구된 파일: ${result.modifiedFiles.join(', ')}\n`);
    }
  }
} catch (error) {
  process.stderr.write(`정책 복구 중단: ${error.message}. 파일은 변경하지 않았습니다.\n`);
  process.exitCode = 1;
}
