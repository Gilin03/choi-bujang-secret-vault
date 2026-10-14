import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import config from '../aleph.config.json' with { type: 'json' };
import { RESOURCE_IDS } from './resource-zones.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[0-9a-f]{64}$/iu;
const VERSION = /^[A-Za-z0-9._-]{1,80}$/u;
const BACKUP_SCHEMA = 'aleph.private-note-backup.v1';
const MAX_BACKUP_BYTES = 12000;
const MAX_REQUEST_BODY_BYTES = 2048;
const PRIVATE_BACKUP_URL = new URL('../recovery/private/stage10-b-note-backup.json', import.meta.url);
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

async function defaultBackupReader() {
  try {
    return await readFile(PRIVATE_BACKUP_URL, 'utf8');
  } catch {
    return null;
  }
}

function exactKeys(record, expected) {
  return Object.keys(record).sort().join(',') === [...expected].sort().join(',');
}

export async function readVerifiedNoteBackup(noteId, backupReader = defaultBackupReader) {
  let raw;
  try {
    raw = await backupReader(noteId);
  } catch {
    return null;
  }
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > MAX_BACKUP_BYTES) return null;

  let backup;
  try {
    backup = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(backup) || !exactKeys(backup, ['schema', 'version', 'note', 'backupSha256'])
      || backup.schema !== BACKUP_SCHEMA || !VERSION.test(backup.version ?? '')
      || !isRecord(backup.note)
      || !exactKeys(backup.note, ['id', 'ownerId', 'title', 'body', 'contentSha256'])
      || !UUID.test(backup.note.id ?? '') || !UUID.test(backup.note.ownerId ?? '')
      || typeof backup.note.title !== 'string' || !backup.note.title.trim()
      || backup.note.title.length > 200
      || typeof backup.note.body !== 'string' || !backup.note.body.trim()
      || backup.note.body.length > 5000
      || !SHA256.test(backup.note.contentSha256 ?? '')
      || !SHA256.test(backup.backupSha256 ?? '')) return null;

  const note = {
    id: backup.note.id,
    ownerId: backup.note.ownerId,
    title: backup.note.title,
    body: backup.note.body,
  };
  const contentSha256 = digest(JSON.stringify(note));
  if (contentSha256 !== backup.note.contentSha256.toLowerCase()) return null;

  const payload = {
    schema: backup.schema,
    version: backup.version,
    note: { ...note, contentSha256: backup.note.contentSha256.toLowerCase() },
  };
  const backupSha256 = digest(JSON.stringify(payload));
  if (backupSha256 !== backup.backupSha256.toLowerCase()) return null;

  if (backup.note.id !== noteId) return { invalidTarget: true };
  return {
    note,
    contentSha256,
    backupSha256,
    version: backup.version,
  };
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
  return keys === 'backupSha256,backupVersion,currentContentSha256,operation'
    && VERSION.test(body.backupVersion ?? '')
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

function isRestoredRow(row, backup) {
  return Boolean(row && row.id === backup.note.id
    && row.owner_id === backup.note.ownerId
    && row.title === backup.note.title
    && row.content === backup.note.body
    && rowContentHash(row) === backup.contentSha256);
}

async function rollbackMutation(supabase, current, backup) {
  if (current) {
    return supabase.from('vault_notes')
      .update({ title: current.title, content: current.content })
      .eq('id', backup.note.id).eq('owner_id', backup.note.ownerId)
      .eq('title', backup.note.title).eq('content', backup.note.body)
      .select('id').maybeSingle();
  }
  return supabase.from('vault_notes').delete()
    .eq('id', backup.note.id).eq('owner_id', backup.note.ownerId)
    .eq('title', backup.note.title).eq('content', backup.note.body)
    .select('id').maybeSingle();
}

export function createPrivateNoteRecoveryHandler({
  env = process.env,
  createClient,
  verifyLogin,
  backupReader = defaultBackupReader,
} = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const id = requestedId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!id) return json({ error: 'Invalid note ID' }, 400);

      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      const body = await parseBody(request);
      if (!isRecord(body) || !['preview', 'restore'].includes(body.operation)
          || !validOperationBody(body, body.operation)) {
        return json({ error: 'Invalid recovery request' }, 400);
      }

      const backup = await readVerifiedNoteBackup(id, backupReader);
      if (!backup) return json({ error: 'Recovery backup unavailable or invalid' }, 503);
      if (backup.invalidTarget || backup.note.ownerId !== auth.userId) {
        return json({ error: 'Recovery backup not found' }, 404);
      }
      if (body.operation === 'restore'
          && (body.backupVersion !== backup.version || body.backupSha256 !== backup.backupSha256)) {
        return json({ error: 'Recovery preview changed; preview again' }, 409);
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
          const changes = current
            ? ['title', 'content'].filter((field) => current[field] !== backup.note[field === 'content' ? 'body' : field])
            : ['id', 'owner_id', 'title', 'content'];
          return json({
            operation: 'preview',
            id,
            backupVersion: backup.version,
            backupSha256: backup.backupSha256,
            action: current ? 'update' : 'insert',
            changes,
            currentContentSha256,
            confirmationRequired: true,
          }, 200);
        }

        if (body.currentContentSha256 !== currentContentSha256) {
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
        if (!isRestoredRow(restored, backup)) {
          if (restored && restored.id === backup.note.id
              && restored.owner_id === backup.note.ownerId) {
            const rollback = await rollbackMutation(supabase, current, backup);
            if (rollback.error || !rollback.data) {
              return json({ error: 'Restore verification failed; compensation was incomplete' }, 500);
            }
          }
          return json({ error: 'Restored note verification failed' }, 500);
        }
        return json({
          operation: 'restored',
          id: restored.id,
          backupVersion: backup.version,
          ownerMatched: true,
          contentSha256: backup.contentSha256,
        }, current ? 200 : 201);
      } catch {
        return json({ error: 'Unable to restore note' }, 500);
      }
    },
  };
}
