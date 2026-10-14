import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import config from '../aleph.config.json' with { type: 'json' };
import { RESOURCE_IDS } from './resource-zones.mjs';
import { RULE_IDS } from './decider.mjs';
import { verifyPolicySnapshotIntegrity } from './stage10-policy-recovery.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const POLICY_FILE_URL = new URL('../recovery/policy-snapshots/stage9-safe-policy.json', import.meta.url);
const SNAPSHOT_SCHEMA = 'aleph.note-snapshot.v1';
const MAX_REQUEST_BODY_BYTES = 2048;
let defaultVerifier;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function contentSha256(title, content) {
  return digest(`${title}\u001f${content}`);
}

// The database trigger uses the same fixed metadata order and newline separators.
export function noteSnapshotSha256(snapshot) {
  return digest([
    snapshot.snapshot_schema,
    snapshot.snapshot_version,
    snapshot.note_id,
    snapshot.owner_id,
    snapshot.content_sha256,
  ].join('\n'));
}

function json(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Aleph-Resource-Id': RESOURCE_IDS.personalNotes,
    },
  });
}

function serviceReady(env) {
  return typeof env.SUPABASE_URL === 'string' && env.SUPABASE_URL.length > 0
    && typeof env.SUPABASE_SECRET_KEY === 'string' && env.SUPABASE_SECRET_KEY.length > 0;
}

async function userVerifier(env, injectedVerifier) {
  if (injectedVerifier) return injectedVerifier;
  if (!defaultVerifier) {
    const { createLoginVerifier } = await import('./verify-login.mjs');
    defaultVerifier = createLoginVerifier({ config, supabaseSecretKey: env.SUPABASE_SECRET_KEY });
  }
  return defaultVerifier;
}

async function authenticatedStudent(request, env, injectedVerifier) {
  if (!serviceReady(env)) return { error: json({ error: 'Service unavailable' }, 500) };
  let principal;
  try {
    principal = await (await userVerifier(env, injectedVerifier))(request.headers.get('authorization'));
  } catch {
    return { error: json({ error: 'Authentication required' }, 401) };
  }
  if (principal?.kind !== 'student' || !UUID.test(principal.userId ?? '')) {
    return { error: json({ error: 'Authentication required' }, 401) };
  }
  return { userId: principal.userId };
}

async function defaultPolicyReader() {
  try {
    return await readFile(POLICY_FILE_URL, 'utf8');
  } catch {
    return null;
  }
}

function readPolicyResult(value) {
  let snapshot = value;
  if (typeof value === 'string') {
    try { snapshot = JSON.parse(value); } catch { return { error: 'missing_or_invalid' }; }
  }
  try {
    verifyPolicySnapshotIntegrity(snapshot);
  } catch {
    return { error: 'missing_or_invalid' };
  }

  const currentRules = [...RULE_IDS];
  const expectedRules = [...snapshot.safeRules];
  const missingRules = expectedRules.filter((rule) => !currentRules.includes(rule)).sort();
  const extraRules = currentRules.filter((rule) => !expectedRules.includes(rule)).sort();
  const policy = {
    policyRevision: snapshot.source.commit,
    policySha256: snapshot.sha256.toLowerCase(),
    currentRules,
    safeRules: expectedRules,
    missingRules,
    extraRules,
  };
  return missingRules.length || extraRules.length
    ? { error: 'policy_drift', policy }
    : { policy };
}

async function database(env, injectedFactory) {
  let factory = injectedFactory;
  if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
  return factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function requestedId(request) {
  const url = new URL(request.url);
  const match = /^\/api\/recovery\/notes\/([^/]+)$/u.exec(url.pathname);
  if (!match || url.search) return null;
  try {
    const id = decodeURIComponent(match[1]);
    return UUID.test(id) ? id : '';
  } catch {
    return '';
  }
}

async function parseRequestBody(request) {
  const raw = await request.text();
  if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BODY_BYTES) return { error: true };
  if (!raw.trim()) return { confirm: false };

  let body;
  try { body = JSON.parse(raw); } catch { return { error: true }; }
  if (!isRecord(body)) return { error: true };
  if (Object.keys(body).length === 0 || (Object.keys(body).length === 1 && body.confirm === false)) {
    return { confirm: false };
  }
  return Object.keys(body).length === 1 && body.confirm === true ? body : { error: true };
}

function isValidSnapshot(row, requestedNoteId) {
  if (!isRecord(row)
      || Object.keys(row).sort().join(',') !== [
        'captured_at', 'content', 'content_sha256', 'note_id', 'owner_id',
        'snapshot_schema', 'snapshot_sha256', 'snapshot_version', 'title',
      ].sort().join(',')
      || row.snapshot_schema !== SNAPSHOT_SCHEMA
      || !UUID.test(row.note_id ?? '') || row.note_id !== requestedNoteId
      || !UUID.test(row.owner_id ?? '')
      || typeof row.title !== 'string' || !row.title.trim() || row.title.length > 200
      || typeof row.content !== 'string' || !row.content.trim() || row.content.length > 5000
      || !UUID.test(row.snapshot_version ?? '')
      || typeof row.captured_at !== 'string' || !Number.isFinite(Date.parse(row.captured_at))
      || !SHA256.test(row.content_sha256 ?? '')
      || !SHA256.test(row.snapshot_sha256 ?? '')) return false;

  return contentSha256(row.title, row.content) === row.content_sha256.toLowerCase()
    && noteSnapshotSha256(row) === row.snapshot_sha256.toLowerCase();
}

