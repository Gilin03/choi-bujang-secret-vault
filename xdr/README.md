# XDR 보너스 경보

이 폴더는 보너스 여섯 개의 연습 경보입니다. 경보는 수업용으로 만든 Wazuh 모양이며, 실제 로그가 아닙니다. 정답은 이 저장소에 없습니다.

## 경보 묶음

`xdr/fixtures/<moduleKey>.json` 을 읽습니다. `moduleKey` 는 아래 여섯 개입니다.

| moduleKey | 보는 것 |
|---|---|
| `brute-force` | 짧은 시간에 몰린 로그인 실패 |
| `web-injection` | 웹 요청에 섞인 주입 형태 |
| `known-cve` | 이미 공개된 취약점을 노린 요청 형태 |
| `persistence` | 다시 켜도 남도록 심긴 서비스·예약 작업 |
| `privilege` | 평범한 계정의 갑작스러운 권한 상승 |
| `exfiltration` | 처음 보는 곳으로 빠지는 큰 전송 |

한 파일에는 명확한 공격, 애매한 시도, 정상 이벤트가 함께 들어 있습니다. 주소는 문서용 대역만 쓰고, 계정은 `user01` 같은 가상 이름입니다. `known-cve` 의 원격 조회 구문은 문서용 표기입니다. 그 문자열을 다른 시스템에 넣거나 변형하지 않습니다.

## 학생이 만드는 파일

항목마다 `xdr/<moduleKey>/decide.mjs` 를 만듭니다. `decide(alert)` 를 내보냅니다. 비동기 함수여도 됩니다. 반환은 아래 세 값입니다.

- `action`: `block`, `alert`, `record` 중 하나
- `confidence`: 0 이상 1 이하 숫자
- `reason`: 짧은 이유

명확한 공격은 `block`, 애매한 시도는 `alert`, 정상 이벤트는 `record` 입니다. 경보 원본은 고치지 않습니다.

## 실행

저장소 루트에서 항목 키 하나를 넣습니다.

```
node scripts/xdr-run.mjs brute-force
```

`npm run xdr:run -- brute-force` 도 같은 명령입니다. 실행기는 해당 경보마다 `decide` 를 부르고, 결과를 `xdr/<moduleKey>/result.json` 에 씁니다. 형식은 `aleph.xdr.result.v1` 이고, `decisions` 에는 경보 id·행동·확신도·이유가, `counts` 에는 `block`·`alert`·`record` 건수가 있습니다.

반환 형식이 틀린 경보는 `record` 로 남고, 오류 한 줄이 출력됩니다. 실행기 자체는 네트워크를 쓰지 않습니다. 판정자는 격리된 환경에서 같은 명령을 다시 실행해 결과를 봅니다. 이미 커밋된 `result.json` 만으로 판정이 끝나지 않습니다.

무차별 대입 연습에서 `npm run xdr:run -- brute-force`를 실행하면 `result.json`과 함께 차단 후보만 담은 `brute-force/deny-rules.json`을 만들고, `xdr/alerts.log`에는 block·alert 항목을 한 줄씩 기록합니다. 차단 규칙은 15분 뒤 만료되며 근거 경보 ID를 포함합니다. 같은 fixture로 재실행해도 경보 로그는 중복되지 않습니다. 실행기는 fixture의 출발 주소로 `src/decider-with-xdr.mjs`를 호출합니다. 규칙에 걸리지 않은 요청은 기존 `src/decider.mjs`로 넘어갑니다. 현재 실제 반 엔진/배포 요청 계약에는 출발 IP가 없어 운영 경로에는 연결되지 않았으므로 운영 차단으로 표현하지 않습니다.

웹 주입 연습은 `npm run xdr:run -- web-injection`으로 실행합니다. 확인용 `web-injection/read-alerts.mjs`는 경보마다 시각·출발 주소·계정·규칙 수준·설명만 추출하고 비밀값처럼 보이는 문자열을 마스킹합니다. `web-injection/decide.mjs`는 이 모듈을 import하지 않으며, 패턴 상수만 사용해 단독으로 판단합니다. `patterns.json`은 SQL 구문, 스크립트 태그, 반복 `../` 경로 이탈 세 신호와 구체 패턴을 식별하지 못한 T1190 경보의 검토 fallback을 기록합니다. 뚜렷한 패턴이 반복되고 심각도와 출발 주소까지 확인될 때만 block하며, 그 외 T1190 경보는 alert, 나머지는 record로 둡니다.

실행하면 `web-injection/result.json`과 15분 만료·근거 경보 ID가 있는 `web-injection/deny-rules.json`이 생성됩니다. 응답 모듈은 block·alert 메타데이터와 고정된 안전 사유만 `xdr/alerts.log`에 한 줄씩 추가하며 재실행 시 중복을 피합니다. 계정·요청 URL·원본 설명은 기록하지 않습니다. 실행기는 거부 규칙을 `src/decider-with-xdr.mjs` 사전 차단 게이트에 전달하고, 차단되지 않은 요청은 기존 판정기로 넘깁니다. 현재 출발 IP가 운영 요청 계약에 없으므로 이는 fixture 연습 연결이며 실제 Wazuh 운영 로그 수집이나 운영 트래픽 차단이 아닙니다.
