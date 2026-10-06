# BYTE BACK 방어전 자료실 — 4단계

이 저장소는 Supabase Auth 로그인과 서버 측 사용자별 소유권 검사를 붙인 4단계 학습용 자료실입니다. 초기 가상 메모 네 건은 A 소유 세 건, B 소유 한 건이며, 실제 개인정보나 운영 자료는 넣지 마세요.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Supabase 공식 JavaScript SDK의 이메일·비밀번호 로그인을 사용합니다. 화면에서 비밀번호나 JWT를 직접 만들지 않습니다. 브라우저는 로그인 세션의 access token만 자료 API에 전달합니다.
- 자료 API는 `src/verify-login.mjs`로 Supabase 발급자·대상·만료를 확인합니다. 요청의 브라우저 `userId`, `role`, `owner_id`를 신뢰하지 않고, 확인한 사용자 ID를 새 메모의 `owner_id`로 저장합니다.
- `GET /api/notes`는 로그인한 사용자의 메모만 반환합니다. `POST /api/notes`는 메모를 추가하고, `GET`, `PUT`, `DELETE /api/notes/:id`도 본인 소유 행만 처리합니다. 다른 사용자 소유 ID와 없는 ID는 모두 `404`이며, 수정 뒤에도 `owner_id`가 본인인지 확인합니다.
- 비로그인 API 요청은 `401`로 거부됩니다. A/B 교차 계정의 단건 읽기·수정·삭제는 테스트에서 `404`로 거부되고, 본인 메모 CRUD는 허용됩니다.
- `/data.json`과 `public/data.json`은 없습니다. 옛 공개 Git 커밋과 옛 배포 이력은 남으므로, 과거 노출이 지워졌다고 보지 마세요.
- 로컬 점검: `npm run test:r5`, `npm run test:stage3`, `npm run build -- --local`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 비로그인 요청의 상태만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. A 계정의 정상 로그인과 메모 CRUD는 웹 화면에서 별도로 확인해야 합니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

## Supabase 학습용 테이블

연결된 `defense` 프로젝트의 `public.vault_notes` 초기 네 샘플(`sort_order` 1–4)은 A 소유 세 건, B 소유 한 건으로 지정했습니다. 최근 재점검에서는 각 계정의 추가 소유 메모 한 건씩도 확인되어 현재 합계는 여섯 건(A 소유 네 건, B 소유 두 건)입니다. 메모 본문은 확인하거나 변경하지 않았습니다. `owner_id uuid`에는 `auth.users` 외래키가 없습니다. RLS와 읽기·추가·수정·삭제 소유자 정책을 적용했습니다. 서버 API도 검증한 사용자 ID로 각 요청을 제한합니다.

재현용 [owner-policies.sql](supabase/owner-policies.sql)은 적용 전·후 GRANT 조회와 정책 SQL을 담고 있습니다. 연결된 DB에는 적용을 완료했습니다. 새 학습 DB에 적용할 때는 파일의 **Before** 조회를 먼저 실행하고 결과를 기록한 뒤 **Apply** 구문을 실행하고 **After** 조회로 대조하세요. 이 파일은 `public.vault_notes`와 메모 생성에 쓰는 해당 시퀀스 외의 테이블을 바꾸지 않습니다.

`sort_order`는 새 메모 저장에 쓰는 시퀀스 기본값을 가집니다. 저장소의 [schema.sql](supabase/schema.sql)은 테이블·시퀀스 구조와 기본 권한을 정의하며 메모 본문을 담지 않습니다. 새 학습 DB에 처음 적용할 때만 Supabase **SQL Editor**에서 실행하세요. 이미 테이블이 있는 연결 DB에는 다시 실행하지 마세요.

Table Editor에서 다음을 확인하세요.

- `id uuid` 기본키, 고유한 `sort_order`, nullable `owner_id uuid`, `title text`, `content text`
- `owner_id`에서 `auth.users`로 가는 외래키가 없음
- `vault_notes`의 RLS가 켜져 있음
- `anon`에는 테이블 권한이 없고, `authenticated`에는 SELECT·INSERT·UPDATE·DELETE만 있음
- 소유자 정책 네 개가 각 CRUD 작업에 `(select auth.uid()) = owner_id`를 적용함
- 새 메모용 `vault_notes_sort_order_seq` 기본값이 있음. `authenticated`에는 기본값 INSERT를 위한 `USAGE`가 있고 `anon`에는 없음

SQL Editor에서 권한도 확인할 수 있습니다.

```sql
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_can_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_can_select,
  has_table_privilege('service_role', 'public.vault_notes', 'select') as service_role_can_select;
```

적용 후 확인값은 `anon`의 네 CRUD 권한이 모두 `false`, `authenticated`의 네 CRUD 권한이 모두 `true`입니다. `information_schema.role_table_grants`에는 authenticated의 네 권한만 표시됩니다. anon 직접 REST 조회는 HTTP `401`과 PostgreSQL 권한 오류 `42501`로 거부됐습니다. RLS 정책은 `(select auth.uid()) = owner_id`를 읽기·추가·수정·삭제에 각각 적용합니다. authenticated 역할의 직접 Data API 호출은 심판 점검 범위에서 제외되어 별도로 요청하지 않았습니다.

## 로그인 발급자와 키 설정

