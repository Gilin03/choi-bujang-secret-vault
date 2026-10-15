import assert from 'node:assert/strict';
import test from 'node:test';
import { runAttackChecks } from '../src/attack-check.mjs';

test('bundle checks use only GET or HEAD and mark write checks not_run', async () => {
  const originalFetch = globalThis.fetch;
  const requests = [];
  globalThis.fetch = async (input, init = {}) => {
    const url = new URL(input);
    requests.push({ url, method: init.method ?? 'GET' });
    const status = url.pathname === '/data.json' ? 200 : 401;
    return {
      status,
      ok: status >= 200 && status < 300,
      async json() { return { notes: [] }; },
    };
  };

  let attempts;
  try {
    attempts = await runAttackChecks({ step: 12, publicAppUrl: 'https://vault.example.org/' });
  } finally {
    globalThis.fetch = originalFetch;
  }

  assert.deepEqual(requests.map(({ method }) => method), ['GET', 'GET', 'GET']);
  assert.equal(requests.length, 3);
  assert.ok(requests.every(({ url, method }) => url.protocol === 'https:' && ['GET', 'HEAD'].includes(method)));
  assert.deepEqual(requests.map(({ url, method }) => [url.pathname, method]), [
    ['/api/notes', 'GET'],
    ['/data.json', 'GET'],
    ['/api/session-approval/status', 'GET'],
  ]);

  const byId = Object.fromEntries(attempts.map(({ attackId, expected, observed }) => [attackId, { expected, observed }]));
  assert.equal(byId.anonymous_note_read.observed, '비로그인 GET /api/notes HTTP 401, 인증 거부 확인');
  assert.equal(byId.static_note_exposure.observed, '비로그인 GET /data.json HTTP 200, 메모 본문 없음');
  assert.equal(byId.anonymous_session_approval_status.observed, '비로그인 GET /api/session-approval/status HTTP 401, 인증 거부 확인');
  assert.equal(byId.anonymous_note_write.expected, '비로그인 POST /api/notes는 401로 거부됨');
  assert.equal(byId.anonymous_note_write.observed, 'not_run');
  assert.equal(byId.anonymous_session_approval_request.expected, '비로그인 POST /api/session-approval/request는 401로 거부됨');
  assert.equal(byId.anonymous_session_approval_request.observed, 'not_run');
});
