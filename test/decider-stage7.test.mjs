import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fixtureRequests } from '../scripts/fixture-7.mjs';
import { decide } from '../src/decider.mjs';

test('known normal fixture is allowed, composite anomaly requests step-up, and region alone is not a trigger', async () => {
  const { normal, suspicious } = fixtureRequests();

  assert.equal((await decide(normal)).decision, 'allow');

  const challenge = await decide(suspicious);
  assert.equal(challenge.decision, 'step_up');
  assert.equal(challenge.reasonCode, 'step_up_required');

  const regionOnly = {
    ...normal,
    signals: { ...normal.signals, region: 'foreign' },
  };
  assert.equal((await decide(regionOnly)).decision, 'allow');
});

test('client supplied signal values are challenged but the declared live no-signal path stays available', async () => {
  const { normal, suspicious } = fixtureRequests();
  const clientHeaderValues = {
    ...suspicious,
    signals: { source: 'client_header', region: 'local', network: 'usual', hour: 14 },
    recentEvents: [],
  };
  const unknownSource = await decide(clientHeaderValues);
  assert.equal(unknownSource.decision, 'step_up');
  assert.equal(unknownSource.reasonCode, 'step_up_required');

  const noSource = {
    ...normal,
    signals: { source: 'none', region: 'unknown', network: 'unknown', hour: null },
  };
  const absentSource = await decide(noSource);
  assert.equal(absentSource.decision, 'allow');
  assert.equal(absentSource.reasonCode, 'approved');
});

test('missing region, network, hour, or behavior is challenged instead of filled with normal defaults', async () => {
  const { suspicious } = fixtureRequests();
  const fields = ['region', 'network', 'hour', 'recentEvents'];
  const incompleteRequests = fields.map(() => ({
    ...suspicious,
    signals: { ...suspicious.signals },
    recentEvents: suspicious.recentEvents.map((event) => ({ ...event })),
  }));
  for (const [index, field] of fields.entries()) {
    if (field === 'recentEvents') delete incompleteRequests[index].recentEvents;
    else delete incompleteRequests[index].signals[field];
  }

  for (const request of incompleteRequests) {
    const result = await decide(request);
    assert.equal(result.decision, 'step_up');
    assert.equal(result.reasonCode, 'step_up_required');
  }
});

test('only a fresh engine-verified step-up permits the anomalous request on re-evaluation', async () => {
  const { suspicious } = fixtureRequests();
  const unverified = await decide({
    ...suspicious,
    stepUp: { verified: false, authAgeSeconds: null },
  });
  assert.equal(unverified.decision, 'step_up');

  const verifiedAtBoundary = await decide({
    ...suspicious,
    stepUp: { verified: true, authAgeSeconds: 900 },
  });
  assert.equal(verifiedAtBoundary.decision, 'allow');
  assert.equal(verifiedAtBoundary.reasonCode, 'approved');

  const expired = await decide({
    ...suspicious,
    stepUp: { verified: true, authAgeSeconds: 901 },
  });
  assert.equal(expired.decision, 'step_up');
});

test('step-up cannot override the existing unregistered-device denial', async () => {
  const { suspicious } = fixtureRequests();
  const result = await decide({
    ...suspicious,
    deviceRegistered: false,
    stepUp: { verified: true, authAgeSeconds: 60 },
  });

  assert.equal(result.decision, 'deny');
  assert.equal(result.reasonCode, 'device_not_registered');
});
