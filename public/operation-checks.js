// Student self-check plan. This is not the official judge's 41-attack catalog.
const get = (id, stage, kind, label, path, expectedStatus, authenticated = false, extra = {}) =>
  ({ id, stage, kind, label, method: 'GET', path, expectedStatus, authenticated, ...extra });
const unavailable = (id, stage, kind, label, reason) =>
  ({ id, stage, kind, label, unavailable: reason,
    requestText: stage === 5 ? '원본 Data API GET (공개키)' : stage === 10 ? 'POST /api/notes/:id/restore' : `운영 엔진 ${stage}단계 계약 요청`,
    expectedText: stage === 5 ? 'HTTP 401 / 42501' : stage === 10 ? (kind === 'normal' ? 'HTTP 200 / 복원 검증' : 'HTTP 404')
      : stage === 9 ? (kind === 'normal' ? 'observe' : 'propose_revocation / 집행 별도 확인')
        : stage === 7 ? (kind === 'normal' ? 'allow' : 'step_up') : (kind === 'normal' ? 'allow' : 'deny'),
  });
export const CHECK_PLAN = Object.freeze([
  get('app_identity', 1, 'normal', '배포 식별 정보 읽기', '/aleph.json', 200),
  get('static_exposure', 1, 'forbidden', '공개 자료 파일 접근', '/data.json', 404),
  get('own_list', 2, 'normal', '승인 세션의 자기 목록', '/api/my/notes', 200, true),
  get('anonymous_list', 2, 'forbidden', '비로그인 목록 접근', '/api/my/notes', 401),
  get('valid_login', 3, 'normal', '로그인 세션 검증', '/api/session-approval/status', 200, true),
  get('missing_login', 3, 'forbidden', '인증 없이 승인 상태 조회', '/api/session-approval/status', 401),
  get('nosniff', 4, 'normal', '화면 응답 보안 헤더', '/', 200, false, { requiredHeader: ['x-content-type-options', 'nosniff'] }),
  get('forbidden_route', 4, 'forbidden', '허용되지 않은 자료 경로', '/api/my/notes/extra', 404),
  get('server_notes', 5, 'normal', '서버 자료 API 읽기', '/api/my/notes', 200, true),
  unavailable('direct_database', 5, 'forbidden', '원본 DB 직접 접근 거부', '키를 사용한 원본 DB 점검은 별도 서버 점검 필요'),
  unavailable('registered_engine', 6, 'normal', '엔진 등록 기기 허용', '운영 엔진 결과 경로 미연결'),
  unavailable('unregistered_engine', 6, 'forbidden', '엔진 미등록 기기 거부', '운영 엔진 결과 경로 미연결'),
  unavailable('stepup_verified', 7, 'normal', '엔진 추가 확인 뒤 재판정', '운영 엔진 결과 경로 미연결'),
  unavailable('stepup_required', 7, 'forbidden', '복합 이상 접속 추가 확인', '운영 엔진 결과 경로 미연결'),
  get('personal_zone', 8, 'normal', '자기 자료 구역 조회', '/api/my/notes', 200, true),
  get('ambiguous_scope', 8, 'forbidden', '전체 범위 쿼리 거부', '/api/my/notes?scope=all', 404, true),
  unavailable('ordinary_detection', 9, 'normal', '정상 조회 관찰', '운영 탐지 사건 경로 미연결; 로컬 fixture는 별도'),
  unavailable('burst_revocation', 9, 'forbidden', '대량 조회 탐지와 실제 회수', '운영 탐지·회수 경로 미연결'),
  unavailable('owned_restore', 10, 'normal', '본인 백업 단건 복원', '자료 변경을 수반하는 복원 E2E는 자동 실행하지 않음'),
  unavailable('foreign_restore', 10, 'forbidden', '다른 계정 메모 복원 거부', '교차 계정 세션이 필요한 별도 시험'),
  get('approved_session', 11, 'normal', '현재 세션 승인 상태 조회', '/api/session-approval/status', 200, true, { expectedJson: { status: 'approved' } }),
  { id: 'anonymous_approval', stage: 11, kind: 'forbidden', label: '비로그인 승인 요청', method: 'POST', path: '/api/session-approval/request', expectedStatus: 401, authenticated: false },
  get('own_operations', 12, 'normal', '본인 작전실 기록 조회', '/api/session-approval/operations', 200, true),
  get('anonymous_operations', 12, 'forbidden', '비로그인 작전실 접근', '/api/session-approval/operations', 401),
]);

export function unexecutedChecks(plan = CHECK_PLAN) {
  return plan.map(check => ({ ...check, state: 'unexecuted', actualStatus: null, requestId: null,
    checkedAt: null, recorded: false, note: check.unavailable || '미실행' }));
}

export async function runOperationChecks({ plan = CHECK_PLAN, token, fetchImpl = fetch, expectedCommit,
  isCurrent = () => true, onResult } = {}) {
  const results = unexecutedChecks(plan);
  for (let i = 0; i < results.length; i += 1) {
    const row = results[i];
    if (!isCurrent()) break;
    if (row.unavailable || (row.authenticated && !token)) {
      row.note = row.unavailable || '로그인 세션 없음';
      onResult?.([...results]);
      continue;
    }
    const headers = new Headers();
    if (row.authenticated) headers.set('Authorization', `Bearer ${token}`);
    try {
      const response = await fetchImpl(row.path, { method: row.method, headers, cache: 'no-store',
        redirect: 'error', signal: AbortSignal.timeout(10000) });
      row.actualStatus = response.status;
      const id = response.headers.get('x-request-id');
      // Do not echo arbitrary upstream headers into an evidence artifact.
      row.requestId = /^[a-f0-9-]{36}$/iu.test(id ?? '') ? id : null;
      const at = response.headers.get('x-checked-at');
      row.checkedAt = Number.isFinite(Date.parse(at)) ? new Date(at).toISOString() : new Date().toISOString();
      row.clockSource = Number.isFinite(Date.parse(at)) ? 'server' : 'client';
      row.recorded = response.headers.get('x-audit-recorded') === 'true';
      const responseCommit = response.headers.get('x-deployment-commit');
      row.commit = /^[a-f0-9]{40}$/iu.test(responseCommit ?? '') ? responseCommit.toLowerCase() : null;
      const headerMatches = !row.requiredHeader || response.headers.get(row.requiredHeader[0]) === row.requiredHeader[1];
      let dataMatches = true;
      if (row.expectedJson) {
        const data = await response.json().catch(() => null);
        dataMatches = Object.entries(row.expectedJson).every(([key, value]) => data?.[key] === value);
      }
      const sameCommit = !expectedCommit || !row.commit || row.commit === expectedCommit;
      row.state = response.status === row.expectedStatus && headerMatches && dataMatches && sameCommit ? 'matched' : 'mismatch';
      row.note = row.state === 'matched' ? '실측 기대 일치' : '실측 기대 불일치';
      if (!sameCommit) row.note += ' · 배포 커밋 변경';
      if (!row.requestId) row.note += ' · 서버 요청 ID 미제공';
    } catch {
      row.state = 'error'; row.note = '통신 실패 · 응답 미확인';
      row.checkedAt = new Date().toISOString(); row.clockSource = 'client';
    }
    // Only approval.status is inspected. Note bodies are never read or persisted.
    onResult?.([...results]);
  }
  return results;
}
