# 최초 백업과 복구 경계

## 백업은 버전 이력이 아닙니다

`supabase/stage10-note-backups.sql`은 `vault_notes` insert trigger에서 최초 메모 상태를 복사합니다. `note_id`가 primary key이며 `ON CONFLICT (note_id) DO NOTHING`이므로 이후 변경 내용을 버전별로 쌓지 않습니다. 기존 메모를 초기화 시 backfill하더라도 이미 백업된 행은 덮어쓰지 않습니다.

백업 행은 `owner_id`, `note_id`, 제목, 내용, 저장 시각과 본문 SHA-256을 포함합니다. DB가 UTF-8 본문으로 digest를 계산하고 `src/notes-api.mjs`는 복구 전후 본문 hash를 비교합니다.

## 현재 main 복구 경로

`createNoteRestoreHandler`는 다음 단계를 거칩니다.

1. 인증된 사용자를 서버에서 검증합니다.
2. 요청 ID로 백업을 조회하고 백업 owner, 요청 ID, 본문 SHA-256을 확인합니다.
3. 현재 메모 행을 ID로 조회합니다.
4. 행이 있으면 제목·내용·owner를 update하고, 없으면 백업 ID·owner를 사용해 insert합니다.
5. 별도의 DB 요청으로 복원 행을 다시 읽고 ID·owner·본문 hash를 확인합니다.

## 보장하지 않는 항목

현재 `main`은 여러 Supabase REST 요청으로 복구를 수행합니다. 이 코드는 하나의 PostgreSQL transaction/RPC 안에 묶여 있지 않습니다. 기존 행의 조회는 ID만으로 하며, 복구 전 기존 행 owner가 요청 사용자와 같은지 충돌로 거부하지 않습니다. 기존 행이 다른 사용자 소유인 경우 update가 그 행의 owner를 백업 owner로 덮어쓸 수 있습니다.

또한 반영 후 재검증이 실패해도 앞선 update/insert가 같은 트랜잭션에서 자동 롤백되지 않습니다. 따라서 현재 `main`에 대해 다음을 주장할 근거는 없습니다.

- 다른 owner 행의 변경·덮어쓰기 방지
- 실패 시 전체 DB 반영 원자적 롤백
- 동시 수정·삭제·복구 경합의 무결성
- PostgreSQL 잠금/RPC 수준 보장

이는 포트폴리오 문서의 제한 사항입니다. 이 작업에서는 복구 코드·SQL·migration을 변경하거나 DB 테스트를 수행하지 않았습니다.

## 테스트 근거의 범위

`test/note-restore.test.mjs`는 주입된 fake DB client를 이용한 Node 테스트입니다. 이 테스트는 SQL lock, PostgreSQL transaction, RLS, service role effective grants 또는 동시 트랜잭션을 검증하지 않습니다. 테스트 파일의 존재만으로 실제 DB 복구 안정성을 주장하지 않습니다.

관련 구현 파일: `src/notes-api.mjs`, `supabase/stage10-note-backups.sql`, `test/note-restore.test.mjs`.
