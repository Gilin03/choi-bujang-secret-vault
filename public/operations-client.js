import { runOperationChecks, unexecutedChecks } from './operation-checks.js';

const stateLabels = { unexecuted: '미실행', matched: '기대 일치', mismatch: '기대 불일치', error: '통신 실패' };
const stamp = value => value ? new Date(value).toLocaleString('ko-KR', { timeZone: 'Asia/Seoul' }) : '미확인';
const cell = value => { const el = document.createElement('td'); el.textContent = String(value ?? '미확인'); return el; };
const row = values => { const el = document.createElement('tr'); el.append(...values.map(cell)); return el; };

export function createOperationsPanel({ api, getSession }) {
  const panel = document.querySelector('#operations-panel');
  const message = document.querySelector('#operations-message');
  const checksBody = document.querySelector('#operation-checks');
  const runButton = document.querySelector('#operations-run');
  const refreshButton = document.querySelector('#operations-refresh');
  const exportButton = document.querySelector('#operations-export');
  const logBody = document.querySelector('#operation-records');
  let generation = 0;
  let checkGeneration = 0;
  let refreshGeneration = 0;
  let evidence = null;
  let checkedCommit = null;
  let results = unexecutedChecks();

  function renderChecks() {
    checksBody.replaceChildren(...results.map(check => row([
      check.stage, check.kind === 'normal' ? '정상' : '금지', check.label,
      check.path ? `${check.method} ${check.path}` : check.requestText,
      check.expectedStatus ? `HTTP ${check.expectedStatus}${check.expectedJson ? ' / approved' : ''}` : check.expectedText,
      check.actualStatus ? `HTTP ${check.actualStatus}` : '미실행 / 응답 없음',
      stateLabels[check.state], check.requestId || '서버 ID 미제공',
      check.checkedAt ? `${stamp(check.checkedAt)} (${check.clockSource === 'server' ? '서버' : '클라이언트'})` : '미실행',
      check.recorded ? '서버 DB 기록됨' : 'DB 기록 없음', check.note,
    ])));
  }

  function reset() {
    generation += 1;
    checkGeneration += 1;
    refreshGeneration += 1;
    evidence = null;
    checkedCommit = null;
    results = unexecutedChecks();
    panel.hidden = true;
    document.querySelector('#vault-panels').hidden = false;
    document.querySelector('#operations-commit').textContent = '검사 커밋 미확인';
    document.querySelector('#operations-summary').replaceChildren();
    logBody.replaceChildren();
    document.querySelector('#operation-backups').replaceChildren();
    message.textContent = '';
    runButton.disabled = false;
    refreshButton.disabled = false;
    exportButton.disabled = true;
    renderChecks();
  }

  async function refresh() {
    const runGeneration = generation;
    const requestRefreshGeneration = ++refreshGeneration;
    message.textContent = '본인 서버 기록을 조회합니다.';
    let data;
    try { data = await api('/api/session-approval/operations'); }
    catch (error) {
      if (runGeneration !== generation || requestRefreshGeneration !== refreshGeneration) return false;
      throw error;
    }
    if (runGeneration !== generation || requestRefreshGeneration !== refreshGeneration) return false;
    const changedCommit = checkedCommit && checkedCommit !== data.commit;
    if (changedCommit) {
      checkGeneration += 1;
      checkedCommit = null;
      results = unexecutedChecks();
      renderChecks();
    }
    evidence = data;
    document.querySelector('#operations-commit').textContent = `배포 커밋 ${data.commit || '미확인'} · 조회 ${stamp(data.checkedAt)}`;
    const summary = data.api.summary;
    const cards = [
      ['API 실측', `최근 본인 ${summary.total}건 · 허용 ${summary.allowed} · 거부 ${summary.rejected} · 서버 오류 ${summary.errors}`],
      ['학생 판정기 규칙', `${data.rules.length}개: ${data.rules.join(', ')}. 운영 판정 결과 미실행`],
      ['탐지 사건', '미실행 · 운영 엔진 사건 경로 미연결 (0건으로 간주하지 않음)'],
      ['접속 회수', '미실행 · 탐지 제안은 실제 회수 완료가 아님'],
      ['복구 버전', `정책 기준 v${data.recovery.policyVersion} · ${data.recovery.policyRevision}. 정책 복구 결과 미실행`],
      ['메모 복구 기록', `최근 기록 내 성공 응답 ${data.recovery.executedRestores}건 · 본인 백업 최대 100건 중 ${data.recovery.backups.length}건`],
      ['공식 총공세', `${data.finalAssault.total}종 · 실행 ${data.finalAssault.executed} · 미실행 ${data.finalAssault.unexecuted} · 통과 수 미확인`],
    ];
    document.querySelector('#operations-summary').replaceChildren(...cards.map(([title, detail]) => {
      const item = document.createElement('div'); item.className = 'operation-card';
      const label = document.createElement('strong'); label.textContent = title;
      const text = document.createElement('p'); text.textContent = detail;
      item.append(label, text); return item;
    }));
    logBody.replaceChildren(...data.api.records.map(record => row([
      record.requestId, `${record.method} ${record.route}`, record.status,
      stamp(record.checkedAt), record.commit || '배포 SHA 없음',
    ])));
    document.querySelector('#operation-backups').replaceChildren(...data.recovery.backups.map(backup => {
      const item = document.createElement('li');
      item.textContent = `사본 ${backup.reference} · 캡처 ${stamp(backup.capturedAt)} · SHA-256 ${backup.fingerprint}`;
      return item;
    }));
    message.textContent = `${changedCommit ? '배포 커밋이 바뀌어 이전 확인표를 미실행으로 초기화했습니다. ' : ''}API 응답과 아래 가린 서버 기록이 같은 조회 결과입니다. 백업 존재만으로 복구 성공을 판단하지 않습니다.`;
    exportButton.disabled = false;
    return true;
  }

  function unavailable(error) {
    evidence = null; exportButton.disabled = true;
    document.querySelector('#operations-summary').replaceChildren();
    logBody.replaceChildren(); document.querySelector('#operation-backups').replaceChildren();
    document.querySelector('#operations-commit').textContent = '서버 기록 조회 실패 · 현재 상태 미확인';
    message.textContent = error.message;
  }

  document.querySelector('#show-operations').addEventListener('click', async () => {
    const requestGeneration = generation;
    document.querySelector('#vault-panels').hidden = true;
    panel.hidden = false;
    try { await refresh(); } catch (error) { if (requestGeneration === generation) unavailable(error); }
  });
  document.querySelector('#show-vault').addEventListener('click', () => {
    panel.hidden = true; document.querySelector('#vault-panels').hidden = false;
  });
  refreshButton.addEventListener('click', async () => {
    const requestGeneration = generation;
    refreshButton.disabled = true;
    try { await refresh(); } catch (error) { if (requestGeneration === generation) unavailable(error); }
    finally { if (requestGeneration === generation) refreshButton.disabled = false; }
  });
  runButton.addEventListener('click', async () => {
    const runGeneration = generation;
    const runCheckGeneration = ++checkGeneration;
    let runCommit;
    const isCurrentRun = () => runGeneration === generation
      && runCheckGeneration === checkGeneration && checkedCommit === runCommit;
    runButton.disabled = true;
    try {
      checkedCommit = null;
      results = unexecutedChecks();
      renderChecks();
      if (!await refresh()) return;
      if (runGeneration !== generation) return;
      if (!/^[a-f0-9]{40}$/iu.test(evidence?.commit ?? '')) throw new Error('검사 커밋을 서버에서 확인할 수 없어 실행하지 않았습니다.');
      runCommit = evidence.commit;
      checkedCommit = runCommit;
      results = unexecutedChecks();
      renderChecks();
      const session = await getSession();
      const measured = await runOperationChecks({ token: session?.access_token, expectedCommit: runCommit,
        isCurrent: isCurrentRun,
        onResult: rows => { if (isCurrentRun()) { results = rows; renderChecks(); } },
      });
      if (isCurrentRun()) { results = measured; renderChecks(); await refresh(); }
    } catch (error) { if (runGeneration === generation) message.textContent = error.message; }
    finally { if (runGeneration === generation) runButton.disabled = false; }
  });
  exportButton.addEventListener('click', () => {
    if (!evidence) return;
    const artifact = { schema: 'byteback.operation-checks.v1', commit: evidence.commit,
      checkedCommit, source: 'browser_http_self_check', origin: window.location.origin, finalAssault: evidence.finalAssault,
      results, serverEvidence: evidence };
    const url = URL.createObjectURL(new Blob([JSON.stringify(artifact, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = 'operation-checks.json'; link.click();
    URL.revokeObjectURL(url);
  });
  reset();
  return { reset };
}
