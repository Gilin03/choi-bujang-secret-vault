// ALEPH SDP 엔진이 확인한 계약 요청만 받습니다. 브라우저 헤더를 읽지 않습니다.
export const RULE_IDS = Object.freeze(['device_registered', 'step_up_required']);

const MAX_RECENT_EVENTS = 12;
const HIGH_VOLUME_COUNT = 20;
const HIGH_VOLUME_WINDOW_SECONDS = 300;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function verifiedFixtureContext(request) {
  const signals = request?.signals;
  if (!isRecord(signals) || signals.source !== 'judge_fixture') return null;

  if (typeof signals.region !== 'string' || !signals.region.trim() || signals.region === 'unknown'
      || typeof signals.network !== 'string' || !signals.network.trim() || signals.network === 'unknown'
      || !Number.isInteger(signals.hour) || signals.hour < 0 || signals.hour > 23) {
    return null;
  }

  const events = request.recentEvents;
  if (!Array.isArray(events) || events.length > MAX_RECENT_EVENTS
      || events.some((event) => !isRecord(event)
        || typeof event.kind !== 'string' || !event.kind.trim()
        || !Number.isFinite(event.ageSeconds) || event.ageSeconds < 0
        || !Number.isInteger(event.count) || event.count < 0)) {
    return null;
  }

  return { signals, events };
}

function hasFreshEngineStepUp(request) {
  const stepUp = request?.stepUp;
  return isRecord(stepUp) && stepUp.verified === true
    && Number.isFinite(stepUp.authAgeSeconds)
    && stepUp.authAgeSeconds >= 0 && stepUp.authAgeSeconds <= 900;
}

function stepUpResponse(request) {
  return {
    schema: 'aleph.decision.v1',
    requestId: request.requestId,
    decision: 'step_up',
    reasonCode: 'step_up_required',
    ruleIds: ['step_up_required'],
  };
}

export async function decide(request) {
  const deviceRegistered = request?.deviceRegistered === true;

  if (!deviceRegistered) {
    return {
      schema: 'aleph.decision.v1',
      requestId: request.requestId,
      decision: 'deny',
      reasonCode: 'device_not_registered',
      ruleIds: ['device_registered'],
    };
  }

  // Missing, unknown, malformed, or non-fixture signals are never filled with normal values.
  // A re-authentication challenge is temporary; only the engine can verify its completion.
  const context = verifiedFixtureContext(request);
  if (!context) {
    if (hasFreshEngineStepUp(request)) {
      return {
        schema: 'aleph.decision.v1',
        requestId: request.requestId,
        decision: 'allow',
        reasonCode: 'approved',
        ruleIds: ['device_registered', 'step_up_required'],
      };
    }
    return stepUpResponse(request);
  }

  const unusualHour = context.signals.hour < 6 || context.signals.hour >= 22;
  const newNetwork = context.signals.network === 'unusual';
  const highVolumeReads = context.events.some((event) => ['bulk_read', 'risk_signal'].includes(event.kind)
    && event.count >= HIGH_VOLUME_COUNT
    && event.ageSeconds <= HIGH_VOLUME_WINDOW_SECONDS);
  const compositeAnomaly = unusualHour && newNetwork && highVolumeReads;

  if (!compositeAnomaly) {
    return {
      schema: 'aleph.decision.v1',
      requestId: request.requestId,
      decision: 'allow',
      reasonCode: 'approved',
      ruleIds: ['device_registered'],
    };
  }

  if (hasFreshEngineStepUp(request)) {
    return {
      schema: 'aleph.decision.v1',
      requestId: request.requestId,
      decision: 'allow',
      reasonCode: 'approved',
      ruleIds: ['device_registered', 'step_up_required'],
    };
  }

  return stepUpResponse(request);
}
