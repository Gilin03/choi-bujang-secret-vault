import { createHash, randomBytes } from 'node:crypto';
import config from '../aleph.config.json' with { type: 'json' };
import {
  challengeFromCredential,
  verifyAssertionCredential,
  verifyRegistrationCredential,
} from './webauthn.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;
const ASSERTION_HEADER = 'x-aleph-device-assertion';
const DEVICE_TABLE = 'vault_registered_devices';
const CHALLENGE_TABLE = 'vault_device_challenges';
const CHALLENGE_TTL_MS = 5 * 60 * 1000;
let defaultVerifier;

function json(payload, status = 200) {
  return Response.json(payload, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
  });
}

function serviceReady(env) {
  return typeof env.SUPABASE_URL === 'string' && env.SUPABASE_URL.length > 0
    && typeof env.SUPABASE_SECRET_KEY === 'string' && env.SUPABASE_SECRET_KEY.length > 0;
}

function relyingParty(configValue) {
  try {
    const app = new URL(configValue?.publicAppUrl);
    if (app.protocol !== 'https:' || app.username || app.password || app.search || app.hash
        || app.pathname !== '/' || !app.hostname.endsWith('.vercel.app')) return null;
    return { origin: app.origin, rpId: app.hostname };
  } catch { return null; }
}

function requestPath(request) {
  const url = new URL(request.url);
  let path = url.pathname;
  let id = request.query?.id;
  try { path = decodeURIComponent(path); } catch { return null; }
  if (typeof id !== 'string' || !UUID.test(id)) id = null;

  if (path.includes('/_vercel/functions/api/notes/[id]/restore.mjs')) {
    return id ? `/api/notes/${id}/restore` : null;
  }
  if (path.includes('/_vercel/functions/api/notes/[id].mjs')) {
    return id ? `/api/notes/${id}` : null;
  }
  if (path.includes('/_vercel/functions/api/announcements/[id].mjs')) {
    return id ? `/api/announcements/${id}` : null;
  }
  const note = /^\/api\/notes\/([0-9a-f-]{36})(\/restore)?$/iu.exec(path);
  if (note && id) return `/api/notes/${id}${note[2] ?? ''}`;
  const announcement = /^\/api\/announcements\/([0-9a-f-]{36})$/iu.exec(path);
  if (announcement && id) return `/api/announcements/${id}`;
  return path;
}

function routeName(method, path) {
  if (/^\/api\/notes\/[0-9a-f-]{36}\/restore$/iu.test(path)) return `${method} /api/notes/:id/restore`;
  if (/^\/api\/notes\/[0-9a-f-]{36}$/iu.test(path)) return `${method} /api/notes/:id`;
  if (/^\/api\/announcements\/[0-9a-f-]{36}$/iu.test(path)) return `${method} /api/announcements/:id`;
  return `${method} ${path}`;
}

function parseJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function challengeHash(challenge) {
  if (typeof challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(challenge)) return null;
  return createHash('sha256').update(challenge, 'utf8').digest('hex');
}

function credentialPayload(credential) {
  if (!credential || typeof credential !== 'object' || Array.isArray(credential)
      || typeof credential.id !== 'string' || typeof credential.rawId !== 'string'
      || credential.id !== credential.rawId || credential.type !== 'public-key'
      || !credential.response || typeof credential.response !== 'object'
      || Array.isArray(credential.response)) return null;
  return credential;
}

async function readBody(request) {
  try {
    const text = await request.text();
    if (text.length > 24_000) return null;
    return parseJson(text);
  } catch { return null; }
}

function browserCredentialIds(rows) {
  return rows.filter(row => typeof row.credential_id === 'string'
    && /^[A-Za-z0-9_-]+$/u.test(row.credential_id)).map(row => ({
    type: 'public-key',
    id: row.credential_id,
    transports: ['internal'],
  }));
}

function makeOptions(challenge, rpId, credentials = []) {
  return {
    challenge,
    rpId,
    timeout: 60_000,
    userVerification: 'required',
    ...(credentials.length ? { allowCredentials: browserCredentialIds(credentials) } : {}),
  };
}

