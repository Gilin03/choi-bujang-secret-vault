# 로컬 설정과 실행

## 준비물

- Node.js 22 이상과 Git
- Vercel CLI로 연결할 프로젝트
- Supabase Auth와 이 저장소의 학습용 DB 스키마

## 새 학습 DB 구성

이미 테이블과 학습 자료가 있는 DB에는 초기 스키마를 다시 적용하지 마세요. 새 DB에서만 다음 순서로 SQL을 적용합니다.

1. `supabase/schema.sql`
2. `supabase/owner-policies.sql`
3. `supabase/close-direct-access.sql`
4. `supabase/stage8-resource-zones.sql`
5. `supabase/stage10-note-backups.sql`
6. `supabase/stage11-session-approval.sql`
7. `supabase/migrations/20261014131532_stage12_operation_events.sql` — 한 번만 적용

기존 자료·owner·백업을 삭제하거나 가짜 자료로 교체하지 않습니다. 이미 적용된 스키마나 migration은 재실행하지 않습니다.

## 서버 환경변수와 공개 설정

Vercel 프로젝트 환경변수에 아래 이름을 설정합니다. 값은 문서, 브라우저 코드, Git, 로그에 넣지 않습니다.

- `SUPABASE_URL`
- `SUPABASE_SECRET_KEY` — 서버 함수 전용
- `SUPABASE_PUBLISHABLE_KEY` — Auth 프록시에서 사용

Supabase Auth에는 사용할 로그인 계정이 있어야 합니다. 화면에는 가입 기능이 없습니다. 개인 프로젝트로 배포할 때는 `aleph.config.json`의 저장소·앱 주소·Supabase identity provider·원본 API 공개 설정을 해당 환경에 맞추고, 운영 측 `judgeIssuer` 값은 변경하지 않습니다.

## 설치와 실행

저장소 루트에서 실행합니다.

    git clone https://github.com/gilin03/choi-bujang-secret-vault.git
    cd choi-bujang-secret-vault
    npm install

Vercel CLI에서 프로젝트를 연결하고 필요한 환경변수가 준비되면 앱과 API를 함께 실행합니다.

    npx vercel dev

종료는 터미널에서 `Ctrl+C`입니다. `npm run build -- --local`은 로컬 정적 산출물 준비 명령이며 서버 함수까지 대신 실행하지 않습니다. 정적 파일 서버만으로는 보호 API를 사용할 수 없습니다.
