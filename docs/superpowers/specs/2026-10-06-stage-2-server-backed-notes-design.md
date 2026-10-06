# 2단계 서버 자료실 설계

## 목표

2단계에서는 화면과 GitHub 최신 버전의 정적 파일에서 가상 메모를 제거하고, 화면이 Vercel 서버 함수를 통해 Supabase의 학습용 테이블에서 메모 네 건을 읽게 한다. 서버 함수는 Supabase 비밀 키를 사용하지만, 3단계 전까지 함수 자체는 익명으로 호출할 수 있다는 점을 남은 약점으로 명시한다.

## 범위와 제약

- 현재 자료실의 가상 메모 네 건을 계속 화면에 표시한다.
- 저장소 SQL 파일에는 스키마와 권한 설정만 넣는다. 메모 본문은 Supabase 사이트에 별도로 입력해 최신 GitHub 파일에 포함하지 않는다.
- `owner_id uuid`를 두고 `auth.users` 외래키는 만들지 않는다.
- 테이블은 RLS를 켜고 `anon`과 `authenticated`의 직접 읽기를 허용하지 않는다.
- 비밀 키는 `SUPABASE_SECRET_KEY`로 Vercel 서버 환경에만 저장한다. 코드, 브라우저 번들, 응답, 로그, 제출 묶음에는 키 값을 두지 않는다.
- 과거 공개 커밋과 배포 이력은 이번 변경으로 없어지지 않는다.
- `aleph.config.json`의 `judgeIssuer`는 수정하지 않는다. 단계는 2로 맞추며, 인증·허용 경로는 아직 추가하지 않는다.

## 데이터베이스

저장소에는 `supabase/schema.sql` 하나를 추가한다. 이 파일은 `public.vault_notes` 테이블 생성, RLS 활성화, `anon`·`authenticated`의 권한 회수, 서버 함수가 사용하는 `service_role`의 `SELECT` 권한을 정의한다. 컬럼은 `id uuid primary key default gen_random_uuid()`, 고유한 `sort_order`, nullable `owner_id uuid`, `title text`, `content text`로 한다. `owner_id`에는 외래키나 기본 사용자 정책을 두지 않는다.

테이블에는 `anon` 또는 `authenticated` 대상의 RLS 정책을 만들지 않는다. 메모 네 건은 연결된 Supabase 프로젝트의 SQL Editor 또는 Supabase 연결 도구로 별도 입력하며, 메모 본문을 저장소의 SQL 파일이나 제출 묶음에 복사하지 않는다. API 클라이언트는 서버 비밀 키로만 `SELECT`한다. Supabase 비밀 키는 RLS를 우회하므로 이 함수에는 가상 메모만 두고, 공개 API라는 한계를 문서화한다.

## 서버와 화면 흐름

`api/notes.mjs`는 Vercel Node.js 함수로 추가한다. 현재 프로젝트의 ESM 설정과 설치된 `@supabase/supabase-js`를 사용하고 Vercel Web Standard handler 형식으로 `GET /api/notes`를 제공한다. 함수는 `SUPABASE_URL`과 `SUPABASE_SECRET_KEY`를 서버 환경에서 읽고, `vault_notes`에서 필요한 표시 컬럼만 `sort_order` 순으로 가져와 `{ notes: [...] }`로 반환한다. 다른 HTTP 메서드는 거부한다.

함수는 요청 인증을 추가하지 않는다. 익명 방문자도 공개 API에서 네 건의 가상 메모를 받을 수 있는 상태가 이번 단계의 의도된 약점이다. 성공 응답에는 화면 표시용 데이터만 포함하고 `Cache-Control: no-store`를 설정한다. 환경변수 누락이나 Supabase 오류는 일반화된 오류 응답으로 처리하며 키, 응답 원문, 메모 본문을 오류 로그에 쓰지 않는다.

`public/index.html`은 `/api/notes`를 읽도록 바꾼다. `data.json`과 `public/data.json`은 저장소 및 빌드 결과에서 제거하고, `scripts/build-public.mjs`는 JSON 복사를 중단한다. 배포 식별 정보 생성은 유지한다. `aleph.config.json`은 실제 Git origin과 Vercel 배포 주소를 사용하고 단계 2로 맞춘다. 실제 비밀 키 값은 사용자가 Vercel 프로젝트의 환경변수 입력란에 직접 등록한다.

## 문서와 점검 기록

README에는 다음을 기록한다.

- SQL 파일을 Supabase SQL Editor에서 적용하고 테이블 컬럼 및 RLS를 확인하는 순서
- Vercel 환경변수 입력 위치와 화면 확인 방법. 비밀값 자체는 쓰지 않는다.
- 화면은 네 카드, `/data.json`에는 메모 본문 없음, 익명 DB 직접 읽기는 거부됨이라는 기대 결과
- `/api/notes`는 아직 익명 호출이 가능하고 가상 메모를 반환한다는 남은 약점
- 현재 배포와 최신 GitHub 파일을 검색하는 방법 및 과거 커밋·배포 이력은 지워지지 않았다는 한계

`src/attack-check.mjs`는 공개 배포 주소에 실제 HTTP 요청을 보내고 요청 결과 요약만 제출용 점검 기록으로 반환한다. `/api/notes`의 익명 응답을 운영 심판의 판정으로 표현하지 않는다. 점검 결과에는 메모 본문이나 비밀값을 넣지 않는다.

## 저장점과 제출 묶음

저장소 파일을 바꾸기 전에 해당 단계에서 포함할 파일을 확인하고, 키·토큰·개인정보·메모 본문이 들어가지 않았는지 검사한다. `aleph.config.json`의 `repoUrl`, `publicAppUrl`, `step`은 실제 설정과 대조하고 `judgeIssuer`는 그대로 둔다. 변경은 `2단계 저장점`으로 커밋한 뒤 `npm run bundle`을 실행한다. `bundle-notes.json`과 `artifacts/submission.json`은 커밋하지 않는다. 번들 결과는 학생의 실제 자체 점검 요청만 기록하며 심판 판정으로 부르지 않는다.

## 완료 조건

1. 화면에 Supabase에서 읽은 가상 메모 네 건이 보인다.
2. `/data.json`과 빌드된 정적 파일에 메모 본문이 없다.
3. GitHub 최신 커밋의 파일에 메모 본문이 없다.
4. 익명 Supabase 직접 `SELECT`는 거부되고, 익명 `GET /api/notes`는 네 건을 반환한다.
5. 브라우저 파일·응답·로그·제출 묶음에서 서버 비밀 키를 찾을 수 없다.
6. README가 공개 API 약점과 과거 커밋·배포 이력의 한계를 분명히 설명한다.
7. 실행한 자체 점검만 `npm run bundle` 결과에 포함되고, 제출 JSON과 요약이 생성된다.

## 공식 문서 참고

- [Vercel Node.js Functions](https://vercel.com/docs/functions/runtimes/node-js)
- [Supabase Row Level Security](https://supabase.com/docs/guides/database/postgres/row-level-security)
- [Supabase API keys](https://supabase.com/docs/guides/getting-started/api-keys)
