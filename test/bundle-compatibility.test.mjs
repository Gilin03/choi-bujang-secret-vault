import assert from 'node:assert/strict';
import test from 'node:test';
import { runAttackChecks } from '../src/attack-check.mjs';

test('Stage 12 bundle leaves unrecorded anonymous checks not_run without sending requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, method: init.method ?? 'GET' });
    throw new Error('Stage 12 unrecorded checks must not send requests');
  };

  let attempts;
  try {
    attempts = await runAttackChecks({ step: 12, publicAppUrl: 'https://vault.example.org/' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, []);

  const byId = Object.fromEntries(attempts.map(({ attackId, expected, observed }) => [attackId, { expected, observed }]));
  assert.equal(byId.anonymous_note_read.observed, 'not_run');
  assert.equal(byId.static_note_exposure.observed, 'not_run');
  assert.equal(byId.anonymous_session_approval_status.observed, 'not_run');
  assert.equal(byId.anonymous_note_write.expected, '비로그인 POST /api/notes는 401로 거부됨');
  assert.equal(byId.anonymous_note_write.observed, 'not_run');
  assert.equal(byId.anonymous_session_approval_request.expected, '비로그인 POST /api/session-approval/request는 401로 거부됨');
  assert.equal(byId.anonymous_session_approval_request.observed, 'not_run');
});

test('Stage 12 missing-response checks do not attempt network requests', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    requests.push({ url: new URL(input), method: init.method ?? 'GET' });
    throw new TypeError('network unavailable');
  };

  let attempts;
  try {
    attempts = await runAttackChecks({ step: 12, publicAppUrl: 'https://vault.example.org/' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests, []);
  const byId = Object.fromEntries(attempts.map(({ attackId, expected, observed }) => [attackId, { expected, observed }]));
  for (const attackId of ['anonymous_note_read', 'static_note_exposure', 'anonymous_session_approval_status']) {
    assert.equal(byId[attackId].observed, 'not_run');
  }
  assert.equal(byId.anonymous_note_read.expected, '비로그인 GET /api/notes는 401로 거부됨');
  assert.equal(byId.static_note_exposure.expected, '정적 /data.json에서 메모 본문을 찾을 수 없음');
  assert.equal(byId.anonymous_session_approval_status.expected, '비로그인 GET /api/session-approval/status는 401로 거부됨');
});
