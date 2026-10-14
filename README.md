# BYTE BACK 방어전 자료실 — 12단계

이 저장소는 Supabase Auth 로그인과 서버 측 사용자별 소유권 검사를 유지하면서 메모 자료 요청을 Vercel 서버 함수로 모으고, 계약 판정·가상 사건 탐지·단건 복구·설치형 화면·로그인 세션 승인과 실제 API 기록을 읽는 탈환 작전실을 추가한 12단계 학습용 자료실입니다. 세션 승인은 학습용 서버 승인으로 물리 기기 증명을 뜻하지 않습니다. 메모 데이터는 가상 자료만 사용합니다.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Supabase 공식 JavaScript SDK의 이메일·비밀번호 로그인·로그아웃 흐름을 사용합니다. 화면에서 비밀번호나 JWT를 직접 만들지 않습니다. SDK의 Auth 네트워크 요청은 같은 출처의 Vercel Auth 프록시를 거치며, 로그인 세션의 access token만 자료 API에 전달합니다.
- 브라우저 파일에는 Supabase API 키가 없고 메모 테이블을 직접 읽거나 고치는 Data API 호출도 없습니다. `signInWithPassword`, `signOut`, `getSession` 호출은 유지합니다. 메모 CRUD는 아래 Vercel 자료 함수만 호출합니다.
- `/api/auth-proxy/token`, `/api/auth-proxy/user`, `/api/auth-proxy/logout`은 각각 고정된 Vercel 함수이며 해당 Auth 경로만 허용합니다. 로그인 요청은 Supabase로 HTTPS 전달되며 프록시는 요청 본문이나 자격 증명을 로그에 쓰지 않습니다. 이 공개 경로는 로그인을 중개할 뿐, 로그인 시도 자체를 제한하지 않습니다.
- 자료 API는 `src/verify-login.mjs`로 Supabase 발급자·대상·만료를 확인합니다. 요청의 브라우저 `userId`, `role`, `owner_id`를 신뢰하지 않고, 확인한 사용자 ID를 새 메모의 `owner_id`로 저장합니다.
- 화면은 명시적 자기 목록 경로 `GET /api/my/notes`를 사용합니다. 이 경로는 검증한 로그인 사용자 ID로 DB를 필터하고 응답 직전 소유자를 다시 대조합니다. 기존 `GET /api/notes`도 API 호환성을 위해 유지하지만 판정기 허용 경로에는 없습니다. `POST /api/notes`는 메모를 추가하고, `GET`, `PUT`, `DELETE /api/notes/:id`는 검증한 사용자 ID와 저장된 `owner_id`를 대조한 뒤 처리합니다. 수정·삭제는 변경 전에 소유자를 확인하고 변경 뒤에도 소유자를 확인합니다. 다른 사용자 소유 ID와 없는 ID는 모두 `404`입니다.
- 비로그인 API 요청은 `401`로 거부됩니다. A/B 교차 계정의 단건 읽기·수정·삭제는 테스트에서 `404`로 거부되고, 본인 메모 CRUD는 허용됩니다.
- `SUPABASE_SECRET_KEY`는 자료 CRUD용 Vercel 서버 함수에서만 사용합니다. Auth 프록시는 별도 `SUPABASE_PUBLISHABLE_KEY` 환경변수를 사용합니다. 실제 키 값은 두 환경변수 모두 브라우저·응답·로그·GitHub·제출 묶음에 넣지 않습니다.
- 서버는 Supabase `getClaims(accessToken)` 검증 결과에서 사용자 ID와 UUID 형식 `session_id`를 가져옵니다. 토큰의 브라우저 파싱 결과는 신뢰하지 않습니다. `session_id`가 없거나 형식이 맞지 않으면 승인 조회와 보호 자료 접근을 거부합니다.
- `/data.json`과 `public/data.json`은 없습니다. 옛 공개 Git 커밋과 옛 배포 이력은 남으므로, 과거 노출이 지워졌다고 보지 마세요.
- 6단계 판정기는 계약의 `deviceRegistered` 값이 `true`일 때만 허용하고, `false` 또는 누락은 `device_not_registered`로 거부합니다. `npm run decider:test`는 등록·미등록·상태 누락 가상 요청을 확인하는 로컬 연습이며 실제 기기 등록이나 심판 판정의 증거가 아닙니다.
- 7단계 판정기는 가상 접속 신호의 출처와 모양을 검사해 복합 이상 사건에 `step_up`을 요구합니다. 현재 실제 계약은 위치·네트워크 신호와 재로그인 확인 기능을 제공하지 않으므로 `source: none` 요청에는 신호를 꾸며 넣지 않고 정상 기기·허용 경로 규칙만 적용합니다. 지역 하나만으로 차단하지 않습니다.
- 8단계 `src/resource-zones.mjs`는 명시적 자기 목록, 메모 추가, 메모 단건 읽기·수정·삭제 경로를 분류합니다. 판정기는 사용자 메모 소유자를 추정하지 않으며, 최종 메모 API가 검증된 사용자와 저장된 `owner_id`를 대조합니다. 공지 API는 저장된 강사 권한을 별도로 확인합니다.
- 9단계 `src/detect.mjs`는 `docs/DETECT_EVENTS.md` 계약의 시각·메서드·가명 `identity.sub`만 읽습니다. 같은 가명 주체의 GET이 임의의 10분 구간에서 120건을 넘으면 `propose_revocation`을 제안하고, 실제 접근 회수는 수행하지 않습니다.
- 로컬 점검: `node --test test/auth-proxy.test.mjs`, `npm run test:r5`, `npm run test:stage3`, `npm run build -- --local`, `npm run decider:test`, `npm run fixture:7`, `node --test test/decider-stage7.test.mjs`, `npm run test:stage8`, `npm run detect:test`, `node --test test/detect-stage9.test.mjs`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 비로그인 요청의 상태만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. A 계정의 정상 로그인과 메모 CRUD는 웹 화면에서 별도로 확인해야 합니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

