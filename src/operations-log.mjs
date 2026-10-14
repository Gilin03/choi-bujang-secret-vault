const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ROUTES = new Set(['/api/my/notes', '/api/notes', '/api/notes/:id', '/api/notes/:id/restore',
  '/api/announcements', '/api/announcements/:id', '/api/session-approval/status',
  '/api/session-approval/request', '/api/session-approval/operations', '/unrecognized']);

export function operationRoute(url) {
  const path = new URL(url).pathname;
  if (ROUTES.has(path)) return path;
  if (/^\/api\/notes\/[^/]+\/restore$/u.test(path)) return '/api/notes/:id/restore';
  if (/^\/api\/notes\/[^/]+$/u.test(path)) return '/api/notes/:id';
  if (/^\/api\/announcements\/[^/]+$/u.test(path)) return '/api/announcements/:id';
  return '/unrecognized';
}

export async function recordOperationResult(event, { env = process.env, createClient } = {}) {
  // Only the verified server principal may attribute a record. Never retain raw requests.
  if (event.principal?.kind !== 'student' || !UUID.test(event.principal.userId ?? '')
      || !UUID.test(event.principal.sessionId ?? '') || !UUID.test(event.requestId ?? '')
      || !Number.isFinite(Date.parse(event.checkedAt)) || !ROUTES.has(event.route)
      || !['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'HEAD', 'OPTIONS'].includes(event.method)
      || !Number.isInteger(event.status) || event.status < 100 || event.status > 599) return false;
  try {
    let factory = createClient;
    if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
    const client = factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
    const { error } = await client.from('vault_operation_events').insert({
      owner_id: event.principal.userId, request_id: event.requestId,
      checked_at: event.checkedAt, method: event.method, route: event.route, status: event.status,
      commit_sha: /^[a-f0-9]{40}$/iu.test(env.VERCEL_GIT_COMMIT_SHA ?? '') ? env.VERCEL_GIT_COMMIT_SHA.toLowerCase() : null,
    });
    return !error;
  } catch { return false; }
}
