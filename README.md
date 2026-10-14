# BYTE BACK 방어전 자료실 — 9단계

이 저장소는 Supabase Auth 로그인과 서버 측 사용자별 소유권 검사를 유지하면서 메모 자료 요청을 Vercel 서버 함수로 모으고, 엔진의 가상 접속·자원 구역 판정 및 가상 사건 탐지 연습을 추가한 9단계 학습용 자료실입니다. 메모 데이터는 가상 자료만 사용합니다.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Supabase 공식 JavaScript SDK의 이메일·비밀번호 로그인·로그아웃 흐름을 사용합니다. 화면에서 비밀번호나 JWT를 직접 만들지 않습니다. SDK의 Auth 네트워크 요청은 같은 출처의 Vercel Auth 프록시를 거치며, 로그인 세션의 access token만 자료 API에 전달합니다.
- 브라우저 파일에는 Supabase API 키가 없고 메모 테이블을 직접 읽거나 고치는 Data API 호출도 없습니다. `signInWithPassword`, `signOut`, `getSession` 호출은 유지합니다. 메모 CRUD는 아래 Vercel 자료 함수만 호출합니다.
- `/api/auth-proxy/token`, `/api/auth-proxy/user`, `/api/auth-proxy/logout`은 각각 고정된 Vercel 함수이며 해당 Auth 경로만 허용합니다. 로그인 요청은 Supabase로 HTTPS 전달되며 프록시는 요청 본문이나 자격 증명을 로그에 쓰지 않습니다. 이 공개 경로는 로그인을 중개할 뿐, 로그인 시도 자체를 제한하지 않습니다.
- 자료 API는 `src/verify-login.mjs`로 Supabase 발급자·대상·만료를 확인합니다. 요청의 브라우저 `userId`, `role`, `owner_id`를 신뢰하지 않고, 확인한 사용자 ID를 새 메모의 `owner_id`로 저장합니다.
- 화면은 명시적 자기 목록 경로 `GET /api/my/notes`를 사용합니다. 이 경로는 검증한 로그인 사용자 ID로 DB를 필터하고 응답 직전 소유자를 다시 대조합니다. 기존 `GET /api/notes`도 API 호환성을 위해 유지하지만 판정기 허용 경로에는 없습니다. `POST /api/notes`는 메모를 추가하고, `GET`, `PUT`, `DELETE /api/notes/:id`는 검증한 사용자 ID와 저장된 `owner_id`를 대조한 뒤 처리합니다. 수정·삭제는 변경 전에 소유자를 확인하고 변경 뒤에도 소유자를 확인합니다. 다른 사용자 소유 ID와 없는 ID는 모두 `404`입니다.
- 비로그인 API 요청은 `401`로 거부됩니다. A/B 교차 계정의 단건 읽기·수정·삭제는 테스트에서 `404`로 거부되고, 본인 메모 CRUD는 허용됩니다.
- `SUPABASE_SECRET_KEY`는 자료 CRUD용 Vercel 서버 함수에서만 사용합니다. Auth 프록시는 별도 `SUPABASE_PUBLISHABLE_KEY` 환경변수를 사용합니다. 실제 키 값은 두 환경변수 모두 브라우저·응답·로그·GitHub·제출 묶음에 넣지 않습니다.
- `/data.json`과 `public/data.json`은 없습니다. 옛 공개 Git 커밋과 옛 배포 이력은 남으므로, 과거 노출이 지워졌다고 보지 마세요.
- 6단계 판정기는 계약의 `deviceRegistered` 값이 `true`일 때만 허용하고, `false` 또는 누락은 `device_not_registered`로 거부합니다. `npm run decider:test`는 등록·미등록·상태 누락 가상 요청을 확인하는 로컬 연습이며 실제 기기 등록이나 심판 판정의 증거가 아닙니다.
- 7단계 판정기는 가상 접속 신호의 출처와 모양을 검사해 복합 이상 사건에 `step_up`을 요구합니다. 현재 실제 계약은 위치·네트워크 신호와 재로그인 확인 기능을 제공하지 않으므로 `source: none` 요청에는 신호를 꾸며 넣지 않고 정상 기기·허용 경로 규칙만 적용합니다. 지역 하나만으로 차단하지 않습니다.
- 8단계 `src/resource-zones.mjs`는 명시적 자기 목록, 메모 추가, 메모 단건 읽기·수정·삭제 경로를 분류합니다. 판정기는 사용자 메모 소유자를 추정하지 않으며, 최종 메모 API가 검증된 사용자와 저장된 `owner_id`를 대조합니다. 공지 API는 저장된 강사 권한을 별도로 확인합니다.
- 9단계 `src/detect.mjs`는 `docs/DETECT_EVENTS.md` 계약의 시각·메서드·가명 `identity.sub`만 읽습니다. 같은 가명 주체의 GET이 임의의 10분 구간에서 120건을 넘으면 `propose_revocation`을 제안하고, 실제 접근 회수는 수행하지 않습니다.
- 로컬 점검: `node --test test/auth-proxy.test.mjs`, `npm run test:r5`, `npm run test:stage3`, `npm run build -- --local`, `npm run decider:test`, `npm run fixture:7`, `node --test test/decider-stage7.test.mjs`, `npm run test:stage8`, `npm run detect:test`, `node --test test/detect-stage9.test.mjs`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 비로그인 요청의 상태만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. A 계정의 정상 로그인과 메모 CRUD는 웹 화면에서 별도로 확인해야 합니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

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

