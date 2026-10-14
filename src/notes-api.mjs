import { createHash, randomUUID } from 'node:crypto';
import config from '../aleph.config.json' with { type: 'json' };
import { RESOURCE_IDS } from './resource-zones.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const SHA256 = /^[a-f0-9]{64}$/u;
let defaultVerifier;

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

async function database(env, injectedFactory) {
  let factory = injectedFactory;
  if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
  return factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
      detectSessionInUrl: false,
    },
  });
}

function displayRows(rows) {
  return rows.map(({ id, title, content }) => ({ id, title, body: content }));
}

function noteFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  if (typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200
      || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 5000) return null;
  return { title: body.title.trim(), content: body.body.trim() };
}

async function parseBody(request) {
  try { return await request.json(); } catch { return null; }
}

function requestId(request) {
  const url = new URL(request.url);
  const match = /^\/api\/notes\/([^/]+)$/u.exec(url.pathname);
  if (!match || url.search) return null;
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

function restoreRequestId(request) {
  const url = new URL(request.url);
  const match = /^\/api\/notes\/([^/]+)\/restore$/u.exec(url.pathname);
  if (!match) return null;
  const routeId = request.query?.id ?? match[1];
  if (typeof routeId !== 'string') return '';
  if (request.query?.id !== undefined && request.query.id !== null) return routeId;
  try { return decodeURIComponent(routeId); } catch { return ''; }
}

function sha256(value) {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

function validNoteBackup(backup, requestedId) {
  return backup && typeof backup === 'object' && !Array.isArray(backup)
    && backup.note_id === requestedId && UUID.test(backup.note_id ?? '')
    && UUID.test(backup.owner_id ?? '')
    && typeof backup.title === 'string'
    && typeof backup.content === 'string'
    && typeof backup.content_sha256 === 'string' && SHA256.test(backup.content_sha256)
    && sha256(backup.content) === backup.content_sha256;
}

export function createNotesHandler({ env = process.env, createClient, verifyLogin,
  path = '/api/notes', allowCreate = true } = {}) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== path || url.search) {
        return json({ error: 'Resource not found' }, 404);
      }
      const allowedMethods = allowCreate ? ['GET', 'POST'] : ['GET'];
      if (!allowedMethods.includes(request.method)) {
        return json({ error: 'Method not allowed' }, 405);
      }
      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      try {
        const supabase = await database(env, createClient);
        if (request.method === 'GET') {
          const notes = await supabase.from('vault_notes').select('id,title,content,owner_id')
            .eq('owner_id', auth.userId)
            .order('sort_order', { ascending: true });
          if (notes.error || !Array.isArray(notes.data)) {
            return json({ error: 'Unable to load notes' }, 500);
          }
          const ownedNotes = notes.data.filter(note => note.owner_id === auth.userId);
          return json({ samples: [], notes: displayRows(ownedNotes) }, 200);
        }

        const body = await parseBody(request);
        const fields = noteFields(body);
        if (!fields || (body.id !== undefined && (typeof body.id !== 'string' || !UUID.test(body.id)))) {
          return json({ error: 'Invalid note' }, 400);
        }
        const id = body.id ?? randomUUID();
        const { data, error } = await supabase.from('vault_notes').insert({
          id,
          owner_id: auth.userId,
          title: fields.title,
          content: fields.content,
        }).select('id').single();
        if (error || typeof data?.id !== 'string') return json({ error: 'Unable to save note' }, 500);
        return json({ id: data.id }, 201);
      } catch {
        return json({ error: request.method === 'GET' ? 'Unable to load notes' : 'Unable to save note' }, 500);
      }
    },
  };
}

export function createMyNotesHandler(options = {}) {
  return createNotesHandler({ ...options, path: '/api/my/notes', allowCreate: false });
}

