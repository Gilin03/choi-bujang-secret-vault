import assert from 'node:assert/strict';
import { createHash, generateKeyPairSync, randomBytes, sign as signData } from 'node:crypto';
import test from 'node:test';
import { createDeviceApiHandler } from '../api/device/[...path].mjs';
import {
  createDeviceApprovalHandlers,
  createDeviceProtectedHandler,
} from '../src/device-approval.mjs';
import {
  verifyAssertionCredential,
  verifyRegistrationCredential,
} from '../src/webauthn.mjs';

const origin = 'https://vault.example.vercel.app';
const rpId = 'vault.example.vercel.app';
const userId = '11111111-1111-4111-8111-111111111111';
const env = { SUPABASE_URL: 'https://project.example', SUPABASE_SECRET_KEY: 'server-test-key' };

function encodeCbor(value) {
  const head = (major, input) => {
    if (input < 24) return Buffer.from([(major << 5) | input]);
    if (input <= 0xff) return Buffer.from([(major << 5) | 24, input]);
    if (input <= 0xffff) {
      const bytes = Buffer.alloc(3);
      bytes[0] = (major << 5) | 25;
      bytes.writeUInt16BE(input, 1);
      return bytes;
    }
    throw new Error('test CBOR value too large');
  };
  if (Buffer.isBuffer(value)) return Buffer.concat([head(2, value.length), value]);
  if (typeof value === 'string') {
    const bytes = Buffer.from(value);
    return Buffer.concat([head(3, bytes.length), bytes]);
  }
  if (typeof value === 'number') {
    return value >= 0 ? head(0, value) : head(1, -1 - value);
  }
  if (value instanceof Map) {
    return Buffer.concat([head(5, value.size), ...[...value].flatMap(([key, item]) => [
      encodeCbor(key), encodeCbor(item),
    ])]);
  }
  throw new Error('unsupported test CBOR value');
}

function base64url(value) {
  return Buffer.from(value).toString('base64url');
}

function clientData(type, challenge, requestOrigin = origin) {
  return Buffer.from(JSON.stringify({ type, challenge, origin: requestOrigin, crossOrigin: false }));
}