## 12단계 탈환 작전실 · 설치와 재현

`12단계 저장점` 커밋을 검사 기준으로 사용합니다. `git rev-parse HEAD`와 Production `/aleph.json`의 `commit`, 작전실의 배포 커밋을 대조하세요. 결과 파일도 검사한 commit을 포함합니다. 이전 커밋에서 확인한 결과를 새 배포 결과로 옮기지 않습니다.

- 승인 후 **탈환 작전실** 탭을 열면 `GET /api/session-approval/operations`가 본인의 최근 서버 요청 최대 100건과 복구 사본 메타데이터를 반환합니다. 가상 메모 제목·본문, 토큰, 이메일, 사용자 UUID, session_id는 작전실 응답에 없습니다. 기존 메모 화면은 **내 자료실** 탭으로 유지합니다.
- API 허용·거부·서버 오류 수는 응답의 `api.records` 배열과 동일한 범위에서 계산합니다. 이는 HTTP 결과이며 ALEPH 판정기의 allow/deny 결과로 바꾸지 않습니다. 기록의 요청 ID·시각·경로 템플릿·HTTP 상태·배포 commit을 표에서 대조할 수 있습니다. 서버가 기록에 실패하면 `X-Audit-Recorded: false`이며 그 요청은 DB 집계에 포함되지 않습니다.
- 규칙 3개는 실제 `RULE_IDS`입니다. 운영 엔진의 판정·탐지·접속 회수 결과 경로는 이 저장소에 연결되어 있지 않아 **미실행**, 사건 수는 **미확인**입니다. `detect()`의 `propose_revocation`은 회수 제안입니다. 실제 회수 완료라고 표시하지 않습니다.
- 정책 복구 기준은 검증 가능한 Stage 9 사본의 버전·revision입니다. 실제 정책 복구 결과는 미실행입니다. 메모 사본은 본인 소유 백업의 캡처 시각·SHA-256·가린 참조만 보여 줍니다. 백업 존재는 복구 성공이 아닙니다. 단건 복구 성공 응답 수는 최근 감사 기록에 한정합니다.
- **정상·금지 요청 검사**는 1~11단계의 요청 계획·기대 결과·실제 HTTP 상태·요청 ID·확인 시각을 한 표로 만듭니다. 승인된 자기 목록 GET과 비로그인 거부 요청은 실측하며, 지원되지 않는 운영 엔진·교차 계정·자료 복구 요청은 사유와 함께 미실행으로 둡니다. 클라이언트에서 추정한 상태는 기록하지 않습니다. 승인 상태는 HTTP 200뿐 아니라 `status: approved`도 확인합니다.
- 결과 JSON은 검사 당시 커밋, 화면 메모리의 실측과 서버의 가린 기록을 담습니다. 실행 전후 배포를 확인하며 배포 커밋이 바뀌면 이전 검사와 진행 중인 결과 반영을 무효화합니다. 로그아웃·승인 재확인 때 화면 기록은 지워집니다. **가린 결과 JSON 받기**로 재실행 전 보관할 수 있습니다. 브라우저 저장소에는 승인 토큰·기기 키·검사 기록을 저장하지 않습니다.
- 공식 41종 시험의 이름·결과 계약은 제공되지 않았으므로 **총수 41 / 실행 0 / 미실행 41 / 통과 미확인**입니다. 자체 HTTP 검사와 로컬 fixture를 41종 통과로 집계하지 않습니다. 12단계 통과·총공세 클리어는 운영 심판 결과가 필요합니다.

### 학생 작업과 제공 엔진의 출처

제공 엔진은 **ALEPH SDP 엔진**입니다. `docs/DECIDER_REQUEST.md`의 `student-kit/sdp-core/decision-contract.mjs` 계약이 요청·응답의 출처입니다. 이 저장소는 제공 엔진의 소스·설치 프로그램·relay를 포함하지 않습니다. 엔진 설치·실행·중지·회수는 수업에서 제공하는 엔진 배포 안내를 따릅니다. 없는 실행 명령이나 결과 API를 만들지 않습니다.

학생이 작성·관리하는 부분은 `src/decider.mjs`, `src/detect.mjs`, 소유권을 검사하는 자료 API, Auth 프록시, 정책·메모 복구 코드, 세션 승인 접속 화면, `src/operations-api.mjs`·`operations-log.mjs`, 작전실 UI와 자체 HTTP 확인 절차입니다. `deviceRegistered`는 엔진 계약 값이며 웹앱 승인 DB를 이 값으로 변환하지 않습니다. 제공 엔진의 보안 성공을 학생 화면 문구로 대신하지 않습니다.

### 설치·실행·중지

1. Node.js 22 이상과 Git을 설치하고 같은 저장소를 받습니다.
   ```powershell
   git clone https://github.com/gilin03/choi-bujang-secret-vault.git
   cd choi-bujang-secret-vault
   git rev-parse HEAD
   npm install
   ```
2. 새 학습 DB는 아래 기존 테이블 순서로 구성합니다. 현재 연결 DB에는 다시 초기 스키마를 적용하지 않습니다.
   `supabase/schema.sql` → `owner-policies.sql` → `close-direct-access.sql` →
   `stage8-resource-zones.sql` → `stage10-note-backups.sql` → `stage11-session-approval.sql`.
   Stage 12는 `supabase/migrations/20261014131532_stage12_operation_events.sql`을 **한 번** 추가 적용합니다.
   이미 적용된 migration은 다시 실행하지 않습니다. 자료·owner·backup을 삭제하거나 가짜 자료로 바꾸지 않습니다.
