import { createHash } from 'node:crypto';
import config from '../aleph.config.json' with { type: 'json' };
import { RESOURCE_IDS } from './resource-zones.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/u;
const BACKUP_SCHEMA = 'aleph.private-note-backup.v1';
const MAX_BACKUP_BYTES = 12000;
const MAX_REQUEST_BODY_BYTES = 2048;
let defaultVerifier;

function isRecord(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
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

function privateBackup(env) {
  const raw = env.STAGE10_B_NOTE_BACKUP_JSON;
  const expectedHash = env.STAGE10_B_NOTE_BACKUP_SHA256;
  if (typeof raw !== 'string' || !raw || Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_BYTES
      || typeof expectedHash !== 'string' || !SHA256.test(expectedHash)) return null;
  const backupSha256 = digest(raw);
  if (backupSha256 !== expectedHash.toLowerCase()) return null;
  let backup;
  try { backup = JSON.parse(raw); } catch { return null; }
  if (!isRecord(backup) || backup.schema !== BACKUP_SCHEMA
      || Object.keys(backup).sort().join(',') !== 'note,schema'
      || !isRecord(backup.note)
      || Object.keys(backup.note).sort().join(',') !== 'body,contentSha256,id,ownerId,title'
      || !UUID.test(backup.note.id ?? '') || !UUID.test(backup.note.ownerId ?? '')
      || typeof backup.note.title !== 'string' || !backup.note.title.trim()
      || backup.note.title.length > 200
      || typeof backup.note.body !== 'string' || !backup.note.body.trim()
      || backup.note.body.length > 5000
      || !SHA256.test(backup.note.contentSha256 ?? '')) return null;
  const noteCore = {
    id: backup.note.id,
    ownerId: backup.note.ownerId,
    title: backup.note.title,
    body: backup.note.body,
  };
  const contentSha256 = digest(JSON.stringify(noteCore));
  if (contentSha256 !== backup.note.contentSha256) return null;
  return { note: noteCore, contentSha256, backupSha256 };
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

async function parseBody(request) {
  const contentLength = Number(request.headers.get('content-length'));
  if (Number.isFinite(contentLength) && contentLength > MAX_REQUEST_BODY_BYTES) return null;
  try {
    const raw = await request.text();
    if (Buffer.byteLength(raw, 'utf8') > MAX_REQUEST_BODY_BYTES) return null;
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function validOperationBody(body, operation) {
  if (!isRecord(body) || body.operation !== operation) return false;
  const keys = Object.keys(body).sort().join(',');
  if (operation === 'preview') return keys === 'operation';
  return keys === 'backupSha256,currentContentSha256,operation'
    && SHA256.test(body.backupSha256 ?? '')
    && (body.currentContentSha256 === null || SHA256.test(body.currentContentSha256 ?? ''));
}

function rowContentHash(row) {
  return digest(JSON.stringify({
    id: row.id,
    ownerId: row.owner_id,
    title: row.title,
    body: row.content,
  }));
}

async function database(env, injectedFactory) {
  let factory = injectedFactory;
  if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
  return factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

export function createPrivateNoteRecoveryHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const id = requestedId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!id) return json({ error: 'Invalid note ID' }, 400);

      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;
      const backup = privateBackup(env);
      if (!backup) return json({ error: 'Recovery backup unavailable' }, 503);
      if (backup.note.id !== id || backup.note.ownerId !== auth.userId) {
        return json({ error: 'Recovery backup not found' }, 404);
      }

      const body = await parseBody(request);
      if (!isRecord(body) || !['preview', 'restore'].includes(body.operation)
          || !validOperationBody(body, body.operation)) {
        return json({ error: 'Invalid recovery request' }, 400);
      }

      try {
        const supabase = await database(env, createClient);
        const currentResult = await supabase.from('vault_notes')
          .select('id,owner_id,title,content').eq('id', id).maybeSingle();
        if (currentResult.error) return json({ error: 'Unable to verify recovery target' }, 500);
        const current = currentResult.data;
        if (current && current.owner_id !== backup.note.ownerId) {
          return json({ error: 'Recovery backup not found' }, 404);
        }
        const currentContentSha256 = current ? rowContentHash(current) : null;

        if (body.operation === 'preview') {
          return json({
            operation: 'preview',
            id,
            ownerMatched: true,
            action: current ? 'update' : 'insert',
            backupSha256: backup.backupSha256,
            contentSha256: backup.contentSha256,
            currentContentSha256,
            confirmationRequired: true,
          }, 200);
        }

        if (body.backupSha256 !== backup.backupSha256
            || body.currentContentSha256 !== currentContentSha256) {
          return json({ error: 'Recovery preview changed; preview again' }, 409);
        }

        let restoredResult;
        if (current) {
          restoredResult = await supabase.from('vault_notes')
            .update({ title: backup.note.title, content: backup.note.body })
            .eq('id', id).eq('owner_id', backup.note.ownerId)
            .eq('title', current.title).eq('content', current.content)
            .select('id,owner_id,title,content').maybeSingle();
        } else {
          restoredResult = await supabase.from('vault_notes').insert({
            id,
            owner_id: backup.note.ownerId,
            title: backup.note.title,
            content: backup.note.body,
          }).select('id,owner_id,title,content').single();
        }
        if (restoredResult.error) return json({ error: 'Unable to restore note' }, 409);
        const restored = restoredResult.data;
        if (!restored || restored.id !== backup.note.id
            || restored.owner_id !== backup.note.ownerId
            || restored.title !== backup.note.title || restored.content !== backup.note.body
            || rowContentHash(restored) !== backup.contentSha256) {
          return json({ error: 'Restored note verification failed' }, 500);
        }
        return json({
          operation: 'restored',
          id: restored.id,
          ownerMatched: true,
          contentSha256: backup.contentSha256,
        }, current ? 200 : 201);
      } catch {
        return json({ error: 'Unable to restore note' }, 500);
      }
    },
  };
}