function createCredentialFixture() {
  const { publicKey, privateKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const jwk = publicKey.export({ format: 'jwk' });
  const credentialId = randomBytes(32);
  const cose = new Map([
    [1, 2], [3, -7], [-1, 1], [-2, Buffer.from(jwk.x, 'base64url')],
    [-3, Buffer.from(jwk.y, 'base64url')],
  ]);
  const authData = Buffer.concat([
    createHash('sha256').update(rpId).digest(),
    Buffer.from([0x45, 0, 0, 0, 1]),
    Buffer.alloc(16),
    Buffer.from([credentialId.length >> 8, credentialId.length & 0xff]),
    credentialId,
    encodeCbor(cose),
  ]);
  return {
    credentialId: base64url(credentialId),
    publicKey,
    privateKey,
    registration(challenge, requestOrigin = origin) {
      return {
        id: base64url(credentialId), rawId: base64url(credentialId), type: 'public-key',
        response: {
          clientDataJSON: base64url(clientData('webauthn.create', challenge, requestOrigin)),
          attestationObject: base64url(encodeCbor(new Map([
            ['fmt', 'none'], ['authData', authData], ['attStmt', new Map()],
          ]))),
        },
      };
    },
    assertion(challenge, counter = 2, requestOrigin = origin) {
      const assertionData = Buffer.concat([
        createHash('sha256').update(rpId).digest(), Buffer.from([0x05]),
        Buffer.from([counter >>> 24, counter >>> 16, counter >>> 8, counter]),
      ]);
      const data = Buffer.concat([
        assertionData,
        createHash('sha256').update(clientData('webauthn.get', challenge, requestOrigin)).digest(),
      ]);
      return {
        id: base64url(credentialId), rawId: base64url(credentialId), type: 'public-key',
        response: {
          clientDataJSON: base64url(clientData('webauthn.get', challenge, requestOrigin)),
          authenticatorData: base64url(assertionData),
          signature: base64url(signData('sha256', data, privateKey)),
          userHandle: null,
        },
      };
    },
  };
}

function request(path, method = 'GET', body, headers = {}) {
  return new Request(`https://vault.example.vercel.app${path}`, {
    method,
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}

function createDatabase(initial = {}) {
  const tables = {
    vault_registered_devices: [...(initial.vault_registered_devices ?? [])],
    vault_device_challenges: [...(initial.vault_device_challenges ?? [])],
  };
  const createClient = () => ({
    from(table) {
      const filters = [];
      let operation = 'select';
      let payload;
      let single = false;
      const query = {
        select() { if (operation === 'select') operation = 'select'; return query; },
        insert(value) { operation = 'insert'; payload = value; return query; },
        update(value) { operation = 'update'; payload = value; return query; },
        delete() { operation = 'delete'; return query; },
        eq(field, value) { filters.push(row => row[field] === value); return query; },
        lt(field, value) { filters.push(row => row[field] < value); return query; },
        gt(field, value) { filters.push(row => row[field] > value); return query; },
        maybeSingle() { single = true; return query; },
        single() { single = true; return query; },
        then(resolve, reject) {
          try {
            const rows = tables[table];
            if (!rows) throw new Error(`unknown table ${table}`);
            const matches = row => filters.every(filter => filter(row));
            let data;
            if (operation === 'insert') {
              const inserted = Array.isArray(payload) ? payload : [payload];
              rows.push(...inserted.map(row => ({ ...row })));
              data = inserted;
            } else if (operation === 'update') {
              data = rows.filter(matches).map(row => Object.assign(row, payload));
            } else if (operation === 'delete') {
              data = rows.filter(matches);
              tables[table] = rows.filter(row => !matches(row));
            } else {
              data = rows.filter(matches).map(row => ({ ...row }));
            }
            if (single) data = data[0] ?? null;
            return Promise.resolve({ data, error: null }).then(resolve, reject);
          } catch (error) { return Promise.reject(error).then(resolve, reject); }
        },
      };
      return query;
    },
  });
  return { tables, createClient };
}

function makeService(database) {
  const verifyLogin = async token => token === 'Bearer fixture-session'
    ? { kind: 'student', userId }
    : null;
  const config = {
    ...JSON.parse(JSON.stringify({
      publicAppUrl: origin,
      allowedRoutes: [
        'GET /api/my/notes', 'GET /api/notes/:id', 'PUT /api/notes/:id',
        'DELETE /api/notes/:id', 'POST /api/notes/:id/restore',
      ],
    })),
  };
  const options = { env, createClient: database.createClient, verifyLogin, config };
  return {
    api: createDeviceApiHandler(options),
    verifyLogin,
    handlers: createDeviceApprovalHandlers(options),
    protect: inner => createDeviceProtectedHandler(inner, {
      ...options,
    }),
  };
}

test('one catch-all device function dispatches the existing protected API paths', async () => {
  const service = makeService(createDatabase());
  const routes = [
    ['GET', '/api/device/status'],
    ['POST', '/api/device/status/verify'],
    ['POST', '/api/device/register/options'],
    ['POST', '/api/device/register'],
    ['POST', '/api/device/challenge'],
  ];

  for (const [method, path] of routes) {
    const response = await service.api.fetch(request(path, method));
    assert.equal(response.status, 401, `${method} ${path} must reach the device handler`);
  }

  const unknown = await service.api.fetch(request('/api/device/unknown', 'GET'));
  assert.equal(unknown.status, 404);
});

test('registration creates a pending server record and status never treats it as approved', async () => {
  const database = createDatabase();
  const service = makeService(database);
  const start = await service.handlers.registerOptions.fetch(request(
    '/api/device/register/options', 'POST', {}, { Authorization: 'Bearer fixture-session' }));
  assert.equal(start.status, 200);
  const options = await start.json();
  const credential = createCredentialFixture();
  const enrolled = await service.handlers.register.fetch(request(
    '/api/device/register', 'POST', { credential: credential.registration(options.challenge) },
    { Authorization: 'Bearer fixture-session' }));
  assert.equal(enrolled.status, 202);
  assert.equal((await enrolled.json()).status, 'pending');
  assert.equal(database.tables.vault_registered_devices[0].status, 'pending');

  const status = await service.handlers.status.fetch(request(
    '/api/device/status', 'GET', undefined, { Authorization: 'Bearer fixture-session' }));
  assert.equal((await status.json()).status, 'pending');
});

test('protected material stays denied without an approved device assertion', async () => {
  const database = createDatabase();
  const service = makeService(database);
  let opened = 0;
  const protectedHandler = service.protect({ fetch: async () => { opened += 1; return Response.json({ notes: [] }); } });

  const response = await protectedHandler.fetch(request(
    '/api/my/notes', 'GET', undefined, { Authorization: 'Bearer fixture-session' }));

  assert.equal(response.status, 403);
  assert.equal(opened, 0);
});

test('status unlocks only after an approved authenticator signs the server challenge', async () => {
  const credential = createCredentialFixture();
  const database = createDatabase({ vault_registered_devices: [{
    id: 'device-row', owner_id: userId, credential_id: credential.credentialId,
    credential_public_key: credential.publicKey.export({ format: 'jwk' }),
    sign_count: 1, status: 'approved',
  }] });
  const service = makeService(database);
  const statusResponse = await service.handlers.status.fetch(request(
    '/api/device/status', 'GET', undefined, { Authorization: 'Bearer fixture-session' }));
  const status = await statusResponse.json();
  assert.equal(status.status, 'verification_required');

  const denied = await service.handlers.verifyStatus.fetch(request(
    '/api/device/status/verify', 'POST', {
      challenge: status.challenge,
      credential: credential.assertion(status.challenge),
    }, { Authorization: 'Bearer fixture-session' }));

  assert.equal(denied.status, 200);
  assert.equal((await denied.json()).status, 'approved');
  assert.equal(database.tables.vault_registered_devices[0].sign_count, 2);
});

test('approved assertion opens a protected request once and rejects replay', async () => {
  const credential = createCredentialFixture();
  const database = createDatabase({ vault_registered_devices: [{
    id: 'device-row', owner_id: userId, credential_id: credential.credentialId,
    credential_public_key: credential.publicKey.export({ format: 'jwk' }),
    sign_count: 1, status: 'approved',
  }] });
  const service = makeService(database);
  const challengeResponse = await service.handlers.challenge.fetch(request(
    '/api/device/challenge', 'POST', { method: 'GET', path: '/api/my/notes' },
    { Authorization: 'Bearer fixture-session' }));
  assert.equal(challengeResponse.status, 200);
  const { challenge } = await challengeResponse.json();
  const assertion = credential.assertion(challenge);
  const headers = {
    Authorization: 'Bearer fixture-session',
    'X-Aleph-Device-Assertion': JSON.stringify(assertion),
  };
  let opened = 0;
  const protectedHandler = service.protect({ fetch: async () => {
    opened += 1;
    return Response.json({ notes: ['fixture'] });
  } });

  const response = await protectedHandler.fetch(request('/api/my/notes', 'GET', undefined, headers));
  const replay = await protectedHandler.fetch(request('/api/my/notes', 'GET', undefined, headers));

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), { notes: ['fixture'] });
  assert.equal(replay.status, 403);
  assert.equal(opened, 1);
});

test('a signed dynamic route is bound to the Vercel route ID that the API will read', async () => {
  const noteId = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const credential = createCredentialFixture();
  const database = createDatabase({ vault_registered_devices: [{
    id: 'device-row', owner_id: userId, credential_id: credential.credentialId,
    credential_public_key: credential.publicKey.export({ format: 'jwk' }),
    sign_count: 1, status: 'approved',
  }] });
  const service = makeService(database);
  const challengeResponse = await service.handlers.challenge.fetch(request(
    '/api/device/challenge', 'POST', { method: 'GET', path: `/api/notes/${noteId}` },
    { Authorization: 'Bearer fixture-session' }));
  const { challenge } = await challengeResponse.json();
  const signedHeaders = {
    Authorization: 'Bearer fixture-session',
    'X-Aleph-Device-Assertion': JSON.stringify(credential.assertion(challenge)),
  };
  const vercelRequest = request('/_vercel/functions/api/notes/[id].mjs', 'GET', undefined, signedHeaders);
  Object.defineProperty(vercelRequest, 'query', { value: { id: noteId } });
  let opened = 0;
  const protectedHandler = service.protect({ fetch: async () => {
    opened += 1;
    return Response.json({ id: noteId });
  } });

  const response = await protectedHandler.fetch(vercelRequest);
  assert.equal(response.status, 200);
  assert.equal(opened, 1);

  const anotherId = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const other = request(`/_vercel/functions/api/notes/[id].mjs`, 'GET', undefined, signedHeaders);
  Object.defineProperty(other, 'query', { value: { id: anotherId } });
  const denied = await protectedHandler.fetch(other);
  assert.equal(denied.status, 403);
  assert.equal(opened, 1);
});

test('registration and assertion verification reject a wrong origin and an invalid signature', async () => {
  const credential = createCredentialFixture();
  const challenge = randomBytes(32).toString('base64url');
  const registered = await verifyRegistrationCredential({
    credential: credential.registration(challenge), challenge, origin, rpId,
  });
  assert.equal(registered.credentialId, credential.credentialId);

  assert.throws(() => verifyRegistrationCredential({
    credential: credential.registration(challenge, 'https://attacker.example'),
    challenge, origin, rpId,
  }), /origin/u);
  const assertion = credential.assertion(challenge);
  assertion.response.signature = base64url(randomBytes(64));
  assert.throws(() => verifyAssertionCredential({
    credential: assertion, challenge, origin, rpId,
    publicKey: credential.publicKey.export({ format: 'jwk' }), previousCounter: 1,
  }), /signature/u);
});
