# BYTE BACK — 서버 측 인증·인가와 사용자별 데이터 보호

Supabase Auth 로그인 세션을 Vercel Functions에서 검증하고, 사용자별 메모 API와 데이터 접근 경계를 구현한 웹 애플리케이션입니다. 계약 판정기·탐지기·XDR fixture는 운영 앱과 분리된 로컬 학습 모듈입니다.

[데모 링크](https://choi-bujang-secret-vault-umber.vercel.app/) · [아키텍처 흐름도](docs/portfolio/architecture.svg) · [상세 기술 문서](docs/portfolio/architecture.md)

> 이 문서는 `main`의 `88549c2`를 기준으로 작성했습니다. 데모와 Production API·DB는 이 문서 정리 중 접속하거나 검증하지 않았습니다.

## 프로젝트 개요

- **문제:** 브라우저가 보낸 사용자 식별값을 신뢰하지 않고, 서버가 검증한 로그인 사용자와 현재 세션을 기준으로 개인 자료 요청을 처리합니다.
- **역할:** Supabase Auth 로그인·JWT 검증, 세션 승인 게이트, 사용자별 메모 API, 첫 상태 백업·복구, 운영 메타데이터 화면을 구현했습니다.
- **핵심 경험:** 인증된 principal을 서버 API의 권한 검사에 연결하고, DB 권한과 RLS가 실제로 보호하는 경계를 구분해 문서화했습니다.
- **기술:** JavaScript ES modules, Node.js 22+, Vercel Functions, Supabase Auth/Postgres, `@supabase/supabase-js`, `jose`, HTML/CSS.

## 실제 화면과 아키텍처

저장소 `main`에는 검증된 앱 화면 캡처가 없습니다. 가짜 화면 이미지는 넣지 않았으며, 화면 캡처 대신 실제 코드 흐름에서 정리한 아키텍처를 표시합니다. 앱 화면의 구조는 [public/index.html](public/index.html)에서 확인할 수 있습니다. 데모 링크는 존재 여부와 동작을 이번 정리에서 확인하지 않았습니다.

![BYTE BACK architecture derived from main source](docs/portfolio/architecture.svg)

## 주요 기능

| 기능 | 구현 |
| --- | --- |
| 로그인 | 같은 출처의 Vercel Auth 프록시가 허용된 Supabase Auth 요청을 전달합니다. |
| 서버 세션 검증 | 보호 API가 JWT 발급자·대상·역할·만료, 사용자 `sub`, `session_id`를 확인합니다. |
| 세션 활성화 게이트 | 로그인한 사용자가 현재 검증된 세션을 승인 상태로 등록합니다. 관리자 승인·MFA·물리 기기 소유 증명은 아닙니다. |
| 메모 API | 서버에서 검증한 사용자 ID로 목록과 항목 소유권을 제한합니다. |
| 백업·복구 | DB trigger가 메모 최초 상태를 한 번 저장하고 SHA-256을 계산합니다. 현재 `main`의 복구는 다중 DB 요청이며 트랜잭션 보장을 하지 않습니다. |
| 운영실 | 본인 요청의 경로 템플릿·상태·시각 등 제한된 메타데이터와 백업 fingerprint를 보여줍니다. |
| 학습 모듈 | 판정기·탐지기·가상 XDR 경보를 로컬 fixture로 실행합니다. 운영 이벤트 수집이나 실제 차단에 연결된 기능이 아닙니다. |

## 인증·권한 흐름

1. 브라우저가 Vercel Auth 프록시를 통해 Supabase Auth에 로그인합니다.
2. 브라우저는 받은 bearer token을 보호 API에 전달합니다.
3. 서버가 Supabase Auth의 `getClaims`를 사용해 토큰을 검증하고, 검증된 `sub`와 `session_id`로 principal을 만듭니다.
4. 세션 게이트가 해당 사용자와 세션 ID가 함께 일치하는 승인 상태인지 확인합니다.
5. 메모 API가 서버에서 얻은 사용자 ID를 DB 쿼리의 `owner_id` 조건에 사용합니다.

이 API는 서버 전용 Supabase secret/service-role key를 사용합니다. 이 키는 RLS를 우회하므로 런타임의 사용자별 보호는 RLS만으로 성립하지 않고, 서버 코드의 owner 조건에 의존합니다. 현재 `schema.sql`은 `vault_notes`에 대해 service role의 SELECT만 명시하고 있어 새 DB의 쓰기 grant 재현성은 별도 확인이 필요합니다.

## 설계에서 드러나는 중요한 경계

- **세션 승인:** `session_id`별 게이트로 새 로그인 세션에 기존 승인 상태가 상속되지 않도록 합니다. 로그인한 사용자가 자기 세션을 승인하므로 독립적인 사용자 확인이나 기기 소유 증명은 제공하지 않습니다.
- **메모 소유권:** 메모 요청의 사용자 ID는 요청 본문이 아니라 검증된 JWT에서 가져옵니다. 생성 API는 현재 유효한 UUID 형태의 클라이언트 메모 ID도 허용합니다.
- **복구 제한:** 백업 owner·메모 ID·해시는 복구 전에 검사하지만, 현재 행의 다른 owner 충돌을 충분히 막지 못하고 DB 반영이 원자적이지 않습니다. 따라서 타 사용자 행 보호나 실패 시 롤백이 보장된 복구로 설명하지 않습니다.
- **백업 의미:** 변경 이력 버전이 아니라 최초 상태의 단일 백업입니다.
- **개인정보:** 운영 기록에는 본문·bearer token·이메일을 저장하지 않도록 구현했지만, 실제 Production 로그·환경 설정은 이 문서 작업에서 확인하지 않았습니다.

상세 경계와 파일 근거: [인증·세션](docs/portfolio/authentication-and-session.md) · [인가·데이터 격리](docs/portfolio/authorization-and-data-isolation.md) · [백업·복구](docs/portfolio/backup-and-recovery.md) · [운영 기록](docs/portfolio/operations-and-audit.md)

## 테스트와 구현 근거

저장소에는 Node.js test runner 기반 테스트가 있습니다. 예를 들어 `test/verify-login-session.test.mjs`, `test/session-approval.test.mjs`, `test/note-restore.test.mjs`, `test/operations.test.mjs`는 주입된 verifier와 fixture DB 경로를 확인합니다. 이 테스트들은 실제 PostgreSQL 트랜잭션·동시성 또는 Production 인증 E2E를 대신하지 않습니다.

저장소에 정의된 주요 명령:

```sh
node --test test/*.test.mjs
npm run test:stage11
npm run test:stage12
npm run decider:test
npm run detect:test
npm run xdr:run -- brute-force
npm run build -- --local
```

이번 포트폴리오 문서 작업에서는 테스트나 빌드를 실행하지 않았습니다. 기존 학습·실행 기록은 [COURSE_HISTORY](docs/COURSE_HISTORY.md)와 [Stage 12 운영실 기록](docs/stage12-operations.md)에 보존되어 있습니다.

## 로컬 실행

Node.js 22 이상이 필요합니다. Supabase/Auth 환경변수와 새 학습 DB 구성 순서는 [docs/LOCAL_SETUP.md](docs/LOCAL_SETUP.md)를 확인하세요. Vercel Functions를 포함한 로컬 실행은 환경이 준비된 뒤 `npx vercel dev`를 사용합니다. 보호 API는 정적 파일 서버만으로 동작하지 않습니다.

실제 개인정보나 운영 비밀값은 입력하지 마세요.

## 범위와 다음 확인 항목

이 저장소는 서버 측 인증·인가와 개인 데이터 경계를 보여주는 프로젝트입니다. 아래 항목은 현재 `main`의 완료 기능으로 주장하지 않습니다.

- 새 Supabase DB의 테이블·시퀀스 grant 재현성과 실제 API 쓰기 경로
- owner 충돌을 포함한 원자적 백업 복구 및 동시성 보장
- 독립 승인 요소(MFA 또는 실제 기기 증명)
- 운영 환경의 Postgres 통합 테스트·Production E2E
- 실제 서비스 XDR telemetry·차단 엔진 연동

## 상세 문서

- [시스템 아키텍처](docs/portfolio/architecture.md)
- [인증과 세션 활성화 게이트](docs/portfolio/authentication-and-session.md)
- [인가와 사용자별 데이터 보호](docs/portfolio/authorization-and-data-isolation.md)
- [최초 백업과 복구 경계](docs/portfolio/backup-and-recovery.md)
- [운영 기록과 민감정보 경계](docs/portfolio/operations-and-audit.md)
- [분리된 보안 학습 모듈](docs/portfolio/learning-modules.md)
- [단계별 원본 학습 기록](docs/COURSE_HISTORY.md) · [로컬 설정](docs/LOCAL_SETUP.md) · [XDR fixture 설명](xdr/README.md)