function makeRegistrationOptions(challenge, rpId, userId, existing) {
  return {
    challenge,
    rp: { name: 'BYTE BACK 자료실', id: rpId },
    user: {
      id: Buffer.from(userId.replaceAll('-', ''), 'hex').toString('base64url'),
      name: userId,
      displayName: '자료실 계정',
    },
    pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
    timeout: 60_000,
    attestation: 'none',
    authenticatorSelection: {
      authenticatorAttachment: 'platform',
      residentKey: 'preferred',
      userVerification: 'required',
    },
    excludeCredentials: browserCredentialIds(existing),
  };
}

function databaseFactory(env, injectedFactory) {
  if (injectedFactory) return injectedFactory;
  return async () => {
    const { createClient } = await import('@supabase/supabase-js');
    return createClient(env.SUPABASE_URL, env.SUPABASE_SECRET_KEY, {
      auth: { persistSession: false, autoRefreshToken: false, detectSessionInUrl: false },
    });
  };
}

function makeAuthenticator({ env, verifyLogin: injectedVerifier, appConfig }) {
  return async request => {
    if (!serviceReady(env)) return { error: json({ error: 'Service unavailable' }, 503) };
    try {
      let verifyLogin = injectedVerifier;
      if (!verifyLogin) {
        if (!defaultVerifier) {
          const { createLoginVerifier } = await import('./verify-login.mjs');
          defaultVerifier = createLoginVerifier({
            config: appConfig,
            supabaseSecretKey: env.SUPABASE_SECRET_KEY,
          });
        }
        verifyLogin = defaultVerifier;
      }
      const principal = await verifyLogin(request.headers.get('authorization'));
      if (principal?.kind !== 'student' || !UUID.test(principal.userId ?? '')) {
        return { error: json({ error: 'Authentication required' }, 401) };
      }
      return { userId: principal.userId };
    } catch {
      return { error: json({ error: 'Authentication required' }, 401) };
    }
  };
}

