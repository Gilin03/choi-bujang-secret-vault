# 인증과 세션 활성화 게이트

## 인증 흐름

1. `public/index.html`의 로그인 UI는 `public/auth-proxy-client.js`를 통해 `/api/auth-proxy/token` 경로를 사용합니다.
2. `src/auth-proxy.mjs`는 token, user, logout 경로와 허용된 method/grant만 Supabase Auth로 전달합니다. Auth 프록시는 서버 비밀 키 대신 publishable key를 사용합니다.
3. 브라우저가 bearer token을 Vercel 보호 API에 전달합니다.
4. `src/verify-login.mjs:createLoginVerifier`가 학생 token에 대해 Supabase Auth의 `getClaims(token)`를 호출합니다.
5. 검증 후 서버 principal은 token의 `sub`를 `userId`, `session_id`를 `sessionId`로 사용합니다.

학생 token 검사에는 issuer, audience, `role=authenticated`, UUID 사용자 ID, UUID 세션 ID, 만료 시각이 포함됩니다. JWT를 단순 decode한 결과를 인증 증거로 신뢰하지 않습니다. 같은 파일에는 별도 judge token 검증 분기도 있으나 학생 자료실 로그인 흐름과 목적이 다릅니다.

## 세션 활성화 흐름

- `GET /api/session-approval/status`: 검증된 현재 사용자와 현재 세션 ID의 상태를 읽습니다.
- `POST /api/session-approval/request`: 인증된 사용자가 자기 검증 세션을 approved 상태로 등록합니다.
- 보호 API: `owner_id`와 `session_id`를 함께 조회해 승인 상태가 확인된 경우 handler에 전달합니다.
- `vault_session_approvals.session_id`는 primary key이며 `owner_id`는 Auth 사용자와 연결됩니다.

`approveVerifiedSession`은 별도 관리자나 두 번째 기기 신호 없이 현재 로그인한 사용자의 검증된 세션을 승인합니다. 그러므로 UI·문서에서 이 기능은 **세션 승인 / 세션 활성화 게이트**로 설명합니다. 이는 독립 MFA, 관리자 승인, 물리 기기 소유 증명 또는 설치 앱 검증이 아닙니다. 해당 의미는 `public/index.html`에도 제한으로 표시됩니다.

## 보안 경계

세션 게이트는 로그인 세션 단위로 서버 보호 API 접근을 구분합니다. 새로 발급된 세션은 이전 세션의 승인 행을 자동으로 상속하지 않습니다. 다만 사용자가 같은 세션의 승인을 직접 요청할 수 있으므로, 이 게이트는 “사용자 본인이 승인했다”는 독립적인 추가 인증 요소를 제공하지 않습니다.

## 코드와 테스트 근거

- 구현: `src/auth-proxy.mjs`, `src/verify-login.mjs`, `src/session-approval.mjs`
- 연결: `api/session-approval/status.mjs`, `api/session-approval/request.mjs`, 세션 보호 API adapters
- fixture 테스트: `test/auth-proxy.test.mjs`, `test/verify-login-session.test.mjs`, `test/session-approval.test.mjs`, `test/stage11-ui.test.mjs`

위 테스트 파일이 존재한다는 사실은 실서비스 JWT·Supabase·브라우저 세션의 Production E2E 통과를 뜻하지 않습니다. 이번 문서 정리에서는 테스트를 실행하지 않았습니다.
