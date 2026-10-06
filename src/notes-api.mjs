import { randomUUID } from 'node:crypto';
import config from '../aleph.config.json' with { type: 'json' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let defaultVerifier;

function json(payload, status) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store' },
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
  const segment = new URL(request.url).pathname.split('/').at(-1);
  try { return decodeURIComponent(segment); } catch { return ''; }
}

export function createNotesHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (!['GET', 'POST'].includes(request.method)) {
        return json({ error: 'Method not allowed' }, 405);
      }
      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      try {
        const supabase = await database(env, createClient);
        if (request.method === 'GET') {
          const notes = await supabase.from('vault_notes').select('id,title,content')
            .eq('owner_id', auth.userId)
            .order('sort_order', { ascending: true });
          if (notes.error || !Array.isArray(notes.data)) {
            return json({ error: 'Unable to load notes' }, 500);
          }
          return json({ samples: [], notes: displayRows(notes.data) }, 200);
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

export function createNoteItemHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (!['GET', 'PUT', 'DELETE'].includes(request.method)) {
        return json({ error: 'Method not allowed' }, 405);
      }
      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;
      const id = requestId(request);
      if (!UUID.test(id)) return json({ error: 'Invalid note ID' }, 400);

      try {
        const supabase = await database(env, createClient);
        if (request.method === 'GET') {
          const { data, error } = await supabase.from('vault_notes').select('id,title,content')
            .eq('id', id).eq('owner_id', auth.userId).maybeSingle();
          if (error) return json({ error: 'Unable to load note' }, 500);
          if (!data) return json({ error: 'Note not found' }, 404);
          return json({ id: data.id, title: data.title, body: data.content }, 200);
        }

        if (request.method === 'PUT') {
          const fields = noteFields(await parseBody(request));
          if (!fields) return json({ error: 'Invalid note' }, 400);
          const { data, error } = await supabase.from('vault_notes').update(fields)
            .eq('id', id).eq('owner_id', auth.userId).select('id,owner_id').maybeSingle();
          if (error) return json({ error: 'Unable to update note' }, 500);
          if (!data || data.owner_id !== auth.userId) return json({ error: 'Note not found' }, 404);
          return json({ id: data.id }, 200);
        }

        const { data, error } = await supabase.from('vault_notes').delete()
          .eq('id', id).eq('owner_id', auth.userId).select('id').maybeSingle();
        if (error) return json({ error: 'Unable to delete note' }, 500);
        if (!data) return json({ error: 'Note not found' }, 404);
        return new Response(null, { status: 204, headers: { 'Cache-Control': 'no-store' } });
      } catch {
        return json({ error: 'Unable to update note' }, 500);
      }
    },
  };
}
