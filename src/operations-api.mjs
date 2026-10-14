import { createHash } from 'node:crypto';
import config from '../aleph.config.json' with { type: 'json' };
import snapshot from '../policies/stage9-safe-policy.json' with { type: 'json' };
import { RULE_IDS } from './decider.mjs';
import { createLoginVerifier } from './verify-login.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const LOG_COLUMNS = 'request_id,checked_at,method,route,status,commit_sha';
let verifier;
const json = (data, status = 200) => Response.json(data, { status, headers: { 'Cache-Control': 'no-store' } });
const notConnected = () => ({ status: 'unexecuted', source: 'engine_not_connected', count: null });

export function createOperationsHandler({ env = process.env, verifyLogin, createClient } = {}) {
  return {
    async fetch(request) {
      if (request.method !== 'GET') return json({ error: 'Method not allowed' }, 405);
      if (new URL(request.url).search) return json({ error: 'Resource not found' }, 404);
      if (!env.SUPABASE_URL || !env.SUPABASE_SECRET_KEY) return json({ error: 'Service unavailable' }, 503);
      let principal;
      try {
        verifier ??= createLoginVerifier({ config, supabaseSecretKey: env.SUPABASE_SECRET_KEY });
        principal = await (verifyLogin ?? verifier)(request.headers.get('authorization'));
      } catch { return json({ error: 'Authentication required' }, 401); }
      if (principal?.kind !== 'student' || !UUID.test(principal.userId ?? '')) return json({ error: 'Authentication required' }, 401);
      if (!UUID.test(principal.sessionId ?? '')) return json({ error: 'Verified login session required' }, 403);
      try {
        let factory = createClient;
        if (!factory) ({ createClient: factory } = await import('@supabase/supabase-js'));
        const client = factory(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
          auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
        });
        const [logs, backups] = await Promise.all([
          client.from('vault_operation_events').select(LOG_COLUMNS).eq('owner_id', principal.userId)
            .order('checked_at', { ascending: false }).limit(100),
          client.from('vault_note_backups').select('note_id,content_sha256,captured_at').eq('owner_id', principal.userId)
            .order('captured_at', { ascending: false }).limit(100),
        ]);
        if (logs.error || backups.error || !Array.isArray(logs.data) || !Array.isArray(backups.data)) throw new Error('evidence_unavailable');
        // Explicit projection remains mandatory even with server-side DB selection.
        const records = logs.data.map(row => ({
          requestId: row.request_id, checkedAt: row.checked_at, method: row.method,
          route: row.route, status: row.status, commit: row.commit_sha,
        }));
        const summary = {
          total: records.length,
          allowed: records.filter(row => row.status >= 200 && row.status < 300).length,
          rejected: records.filter(row => row.status >= 400 && row.status < 500).length,
          errors: records.filter(row => row.status >= 500).length,
        };
        return json({
          schema: 'byteback.operations.v1', checkedAt: new Date().toISOString(),
          commit: /^[a-f0-9]{40}$/iu.test(env.VERCEL_GIT_COMMIT_SHA ?? '') ? env.VERCEL_GIT_COMMIT_SHA.toLowerCase() : null,
          rules: [...RULE_IDS],
          api: { source: 'server_database', scope: 'own_latest_100', summary, records },
          engine: { source: 'ALEPH SDP 엔진 (제공)', decisions: notConnected(), detection: notConnected(), revocation: notConnected() },
          recovery: {
            policyVersion: snapshot.policyVersion, policyRevision: snapshot.policyRevision,
            policyRestoreStatus: 'unexecuted', scope: 'own_latest_100',
            executedRestores: records.filter(row => row.route === '/api/notes/:id/restore' && row.status >= 200 && row.status < 300).length,
            backups: backups.data.map(row => ({
              reference: createHash('sha256').update(row.note_id).digest('hex').slice(0, 12),
              capturedAt: row.captured_at, fingerprint: row.content_sha256,
            })),
          },
          finalAssault: { total: 41, executed: 0, unexecuted: 41, passed: null, source: 'not_connected' },
        });
      } catch { return json({ error: 'Operations evidence unavailable' }, 503); }
    },
  };
}
