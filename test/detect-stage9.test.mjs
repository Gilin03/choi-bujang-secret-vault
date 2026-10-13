import assert from 'node:assert/strict';
import { test } from 'node:test';
import { detect } from '../src/detect.mjs';

const start = Date.UTC(2026, 9, 1, 0, 0, 0);

function reads(count, { sub = 'learner_fixture', intervalMs = 2_000, startAt = start } = {}) {
  return Array.from({ length: count }, (_, index) => ({
    at: new Date(startAt + index * intervalMs).toISOString(),
    method: 'GET',
    identity: { sub },
  }));
}

test('121 GETs for one pseudonymous subject inside ten minutes propose revocation', () => {
  assert.deepEqual(detect(reads(121)), {
    action: 'propose_revocation',
    reasonCode: 'burst_read',
    subject: 'learner_fixture',
  });
});

test('exactly 120 GETs do not propose revocation', () => {
  assert.deepEqual(detect(reads(120)), { action: 'observe' });
});

test('separate subjects and non-GET requests are not combined', () => {
  const events = [
    ...reads(100, { sub: 'learner_fixture' }),
    ...reads(100, { sub: 'other_fixture' }),
    { at: new Date(start).toISOString(), method: 'POST', identity: { sub: 'learner_fixture' } },
  ];

  assert.deepEqual(detect(events), { action: 'observe' });
});

test('the ten-minute window is sliding and event order does not affect the result', () => {
  const events = reads(121, { intervalMs: 5_000, startAt: start + 30_000 }).reverse();

  assert.deepEqual(detect(events), {
    action: 'propose_revocation',
    reasonCode: 'burst_read',
    subject: 'learner_fixture',
  });
});

test('121 reads spread beyond every ten-minute window are only observed', () => {
  assert.deepEqual(detect(reads(121, { intervalMs: 5_001 })), { action: 'observe' });
});

test('only the documented event fields affect output', () => {
  const events = reads(121).map(event => ({
    ...event,
    network: 'normal',
    role: 'admin',
    token: 'synthetic-invalid-marker',
    body: 'synthetic-fixture-content',
  }));

  assert.deepEqual(detect(events), {
    action: 'propose_revocation',
    reasonCode: 'burst_read',
    subject: 'learner_fixture',
  });
});

test('non-array input is rejected without echoing it', () => {
  assert.throws(() => detect({ token: 'synthetic-invalid-marker' }), { name: 'TypeError', message: 'invalid_detection_events' });
});
