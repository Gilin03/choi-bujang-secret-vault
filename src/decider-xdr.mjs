import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { decide } from './decider.mjs';
import { checkZtnaDenyRules, normalizeSourceAddress } from '../xdr/brute-force/deny-rules.mjs';

const denyRulesPath = resolve(import.meta.dirname, '../xdr/brute-force/deny-rules.json');

async function readDenyRules() {
  try {
    const rules = JSON.parse(await readFile(denyRulesPath, 'utf8'));
    if (!Array.isArray(rules)) throw new Error('invalid_xdr_deny_rules');
    return rules;
  } catch (error) {
    if (error.code === 'ENOENT') return [];
    throw new Error('invalid_xdr_deny_rules');
  }
}

// Call this with the request and source address verified by the upstream ZTNA engine.
// The source address stays outside the strict decide(request) contract.
export function createXdrGate(policyDecide = decide) {
  if (typeof policyDecide !== 'function') throw new TypeError('invalid_policy_decider');
  return async function gate(request, verifiedSourceAddress, options = {}) {
    if (normalizeSourceAddress(verifiedSourceAddress) === null) {
      throw new TypeError('invalid_verified_source_address');
    }
    const rules = options.rules ?? await readDenyRules();
    if (!Array.isArray(rules)) throw new TypeError('invalid_xdr_deny_rules');
    const now = options.now ?? new Date();
    const xdr = checkZtnaDenyRules(verifiedSourceAddress, rules, now);
    if (xdr.action === 'deny') return { xdr, decision: null };
    return { xdr, decision: await policyDecide(request) };
  };
}

export const decideWithXdr = createXdrGate();