function currentContentHash(row) {
  return row ? contentSha256(row.title, row.content) : null;
}

function beforeState(current, snapshot) {
  if (!current) return 'deleted';
  return currentContentHash(current) === snapshot.content_sha256 ? 'unchanged' : 'modified';
}

function changedFields(current, snapshot) {
  if (!current) return ['id', 'owner_id', 'title', 'content'];
  return ['title', 'content'].filter((field) => current[field] !== snapshot[field]);
}

export function createPrivateNoteRecoveryHandler({
  env = process.env,
  createClient,
  verifyLogin,
  policyReader = defaultPolicyReader,
} = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const id = requestedId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!id) return json({ error: 'Invalid note ID' }, 400);

      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      let input;
      try { input = await parseRequestBody(request); } catch { input = { error: true }; }
      if (input.error) return json({ error: 'Invalid recovery request' }, 400);

      let policyRaw;
      try { policyRaw = await policyReader(); } catch { policyRaw = null; }
      const policyResult = readPolicyResult(policyRaw);
      if (policyResult.error === 'missing_or_invalid') {
        return json({ error: 'POLICY_UNVERIFIED' }, 503);
      }
      if (policyResult.error === 'policy_drift') {
        return json({ error: 'POLICY_UNVERIFIED', diff: policyResult.policy }, 409);
      }
      const policy = policyResult.policy;

      try {
        const supabase = await database(env, createClient);
        const snapshotResult = await supabase.from('note_snapshots')
          .select('snapshot_schema,note_id,owner_id,title,content,content_sha256,snapshot_version,captured_at,snapshot_sha256')
          .eq('note_id', id).maybeSingle();
        if (snapshotResult.error) return json({ error: 'Unable to read recovery snapshot' }, 500);
        const snapshot = snapshotResult.data;
        if (!snapshot) return json({ error: 'NO_SNAPSHOT' }, 404);
        if (!isValidSnapshot(snapshot, id)) return json({ error: 'SNAPSHOT_INVALID' }, 503);
        if (snapshot.owner_id !== auth.userId) return json({ error: 'Recovery snapshot not found' }, 404);

        const currentResult = await supabase.from('vault_notes')
          .select('id,owner_id,title,content').eq('id', id).maybeSingle();
        if (currentResult.error) return json({ error: 'Unable to verify recovery target' }, 500);
        const current = currentResult.data;
        if (current && current.owner_id !== auth.userId) return json({ error: 'Recovery target not found' }, 404);

        const before = beforeState(current, snapshot);
        const changes = changedFields(current, snapshot);
        const version = {
          policyRevision: policy.policyRevision,
          policySha256: policy.policySha256,
          snapshotVersion: snapshot.snapshot_version,
          snapshotSha256: snapshot.snapshot_sha256.toLowerCase(),
          capturedAt: snapshot.captured_at,
        };

        if (!input.confirm) {
          return json({
            operation: 'preview',
            id,
            before,
            action: current ? 'update' : 'insert',
            changes,
            policyDiff: { missingRules: policy.missingRules, extraRules: policy.extraRules },
            version,
            confirmationRequired: true,
          }, 200);
        }

        if (before === 'unchanged') {
          return json({ operation: 'restored', id, restored: false, before, changes, version,
            matches: { id: true, owner: true, contentSha256: true } }, 200);
        }

        let mutation;
        if (current) {
          mutation = await supabase.from('vault_notes')
            .update({ title: snapshot.title, content: snapshot.content })
            .eq('id', id).eq('owner_id', auth.userId)
            .eq('title', current.title).eq('content', current.content)
            .select('id,owner_id,title,content').maybeSingle();
        } else {
          mutation = await supabase.from('vault_notes').insert({
            id,
            owner_id: auth.userId,
            title: snapshot.title,
            content: snapshot.content,
          }).select('id,owner_id,title,content').maybeSingle();
        }
        if (mutation.error || !mutation.data) return json({ error: 'Unable to restore note' }, 409);

        const afterResult = await supabase.from('vault_notes')
          .select('id,owner_id,title,content').eq('id', id).maybeSingle();
        if (afterResult.error) return json({ error: 'Unable to verify restored note' }, 500);
        const after = afterResult.data;
        const matches = {
          id: after?.id === snapshot.note_id,
          owner: after?.owner_id === snapshot.owner_id,
          contentSha256: Boolean(after) && currentContentHash(after) === snapshot.content_sha256.toLowerCase(),
        };
        if (!matches.id || !matches.owner || !matches.contentSha256) {
          return json({ error: 'RESTORE_MISMATCH', matches }, 500);
        }

        return json({
          operation: 'restored',
          id: after.id,
          restored: true,
          before,
          changes,
          version,
          matches,
        }, current ? 200 : 201);
      } catch {
        return json({ error: 'Unable to restore note' }, 500);
      }
    },
  };
}
