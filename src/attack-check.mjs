// The bundle records the results of actual anonymous requests. It never
// returns response bodies, note text, keys, or judge decisions.
export async function runAttackChecks(config) {
  if (config.step !== 2) throw new Error('이 단계의 공격 점검을 src/attack-check.mjs에 구현해 주세요.');

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

  async function request(path, method = 'GET') {
    try {
      return await fetch(new URL(path, app), {
        method,
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return null;
    }
  }

  const apiResponse = await request('/api/notes');
  let apiCount = null;
  if (apiResponse?.ok) {
    try {
      const data = await apiResponse.json();
      if (Array.isArray(data?.notes)) apiCount = data.notes.length;
    } catch {
      // Report only that the expected JSON shape was not observed.
    }
  }
  const apiObserved = apiResponse
    ? `비로그인 GET /api/notes HTTP ${apiResponse.status}${apiCount === null ? ', 응답 형식 확인 실패' : `, ${apiCount}건 확인`}`
    : '비로그인 GET /api/notes 응답 없음';

  const staticResponse = await request('/data.json');
  let staticObserved = staticResponse
    ? `비로그인 GET /data.json HTTP ${staticResponse.status}`
    : '비로그인 GET /data.json 응답 없음';
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

  const writeResponse = await request('/api/notes', 'POST');
  const writeObserved = writeResponse
    ? `비로그인 POST /api/notes HTTP ${writeResponse.status}${writeResponse.status === 405 ? ', 거부 확인' : ', 거부되지 않음'}`
    : '비로그인 POST /api/notes 응답 없음';

  return [
    {
      attackId: 'anonymous_note_read',
      expected: '비로그인 GET /api/notes에서 가상 메모 네 건을 읽을 수 있음',
      observed: apiObserved,
    },
    {
      attackId: 'static_note_exposure',
      expected: '정적 /data.json에서 메모 본문을 찾을 수 없음',
      observed: staticObserved,
    },
    {
      attackId: 'anonymous_note_write',
      expected: '비로그인 POST /api/notes는 405로 거부됨',
      observed: writeObserved,
    },
  ];
}
