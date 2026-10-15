import test from 'node:test';
import assert from 'node:assert/strict';
import { createOperationsPanel } from '../public/operations-client.js';

const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const evidence = commit => ({ commit, checkedAt: '2026-10-14T00:00:00Z', rules: [],
  api: { summary: { total: 0, allowed: 0, rejected: 0, errors: 0 }, records: [] },
  recovery: { policyVersion: 9, policyRevision: 'fixture', executedRestores: 0, backups: [] },
  finalAssault: { total: 41, executed: 0, unexecuted: 41 } });

// A minimal DOM boundary keeps deferred-request ordering deterministic.
// Rendering is separately checked in a real browser against the local API fixture.
function mount(t, api) {
  const originals = { document: globalThis.document, fetch: globalThis.fetch };
  const elements = new Map();
  const element = () => ({ hidden: false, disabled: false, textContent: '', children: [], listeners: new Map(),
    addEventListener(type, listener) { this.listeners.set(type, listener); },
    replaceChildren(...children) { this.children = children; }, append(...children) { this.children.push(...children); } });
  globalThis.document = {
    querySelector(selector) { if (!elements.has(selector)) elements.set(selector, element()); return elements.get(selector); },
    createElement: element,
  };
  globalThis.fetch = async path => Response.json({ status: 'approved' }, {
    status: path === '/data.json' ? 404 : 200,
    headers: { 'X-Content-Type-Options': 'nosniff', 'X-Deployment-Commit': A },
  });
  t.after(() => { globalThis.document = originals.document; globalThis.fetch = originals.fetch; });
  const panel = createOperationsPanel({ api, getSession: async () => ({ access_token: 'fixture-memory-only' }) });
  return { panel, get: selector => elements.get(selector),
    click: selector => elements.get(selector).listeners.get('click')(),
    checkStates: () => elements.get('#operation-checks').children.map(row => row.children[6].textContent),
    checks: () => elements.get('#operation-checks').children };
}

test('unrun Stage 12 checks show 미실행 with no request ID or timestamp', async t => {
  const ui = mount(t, async () => evidence(A));
  await ui.click('#show-operations');
  for (const label of ['공개 자료 파일 접근', '비로그인 목록 접근', '인증 없이 승인 상태 조회']) {
    const row = ui.checks().find(item => item.children[2].textContent === label);
    assert.ok(row, `missing check row: ${label}`);
    assert.equal(row.children[5].textContent, '미실행');
    assert.equal(row.children[6].textContent, '미실행');
    assert.equal(row.children[7].textContent, '');
    assert.equal(row.children[8].textContent, '');
  }
  assert.equal(ui.get('#operations-summary').children[0].children[1].textContent,
    '최근 본인 0건 · 허용 0 · 거부 0 · 서버 오류 0');
});

test('stale refresh rejection cannot erase a new session evidence or disable its export', async t => {
  let rejectOld;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  let calls = 0;
  const ui = mount(t, () => ++calls === 1 ? old : Promise.resolve(evidence(B)));
  const pending = ui.click('#show-operations');
  ui.panel.reset();
  await ui.click('#show-operations');
  const message = ui.get('#operations-message').textContent;
  const commit = ui.get('#operations-commit').textContent;
  rejectOld(new Error('old session failure'));
  await pending;
  assert.equal(ui.get('#operations-export').disabled, false);
  assert.equal(ui.get('#operations-message').textContent, message);
  assert.equal(ui.get('#operations-commit').textContent, commit);
});

test('refresh on another deployment clears results measured on the previous commit', async t => {
  let commit = A;
  const ui = mount(t, async () => evidence(commit));
  await ui.click('#show-operations');
  await ui.click('#operations-run');
  assert.ok(ui.checkStates().includes('기대 일치'));
  commit = B;
  await ui.click('#operations-refresh');
  assert.ok(ui.get('#operations-commit').textContent.includes(B));
  assert.ok(ui.checkStates().every(state => state === '미실행'));
});

test('commit change during checks cancels late result rendering from the previous run', async t => {
  let commit = A;
  const ui = mount(t, async () => evidence(commit));
  await ui.click('#show-operations');
  let resolveFirst;
  let signalStarted;
  const started = new Promise(resolve => { signalStarted = resolve; });
  const first = new Promise(resolve => { resolveFirst = resolve; });
  const fallback = globalThis.fetch;
  let called = false;
  globalThis.fetch = async (...args) => {
    if (called) return fallback(...args);
    called = true; signalStarted(); return first;
  };
  const pending = ui.click('#operations-run');
  await started;
  commit = B;
  await ui.click('#operations-refresh');
  assert.ok(ui.checkStates().every(state => state === '미실행'));
  resolveFirst(new Response(null, { status: 200, headers: { 'X-Deployment-Commit': A } }));
  await pending;
  assert.ok(ui.get('#operations-commit').textContent.includes(B));
  assert.ok(ui.checkStates().every(state => state === '미실행'));
});

test('older failed refresh cannot replace a newer successful refresh in the same session', async t => {
  let rejectOld;
  const old = new Promise((_, reject) => { rejectOld = reject; });
  let calls = 0;
  const ui = mount(t, () => ++calls === 1 ? old : Promise.resolve(evidence(B)));
  const pending = ui.click('#show-operations');
  await ui.click('#show-operations');
  rejectOld(new Error('stale refresh failure'));
  await pending;
  assert.equal(ui.get('#operations-export').disabled, false);
  assert.ok(ui.get('#operations-commit').textContent.includes(B));
});