function makeService({ env = process.env, createClient, verifyLogin, config: appConfig = config } = {}) {
  const party = relyingParty(appConfig);
  const getClient = databaseFactory(env, createClient);
  const authenticate = makeAuthenticator({ env, verifyLogin, appConfig });

  async function newChallenge(client, userId, { kind, method, path }) {
    const challenge = randomBytes(32).toString('base64url');
    const now = Date.now();
    await client.from(CHALLENGE_TABLE).delete().eq('owner_id', userId)
      .lt('expires_at', new Date(now).toISOString());
    const { error } = await client.from(CHALLENGE_TABLE).insert({
      owner_id: userId,
      challenge_hash: challengeHash(challenge),
      kind,
      method,
      path,
      expires_at: new Date(now + CHALLENGE_TTL_MS).toISOString(),
    });
    if (error) throw new Error('device_challenge_unavailable');
    return challenge;
  }

  async function consumeChallenge(client, userId, challenge, binding) {
    const hash = challengeHash(challenge);
    if (!hash) return false;
    const { data, error } = await client.from(CHALLENGE_TABLE).delete()
      .eq('owner_id', userId).eq('challenge_hash', hash).eq('kind', binding.kind)
      .eq('method', binding.method).eq('path', binding.path)
      .gt('expires_at', new Date().toISOString()).select('owner_id').maybeSingle();
    return !error && data?.owner_id === userId;
  }

  async function registeredDevices(client, userId, status) {
    let query = client.from(DEVICE_TABLE).select(
      'id,owner_id,credential_id,credential_public_key,sign_count,status',
    ).eq('owner_id', userId);
    if (status) query = query.eq('status', status);
    const { data, error } = await query;
    if (error || !Array.isArray(data)) throw new Error('device_registry_unavailable');
    return data;
  }

  async function verifyDeviceProof(client, userId, credential, challenge, binding) {
    const assertion = credentialPayload(credential);
    if (!assertion || !party) return false;
    const { data: device, error } = await client.from(DEVICE_TABLE)
      .select('id,owner_id,credential_id,credential_public_key,sign_count,status')
      .eq('owner_id', userId).eq('credential_id', assertion.rawId).eq('status', 'approved')
      .maybeSingle();
    if (error || !device || device.credential_id !== assertion.rawId) return false;
    let result;
    try {
      result = verifyAssertionCredential({
        credential: assertion,
        challenge,
        origin: party.origin,
        rpId: party.rpId,
        publicKey: device.credential_public_key,
        previousCounter: Number(device.sign_count) || 0,
      });
    } catch { return false; }
    if (!await consumeChallenge(client, userId, challenge, binding)) return false;
    const nextCounter = Math.max(Number(device.sign_count) || 0, result.signCount);
    const { data: updated, error: updateError } = await client.from(DEVICE_TABLE)
      .update({ sign_count: nextCounter, last_used_at: new Date().toISOString() })
      .eq('id', device.id).eq('owner_id', userId).eq('status', 'approved')
      .eq('sign_count', Number(device.sign_count) || 0).select('id').maybeSingle();
    return !updateError && updated?.id === device.id;
  }

  async function issueStatus(request) {
    const auth = await authenticate(request);
    if (auth.error) return auth.error;
    if (!party) return json({ error: 'Service unavailable' }, 503);
    try {
      const client = await getClient();
      const devices = await registeredDevices(client, auth.userId);
      const approved = devices.filter(device => device.status === 'approved');
      const pending = devices.some(device => device.status === 'pending');
      if (!approved.length) return json({ status: pending ? 'pending' : 'not_registered' });
      const challenge = await newChallenge(client, auth.userId, {
        kind: 'status', method: 'POST', path: '/api/device/status/verify',
      });
      return json({
        status: 'verification_required',
        challenge,
        publicKey: makeOptions(challenge, party.rpId, approved),
      });
    } catch {
      return json({ error: 'Unable to check device approval' }, 503);
    }
  }

  async function verifyStatus(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const auth = await authenticate(request);
    if (auth.error) return auth.error;
    const body = await readBody(request);
    const credential = credentialPayload(body?.credential);
    if (!credential || typeof body?.challenge !== 'string') {
      return json({ error: 'Device approval could not be verified' }, 403);
    }
    try {
      const client = await getClient();
      const verified = await verifyDeviceProof(client, auth.userId, credential, body.challenge, {
        kind: 'status', method: 'POST', path: '/api/device/status/verify',
      });
      return verified
        ? json({ status: 'approved' })
        : json({ error: 'Device approval could not be verified' }, 403);
    } catch {
      return json({ error: 'Unable to verify device approval' }, 503);
    }
  }

  async function beginRegistration(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const auth = await authenticate(request);
    if (auth.error) return auth.error;
    if (!party) return json({ error: 'Service unavailable' }, 503);
    try {
      const client = await getClient();
      const existing = await registeredDevices(client, auth.userId);
      const challenge = await newChallenge(client, auth.userId, {
        kind: 'registration', method: 'POST', path: '/api/device/register',
      });
      return json({
        challenge,
        publicKey: makeRegistrationOptions(challenge, party.rpId, auth.userId, existing),
      });
    } catch {
      return json({ error: 'Unable to start device approval request' }, 503);
    }
  }

  async function register(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const auth = await authenticate(request);
    if (auth.error) return auth.error;
    if (!party) return json({ error: 'Service unavailable' }, 503);
    const body = await readBody(request);
    const credential = credentialPayload(body?.credential);
    if (!credential) return json({ error: 'Invalid device approval request' }, 400);
    let result;
    try {
      result = verifyRegistrationCredential({
        credential,
        challenge: challengeFromCredential(credential),
        origin: party.origin,
        rpId: party.rpId,
      });
    } catch {
      return json({ error: 'Device registration could not be verified' }, 403);
    }
    try {
      const client = await getClient();
      const challenge = challengeFromCredential(credential);
      const consumed = await consumeChallenge(client, auth.userId, challenge, {
        kind: 'registration', method: 'POST', path: '/api/device/register',
      });
      if (!consumed) return json({ error: 'Device registration challenge expired' }, 403);
      const duplicate = await client.from(DEVICE_TABLE).select('id')
        .eq('credential_id', result.credentialId).maybeSingle();
      if (duplicate.error) return json({ error: 'Unable to save device request' }, 503);
      if (duplicate.data) return json({ error: 'This authenticator was already registered' }, 409);
      const { error } = await client.from(DEVICE_TABLE).insert({
        owner_id: auth.userId,
        credential_id: result.credentialId,
        credential_public_key: result.publicKey,
        sign_count: result.signCount,
        status: 'pending',
      });
      if (error) return json({ error: 'Unable to save device request' }, 503);
      return json({ status: 'pending' }, 202);
    } catch {
      return json({ error: 'Unable to save device request' }, 503);
    }
  }

  async function issueRequestChallenge(request) {
    if (request.method !== 'POST') return json({ error: 'Method not allowed' }, 405);
    const auth = await authenticate(request);
    if (auth.error) return auth.error;
    if (!party) return json({ error: 'Service unavailable' }, 503);
    const body = await readBody(request);
    const method = typeof body?.method === 'string' ? body.method.toUpperCase() : '';
    const path = typeof body?.path === 'string' ? body.path : '';
    const route = routeName(method, path);
    if (!['GET', 'POST', 'PUT', 'DELETE'].includes(method)
        || !Array.isArray(appConfig.allowedRoutes) || !appConfig.allowedRoutes.includes(route)) {
      return json({ error: 'Protected route not allowed' }, 403);
    }
    try {
      const client = await getClient();
      const approved = await registeredDevices(client, auth.userId, 'approved');
      if (!approved.length) return json({ error: 'Device approval required', status: 'pending' }, 403);
      const challenge = await newChallenge(client, auth.userId, { kind: 'request', method, path });
      return json({ challenge, publicKey: makeOptions(challenge, party.rpId, approved) });
    } catch {
      return json({ error: 'Unable to verify device approval' }, 503);
    }
  }

  return {
    authenticate,
    issueStatus,
    verifyStatus,
    beginRegistration,
    register,
    issueRequestChallenge,
    verifyDeviceProof,
    getClient,
    config: appConfig,
  };
}

