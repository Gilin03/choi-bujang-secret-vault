# BYTE BACK 방어전 자료실 — 3단계

이 저장소는 Supabase Auth 로그인과 서버 측 토큰 검증을 붙인 3단계 학습용 자료실입니다. 네 개의 공유 샘플과 계정별 메모는 모두 가상 자료이며, 실제 개인정보나 운영 자료는 넣지 마세요.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Supabase 공식 JavaScript SDK의 이메일·비밀번호 로그인을 사용합니다. 화면에서 비밀번호나 JWT를 직접 만들지 않습니다. 브라우저는 로그인 세션의 access token만 자료 API에 전달합니다.
- 자료 API는 `src/verify-login.mjs`로 Supabase 발급자·대상·만료를 확인합니다. 요청의 브라우저 `userId`나 `role`은 신뢰하지 않고, 확인한 사용자 ID로 새 메모의 `owner_id`를 저장합니다.
- `GET /api/notes`는 로그인 계정의 메모와 공유 가상 샘플 네 건을 반환합니다. `POST /api/notes`는 메모를 추가하고, `GET`, `PUT`, `DELETE /api/notes/:id`는 ID로 한 건을 읽고 수정하고 삭제합니다. 삭제 후 해당 ID의 GET은 `404`입니다.
- 로그인하지 않은 `GET`·`POST /api/notes` 및 항목 API는 `401`로 거부됩니다. 소유자 목록은 계정별로 제한하지만, 아직 항목 API가 `owner_id`를 확인하지 않으므로 다른 계정의 메모 ID를 알면 읽거나 고칠 수 있습니다. 이 ID별 소유자 검사는 4단계에서 추가합니다.
- `/data.json`과 `public/data.json`은 없습니다. 옛 공개 Git 커밋과 옛 배포 이력은 남으므로, 과거 노출이 지워졌다고 보지 마세요.
- 로컬 점검: `npm run test:r5`, `npm run test:stage3`, `npm run build -- --local`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 비로그인 요청의 상태만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. A 계정의 정상 로그인과 메모 CRUD는 웹 화면에서 별도로 확인해야 합니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

## Supabase 학습용 테이블

연결된 `defense` 프로젝트에는 `public.vault_notes`와 공유 가상 메모 네 건이 있습니다. `owner_id uuid`에는 `auth.users` 외래키가 없습니다. RLS는 켜져 있고 공개 역할의 직접 테이블 접근은 차단되어 있습니다. `sort_order`는 새 메모 저장에 쓰는 서버 전용 시퀀스 기본값을 가집니다. 저장소의 [schema.sql](supabase/schema.sql)은 테이블·시퀀스 구조와 권한만 정의하며 메모 본문을 담지 않습니다. 새 학습 DB에 처음 적용할 때는 Supabase **SQL Editor**에서 파일을 실행하세요. 이미 테이블이 있는 연결 DB에는 다시 실행하지 마세요.

Table Editor에서 다음을 확인하세요.

- `id uuid` 기본키, 고유한 `sort_order`, nullable `owner_id uuid`, `title text`, `content text`
- `owner_id`에서 `auth.users`로 가는 외래키가 없음
- `vault_notes`의 RLS가 켜져 있음
- `anon`과 `authenticated`에 읽기 권한이나 RLS 정책이 없음. 서버 역할 `service_role`만 읽을 수 있음
- 새 메모용 `vault_notes_sort_order_seq` 기본값이 있고, 시퀀스 사용 권한은 `service_role`에만 있음

SQL Editor에서 권한도 확인할 수 있습니다.

```sql
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_can_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_can_select,
  has_table_privilege('service_role', 'public.vault_notes', 'select') as service_role_can_select;
```

기대값은 `false`, `false`, `true`입니다. RLS를 켜고 공개 역할 정책을 두지 않았다는 Supabase 보안 조언의 `rls_enabled_no_policy` 정보 알림은 이 단계의 직접 DB 접근 차단과 일치합니다.

## 로그인 발급자와 키 설정

`aleph.config.json`의 `identityProvider`는 연결된 Supabase Auth 값을 가리킵니다. `issuer`는 `https://<project-ref>.supabase.co/auth/v1`, `audience`는 `authenticated`, `jwksUrl`은 `https://<project-ref>.supabase.co/auth/v1/.well-known/jwks.json`입니다. 로그인 검증에는 기존 `src/verify-login.mjs`를 사용합니다.

