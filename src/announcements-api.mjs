import config from '../aleph.config.json' with { type: 'json' };
import { RESOURCE_IDS } from './resource-zones.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
let defaultVerifier;

function json(payload, status) {
  return Response.json(payload, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Aleph-Resource-Id': RESOURCE_IDS.instructorAnnouncements,
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
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

function bodyFields(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)
      || typeof body.title !== 'string' || !body.title.trim() || body.title.length > 200
      || typeof body.body !== 'string' || !body.body.trim() || body.body.length > 5000) return null;
  return { title: body.title.trim(), content: body.body.trim() };
}

async function parseBody(request) {
  try { return await request.json(); } catch { return null; }
}

function noticeId(request) {
  const url = new URL(request.url);
  const match = /^\/api\/announcements\/([^/]+)$/u.exec(url.pathname);
  if (!match || url.search) return null;
  try { return decodeURIComponent(match[1]); } catch { return ''; }
}

export function createAnnouncementHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      const url = new URL(request.url);
      if (url.pathname !== '/api/announcements' || url.search) {
        return json({ error: 'Resource not found' }, 404);
      }
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);

      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      try {
        const supabase = await database(env, createClient);
        const { data, error } = await supabase.from('vault_announcements')
          .select('id,title,content').order('updated_at', { ascending: false });
        if (error || !Array.isArray(data)) return json({ error: 'Unable to load announcements' }, 500);
        return json({
          resourceId: RESOURCE_IDS.instructorAnnouncements,
          announcements: data.map(({ id, title, content }) => ({ id, title, body: content })),
        }, 200);
      } catch {
        return json({ error: 'Unable to load announcements' }, 500);
      }
    },
  };
}

export function createAnnouncementItemHandler({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    async fetch(request) {
      if (!['GET', 'PUT'].includes(request.method)) return json({ error: 'Method not allowed' }, 405);
      const id = noticeId(request);
      if (id === null) return json({ error: 'Resource not found' }, 404);
      if (!UUID.test(id)) return json({ error: 'Invalid announcement ID' }, 400);

      const auth = await authenticatedStudent(request, env, verifyLogin);
      if (auth.error) return auth.error;

      try {
        const supabase = await database(env, createClient);
        if (request.method === 'GET') {
          const { data, error } = await supabase.from('vault_announcements')
            .select('id,title,content').eq('id', id).maybeSingle();
          if (error) return json({ error: 'Unable to load announcement' }, 500);
          if (!data) return json({ error: 'Announcement not found' }, 404);
          return json({
            resourceId: RESOURCE_IDS.instructorAnnouncements,
            id: data.id,
            title: data.title,
            body: data.content,
          }, 200);
        }

        const access = await supabase.from('vault_instructor_access').select('user_id')
          .eq('user_id', auth.userId).eq('active', true).maybeSingle();
        if (access.error) return json({ error: 'Unable to verify instructor access' }, 503);
        if (!access.data || access.data.user_id !== auth.userId) {
          return json({ error: 'Access denied' }, 403);
        }

        const fields = bodyFields(await parseBody(request));
        if (!fields) return json({ error: 'Invalid announcement' }, 400);
        const { data, error } = await supabase.from('vault_announcements')
          .update({ ...fields, updated_by: auth.userId, updated_at: new Date().toISOString() })
          .eq('id', id).select('id,updated_by').maybeSingle();
        if (error) return json({ error: 'Unable to update announcement' }, 500);
        if (!data || data.updated_by !== auth.userId) {
          return json({ error: 'Announcement not found' }, 404);
        }
        return json({ id: data.id, resourceId: RESOURCE_IDS.instructorAnnouncements }, 200);
      } catch {
        return json({ error: 'Unable to update announcement' }, 500);
      }
    },
  };
}