## 10단계 백업에서 시험 자료실 복원

- `recovery/policy-snapshots/stage9-safe-policy.json`은 9단계 저장점 `7870df1452c9cd3a045c3edfa7171d452bc653da`의 `src/decider.mjs` Git blob과 규칙 목록을 기준으로 한 안전 정책 스냅샷입니다. 복구 도구는 해당 커밋이 현재 기록의 조상인지, 파일 blob 지문과 규칙 목록이 일치하는지 확인하며 하나라도 다르면 중단합니다.
- 정책 비교·복원은 운영 판정기나 운영 설정이 아니라 무시되는 `artifacts/stage10/test-policy.json`만 대상으로 합니다. `npm run recovery:policy -- init`으로 시험용 변경 정책을 준비하고, `npm run recovery:policy -- preview`로 메모 구역 규칙의 차이와 확인값을 확인한 다음, `npm run recovery:policy -- restore --confirm <확인값>`으로 실행합니다. 복원 범위는 `services.notes.rules`뿐이며 다른 서비스 규칙과 기존 감사 기록은 유지되고 복원 감사 항목 하나가 추가됩니다. 초기화는 기존 파일을 덮어쓰지 않습니다.
- 비공개 가상 메모 복구 경로는 `POST /api/recovery/notes/:id`이며 `aleph.config.json`의 `restoreRoute`에 기록했습니다. `allowedRoutes`에는 판정기가 허용하지 않는 복구 경로를 넣지 않았습니다. 서버 전용 사본은 `recovery/private/stage10-b-note-backup.json`에 있으며, Vercel 정적 배포 경로인 `public/` 밖에 두어 브라우저 경로나 일반 자료 API로 제공하지 않습니다. `STAGE10_B_NOTE_BACKUP_JSON`과 `STAGE10_B_NOTE_BACKUP_SHA256`은 Production 필수 설정이 아닙니다.
- 백업 형식은 `aleph.private-note-backup.v1`이며 `version`, 메모의 `id`·`ownerId`·`title`·`body`, `contentSha256`, 사본 전체의 `backupSha256`를 포함합니다. `contentSha256`는 UTF-8 `JSON.stringify({id,ownerId,title,body})`의 SHA-256이고, `backupSha256`는 `schema`·`version`·`note`를 같은 키 순서로 직렬화한 JSON의 SHA-256입니다. 매 preview와 restore 요청은 파일을 새로 읽어 schema·버전·ID·소유자·두 해시를 다시 검증합니다. 사본이 없거나 검증에 실패하면 DB를 조회·수정하지 않고 중단하며, restore는 preview 때 확인한 버전·백업 해시 및 현재 메모 지문이 그대로일 때만 진행합니다. 요청 본문으로 백업 데이터·owner·role을 전달하거나 바꿀 수 없습니다.
- preview는 복구 버전, 대상 ID, 변경 필드만 보여 주고 데이터를 복구하지 않습니다. 확인된 restore는 지정한 B 메모 한 건만 삽입하거나 갱신합니다. 다른 메모와 감사 기록은 보존하며 복구 함수는 `vault_notes` 외 테이블을 읽거나 쓰지 않습니다. 복구 후 반환 행도 다시 확인하고, 검증이 맞지 않으면 대상 행에 한해 조건부 보상을 시도합니다.
- 복구 뒤 확인 순서: `npm install`; `npm run recovery:policy -- init`; `npm run recovery:policy -- preview`; diff와 확인값 검토; `npm run recovery:policy -- restore --confirm <확인값>`; `npm run test:stage10`; `npm run test:r5`; `npm run test:stage3`; `npm run test:package`; `npm run decider:test`; `npm run fixture:7`; `npm run test:stage8`; `npm run detect:test`; `node --test test/*.test.mjs`; `npm run bundle`. 로컬 API 시험은 가상 B 계정의 메모 한 건 복원, 백업 누락·불일치·오래된 preview 거부, A 메모와 감사 기록 보존을 확인합니다. 실제 Production 복구 요청은 별도 배포 후 확인해야 하며, 실행하지 않은 경우 미실행으로 기록합니다.

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

