# BYTE BACK 방어전 자료실 — 2단계

이 저장소는 화면의 가상 메모 네 건을 정적 파일 밖으로 옮긴 2단계 자료실입니다. 메모 본문은 Supabase 학습용 테이블에 따로 저장합니다. 실제 개인정보나 운영 자료는 넣지 마세요.

이 프로젝트는 1단계에서 학생 본인의 GitHub 저장소와 Vercel 배포를 만든 시작 틀에서 이어집니다. 새로 시작하는 학생은 GitHub 계정을 만든 뒤 방어전 1단계 카드의 **Deploy** 흐름에서 본인 계정의 공개 저장소와 Vercel 프로젝트를 만들고, 배포 주소를 카드에 제출합니다. 이 자료실은 그 같은 저장소와 배포를 단계별로 보강합니다.

## 현재 동작과 다시 실행하기

- `/`는 Vercel 서버 함수 `GET /api/notes`에서 가상 자료를 읽어 네 카드를 표시합니다. 카드 문구는 `textContent`로 렌더링합니다.
- `/data.json`과 `public/data.json`은 없습니다. 최신 배포와 GitHub의 현재 버전에서 정적 메모 파일을 제공하지 않습니다.
- `/api/notes`는 아직 익명으로 호출할 수 있어 누구나 네 건의 가상 메모를 받을 수 있습니다. `POST /api/notes`는 `405`로 거부됩니다. API 접근 제한은 다음 단계에서 추가합니다.
- 로컬 점검: `npm run test:r5`, `npm run build -- --local`.
- 저장점 커밋과 실제 배포가 끝난 뒤 `npm run bundle`을 실행하면 실제 익명 요청의 상태와 건수만 제출 묶음에 기록합니다. 이 결과는 학생의 자체 점검이며 심판 판정이 아닙니다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않습니다.

## Supabase 학습용 테이블

연결된 `defense` 프로젝트에는 `public.vault_notes`와 가상 메모 네 건이 적용되어 있습니다. 저장소의 [schema.sql](supabase/schema.sql)은 테이블 구조와 권한만 정의하며 메모 본문을 담지 않습니다. 다른 새 학습 DB에 처음 적용할 때는 Supabase **SQL Editor**에서 이 파일의 SQL을 실행하세요. 이미 테이블이 있는 프로젝트에는 다시 실행하지 마세요.

Table Editor에서 다음을 확인하세요.

- `id uuid` 기본키, 고유한 `sort_order`, nullable `owner_id uuid`, `title text`, `content text`
- `owner_id`에서 `auth.users`로 가는 외래키가 없음
- `vault_notes`의 RLS가 켜져 있음
- `anon`과 `authenticated`에 읽기 권한이나 RLS 정책이 없음. 서버 역할 `service_role`만 읽을 수 있음

SQL Editor에서 권한도 확인할 수 있습니다.

```sql
select
  has_table_privilege('anon', 'public.vault_notes', 'select') as anon_can_select,
  has_table_privilege('authenticated', 'public.vault_notes', 'select') as authenticated_can_select,
  has_table_privilege('service_role', 'public.vault_notes', 'select') as service_role_can_select;
```

기대값은 `false`, `false`, `true`입니다. RLS를 켜고 공개 역할 정책을 두지 않았다는 Supabase 보안 조언의 `rls_enabled_no_policy` 정보 알림은 이 단계의 직접 DB 접근 차단과 일치합니다.

## Vercel 서버 환경변수

Vercel 프로젝트 **Settings → Environment Variables**에서 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`를 설정하세요. 현재 `SUPABASE_URL`은 연결된 Supabase 주소로 저장되어 있습니다. `SUPABASE_SECRET_KEY`는 **Production**에만 추가하고 민감값 입력란에 직접 입력하세요. 키 값을 소스 코드, 브라우저 파일, 응답, 로그, GitHub 또는 제출 묶음에 복사하지 마세요. `NEXT_PUBLIC_` 접두어도 붙이지 않습니다. 환경변수를 추가하거나 바꾼 뒤 새 배포를 만들어야 서버 함수에 적용됩니다.

## 직접 확인과 남은 약점

최신 Production 주소에서 다음을 확인하세요.

1. `/`에 가상 메모 카드 네 개가 보입니다.
2. `/api/notes`는 익명 `GET`에 `200`과 네 건을 반환합니다. 이는 의도적으로 남아 있는 공개 API 약점입니다.
3. `/api/notes`에 `POST`를 보내면 `405`가 반환됩니다.
4. `/data.json`은 `404`이고 메모 본문을 반환하지 않습니다.
5. Supabase `anon`·`authenticated` 역할의 직접 `SELECT`는 권한 오류로 거부됩니다.

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