브라우저 화면에는 Supabase Project URL과 publishable key가 들어 있습니다. publishable key는 공개용입니다. 로그인 계정은 Supabase **Authentication → Users**에 이미 있는 이메일·비밀번호 계정을 사용하세요. 이 단계 화면에는 가입 기능이 없습니다.

## Vercel 서버 환경변수

Vercel 프로젝트 **Settings → Environment Variables**에 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`가 있어야 합니다. `SUPABASE_SECRET_KEY`는 서버 전용이며 브라우저 파일·응답·로그·GitHub·제출 묶음에 넣지 않습니다. 키 값을 터미널이나 채팅에 출력하지 마세요. 환경변수를 추가하거나 바꾼 뒤 새 배포를 만들어야 서버 함수에 적용됩니다.

## 직접 확인과 남은 약점

최신 Production 주소에서 다음을 확인하세요.

1. 로그아웃 상태에서 로그인 화면이 보입니다. 비밀번호가 틀린 계정으로 로그인하면 Supabase Auth의 오류 이유가 화면에 표시됩니다.
2. A 계정으로 로그인하면 공유 샘플 네 건과 A 계정의 메모 목록이 표시됩니다. 메모를 추가하고, 수정하고, 삭제한 뒤 목록이 갱신됩니다.
3. 로그아웃하면 로그인 화면으로 돌아가고 계정 자료가 화면에서 지워집니다.
4. 시크릿 창에서 `GET /api/notes`를 열면 `401`입니다. 무로그인 `POST /api/notes`와 `GET /api/notes/<UUID>`도 `401`이어야 합니다.
5. 로그인한 B 계정은 아직 알려진 A 메모 UUID로 그 메모를 읽거나 바꿀 수 있습니다. 이는 의도적으로 남긴 4단계 전 약점입니다. BOLA 확인을 위해 실제 사용자 메모 본문을 제출 묶음이나 로그에 복사하지 마세요.
6. `/data.json`은 `404`이고 메모 본문을 반환하지 않습니다. Supabase `anon`·`authenticated` 역할의 직접 `SELECT`는 권한 오류로 거부됩니다.

허용된 자료 경로는 `aleph.config.json`의 `allowedRoutes`에 실제 메서드별로 기록합니다: `GET`·`POST /api/notes`, `GET`·`PUT`·`DELETE /api/notes/:id`.

현재 배포의 정적 파일 목록과 GitHub의 최신 `main` 파일에서 이전 가상 메모 문장이 남았는지 확인하려면, Vercel의 최신 Production 배포 파일 목록과 GitHub 저장소의 현재 파일을 각각 검색하세요. 로컬에서 GitHub 최신 트리를 검색하는 방법은 다음과 같습니다. `<이전 가상 메모 문장>`을 한 문장씩 실제 검색어로 바꿔 실행하고, 검색어 또는 결과를 저장소에 추가하지 마세요.

```powershell
git fetch origin
git grep -n -F -- "<이전 가상 메모 문장>" origin/main
git ls-tree -r --name-only origin/main | Select-String '(^|/)data\.json$'
```

이번 변경은 새 정적 파일과 GitHub 최신 트리에서 현재 메모를 제거하는 작업입니다. 이전 공개 커밋과 이전 Vercel 배포 이력은 남으므로 과거 노출이 지워졌거나 해소됐다고 보지 마세요.

## 1단계 시작 틀의 배포 정보

`vercel.json`은 정적 화면을 `public`에서 배포하고, 루트 `api/notes.mjs`는 Vercel Node.js 함수로 배포합니다. 빌드 때 `public/aleph.json`에 저장소·커밋·배포 주소를 기록합니다. 이 식별 파일만으로 소유권이나 방어 성공을 인정하지 않습니다. `aleph.config.json`의 `judgeIssuer`는 운영 측 설정이므로 수정하지 않습니다.

`npm run test:r5`와 `npm run build -- --local`은 로컬 연습용입니다. 실제 배포와 공개 HTTP 요청은 별도로 확인하고, 운영 심판의 판단으로 표현하지 마세요.

먼저 [AGENTS.md](AGENTS.md)를 읽고 한 번에 한 단계만 요청하세요. `src/decider.mjs`와 `src/detect.mjs`의 로컬 시험은 가상 요청·사건 연습이며 반 엔진이나 운영 심판의 결과가 아닙니다. `aleph.defense.submission.v2` 제출 묶음 계약은 `scripts/bundle.mjs`가 관리합니다.
