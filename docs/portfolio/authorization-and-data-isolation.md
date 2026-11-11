# 인가와 사용자별 데이터 보호

## 서버에서 principal을 정하는 방식

보호 API는 bearer token의 서명을 포함한 인증 검증을 거친 뒤 서버 principal을 사용합니다. 메모 API는 body의 `owner_id`를 소유자 근거로 사용하지 않습니다. 사용자별 데이터 조건은 검증된 `auth.userId`에서 만들어집니다.

| 작업 | 코드상 owner 경계 |
| --- | --- |
| 메모 목록 | 조회 필터에 `owner_id = auth.userId`를 적용하고 반환 행도 다시 필터 |
| 단건 조회 | `id`와 `owner_id`를 함께 조회 |
| 수정 | 기존 행 소유자를 확인한 뒤 update에도 `id`와 `owner_id`를 적용 |
| 삭제 | 기존 행 소유자를 확인한 뒤 delete에도 `id`와 `owner_id`를 적용 |
| 생성 | owner는 서버 principal에서 설정. 현재 `main`은 선택적 client UUID `id`도 허용 |

근거: `src/notes-api.mjs:createNotesHandler`, `createNoteItemHandler`. 메모 생성 시 client ID를 허용하는 특별 계약은 코드에서 확인되지 않지만, 현재 구현은 유효한 UUID면 요청의 `body.id`를 사용합니다. ID 생성 주체를 서버 전용이라고 설명하지 않습니다.

## RLS와 서버 secret key

SQL 파일은 서로 다른 접근 경로를 정의합니다.

1. `schema.sql`은 `vault_notes`에 RLS를 켜고, anon/authenticated에 대한 직접 권한을 회수합니다.
2. `owner-policies.sql`은 authenticated 역할에 owner 기준 SELECT/INSERT/UPDATE/DELETE 정책과 CRUD grant를 설정합니다.
3. `close-direct-access.sql`은 이후 anon/authenticated의 table 및 sequence grant를 다시 회수합니다. 적용 뒤 브라우저 직접 DB 접근은 권한상 닫혀 있고, RLS 정책은 활성 상태로 남습니다.
4. Vercel API는 `SUPABASE_SECRET_KEY`로 DB client를 생성합니다. 이 server/service-role 자격 증명은 RLS를 우회할 수 있습니다.

따라서 API 요청에서 RLS가 각 메모 요청을 대신 분리한다고 주장할 수 없습니다. API 서버의 사용자별 owner 필터와 mutation filter가 런타임 데이터 경계의 핵심입니다. secret key 값은 브라우저 코드에 있어서는 안 됩니다.

## 새 DB에서 확인되지 않은 권한

현재 SQL은 `schema.sql`에서 `service_role`에 `vault_notes` SELECT만 명시하고, `vault_notes_sort_order_seq`에 usage/select를 설정합니다. 확인한 setup SQL에는 `vault_notes` INSERT/UPDATE/DELETE를 service role에 명시하는 grant가 없습니다. 반면 API는 해당 쓰기 작업을 요청합니다.

이 때문에 새 DB에서 어떤 effective privileges가 생기는지, API CRUD가 성공하는지는 문서만으로 확정할 수 없습니다. 이 포트폴리오 업데이트는 DB에 연결하거나 권한을 실행·수정하지 않았습니다. 기존 RLS 정책이나 운영 DB 상태를 추측해서 서술하지 않습니다.

## 점검할 때 볼 파일

- API: `src/notes-api.mjs`, 해당 파일을 감싸는 `api/notes.mjs` 및 `api/my/notes.mjs` adapters
- DB: `supabase/schema.sql`, `supabase/owner-policies.sql`, `supabase/close-direct-access.sql`
- 관련 사례: [백업·복구 경계](backup-and-recovery.md)

테스트 코드의 fake DB 검증과 PostgreSQL 역할·RLS 검증은 다른 근거입니다. 현재 저장소의 SQL 역할 검증이 실제 격리 DB에서 실행되었다고 주장하지 않습니다.