`aleph.config.json`의 `identityProvider`는 연결된 Supabase Auth 값을 가리킵니다. `issuer`는 `https://<project-ref>.supabase.co/auth/v1`, `audience`는 `authenticated`, `jwksUrl`은 `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`입니다. 로그인 검증에는 기존 `src/verify-login.mjs`를 사용합니다.

브라우저 화면에는 Supabase Project URL과 publishable key가 들어 있습니다. publishable key는 공개용입니다. 로그인 계정은 Supabase **Authentication → Users**에 이미 있는 이메일·비밀번호 계정을 사용하세요. 이 단계 화면에는 가입 기능이 없습니다.

## Vercel 서버 환경변수

Vercel 프로젝트 **Settings → Environment Variables**에 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`가 있어야 합니다. `SUPABASE_SECRET_KEY`는 서버 전용이며 브라우저 파일·응답·로그·GitHub·제출 묶음에 넣지 않습니다. 키 값을 터미널이나 채팅에 출력하지 마세요. 환경변수를 추가하거나 바꾼 뒤 새 배포를 만들어야 서버 함수에 적용됩니다.

## 직접 확인과 남은 약점

최신 Production 주소에서 다음을 확인하세요. 브라우저에서 A/B 로그인과 메모 작업은 사용자가 직접 확인해야 하며, 로컬 테스트 결과를 실제 배포 시험으로 표현하지 마세요.

1. 로그아웃 상태에서 로그인 화면이 보입니다. 비밀번호가 틀린 계정으로 로그인하면 Supabase Auth의 오류 이유가 화면에 표시됩니다.
2. A 계정으로 로그인하면 A 소유 메모만 표시됩니다. 현재 확인된 초기 샘플 세 건과 추가 소유 메모 한 건이 보이며, 본인 메모를 추가·수정·삭제한 뒤 목록이 갱신되는지 확인하세요.
3. 로그아웃하면 로그인 화면으로 돌아가고 계정 자료가 화면에서 지워집니다.
4. 시크릿 창에서 `GET /api/notes`를 열면 `401`입니다. 무로그인 `POST /api/notes`와 `GET /api/notes/<UUID>`도 `401`이어야 합니다.
5. B 계정으로 로그인하면 B 소유 메모만 보여야 합니다. 현재 확인된 초기 샘플 한 건과 추가 소유 메모 한 건이 보입니다. A 메모 UUID를 B의 GET·PUT·DELETE 경로에 넣으면 모두 `404`이고 A의 행은 그대로여야 합니다. A와 B 각각 본인 메모 CRUD도 확인하세요.
6. `/data.json`은 `404`이고 메모 본문을 반환하지 않습니다. 이번 적용에서 anon의 직접 REST 읽기는 권한 오류로 거부됐습니다. authenticated 역할에는 테이블 CRUD 권한과 본인 행만 허용하는 RLS 정책을 구성했으며, authenticated 직접 Data API 요청은 심판 점수에서 제외된 조건이므로 재현하지 않았습니다.

허용된 자료 경로는 `aleph.config.json`의 `allowedRoutes`에 실제 메서드별로 기록합니다: `GET`·`POST /api/notes`, `GET`·`PUT`·`DELETE /api/notes/:id`.

현재 배포의 정적 파일 목록과 GitHub의 최신 `main` 파일에서 이전 가상 메모 문장이 남았는지 확인하려면, Vercel의 최신 Production 배포 파일 목록과 GitHub 저장소의 현재 파일을 각각 검색하세요. 로컬에서 GitHub 최신 트리를 검색하는 방법은 다음과 같습니다. `<이전 가상 메모 문장>`을 한 문장씩 실제 검색어로 바꿔 실행하고, 검색어 또는 결과를 저장소에 추가하지 마세요.

```powershell
git fetch origin
git grep -n -F -- "<이전 가상 메모 문장>" origin/main
git ls-tree -r --name-only origin/main | Select-String '(^|/)data\.json$'
```

이번 변경은 API에서 사용자별 메모 소유권을 확인합니다. 이전 공개 커밋과 이전 Vercel 배포 이력은 남으므로 과거 노출이 지워졌거나 해소됐다고 보지 마세요.

## 1단계 시작 틀의 배포 정보

`vercel.json`은 정적 화면을 `public`에서 배포하고, 루트 `api/notes.mjs`는 Vercel Node.js 함수로 배포합니다. 빌드 때 `public/aleph.json`에 저장소·커밋·배포 주소를 기록합니다. 이 식별 파일만으로 소유권이나 방어 성공을 인정하지 않습니다. `aleph.config.json`의 `judgeIssuer`는 운영 측 설정이므로 수정하지 않습니다.

`npm run test:r5`와 `npm run build -- --local`은 로컬 연습용입니다. 실제 배포와 공개 HTTP 요청은 별도로 확인하고, 운영 심판의 판단으로 표현하지 마세요.

먼저 [AGENTS.md](AGENTS.md)를 읽고 한 번에 한 단계만 요청하세요. `src/decider.mjs`와 `src/detect.mjs`의 로컬 시험은 가상 요청·사건 연습이며 반 엔진이나 운영 심판의 결과가 아닙니다. `aleph.defense.submission.v2` 제출 묶음 계약은 `scripts/bundle.mjs`가 관리합니다.
