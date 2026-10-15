// The bundle records the results of actual anonymous requests. It never
// returns response bodies, note text, keys, or judge decisions.
export async function runAttackChecks(config) {
  if (!Number.isInteger(config.step) || config.step < 3) {
    throw new Error('3단계 이후의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');
  }

  let app;
  try {
    app = new URL(config.publicAppUrl);
  } catch {
    throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.');
  }
  if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash
      || app.pathname !== '/' || app.hostname.endsWith('.example')) {
    throw new Error('aleph.config.json의 실제 배포 주소를 먼저 넣어 주세요.');
  }

  async function request(path) {
    try {
      return await fetch(new URL(path, app), {
        method: 'GET',
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return null;
    }
  }

  // The judge supplied no received-request evidence for these Stage 12 IDs.
  // Keep earlier-stage self-checks, but don't turn uncorrelated traffic into observations.
  const runAnonymousChecks = config.step < 12;
  const apiResponse = runAnonymousChecks ? await request('/api/notes') : null;
  const apiObserved = apiResponse
    ? `비로그인 GET /api/notes HTTP ${apiResponse.status}${apiResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
    : 'not_run';

  const staticResponse = runAnonymousChecks ? await request('/data.json') : null;
  let staticObserved = staticResponse
    ? `비로그인 GET /data.json HTTP ${staticResponse.status}`
    : 'not_run';
  if (staticResponse?.ok) {
    try {
      const data = await staticResponse.json();
      if (Array.isArray(data?.notes)) {
        const bodyCount = data.notes.filter(note => typeof note?.content === 'string' && note.content.length > 0).length;
        staticObserved += bodyCount === 0 ? ', 메모 본문 없음' : `, 메모 본문 ${bodyCount}건 발견`;
      } else {
        staticObserved += ', JSON 자료 형식 아님';
      }
    } catch {
      staticObserved += ', JSON 자료 형식 아님';
    }
  }

  const sessionStatusResponse = runAnonymousChecks ? await request('/api/session-approval/status') : null;
  const sessionStatusObserved = sessionStatusResponse
    ? `비로그인 GET /api/session-approval/status HTTP ${sessionStatusResponse.status}${sessionStatusResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
    : 'not_run';

  return [
    {
      attackId: 'anonymous_note_read',
      expected: '비로그인 GET /api/notes는 401로 거부됨',
      observed: apiObserved,
    },
    {
      attackId: 'static_note_exposure',
      expected: '정적 /data.json에서 메모 본문을 찾을 수 없음',
      observed: staticObserved,
    },
    {
      attackId: 'anonymous_note_write',
      expected: '비로그인 POST /api/notes는 401로 거부됨',
      observed: 'not_run',
    },
    {
      attackId: 'anonymous_session_approval_status',
      expected: '비로그인 GET /api/session-approval/status는 401로 거부됨',
      observed: sessionStatusObserved,
    },
    {
      attackId: 'anonymous_session_approval_request',
      expected: '비로그인 POST /api/session-approval/request는 401로 거부됨',
      observed: 'not_run',
    },
  ];
}
