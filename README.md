# BYTE BACK 방어전 자료실 — 5단계

이 저장소는 Supabase Auth 로그인과 서버 측 사용자별 소유권 검사를 유지하면서 메모 자료 요청을 Vercel 서버 함수로 모으는 5단계 학습용 자료실입니다. 메모 데이터는 가상 자료만 사용합니다.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Supabase 공식 JavaScript SDK의 이메일·비밀번호 로그인·로그아웃 흐름을 사용합니다. 화면에서 비밀번호나 JWT를 직접 만들지 않습니다. SDK의 Auth 네트워크 요청은 같은 출처의 Vercel Auth 프록시를 거치며, 로그인 세션의 access token만 자료 API에 전달합니다.
- 브라우저 파일에는 Supabase API 키가 없고 메모 테이블을 직접 읽거나 고치는 Data API 호출도 없습니다. `signInWithPassword`, `signOut`, `getSession` 호출은 유지합니다. 메모 CRUD는 아래 Vercel 자료 함수만 호출합니다.
- `/api/auth-proxy/token`, `/api/auth-proxy/user`, `/api/auth-proxy/logout`은 각각 고정된 Vercel 함수이며 해당 Auth 경로만 허용합니다. 로그인 요청은 Supabase로 HTTPS 전달되며 프록시는 요청 본문이나 자격 증명을 로그에 쓰지 않습니다. 이 공개 경로는 로그인을 중개할 뿐, 로그인 시도 자체를 제한하지 않습니다.
- 자료 API는 `src/verify-login.mjs`로 Supabase 발급자·대상·만료를 확인합니다. 요청의 브라우저 `userId`, `role`, `owner_id`를 신뢰하지 않고, 확인한 사용자 ID를 새 메모의 `owner_id`로 저장합니다.
- `GET /api/notes`는 로그인한 사용자의 메모만 반환합니다. `POST /api/notes`는 메모를 추가하고, `GET`, `PUT`, `DELETE /api/notes/:id`도 본인 소유 행만 처리합니다. 다른 사용자 소유 ID와 없는 ID는 모두 `404`이며, 수정 뒤에도 `owner_id`가 본인인지 확인합니다.
- 비로그인 API 요청은 `401`로 거부됩니다. A/B 교차 계정의 단건 읽기·수정·삭제는 테스트에서 `404`로 거부되고, 본인 메모 CRUD는 허용됩니다.
- `SUPABASE_SECRET_KEY`는 자료 CRUD용 Vercel 서버 함수에서만 사용합니다. Auth 프록시는 별도 `SUPABASE_PUBLISHABLE_KEY` 환경변수를 사용합니다. 실제 키 값은 두 환경변수 모두 브라우저·응답·로그·GitHub·제출 묶음에 넣지 않습니다.
- `/data.json`과 `public/data.json`은 없습니다. 옛 공개 Git 커밋과 옛 배포 이력은 남으므로, 과거 노출이 지워졌다고 보지 마세요.
- 로컬 점검: `node --test test/auth-proxy.test.mjs`, `npm run test:r5`, `npm run test:stage3`, `npm run build -- --local`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 비로그인 요청의 상태만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. A 계정의 정상 로그인과 메모 CRUD는 웹 화면에서 별도로 확인해야 합니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

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
4. 시크릿 창에서 `GET /api/notes`를 열면 `401`입니다. 무로그인 `POST /api/notes`와 `GET /api/notes/<UUID>`도 `401`이어야 합니다.
5. B 계정으로 로그인하면 B 소유 메모만 보여야 합니다. A 메모 UUID를 B의 GET·PUT·DELETE 경로에 넣으면 모두 `404`이고 A의 행은 그대로여야 합니다. A와 B 각각 본인 메모 CRUD도 확인하세요.
6. `npm run build -- --local` 뒤 로컬 첫 화면 응답에 `X-Content-Type-Options: nosniff`가 있는지 확인하세요. Production 배포 뒤에도 같은 헤더가 와야 합니다.
7. `close-direct-access.sql` 적용 뒤 원본 주소 `aleph.config.json`의 `originalApiUrl`에 공개용 키로 직접 보낸 읽기 요청은 HTTP `401`, `42501`, 반환 행 `0`이었습니다. SQL 적용 후 `anon`과 `authenticated`의 네 CRUD 권한은 모두 `false`입니다.

자료 CRUD 경로는 `aleph.config.json`의 `allowedRoutes`에 실제 메서드별로 기록합니다: `GET`·`POST /api/notes`, `GET`·`PUT`·`DELETE /api/notes/:id`. Auth 프록시의 token·user·logout 경로도 기록합니다. `originalApiUrl`은 쿼리 없는 Supabase REST 테이블 경로입니다.

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
- 이 게이트는 fixture 실행기의 연결입니다. 운영 요청 계약에는 출발 IP가 없으므로 실제 서비스 트래픽의 Wazuh 수집이나 운영 ZTNA 차단이 연결된 것은 아닙니다.
먼저 [AGENTS.md](AGENTS.md)를 읽고 한 번에 한 단계만 요청하세요. `src/decider.mjs`와 `src/detect.mjs`의 로컬 시험은 가상 요청·사건 연습이며 반 엔진이나 운영 심판의 결과가 아닙니다. `aleph.defense.submission.v2` 제출 묶음 계약은 `scripts/bundle.mjs`가 관리합니다.