export function createDeviceApprovalHandlers(options = {}) {
  const service = makeService(options);
  const makeHandler = callback => ({ fetch: callback });
  return {
    status: makeHandler(service.issueStatus),
    verifyStatus: makeHandler(service.verifyStatus),
    registerOptions: makeHandler(service.beginRegistration),
    register: makeHandler(service.register),
    challenge: makeHandler(service.issueRequestChallenge),
  };
}

export function createDeviceProtectedHandler(handler, options = {}) {
  const service = makeService(options);
  return {
    async fetch(request, ...args) {
      const auth = await service.authenticate(request);
      if (auth.error) return auth.error;
      const path = requestPath(request);
      if (!path) return json({ error: 'Device approval could not be verified' }, 403);
      const route = routeName(request.method.toUpperCase(), path);
      if (!Array.isArray(service.config.allowedRoutes)
          || !service.config.allowedRoutes.includes(route)) {
        return json({ error: 'Device approval could not be verified' }, 403);
      }
      const rawAssertion = request.headers.get(ASSERTION_HEADER);
      if (typeof rawAssertion !== 'string' || rawAssertion.length > 20_000) {
        return json({ error: 'Device approval required' }, 403);
      }
      const credential = credentialPayload(parseJson(rawAssertion));
      if (!credential) return json({ error: 'Device approval required' }, 403);
      let challenge;
      try { challenge = challengeFromCredential(credential); } catch {
        return json({ error: 'Device approval could not be verified' }, 403);
      }
      try {
        const client = await service.getClient();
        const verified = await service.verifyDeviceProof(client, auth.userId, credential,
          challenge, { kind: 'request', method: request.method.toUpperCase(), path });
        if (!verified) return json({ error: 'Device approval could not be verified' }, 403);
      } catch {
        return json({ error: 'Unable to verify device approval' }, 503);
      }
      return handler.fetch(request, ...args);
    },
  };
}
