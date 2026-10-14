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

  async function request(path, method = 'GET', body) {
    try {
      return await fetch(new URL(path, app), {
        method,
        ...(body === undefined ? {} : {
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        }),
        redirect: 'error',
        signal: AbortSignal.timeout(10000),
      });
    } catch {
      return null;
    }
  }

  const apiResponse = await request('/api/notes');
  const apiObserved = apiResponse
    ? `비로그인 GET /api/notes HTTP ${apiResponse.status}${apiResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
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
    ? `비로그인 POST /api/notes HTTP ${writeResponse.status}${writeResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
    : '비로그인 POST /api/notes 응답 없음';

  const deviceStatusResponse = await request('/api/device/status');
  const deviceStatusObserved = deviceStatusResponse
    ? `비로그인 GET /api/device/status HTTP ${deviceStatusResponse.status}${deviceStatusResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
    : '비로그인 GET /api/device/status 응답 없음';

  const deviceChallengeResponse = await request('/api/device/challenge', 'POST', {
    method: 'GET', path: '/api/my/notes',
  });
  const deviceChallengeObserved = deviceChallengeResponse
    ? `비로그인 POST /api/device/challenge HTTP ${deviceChallengeResponse.status}${deviceChallengeResponse.status === 401 ? ', 인증 거부 확인' : ', 인증 없이 거부되지 않음'}`
    : '비로그인 POST /api/device/challenge 응답 없음';

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
      observed: writeObserved,
    },
    {
      attackId: 'anonymous_device_status',
      expected: '비로그인 GET /api/device/status는 401로 거부됨',
      observed: deviceStatusObserved,
    },
    {
      attackId: 'anonymous_device_challenge',
      expected: '비로그인 POST /api/device/challenge는 401로 거부됨',
      observed: deviceChallengeObserved,
    },
  ];
}
