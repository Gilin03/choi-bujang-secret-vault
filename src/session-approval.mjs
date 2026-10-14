import config from '../aleph.config.json' with { type: 'json' };

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const TABLE = 'vault_session_approvals';
const COLUMNS = 'session_id,owner_id,status,created_at,approved_at';
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

async function loginVerifier(env, injectedVerifier) {
  if (injectedVerifier) return injectedVerifier;
  if (!defaultVerifier) {
    const { createLoginVerifier } = await import('./verify-login.mjs');
    defaultVerifier = createLoginVerifier({ config, supabaseSecretKey: env.SUPABASE_SECRET_KEY });
  }
  return defaultVerifier;
}

async function database(env, injectedFactory) {
  let factory = injectedFactory;
  if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
  return factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
    auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
  });
}

async function authenticate(request, env, injectedVerifier) {
  if (!serviceReady(env)) return { error: json({ error: 'Service unavailable' }, 503) };
  let principal;
  try {
    principal = await (await loginVerifier(env, injectedVerifier))(
      request.headers.get('authorization'));
  } catch {
    return { error: json({ error: 'Authentication required' }, 401) };
  }
  if (principal?.kind !== 'student' || !UUID.test(principal.userId ?? '')) {
    return { error: json({ error: 'Authentication required' }, 401) };
  }
  if (!UUID.test(principal.sessionId ?? '')) {
    return { error: json({ error: 'Verified login session required' }, 403) };
  }
  return { principal };
}

async function approvalFor(client, principal) {
  const { data, error } = await client.from(TABLE).select(COLUMNS)
    .eq('session_id', principal.sessionId).eq('owner_id', principal.userId).maybeSingle();
  if (error) throw new Error('session_approval_lookup_failed');
  return data;
}

function statusFor(row) {
  if (!row) return 'not_registered';
  if (row.status === 'pending' || row.status === 'approved') return row.status;
  throw new Error('invalid_session_approval_status');
}

export function createSessionApprovalHandlers({ env = process.env, createClient, verifyLogin } = {}) {
  return {
    status: {
      async fetch(request) {
        if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
        const auth = await authenticate(request, env, verifyLogin);
        if (auth.error) return auth.error;
        try {
          const client = await database(env, createClient);
          return json({ status: statusFor(await approvalFor(client, auth.principal)) }, 200);
        } catch {
          return json({ error: 'Unable to check session approval' }, 503);
        }
      },
    },
    request: {
      async fetch(request) {
        if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
        const auth = await authenticate(request, env, verifyLogin);
        if (auth.error) return auth.error;
        try {
          const client = await database(env, createClient);
          const existing = await approvalFor(client, auth.principal);
          if (existing) {
            const status = statusFor(existing);
            return json({ status }, status === 'pending' ? 202 : 200);
          }

          const { data, error } = await client.from(TABLE).insert({
            session_id: auth.principal.sessionId,
            owner_id: auth.principal.userId,
            status: 'pending',
          }).select(COLUMNS).maybeSingle();
          if (error?.code === '23505') {
            const raced = await approvalFor(client, auth.principal);
            if (raced) {
              const status = statusFor(raced);
              return json({ status }, status === 'pending' ? 202 : 200);
            }
          }
          if (error || !data || data.session_id !== auth.principal.sessionId
              || data.owner_id !== auth.principal.userId || data.status !== 'pending') {
            return json({ error: 'Unable to create session approval request' }, 503);
          }
          return json({ status: 'pending' }, 202);
        } catch {
          return json({ error: 'Unable to create session approval request' }, 503);
        }
      },
    },
    protect(handler) {
      return {
        async fetch(request, ...args) {
          const auth = await authenticate(request, env, verifyLogin);
          if (auth.error) return auth.error;
          try {
            const client = await database(env, createClient);
            const approval = await approvalFor(client, auth.principal);
            if (approval?.status !== 'approved') {
              return json({
                error: 'Session approval required',
                status: approval?.status === 'pending' ? 'pending' : 'not_registered',
              }, 403);
            }
          } catch {
            return json({ error: 'Unable to verify session approval' }, 503);
          }
          return handler.fetch(request, ...args);
        },
      };
    },
  };
}

export function createSessionProtectedHandler(handler, options = {}) {
  return createSessionApprovalHandlers(options).protect(handler);
}
