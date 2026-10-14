import config from '../aleph.config.json' with { type: 'json' };
import { randomUUID } from 'node:crypto';
import { operationRoute, recordOperationResult } from './operations-log.mjs';

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

function belongsToVerifiedSession(row, principal, status) {
  return row?.session_id === principal.sessionId
    && row?.owner_id === principal.userId
    && row?.status === status;
}

async function approvePendingSession(client, principal) {
  const { data, error } = await client.from(TABLE).update({
    status: 'approved',
    approved_at: new Date().toISOString(),
  }).eq('session_id', principal.sessionId).eq('owner_id', principal.userId)
    .eq('status', 'pending').select(COLUMNS).maybeSingle();
  if (error) throw new Error('session_approval_update_failed');
  if (belongsToVerifiedSession(data, principal, 'approved')) return data;

  // A concurrent request may have completed the transition first.
  const latest = await approvalFor(client, principal);
  if (belongsToVerifiedSession(latest, principal, 'approved')) return latest;
  throw new Error('session_approval_update_failed');
}

async function approveVerifiedSession(client, principal) {
  const existing = await approvalFor(client, principal);
  const existingStatus = statusFor(existing);
  if (existingStatus === 'approved') return existing;
  if (existingStatus === 'pending') return approvePendingSession(client, principal);

  const { data, error } = await client.from(TABLE).insert({
    session_id: principal.sessionId,
    owner_id: principal.userId,
    status: 'approved',
    approved_at: new Date().toISOString(),
  }).select(COLUMNS).maybeSingle();
  if (belongsToVerifiedSession(data, principal, 'approved')) return data;

  if (error?.code === '23505') {
    const raced = await approvalFor(client, principal);
    if (belongsToVerifiedSession(raced, principal, 'approved')) return raced;
    if (belongsToVerifiedSession(raced, principal, 'pending')) {
      return approvePendingSession(client, principal);
    }
  }
  throw new Error('session_approval_insert_failed');
}

function statusFor(row) {
  if (!row) return 'not_registered';
  if (row.status === 'pending' || row.status === 'approved') return row.status;
  throw new Error('invalid_session_approval_status');
}

export function createSessionApprovalHandlers({ env = process.env, createClient, verifyLogin, recordResult } = {}) {
  async function complete(request, response, principal) {
    const requestId = randomUUID();
    const checkedAt = new Date().toISOString();
    let recorded = false;
    if (recordResult) {
      try {
        recorded = await recordResult({ principal, requestId, checkedAt,
          method: request.method, route: operationRoute(request.url), status: response.status }, { env, createClient }) === true;
      } catch { /* Record failure never changes the protected API outcome. */ }
    }
    const headers = new Headers(response.headers);
    headers.set('X-Request-Id', requestId);
    headers.set('X-Checked-At', checkedAt);
    headers.set('X-Audit-Recorded', String(recorded));
    if (/^[a-f0-9]{40}$/iu.test(env.VERCEL_GIT_COMMIT_SHA ?? '')) {
      headers.set('X-Deployment-Commit', env.VERCEL_GIT_COMMIT_SHA.toLowerCase());
    }
    return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
  }
  return {
    status: {
      async fetch(request) {
        if (request.method !== 'GET') return complete(request, json({ error: 'Method not allowed' }, 405));
        const auth = await authenticate(request, env, verifyLogin);
        if (auth.error) return complete(request, auth.error);
        try {
          const client = await database(env, createClient);
          return complete(request, json({ status: statusFor(await approvalFor(client, auth.principal)) }, 200), auth.principal);
        } catch {
          return complete(request, json({ error: 'Unable to check session approval' }, 503), auth.principal);
        }
      },
    },
    request: {
      async fetch(request) {
        if (request.method !== 'POST') return complete(request, json({ error: 'Method not allowed' }, 405));
        const auth = await authenticate(request, env, verifyLogin);
        if (auth.error) return complete(request, auth.error);
        try {
          const client = await database(env, createClient);
          await approveVerifiedSession(client, auth.principal);
          return complete(request, json({ status: 'approved' }, 200), auth.principal);
        } catch {
          return complete(request, json({ error: 'Unable to approve verified session' }, 503), auth.principal);
        }
      },
    },
    protect(handler) {
      return {
        async fetch(request, ...args) {
          const auth = await authenticate(request, env, verifyLogin);
          if (auth.error) return complete(request, auth.error);
          try {
            const client = await database(env, createClient);
            const approval = await approvalFor(client, auth.principal);
            if (approval?.status !== 'approved') {
              return complete(request, json({
                error: 'Session approval required',
                status: approval?.status === 'pending' ? 'pending' : 'not_registered',
              }, 403), auth.principal);
            }
          } catch {
            return complete(request, json({ error: 'Unable to verify session approval' }, 503), auth.principal);
          }
          return complete(request, await handler.fetch(request, ...args), auth.principal);
        },
      };
    },
  };
}

export function createSessionProtectedHandler(handler, options = {}) {
  return createSessionApprovalHandlers({ recordResult: recordOperationResult, ...options }).protect(handler);
}