export function createNoteItemHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (!['GET', 'PUT', 'DELETE'].includes(request.method)) {
        return json({ error: 'Method not allowed' }, 405);
      }
      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;
      const id = requestId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!UUID.test(id)) return json({ error: 'Invalid note ID' }, 400);

      try {
        const supabase = await database(env, createClient);
        if (request.method === 'GET') {
          const { data, error } = await supabase.from('vault_notes').select('id,title,content,owner_id')
            .eq('id', id).eq('owner_id', auth.userId).maybeSingle();
          if (error) return json({ error: 'Unable to load note' }, 500);
          if (!data || data.owner_id !== auth.userId) return json({ error: 'Note not found' }, 404);
          return json({ id: data.id, title: data.title, body: data.content }, 200);
        }

        if (request.method === 'PUT') {
          const fields = noteFields(await parseBody(request));
          if (!fields) return json({ error: 'Invalid note' }, 400);
          const existing = await supabase.from('vault_notes').select('id,owner_id')
            .eq('id', id).maybeSingle();
          if (existing.error) return json({ error: 'Unable to update note' }, 500);
          if (!existing.data || existing.data.owner_id !== auth.userId) {
            return json({ error: 'Note not found' }, 404);
          }
          const { data, error } = await supabase.from('vault_notes').update(fields)
            .eq('id', id).eq('owner_id', auth.userId).select('id,owner_id').maybeSingle();
          if (error) return json({ error: 'Unable to update note' }, 500);
          if (!data || data.owner_id !== auth.userId) return json({ error: 'Note not found' }, 404);
          return json({ id: data.id }, 200);
        }

        const existing = await supabase.from('vault_notes').select('id,owner_id')
          .eq('id', id).maybeSingle();
        if (existing.error) return json({ error: 'Unable to delete note' }, 500);
        if (!existing.data || existing.data.owner_id !== auth.userId) {
          return json({ error: 'Note not found' }, 404);
        }
        const { data, error } = await supabase.from('vault_notes').delete()
          .eq('id', id).eq('owner_id', auth.userId).select('id,owner_id').maybeSingle();
        if (error) return json({ error: 'Unable to delete note' }, 500);
        if (!data || data.owner_id !== auth.userId) return json({ error: 'Note not found' }, 404);
        return new Response(null, { status: 204, headers: {
          'Cache-Control': 'no-store',
          'X-Aleph-Resource-Id': RESOURCE_IDS.personalNotes,
        } });
      } catch {
        return json({ error: 'Unable to update note' }, 500);
      }
    },
  };
}

export function createNoteRestoreHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      const id = restoreRequestId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!UUID.test(id)) return json({ error: 'Invalid note ID' }, 400);

      try {
        const supabase = await database(env, createClient);
        const { data: backup, error: backupError } = await supabase.from('vault_note_backups')
          .select('note_id,owner_id,title,content,content_sha256')
          .eq('note_id', id).maybeSingle();
        if (backupError) return json({ error: 'Unable to load note backup' }, 500);
        if (!backup || backup.note_id !== id || backup.owner_id !== auth.userId) {
          return json({ error: 'Note not found' }, 404);
        }
        if (!validNoteBackup(backup, id)) return json({ error: 'Note backup verification failed' }, 500);

        const existing = await supabase.from('vault_notes').select('id,owner_id')
          .eq('id', backup.note_id).maybeSingle();
        if (existing.error) return json({ error: 'Unable to restore note' }, 500);
        if (existing.data && existing.data.id !== backup.note_id) {
          return json({ error: 'Note not found' }, 404);
        }

        if (existing.data) {
          const { error } = await supabase.from('vault_notes')
            .update({ owner_id: backup.owner_id, title: backup.title, content: backup.content })
            .eq('id', backup.note_id);
          if (error) return json({ error: 'Unable to restore note' }, 500);
        } else {
          const { error } = await supabase.from('vault_notes').insert({
            id: backup.note_id,
            owner_id: backup.owner_id,
            title: backup.title,
            content: backup.content,
          });
          if (error) return json({ error: 'Unable to restore note' }, 500);
        }

        const restored = await supabase.from('vault_notes').select('id,owner_id,content')
          .eq('id', backup.note_id).maybeSingle();
        if (restored.error || !restored.data) return json({ error: 'Restore verification failed' }, 500);
        const contentSha256 = sha256(restored.data.content ?? '');
        if (restored.data.id !== backup.note_id || restored.data.owner_id !== backup.owner_id
            || contentSha256 !== backup.content_sha256) {
          return json({ error: 'Restore verification failed' }, 500);
        }

        return json({
          id: restored.data.id,
          owner_id: restored.data.owner_id,
          contentSha256,
        }, 200);
      } catch {
        return json({ error: 'Unable to restore note' }, 500);
      }
    },
  };
}
