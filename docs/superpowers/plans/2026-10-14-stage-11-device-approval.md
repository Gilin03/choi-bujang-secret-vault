# 11단계 구현 계획: 설치형 자료실과 기기 승인

## 목표

manifest와 설치 상태를 보여 주고, 설치 여부와 별도로 서버가 승인한 WebAuthn 자격 증명만 보호 자료 API에 접근하게 한다. 개인키와 승인 토큰은 브라우저 저장소에 기록하지 않는다. 미승인 자격 증명은 대기 상태로 남긴다.

## 변경 파일

- `test/device-approval.test.mjs`: 등록 대기, 승인 assertion, 미승인·재사용 거부를 먼저 검증한다.
- `src/device-approval.mjs`, `src/webauthn.mjs`: 일회성 서버 challenge, WebAuthn 검증, 승인 상태와 보호 API 래퍼를 구현한다.
- `api/device/*.mjs`와 기존 메모·공지 API 진입점: 기기 요청·상태 API와 모든 자료 API의 서버 검사를 연결한다.
- `public/index.html`, `public/manifest.webmanifest`, `public/vault-icon.svg`: 설치 정보와 승인 전 차단 화면을 제공한다. 인증 세션은 메모리에서만 유지한다.
- `supabase/stage11-device-approval.sql`: RLS 및 서비스 역할만 접근하는 승인·challenge 테이블을 추가한다.
- `aleph.config.json`, `README.md`, `bundle-notes.json`, `src/attack-check.mjs`: 단계 11 기록, 운영 적용 방법, 실제 자체 점검 결과 형식을 갱신한다.

## 순서와 완료 조건

1. Passkey ceremony 및 보호 API의 거부 동작을 테스트로 먼저 작성하고, 예상 실패를 확인한다.
2. 일회성 challenge·등록 검증·승인 상태·요청별 서명 검증을 구현하고 테스트를 통과시킨다.
3. API 라우트, 승인 전 화면, manifest를 연결한다. 앱 설치 상태를 기기 승인으로 표시하지 않는다.
4. SQL을 적용하고 보안 advisor를 확인한다. 공개 테이블의 RLS를 켜고 클라이언트 역할 권한을 제거한다.
5. 회귀 테스트와 빌드, 깨끗한 복제본의 `npm install`, 제출 묶음을 확인한다.
6. 이번 단계 파일만 저장점 커밋·푸시하고 제출 묶음과 자체 점검 요약을 확인한다.

## 보안 경계

서버는 등록 시 attestation challenge와 요청 경로를 확인하고 신규 credential을 `pending`으로 저장한다. 운영자가 DB에서 명시적으로 `approved`로 바꾸기 전에는 승인 assertion 목록에 포함하지 않는다. 보호 API는 사용자 로그인과 일회성 WebAuthn assertion을 모두 확인한다. 브라우저의 WebAuthn 개인키는 인증기에 남고, Auth 세션은 페이지 메모리만 사용한다. Passkey는 앱 설치 여부나 관리형 기기 상태의 증거로 표현하지 않는다.

`src/decider.mjs`는 변경하지 않는다. 11단계 코드는 학생 계약에 없는 요청 필드를 추가하지 않으며, `judgeIssuer`, 발급자 정보, 원본 API 주소를 바꾸지 않는다.
