# 분리된 보안 학습 모듈

운영 앱의 중심은 Vercel Functions에서 처리하는 Supabase Auth, session gate, 개인 메모 API입니다. 아래 모듈은 같은 저장소의 로컬 학습 코드이며 실제 운영 서비스의 탐지·차단·세션 회수 파이프라인이 아닙니다.

| 모듈 | 코드 | 실제 동작 범위 |
| --- | --- | --- |
| 요청 판정기 | `src/decider.mjs`, `src/decider-with-xdr.mjs` | 입력 계약과 가상 신호를 바탕으로 allow/deny/step-up 형태의 판정 객체를 반환 |
| 이벤트 탐지기 | `src/detect.mjs` | 제공한 가상 이벤트 배열에서 읽기 burst를 찾고 `propose_revocation` 제안을 반환 |
| XDR 연습 | `xdr/fixtures/*`, `xdr/<module>/decide.mjs`, `scripts/xdr-run.mjs` | Wazuh 모양의 정적 fixture를 분류하고 로컬 결과 파일·안전한 예시 기록을 생성 |

## 운영 시스템으로 오해하지 않도록

- XDR JSON은 수업용 가상 경보입니다. 실제 Wazuh event stream을 수집하지 않습니다.
- 로컬 판정의 `block` 결과는 운영 네트워크·계정·트래픽을 차단하지 않습니다.
- 탐지기의 `propose_revocation`은 제안 결과이며 로그인 세션을 실제로 취소하지 않습니다.
- 제공 ALEPH SDP 엔진은 repository의 runtime API에 연결되어 있지 않습니다. 운영실 응답은 연결되지 않은 engine 결과를 `unexecuted`로 표시합니다.
- fixture runner와 판정 테스트는 실제 계정이나 Production API를 사용하지 않는 로컬 학습 경로입니다.

테스트 파일, 실행 계약, fixture의 출처와 제한은 [xdr/README.md](../../xdr/README.md), [DECIDER_REQUEST.md](../DECIDER_REQUEST.md), [DETECT_EVENTS.md](../DETECT_EVENTS.md)에서 확인할 수 있습니다.
