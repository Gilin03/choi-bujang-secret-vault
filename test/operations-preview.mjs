// Local browser integration fixture only; never used by Vercel entrypoints.
import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { createSessionApprovalApiHandler } from '../api/session-approval/[...path].mjs';
import { createSessionProtectedHandler } from '../src/session-approval.mjs';
import { createMyNotesHandler } from '../src/notes-api.mjs';

const owner = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const session = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const tables = {
  vault_session_approvals: [{ owner_id: owner, session_id: session, status: 'approved' }],
  vault_operation_events: [],
  vault_notes: [{ id: session, owner_id: owner, title: 'fixture', content: 'PRIVATE_NOTE_BODY', sort_order: 1 }],
  vault_note_backups: [{ note_id: session, owner_id: owner, captured_at: '2026-10-14T00:00:00Z', content_sha256: 'd'.repeat(64) }],
};
const client = { from(table) {
  const filters = [];
  let size = Infinity;
  let ordering;
  const query = {
    select() { return query; }, eq(key, value) { filters.push([key, value]); return query; },
    order(key, options) { ordering = { key, ...options }; return query; },
    limit(value) { size = value; return query; },
    insert(value) { tables[table].unshift(value); return Promise.resolve({ error: null }); },
    maybeSingle() { return query.then(result => ({ ...result, data: result.data[0] ?? null })); },
    then(resolve, reject) {
      const rows = tables[table].filter(row => filters.every(([key, value]) => row[key] === value));
      if (ordering) rows.sort((a, b) => String(a[ordering.key]).localeCompare(String(b[ordering.key])) * (ordering.ascending ? 1 : -1));
      return Promise.resolve({ data: rows.slice(0, size), error: null }).then(resolve, reject);
    },
  };
  return query;
} };
const options = {
  env: { SUPABASE_URL: 'https://local-fixture.example', SUPABASE_SECRET_KEY: 'fixture-only', VERCEL_GIT_COMMIT_SHA: 'a'.repeat(40) },
  createClient: () => client,
  verifyLogin: async auth => auth === 'Bearer fixture-memory-only' ? { kind: 'student', userId: owner, sessionId: session } : null,
};
const approval = createSessionApprovalApiHandler(options);
const notes = createSessionProtectedHandler(createMyNotesHandler(options), options);
const files = new Set(['/operation-checks.js', '/operations-client.js', '/manifest.webmanifest', '/vault-icon.svg', '/vault-icon-192.png', '/vault-icon-512.png']);
const html = (await readFile(new URL('../public/index.html', import.meta.url), 'utf8'))
  .replace(/<script type="module">[\s\S]*?<\/script>/u, `<script type="module">
    import { createOperationsPanel } from './operations-client.js';
    document.querySelector('h1').textContent = 'LOCAL FIXTURE · Production 아님';
    document.querySelector('#login-panel').hidden = true;
    document.querySelector('#workspace').hidden = false;
    document.querySelector('#my-notes').textContent = 'PRIVATE_NOTE_BODY';
    const api = async path => {
      const response = await fetch(path, { headers: { Authorization: 'Bearer fixture-memory-only' } });
      if (!response.ok) throw new Error('Fixture HTTP ' + response.status);
      return response.json();
    };
    const panel = createOperationsPanel({ api, getSession: async () => ({ access_token: 'fixture-memory-only' }) });
    document.querySelector('#logout-button').addEventListener('click', () => panel.reset());
  </script>`);

createServer(async (incoming, outgoing) => {
  try {
    const url = new URL(incoming.url, 'http://127.0.0.1:4312');
    const headers = new Headers(Object.entries(incoming.headers).filter(([, value]) => typeof value === 'string'));
    const request = new Request(url, { method: incoming.method, headers });
    let response;
    if (url.pathname.startsWith('/api/session-approval/')) response = await approval.fetch(request);
    else if (url.pathname === '/api/my/notes') response = await notes.fetch(request);
    else if (url.pathname === '/') response = new Response(html, { headers: { 'Content-Type': 'text/html', 'X-Content-Type-Options': 'nosniff' } });
    else if (url.pathname === '/aleph.json') response = Response.json({ step: 12, commit: 'a'.repeat(40), fixture: true });
    else if (files.has(url.pathname)) response = new Response(await readFile(new URL(`../public${url.pathname}`, import.meta.url)), { headers: { 'Content-Type': url.pathname.endsWith('.js') ? 'text/javascript' : url.pathname.endsWith('.png') ? 'image/png' : 'application/json' } });
    else response = Response.json({ error: 'Not found' }, { status: 404 });
    outgoing.writeHead(response.status, Object.fromEntries(response.headers));
    outgoing.end(Buffer.from(await response.arrayBuffer()));
  } catch { outgoing.writeHead(500); outgoing.end('fixture failure'); }
}).listen(4312, '127.0.0.1', () => console.log('Stage 12 local fixture preview: http://127.0.0.1:4312 (not Production)'));
