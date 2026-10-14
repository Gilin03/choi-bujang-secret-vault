import { readFile, writeFile } from 'node:fs/promises';
import { isDeepStrictEqual } from 'node:util';
import { fileURLToPath } from 'node:url';
import { comparePolicy, readVerifiedSnapshot } from './policy-diff.mjs';

const REPOSITORY_ROOT = fileURLToPath(new URL('../', import.meta.url));
const DEFAULT_DECIDER_PATH = fileURLToPath(new URL('./decider.mjs', import.meta.url));
const DEFAULT_CONFIG_PATH = fileURLToPath(new URL('../aleph.config.json', import.meta.url));
const RULES_DECLARATION = /export const RULE_IDS = Object\.freeze\(\s*(\[[\s\S]*?\])\s*\);/gu;
const ROUTES_PROPERTY = /("allowedRoutes"\s*:\s*)\[[\s\S]*?\]/gu;

function fail(code) {
  throw new Error(code);
}

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function validStringArray(value) {
  return Array.isArray(value) && value.every(item => typeof item === 'string' && item.length > 0);
}

function oneMatch(source, pattern, errorCode) {
  const matches = [...source.matchAll(pattern)];
  if (matches.length !== 1) fail(errorCode);
  return matches[0];
}

function parseRuleIds(source) {
  const match = oneMatch(source, RULES_DECLARATION, 'current_test_policy_invalid');
  let ruleIds;
  try {
    ruleIds = JSON.parse(match[1].replace(/'([^'\\]*)'/gu, '"$1"'));
  } catch {
    fail('current_test_policy_invalid');
  }
  if (!validStringArray(ruleIds)) fail('current_test_policy_invalid');
  return ruleIds;
}

function parsePolicyFiles(deciderText, configText) {
  let config;
  try {
    config = JSON.parse(configText);
  } catch {
    fail('current_test_policy_invalid');
  }
  if (!isRecord(config) || !validStringArray(config.allowedRoutes)) {
    fail('current_test_policy_invalid');
  }
  return { RULE_IDS: parseRuleIds(deciderText), allowedRoutes: config.allowedRoutes };
}

function currentPolicyFromPreview(snapshot, preview) {
  const current = {
    RULE_IDS: [...snapshot.policy.RULE_IDS],
    allowedRoutes: [...snapshot.policy.allowedRoutes],
  };
  for (const change of preview.changes) {
    if (!['RULE_IDS', 'allowedRoutes'].includes(change.field)
        || !validStringArray(change.current)) {
      fail('current_test_policy_changed');
    }
    current[change.field] = [...change.current];
  }
  return current;
}

function replaceRuleIds(source, ruleIds) {
  const match = oneMatch(source, RULES_DECLARATION, 'current_test_policy_invalid');
  const declaration = `export const RULE_IDS = Object.freeze(${JSON.stringify(ruleIds)});`;
  return source.slice(0, match.index) + declaration + source.slice(match.index + match[0].length);
}

function replaceAllowedRoutes(configText, allowedRoutes) {
  const match = oneMatch(configText, ROUTES_PROPERTY, 'current_test_policy_invalid');
  const formattedRoutes = JSON.stringify(allowedRoutes, null, 2).replace(/\n/gu, '\n  ');
  return configText.slice(0, match.index)
    + match[1] + formattedRoutes
    + configText.slice(match.index + match[0].length);
}

function assertOnlyAllowedRoutesChanged(beforeText, afterText) {
  let before;
  let after;
  try {
    before = JSON.parse(beforeText);
    after = JSON.parse(afterText);
  } catch {
    fail('policy_restore_write_validation_failed');
  }
  delete before.allowedRoutes;
  delete after.allowedRoutes;
  if (!isDeepStrictEqual(before, after)) fail('policy_restore_write_validation_failed');
}

function assertOnlyRuleIdsChanged(beforeText, afterText) {
  if (beforeText === afterText) return;
  const before = beforeText.replace(RULES_DECLARATION, '');
  const after = afterText.replace(RULES_DECLARATION, '');
  if (before === beforeText || after === afterText || before !== after) {
    fail('policy_restore_write_validation_failed');
  }
}

export async function applyPolicyRestore({
  apply = false,
  confirmRevision,
  expectedPreview,
  previewOptions = {},
  deciderPath = DEFAULT_DECIDER_PATH,
  configPath = DEFAULT_CONFIG_PATH,
} = {}) {
  const preview = await comparePolicy(previewOptions);
  if (expectedPreview && !isDeepStrictEqual(expectedPreview, preview)) {
    fail('current_test_policy_changed');
  }

  if (apply !== true) {
    return { preview, applied: false, reason: 'explicit_apply_required', modifiedFiles: [] };
  }
  if (typeof confirmRevision !== 'string' || !confirmRevision) {
    return { preview, applied: false, reason: 'explicit_confirmation_required', modifiedFiles: [] };
  }
  if (confirmRevision !== preview.targetPolicy.revision) {
    return { preview, applied: false, reason: 'confirmation_mismatch', modifiedFiles: [] };
  }

  // Re-read and verify the pinned Stage 9 copy immediately before preparing any writes.
  const snapshot = await readVerifiedSnapshot(previewOptions);
  if (snapshot.policyRevision !== preview.targetPolicy.revision) fail('current_test_policy_changed');

  const [deciderBefore, configBefore] = await Promise.all([
    readFile(deciderPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ]);
  const current = parsePolicyFiles(deciderBefore, configBefore);
  if (!isDeepStrictEqual(current, currentPolicyFromPreview(snapshot, preview))) {
    fail('current_test_policy_changed');
  }

  const deciderAfter = isDeepStrictEqual(current.RULE_IDS, snapshot.policy.RULE_IDS)
    ? deciderBefore
    : replaceRuleIds(deciderBefore, snapshot.policy.RULE_IDS);
  const configAfter = isDeepStrictEqual(current.allowedRoutes, snapshot.policy.allowedRoutes)
    ? configBefore
    : replaceAllowedRoutes(configBefore, snapshot.policy.allowedRoutes);
  assertOnlyRuleIdsChanged(deciderBefore, deciderAfter);
  assertOnlyAllowedRoutesChanged(configBefore, configAfter);

  const preparedPolicy = parsePolicyFiles(deciderAfter, configAfter);
  if (!isDeepStrictEqual(preparedPolicy, snapshot.policy)) fail('policy_restore_write_validation_failed');

  const updates = [];
  if (deciderAfter !== deciderBefore) updates.push({ path: deciderPath, text: deciderAfter, name: 'src/decider.mjs' });
  if (configAfter !== configBefore) updates.push({ path: configPath, text: configAfter, name: 'aleph.config.json' });
  for (const update of updates) await writeFile(update.path, update.text, 'utf8');

  const [deciderResult, configResult] = await Promise.all([
    readFile(deciderPath, 'utf8'),
    readFile(configPath, 'utf8'),
  ]);
  const restored = parsePolicyFiles(deciderResult, configResult);
  if (!isDeepStrictEqual(restored, snapshot.policy)) fail('policy_restore_write_validation_failed');

  return {
    preview,
    applied: true,
    reason: updates.length ? 'restored' : 'already_matches_safe_copy',
    modifiedFiles: updates.map(update => update.name),
  };
}