최신 Production 주소에서 다음을 확인하세요. A 계정의 실제 로그인·CRUD는 로컬 핸들러 테스트에서 확인했으며, 브라우저 세션으로 실제 계정에 로그인해 확인한 것은 아닙니다.

1. 로그아웃 상태에서 로그인 화면이 보입니다. 비밀번호가 틀린 계정으로 로그인하면 Supabase Auth의 오류 이유가 화면에 표시됩니다.
2. A 계정으로 로그인하면 A 소유 메모만 표시됩니다. 본인 메모를 추가·수정·삭제한 뒤 목록이 갱신되는지 확인하세요.
3. 로그아웃하면 로그인 화면으로 돌아가고 계정 자료가 화면에서 지워집니다.
4. 시크릿 창에서 `GET /api/my/notes`를 열면 `401`입니다. 무로그인 `POST /api/notes`와 `GET /api/notes/<UUID>`도 `401`이어야 합니다.
5. B 계정으로 로그인하면 B 소유 메모만 보여야 합니다. A 메모 UUID를 B의 GET·PUT·DELETE 경로에 넣으면 모두 `404`이고 A의 행은 그대로여야 합니다. A와 B 각각 본인 메모 CRUD도 확인하세요.
6. `npm run build -- --local` 뒤 로컬 첫 화면 응답에 `X-Content-Type-Options: nosniff`가 있는지 확인하세요. Production 배포 뒤에도 같은 헤더가 와야 합니다.
7. `close-direct-access.sql` 적용 뒤 원본 주소 `aleph.config.json`의 `originalApiUrl`에 공개용 키로 직접 보낸 읽기 요청은 HTTP `401`, `42501`, 반환 행 `0`이었습니다. SQL 적용 후 `anon`과 `authenticated`의 네 CRUD 권한은 모두 `false`입니다.

판정기 허용 경로는 `aleph.config.json`의 `allowedRoutes`와 맞춥니다: `GET /api/my/notes`, `GET /api/notes/:id`, `GET /notes/:id`, `GET /api/announcements`, `GET /api/announcements/:id`. 메모 추가·수정·삭제와 공지 수정은 API에서는 서버 검증 후 가능하지만, 엔진 계약에 소유자·강사 권한 증거가 없어 판정기의 허용 목록에서는 제외했습니다. Auth 프록시의 token·user·logout 경로도 기록합니다. `originalApiUrl`은 쿼리 없는 Supabase REST 테이블 경로입니다.

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