3. Vercel 설정 화면에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`를 등록합니다. 값은 채팅·로그·Git·제출 JSON에 출력하지 않습니다. `aleph.config.json`의 issuer·자료 URL·배포 URL을 본인 프로젝트에 맞춥니다. `judgeIssuer`는 운영 측 설정입니다.
4. 학생 로컬 계약·복구 검사를 실행합니다.
   ```powershell
   node --test test/*.test.mjs
   npm run decider:test
   npm run detect:test
   npm run policy:compare
   npm run build -- --local
   ```
   `decider:test`, `detect:test`, XDR fixture와 메모리 DB 테스트는 로컬 연습입니다. 제공 엔진의 운영 결과가 아닙니다.
5. 전체 앱을 로컬에서 실행하려면 Vercel 공식 CLI로 같은 프로젝트를 연결한 뒤 `npx vercel dev`를 실행합니다. 비밀값은 공식 환경변수 화면/CLI로만 설정하고 출력하지 않습니다. 정적 파일 서버만으로는 보호 API를 실행할 수 없습니다. 로컬 서버 중지는 터미널에서 `Ctrl+C`입니다. Production 중지는 Vercel 관리 화면의 해당 프로젝트 배포 제어를 사용하고 자료 DB를 삭제하지 않습니다.
6. 커밋을 `main`에 푸시해 Vercel Git 배포를 실행합니다. READY 상태와 `/aleph.json`의 commit·step을 대조한 뒤 실제 계정으로 로그인 → 세션 승인 → **탈환 작전실** → **정상·금지 요청 검사**를 실행합니다. 화면 숫자는 아래 서버 기록을 기준으로 대조합니다.
7. 비로그인 Production 자체 점검은 `npm run operations:check`입니다. 현재 HEAD와 배포 SHA가 다르면 중단합니다. `artifacts/operation-checks.json`에 현재 커밋·실측·미실행을 기록하며, 로그인 세션을 요구하는 행은 미실행으로 남습니다. 저장점과 배포가 끝난 뒤 `npm run bundle`로 `artifacts/submission.json`을 생성합니다. 두 결과는 자체 점검이고 심판 판정이 아닙니다.

### 복구·점검 한계

- 정책 복구: `npm run policy:compare`의 검증된 버전과 차이를 확인한 뒤 기존 `policy:apply -- --apply --confirm <revision>` 절차를 따릅니다. Stage 9 정책에는 Stage 10 restore 경로가 없으므로 비교 결과를 검토 없이 적용하면 해당 경로 등록이 빠집니다. 전체 커밋을 되돌리는 대신 필요한 정책 항목만 검토합니다.
- Windows에서도 고정 해시를 검사하도록 `.gitattributes`가 정책 사본의 LF 줄바꿈을 보존합니다. 사본 내용·해시·Git 출처 검증을 느슨하게 하지 않습니다.
- Stage 12 로컬 검증: 전체 회귀 테스트, 판정·탐지 가상 연습, 정책 비교·빌드를 확인했습니다. 로컬 브라우저 메모리 DB fixture에서는 확인표 24행 중 실측 기대 일치 15행·미실행 9행이며, 서버 기록 6건(허용 5·거부 1)과 화면 수치가 일치했습니다. JSON 내보내기에도 본문·토큰·사용자/세션 ID가 없었습니다. 이 결과는 Production 인증 E2E가 아닙니다. 로컬 UI 재현은 `node test/operations-preview.mjs`로 시작하고 `Ctrl+C`로 중지합니다.
- 메모 복구: 승인된 소유자의 `POST /api/notes/:id/restore`만 사용합니다. API의 백업 해시 검증·DB 재검증 후 본인 GET 허용과 다른 계정 GET 거부를 다시 확인하고 요청 ID·시각을 보관합니다. Stage 12의 자동 점검은 자료를 변조·삭제·복원하지 않습니다.
- 접속 앱 복구: 로그아웃·새 로그인 → 새 세션 승인 → 서버 상태 재조회 순서입니다. 새 세션에 이전 승인을 복사하지 않습니다. 접속 회수 기능은 현재 운영 엔진과 미연결입니다.
- 실제 DB에서 감사 테이블 RLS와 anon/authenticated 직접 접근 권한 없음, service_role SELECT/INSERT만 허용을 확인했습니다. 서버 전용 표이므로 RLS 정책 없음 안내는 의도된 구성입니다. [Supabase RLS 정책 없음 안내](https://supabase.com/docs/guides/database/database-linter?lint=0008_rls_enabled_no_policy).
- 현재 연결의 Vercel 관리 API는 권한 오류(403)이며 CLI 로그인 정보도 없습니다. 배포 commit·step은 공개 식별 파일과 실제 HTTP로 대조합니다. 관리 로그 조회는 확인 불가입니다. 새로운 Production 로그인 세션이 없으면 보호 작전실의 Production 브라우저 확인은 미실행으로 남깁니다.

## 11단계 설치형 화면과 기기 승인 (보존)

- `/manifest.webmanifest`는 `BYTE BACK 자료실` 이름, 독립 실행 표시, 아이콘, 오프라인 안내를 제공합니다. 화면에는 브라우저/설치 앱 실행 상태를 보여 주며, 설치 표시는 기기 승인으로 취급하지 않습니다. 오프라인 화면에서는 자료를 보여 주거나 저장하지 않습니다.
- 로그인 뒤 서버가 검증한 현재 Supabase 로그인 세션의 승인 상태를 확인합니다. 계정 전체가 아니라 UUID `session_id`별로 저장하므로 새 로그인 세션은 승인을 이어받지 않습니다. 브라우저 localStorage/sessionStorage에 승인 토큰이나 기기 키를 저장하지 않습니다.
- **기기 승인 요청**을 받으면 서버가 Supabase `getClaims`로 현재 로그인 세션을 검증하고, 그 사용자와 `session_id` 조합만 `approved`로 기록합니다. 요청 본문에서 온 세션·사용자·승인 상태는 무시하며, 세션 ID 검증이나 DB 조회·기록에 실패하면 보호 자료를 차단합니다. 이전 구현에서 남은 `pending` 행도 같은 검증 세션의 요청으로 승인 상태로 바뀝니다.
- DB 구조는 [`stage11-session-approval.sql`](supabase/stage11-session-approval.sql)을 사용합니다. 이 파일은 새 `vault_session_approvals` 테이블만 추가하며 기존 단계 테이블을 변경·삭제하지 않습니다. 아직 DB에 테이블을 만들지 않은 환경은 Supabase **SQL Editor**에서 이 스키마를 한 번 적용해야 합니다. 각 요청을 승인하기 위한 운영자 SQL은 필요하지 않습니다.
- 화면은 승인 API 응답을 받은 뒤 상태 API를 다시 조회하고, 서버 상태가 `approved`인 같은 세션에서만 기존 자료실을 표시합니다. 각 보호 API도 검증된 사용자와 세션 ID를 함께 조회해 `approved`인지 확인한 다음 기존 소유권·강사 권한 검사를 수행합니다. 새 로그인 세션은 별도 행을 가지므로 승인을 상속하지 않습니다.
- Supabase Auth 세션은 페이지 메모리에서만 유지됩니다. 설치형 웹앱 여부, 계정 ID, 버튼 클릭만으로 승인하지 않으며 이 흐름은 실제 물리 기기 증명을 제공하지 않습니다.
- `npm run test:stage11`은 검증된 세션 전달, 누락·잘못된 ID 거부, 서버 승인 기록, 새 세션 비상속, 승인 세션만의 API 접근을 가상 DB로 확인합니다. 이 흐름은 학습용 서버 세션 승인이지 실제 물리 기기 증명이 아닙니다. 실제 Production 계정 흐름은 별도 브라우저 확인입니다.

## 7단계 이상 접속 추가 확인

- 판정기는 브라우저 헤더를 읽지 않고 `docs/DECIDER_REQUEST.md` 계약의 `signals`와 `recentEvents`만 확인합니다. `signals.source`가 `judge_fixture`이고 지역·네트워크·시각 및 최근 사건 모양이 유효한 가상 요청만 이상 규칙 평가에 씁니다. 운영 계약의 `source: none`은 위치·네트워크 증거가 없다는 뜻이며 정상값을 만들어 내지 않습니다. 실제 재로그인 확인 계약이 없으므로 이 경로는 기기·자원 규칙을 통과하면 자료 요청을 막지 않습니다. 클라이언트 출처, 누락·잘못된 필드, 불명확한 출처는 신뢰 신호로 승격하지 않고 `step_up`을 요구합니다.
- 복합 이상 가상 사건은 이른/늦은 시각(0–5시 또는 22–23시), `network: unusual`, 최근 5분 안의 `bulk_read` 또는 호환 `risk_signal` 계수 20 이상이 함께 있을 때만 추가 확인합니다. 지역은 복합 조건에 포함하지 않으므로 외국 지역 하나만으로 추가 확인이나 차단을 하지 않습니다.
- 추가 확인 전에는 `step_up_required`로 응답합니다. 새 요청의 엔진 검증 `stepUp.verified === true`와 `authAgeSeconds` 0–900초가 함께 있어야 재판정에서 허용하고, 미등록 기기는 기존 `device_not_registered` 거부가 우선합니다.
- 요청 계약에는 엔진 검증 `stepUp` 필드가 있지만, 이 저장소에는 실제 로그인 화면·세션 갱신 엔진이 없습니다. `npm run fixture:7`, `npm run decider:test`, `node --test test/decider-stage7.test.mjs`는 가상 요청만 검증하며 실제 재로그인·자료 차단은 측정하지 않았습니다. 현재 계약의 실제 접속 신호 출처는 `none`이므로 실제 접속 데이터로 이상행동을 탐지했다고 주장하지 않습니다.

## 8단계 자료 구역과 강사 공지

- 자원 ID는 `src/resource-zones.mjs`의 `student_notes`와 `instructor_announcements`로 구분합니다. 화면의 자기 목록은 `GET /api/my/notes`를 사용하며, 이 별도 Vercel 함수도 기존 로그인 검증·DB 소유자 필터를 사용합니다. 단건 읽기와 CRUD 주소·응답은 유지하고 메모 응답에는 `X-Aleph-Resource-Id`를 표시합니다.
- 판정기는 엔진 계약의 `subjectId`, `deviceId`, `deviceRegistered`, HTTP 메서드와 정확한 `service`·`path`·`route`를 확인합니다. `subjectId`는 DB 소유자 ID가 아니므로 소유권 증거로 쓰지 않습니다. 모호한 `GET /api/notes` 목록, 쿼리가 있는 요청, 모르는 경로·메서드·서비스, `/notes/:id/export` 같은 추가 깊이는 `resource_not_authorized`로 거부합니다. 허용된 메모 경로 안에서도 최종 소유권은 API가 검증한 사용자와 저장된 소유자를 대조합니다.
- 강사 공지는 `/api/announcements`에서 로그인 사용자에게 읽기 전용으로 보여 주고, `/api/announcements/:id`의 `PUT`은 `vault_instructor_access`에서 검증된 Supabase 사용자 ID의 활성 강사 권한을 확인한 뒤에만 실행합니다. 일반 학생의 role·userId·updated_by 요청 필드는 권한으로 쓰지 않습니다. 강사 권한 조회 실패도 거부합니다.
- `supabase/stage8-resource-zones.sql`은 기존 `vault_notes`와 그 권한을 바꾸지 않고 `vault_announcements`, `vault_instructor_access`만 추가합니다. 두 테이블은 RLS를 켜고 `PUBLIC`, `anon`, `authenticated` 권한을 회수하며, 서버 함수에 필요한 `service_role`의 공지 `SELECT/UPDATE`와 권한표 `SELECT`만 남깁니다. 실제 강사 계정은 운영자가 확인한 Supabase 사용자 UUID로 `vault_instructor_access`에 등록해야 합니다. 임의로 학생을 강사로 지정하지 않았습니다.
- 연결된 `defense` DB에는 두 테이블을 추가했고, 확인 결과 현재 공지 0건·강사 권한 0건입니다. 두 테이블 모두 RLS가 켜졌고 anon/authenticated SELECT·UPDATE는 `false`; `service_role`은 공지 SELECT·UPDATE와 강사표 SELECT만 가능합니다. 아직 실제 강사 계정을 등록하지 않았으므로 실제 계정의 공지 PUT은 기본 거부됩니다. 승인된 강사 등록은 관리자 권한으로 확인한 UUID만 사용하세요.
- 판정기 연습에서 `instructor_fixture`는 가상 강사 subject ID일 뿐입니다. 실제 강사 subject ID 매핑과 `resource_not_authorized` 이유 코드 등록 여부는 반 엔진 운영 설정에 달려 있으며, 이 저장소만으로 운영 엔진을 변경했다고 주장하지 않습니다.
- `npm run test:stage8`은 명시적 자기 목록·메모 CRUD 경로의 판정 분류, 모호한 목록·미등록 기기·공지 쓰기·잘못된 경로의 거부, 7단계 추가 확인 유지, 그리고 API의 A/B 소유자 검사를 확인합니다. 단건 GET은 계약의 가명 `subjectId`만으로 주인을 구분할 수 없으므로 API가 B의 A 메모를 `404`로 거부합니다. 학생 공지 PUT은 API에서 `403`입니다. 화면 메뉴는 변경하지 않았습니다.

## 9단계 가상 도플갱어 조회 탐지

- `docs/DETECT_EVENTS.md`가 제공하는 가상 사건 필드는 `at`, `method`, `identity.sub`입니다. 탐지기는 이 필드만 사용하며 토큰, 메모 본문, 실명, 브라우저가 임의로 보낸 역할·네트워크·기기 값을 읽거나 출력하지 않습니다.
- 같은 가명 `identity.sub`의 `GET`이 어느 슬라이딩 10분 구간에서든 120건을 넘으면 `{ action: 'propose_revocation', reasonCode: 'burst_read', subject: '<가명 sub>' }`를 반환합니다. 정확히 120건, 다른 주체의 합산, 비-GET 요청, 각 10분 구간에서 120건 이하인 요청은 `{ action: 'observe' }`입니다.
- 이 사건 계약에는 네트워크·기기 ID·기존 판정 결과가 없습니다. 따라서 구현은 그 신호를 꾸며내지 않고, 제안 대상도 계약에서 확인되는 가명 `subject`로 한정합니다. 실제 세션 회수·차단·경과 시간 측정은 연결하거나 검증하지 않았습니다.
- `npm run detect:test`와 `node --test test/detect-stage9.test.mjs`는 로컬 가상 사건만 확인합니다. 이 테스트 통과는 운영 사건 전달, 실제 권한 회수, 또는 심판 결과를 뜻하지 않습니다.

## 10단계 제작 1 정책 차이 미리보기

- `npm run policy:compare`는 매 실행마다 `policies/stage9-safe-policy.json`을 다시 읽어 고정 SHA-256과 Stage 9 원본 Git 커밋·blob 근거를 검증한 뒤, `RULE_IDS`와 `allowedRoutes`의 차이만 미리 보여 줍니다. 사본 누락·무결성 오류·출처 검증 실패 시 중단합니다.
- 출력에는 복원 기준 버전과 변경 범위가 표시됩니다. 이 명령은 비교 전용이며 시험 정책·운영 정책·DB를 변경하지 않습니다.
- 시험 정책을 적용하려면 먼저 비교 결과를 확인한 다음 `npm run policy:apply -- --apply --confirm <revision>`을 실행합니다. apply 명령도 사본을 재검증하고 미리보기를 먼저 출력하며, 확인 revision이 다르거나 빠지면 중단합니다. 적용 범위는 `src/decider.mjs`의 `RULE_IDS`와 `aleph.config.json`의 `allowedRoutes`뿐입니다.

### 10단계 제작 3 메모 한 건 복원

- `notes` 서비스의 `POST /api/notes/:id/restore`는 Vercel 함수 `api/notes/[id]/restore.mjs`가 처리합니다. 판정기 허용 경로에도 이 단건 경로만 등록했습니다.
- Stage 10 시작 시 Supabase **SQL Editor**에서 [`stage10-note-backups.sql`](supabase/stage10-note-backups.sql)을 적용합니다. 기존 owner가 있는 메모를 `public.vault_note_backups`에 한 번 캡처하고, 이후 메모 INSERT도 최초 상태만 자동 저장합니다. 백업 행은 API에서 수정·삭제하지 않습니다.
- 복원 API는 URL ID로 해당 backup 한 건만 조회하고 로그인 owner와 ID·내용 SHA-256을 확인합니다. 변조된 메모는 제목·내용을 갱신하고, 삭제된 메모는 백업 ID·owner로 다시 넣은 뒤 DB에서 ID·owner·내용 해시를 확인합니다. 요청 본문은 사용하지 않으며 다른 메모와 감사 테이블은 쓰지 않습니다.
- `node --test test/note-restore.test.mjs`는 B 메모의 변조·삭제 복원과 백업 검증을 메모리 DB fixture로 확인합니다. Production SQL 적용과 Vercel 배포는 진행됐지만, 실제 B 메모를 변조·삭제하는 Production 복원 E2E와 연결 DB 복원 검증은 미실행입니다.

### 10단계 제작 4 복구 뒤 재시험 순서

1. `npm run policy:compare`로 매번 사본의 해시·Git 출처를 검증하고 복원 버전과 변경 항목을 확인합니다. 출력한 revision을 확인한 뒤에만 `npm run policy:apply -- --apply --confirm <revision>`을 실행합니다.
2. 시험 계정 B로 `POST /api/notes/:id/restore`를 호출합니다. 성공 응답의 메모 ID와 owner, content SHA-256이 검증한 backup과 일치하는지 확인합니다. 사본 검증이나 복원 후 DB 재검증이 실패하면 다음 단계로 넘어가지 않습니다.
3. 복구 직후 인증된 A 세션으로 A 소유 메모의 `GET /api/notes/:id`가 `200`인지, B 세션으로 복구된 B 메모의 같은 경로 GET이 `200`인지 확인합니다. 이어 B 세션으로 A 메모를 GET해 `404`로 거부되는지 확인합니다. UI에서 세션의 A/B 소유자를 확인하지 못했거나 요청을 보내지 않았다면 결과는 미실행으로 기록합니다.
4. 로컬 회귀 요청은 단계 순서로 실행합니다: `node --test test/package-starter.test.mjs test/auth-proxy.test.mjs test/r5.test.mjs test/stage3.test.mjs`, `npm run decider:test`, `node --test test/decider-stage7.test.mjs`, `npm run test:stage8`, `node --test test/detect-stage9.test.mjs`, `node --test test/note-restore.test.mjs`. 마지막 테스트의 post-restore 사례는 메모리 DB에서 A 정상 읽기와 B의 A 메모리 접근 거부를 확인하며 Production A/B 시험을 대신하지 않습니다.
5. 각 실행의 실제 상태 코드와 검증 결과만 기록합니다. `npm run bundle`은 비로그인 공개 경로 점검이므로 A/B 정상·금지 요청의 재시험으로 세지 않습니다.

## Supabase 학습용 테이블

연결된 `defense` 프로젝트의 `public.vault_notes` 초기 네 샘플(`sort_order` 1–4)은 A 소유 세 건, B 소유 한 건으로 지정했습니다. 최근 재점검 때 추가 소유 메모 두 건도 확인했습니다. `owner_id uuid`에는 `auth.users` 외래키가 없습니다. RLS와 읽기·추가·수정·삭제 소유자 정책을 적용했습니다. 서버 API도 검증한 사용자 ID로 각 요청을 제한합니다.

5단계용 [close-direct-access.sql](supabase/close-direct-access.sql)은 `public.vault_notes`와 해당 `sort_order` 시퀀스에서 `PUBLIC`, `anon`, `authenticated`의 직접 권한을 회수합니다. 연결된 `defense` 프로젝트에 적용하고 **After** 조회로 확인했습니다. 다른 테이블과 Vercel 함수의 서버 역할은 건드리지 않습니다.

적용 전에는 `authenticated`에 테이블 CRUD와 시퀀스 `USAGE`가 있었고 `anon`은 권한이 없었습니다. 적용 후 `information_schema.role_table_grants` 결과는 비어 있으며 `anon`·`authenticated`의 테이블 CRUD 네 권한과 시퀀스 `USAGE`는 모두 `false`입니다. `service_role`의 테이블 CRUD와 시퀀스 `USAGE`는 계속 `true`입니다. 기존 RLS 정책은 유지되고 Vercel 자료 함수는 `SUPABASE_SECRET_KEY`로 계속 자료를 처리합니다.

`sort_order`는 새 메모 저장에 쓰는 시퀀스 기본값을 가집니다. 저장소의 [schema.sql](supabase/schema.sql)은 테이블·시퀀스 구조와 기본 권한을 정의하며 메모 본문을 담지 않습니다. 새 학습 DB에 처음 적용할 때만 Supabase **SQL Editor**에서 실행하세요. 이미 테이블이 있는 연결 DB에는 다시 실행하지 마세요.

Table Editor에서 다음을 확인하세요.

- `id uuid` 기본키, 고유한 `sort_order`, nullable `owner_id uuid`, `title text`, `content text`
- `owner_id`에서 `auth.users`로 가는 외래키가 없음
- `vault_notes`의 RLS가 켜져 있음
- 적용 후 `PUBLIC`, `anon`, `authenticated`에 테이블 CRUD 권한이 없고, `anon`·`authenticated`의 시퀀스 `USAGE`도 없음
- 소유자 정책 네 개가 각 CRUD 작업에 `(select auth.uid()) = owner_id`를 적용함
- 새 메모용 `vault_notes_sort_order_seq` 기본값이 있음. `service_role`에는 `USAGE`가 있고 `anon`·`authenticated`에는 없음

SQL Editor에서 권한도 확인할 수 있습니다.

```sql
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_can_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_can_select,
  has_table_privilege('service_role', 'public.vault_notes', 'select') as service_role_can_select;
```

5단계 SQL 적용 뒤 anon과 authenticated의 네 CRUD 권한이 모두 `false`이고, `information_schema.role_table_grants`에는 이 세 역할의 권한이 없습니다. 공개용 키로 직접 보낸 Data API `GET`은 HTTP `401`, PostgREST `42501`, 반환 행 `0`으로 확인했습니다. RLS 정책은 `(select auth.uid()) = owner_id`를 읽기·추가·수정·삭제에 각각 적용하며 유지됩니다.

## 로그인 발급자와 키 설정

`aleph.config.json`의 `identityProvider`는 연결된 Supabase Auth 값을 가리킵니다. `issuer`는 `https://<project-ref>.supabase.co/auth/v1`, `audience`는 `authenticated`, `jwksUrl`은 `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`입니다. 로그인 검증에는 기존 `src/verify-login.mjs`를 사용합니다.

브라우저 화면에는 Project URL과 실제 API 키가 없습니다. `SUPABASE_PUBLISHABLE_KEY`는 Vercel **Settings → Environment Variables**에서 민감 환경변수로 설정하고 Auth 프록시만 사용합니다. 로그인 계정은 Supabase **Authentication → Users**에 이미 있는 이메일·비밀번호 계정을 사용하세요. 이 단계 화면에는 가입 기능이 없습니다.

## Vercel 서버 환경변수

Vercel 프로젝트 **Settings → Environment Variables**에 `SUPABASE_URL`, `SUPABASE_SECRET_KEY`, `SUPABASE_PUBLISHABLE_KEY`가 있어야 합니다. 마지막 항목은 공개용 키지만 과제의 화면 키 제외 조건에 맞춰 민감 환경변수로 보관하고 프록시에서만 사용합니다. `SUPABASE_SECRET_KEY`는 서버 전용이며 브라우저 파일·응답·로그·GitHub·제출 묶음에 넣지 않습니다. 값은 터미널이나 채팅에 출력하지 마세요. 환경변수를 추가하거나 바꾼 뒤 새 배포를 만들어야 서버 함수에 적용됩니다.

## 직접 확인과 남은 약점

최신 Production 주소에서 다음을 확인하세요. Stage 11에서는 실제 로그인 → 승인 전 자료 숨김 → 서버 승인 → 같은 세션 메모 3건 표시 → 새 로그인 세션 미승인을 확인했습니다. Stage 12의 현재 커밋에 대한 실측은 작전실 또는 `operations:check` 결과의 commit을 확인하세요. Production 교차 계정 CRUD·자료 변조/삭제 복구는 미실행입니다.

1. 로그아웃 상태에서 로그인 화면이 보입니다. 비밀번호가 틀린 계정으로 로그인하면 Supabase Auth의 오류 이유가 화면에 표시됩니다.
2. A 계정으로 로그인하고 현재 세션을 서버에 승인 요청하면 A 소유 메모만 표시됩니다. 본인 메모를 추가·수정·삭제한 뒤 목록이 갱신되는지 확인하세요.
3. 로그아웃하면 로그인 화면으로 돌아가고 계정 자료가 화면에서 지워집니다.
4. 시크릿 창에서 `GET /api/my/notes`를 열면 `401`입니다. 무로그인 `POST /api/notes`와 `GET /api/notes/<UUID>`도 `401`이어야 합니다.
5. B 계정으로 로그인하면 B 소유 메모만 보여야 합니다. A 메모 UUID를 B의 GET·PUT·DELETE 경로에 넣으면 모두 `404`이고 A의 행은 그대로여야 합니다. A와 B 각각 본인 메모 CRUD도 확인하세요.
6. `npm run build -- --local` 뒤 로컬 첫 화면 응답에 `X-Content-Type-Options: nosniff`가 있는지 확인하세요. Production 배포 뒤에도 같은 헤더가 와야 합니다.
7. `close-direct-access.sql` 적용 뒤 원본 주소 `aleph.config.json`의 `originalApiUrl`에 공개용 키로 직접 보낸 읽기 요청은 HTTP `401`, `42501`, 반환 행 `0`이었습니다. SQL 적용 후 `anon`과 `authenticated`의 네 CRUD 권한은 모두 `false`입니다.

현재 등록 허용 경로는 `aleph.config.json`의 `allowedRoutes`가 기준입니다. 자기 목록·메모 단건 CRUD·복원·공지 경로를 등록합니다. 판정기는 메모 소유권을 추정하지 않고 최종 API가 소유자를 검사합니다. 학생 공지 쓰기는 판정기에서도 거부하고 API는 저장된 강사 권한을 검사합니다. Auth 프록시·세션 승인·작전실은 별도 웹앱 관리 경로이며 엔진 자료 허용 경로에 추가하지 않습니다. `originalApiUrl`은 쿼리 없는 Supabase REST 테이블 경로입니다.

현재 배포의 정적 파일 목록과 GitHub의 최신 `main` 파일에서 이전 가상 메모 문장이 남았는지 확인하려면, Vercel의 최신 Production 배포 파일 목록과 GitHub 저장소의 현재 파일을 각각 검색하세요. 로컬에서 GitHub 최신 트리를 검색하는 방법은 다음과 같습니다. `<이전 가상 메모 문장>`을 한 문장씩 실제 검색어로 바꿔 실행하고, 검색어 또는 결과를 저장소에 추가하지 마세요.

```powershell
git fetch origin
git grep -n -F -- "<이전 가상 메모 문장>" origin/main
git ls-tree -r --name-only origin/main | Select-String '(^|/)data\.json$'
```

브라우저에서 메모 Data API를 직접 부르지 않으며 자료 CRUD는 Vercel 함수로 갑니다. Auth SDK 메서드 호출은 유지하고 HTTP 요청만 같은 출처 프록시로 보냅니다. 브라우저 번들에는 Supabase API 키가 없습니다. 이전 공개 커밋과 이전 Vercel 배포 이력은 남으므로 과거 노출이 지워졌거나 해소됐다고 보지 마세요.

## 1단계 시작 틀의 배포 정보

빌드 산출물 `/aleph.json`에는 저장소·커밋·배포 주소와 `allowedRoutes`가 포함됩니다. 5단계부터는 쿼리 없는 HTTPS `originalApiUrl`도 기록합니다. 이 주소와 경로는 공개 설정이며 비밀값을 넣지 않습니다.

`vercel.json`은 정적 화면을 `public`에서 배포하고, 루트 `api/notes.mjs`는 Vercel Node.js 함수로 배포합니다. 빌드 때 `public/aleph.json`에 저장소·커밋·배포 주소를 기록합니다. 이 식별 파일만으로 소유권이나 방어 성공을 인정하지 않습니다. `aleph.config.json`의 `judgeIssuer`는 운영 측 설정이므로 수정하지 않습니다.

`npm run test:r5`와 `npm run build -- --local`은 로컬 연습용입니다. 실제 배포와 공개 HTTP 요청은 별도로 확인하고, 운영 심판의 판단으로 표현하지 마세요.

## XDR 보너스 fixture

- `xdr/fixtures/brute-force.json`의 28개 가상 Wazuh 형식 경보에서 `xdr/brute-force/read-alerts.mjs`가 시각·출발 주소·계정·규칙 수준·설명만 추립니다. 비밀처럼 보이는 값과 이메일은 가립니다.
- `xdr/brute-force/patterns.json`은 MITRE ATT&CK T1110의 반복 로그인 실패와 T1110.003의 password spraying 두 패턴만 근거와 함께 기록합니다. `decide.mjs`는 분명한 공격을 `block`, 애매한 신호를 `alert`, 정상 이벤트를 `record`로 분류합니다. Jev 연결이 없거나 실패하면 애매한 신호는 `alert`로 남습니다.
- `npm run xdr:run -- brute-force`는 결정 결과를 `xdr/brute-force/result.json`에 쓰고 block·alert·record 건수와 아래 XDR 게이트 결과를 출력합니다. 차단 후보만 `xdr/brute-force/deny-rules.json`에 넣으며 각 규칙에 출발 주소, 만료 시각, 근거 경보 ID, 확신도를 둡니다. 만료는 실행 시각부터 15분입니다.
- 실행기는 fixture의 출발 주소를 `src/decider-with-xdr.mjs`에 전달해 활성 차단 규칙을 확인한 뒤, 차단되지 않은 요청은 기존 `src/decider.mjs`로 넘깁니다. 이 어댑터는 ZTNA 판정 앞에 추가하는 게이트이며 기존 판정기를 대체하지 않습니다. `src/decider.mjs`와 Aleph 요청·응답 계약은 바꾸지 않았습니다.
- `xdr/alerts.log`에는 block·alert 메타데이터를 한 줄씩 남깁니다. 계정·경보 설명·토큰은 기록하지 않으며 웹 주입 항목에는 모듈 키와 고정된 안전 사유를 덧붙입니다. 같은 fixture를 재실행해도 같은 항목은 중복되지 않습니다.
- 현재 반 엔진/배포 요청 경로의 판정 계약에는 출발 IP가 없으므로 어댑터는 실제 운영 경로에는 연결되어 있지 않습니다. fixture 연습은 네트워크를 호출하지 않으며 실제 Wazuh 스트림, Jev 서비스, 운영 ZTNA 차단을 의미하지 않습니다. 실제 개인정보나 비밀값을 넣지 마세요.
- 웹 주입 연습의 `xdr/fixtures/web-injection.json`에는 26개 가상 Wazuh 형식 경보가 있습니다. `xdr/web-injection/read-alerts.mjs`는 확인용으로 다섯 허용 필드만 추출·비밀값 마스킹하며, 단독 실행용 `decide.mjs`는 이 읽기 모듈을 불러오지 않습니다.
- `xdr/web-injection/patterns.json`에는 MITRE ATT&CK T1190 근거와 함께 요청 인자의 SQL 구문, 스크립트 태그, 반복 `../` 경로 이탈 세 신호와 세부 패턴이 불확실할 때 쓰는 검토 전용 fallback을 기록합니다. 강한 패턴·반복 횟수·심각도·유효 출발 주소가 함께 확인될 때만 block, T1190 검토 경보는 alert, 정상 이벤트는 record입니다.
- `npm run xdr:run -- web-injection`은 `xdr/web-injection/result.json`과 15분 뒤 만료되는 `deny-rules.json`을 만들고 fixture 출발 주소를 기존 `src/decider-with-xdr.mjs` 사전 차단 게이트에 넣어 결과를 출력합니다. `respond.mjs`는 block 후보 규칙과 block·alert 로그만 `xdr/alerts.log`에 추가하며, 같은 경보를 재실행해도 중복 기록하지 않습니다.
- `xdr/known-cve/`는 CVE-2021-44228 모양의 JNDI 요청을 고위험·유효 주소와 함께 확인할 때만 block하고, 약한 CVE/T1190·점검 도구 흔적은 alert, 정상 이벤트는 record로 분류합니다. 확인용 reader는 허용된 다섯 필드만 마스킹해 내보내며 단독 `decide.mjs`는 외부 모듈을 불러오지 않습니다.
- `npm run xdr:run -- known-cve`는 24건 결과, 15분 만료·근거 경보 ID가 있는 차단 후보, 중복 방지 알림 로그를 만들고 기존 XDR 사전 차단 게이트를 fixture 출발 주소로 확인합니다. 이는 학습용 fixture 검증이며 실제 Wazuh 수집이나 운영 차단은 아닙니다.
- `npm run xdr:run -- persistence`는 24건의 가상 서비스·예약 작업 경보를 T1543·T1053 패턴으로 분류합니다. 고위험의 구체적인 지속성 신호만 만료가 있는 차단 후보로 만들고, 애매한 신호는 알림, 정상 이벤트는 기록으로 둡니다. `xdr/persistence/result.json`, `deny-rules.json`, `xdr/alerts.log`를 갱신하고 기존 XDR 게이트 결과를 출력합니다. 운영 Wazuh 수집이나 실제 PC 격리를 의미하지 않습니다.
- 이 게이트는 fixture 실행기의 연결입니다. 운영 요청 계약에는 출발 IP가 없으므로 실제 서비스 트래픽의 Wazuh 수집이나 운영 ZTNA 차단이 연결된 것은 아닙니다.
먼저 [AGENTS.md](AGENTS.md)를 읽고 한 번에 한 단계만 요청하세요. `src/decider.mjs`와 `src/detect.mjs`의 로컬 시험은 가상 요청·사건 연습이며 반 엔진이나 운영 심판의 결과가 아닙니다. `aleph.defense.submission.v2` 제출 묶음 계약은 `scripts/bundle.mjs`가 관리합니다.
