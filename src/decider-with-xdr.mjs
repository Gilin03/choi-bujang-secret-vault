import { decide as decideBase } from './decider.mjs';
import { matchActiveDenyRule } from '../xdr/brute-force/deny-rules.mjs';

// sourceAddress must come from the trusted gateway/Wazuh path, never from a browser request body.
// The existing Aleph decision contract remains unchanged; this is an optional pre-decision gate.
export async function decideWithXdr(request, { sourceAddress, denyRules, now } = {}) {
  const rule = matchActiveDenyRule(sourceAddress, denyRules, now);
  if (rule) {
    return {
      gate: {
        action: 'deny',
        ruleId: rule.id,
        evidenceAlertId: rule.evidenceAlertId,
        expiresAt: rule.expiresAt,
      },
      policyDecision: null,
    };
  }

  return {
    gate: { action: 'continue', ruleId: null, evidenceAlertId: null, expiresAt: null },
    policyDecision: await decideBase(request),
  };
}
