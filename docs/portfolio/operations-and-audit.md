# 운영 기록과 민감정보 경계

## 서버가 기록하는 요청 메타데이터

`src/operations-log.mjs:recordOperationResult`는 서버가 검증한 student principal을 바탕으로 다음 항목을 저장합니다.

- owner ID
- 요청 ID와 확인 시각
- method와 정규화된 route template
- HTTP status
- 형식이 맞는 경우 deployment commit SHA

요청 body, 메모 내용, bearer token, 이메일, 원시 사용자 입력을 이 테이블에 넣지 않습니다. `vault_operation_events`의 migration comment도 metadata-only 목적을 명시합니다. 이는 애플리케이션 코드의 저장 설계에 대한 설명이지, 실제 외부 플랫폼 로그 전체에 대한 점검 결과는 아닙니다.

## 사용자별 열람 화면

`src/operations-api.mjs:createOperationsHandler`는 검증한 `principal.userId`에 대해 최근 요청 기록과 백업 metadata를 각각 최대 100건 읽습니다. API 응답은 허용된 필드만 투영하고, 메모 ID 대신 SHA-256 앞부분을 reference로 제공합니다. 운영실 UI는 메모 본문·token·사용자 번호를 보여주지 않는다고 화면에 설명합니다.

## 읽는 사람이 구분할 상태

운영실의 표는 실제 서버 요청 metadata를 집계합니다. 제공 ALEPH SDP 엔진의 decision/detection/revocation은 `unexecuted`로 표시되며, 41개 공식 최종 시험도 실행되지 않은 상태로 표현합니다. 이 화면의 “차단/성공” 문구를 실제 운영 엔진 통과나 실제 트래픽 차단으로 해석해서는 안 됩니다.

## 남는 범위

- 기록 실패는 보호 API 응답을 바꾸지 않도록 처리됩니다.
- 비로그인 요청은 owner를 확정할 수 없으므로 사용자별 DB 기록에 귀속되지 않습니다.
- 코드에서 요청 본문과 token을 저장하지 않는다고 해서 Vercel/Supabase의 별도 플랫폼 로그나 보존 기간까지 검증된 것은 아닙니다.
- RLS와 service-role 권한은 별도 DB 검증이 필요합니다.

근거: `src/operations-log.mjs`, `src/operations-api.mjs`, `public/operations-client.js`, `public/operation-checks.js`, `supabase/migrations/20261014131532_stage12_operation_events.sql`.
