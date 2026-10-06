import assert from 'node:assert/strict';
import test from 'node:test';
import { createSupabaseAuthProxy, createVercelAuthProxyAdapter } from '../src/auth-proxy.mjs';
import { createAuthProxyFetch } from '../public/auth-proxy-client.js';

const env = {
  SUPABASE_URL: 'https://vault-project.example.supabase.co',
  SUPABASE_PUBLISHABLE_KEY: 'server-publishable-fixture',
};

test('password-token requests use the server key and preserve Supabase Auth errors', async () => {
  let forwarded;
  const proxy = createSupabaseAuthProxy({
    env,
    fetchImpl: async request => {
      forwarded = request;
      return new Response('{"msg":"invalid login credentials"}', {
        status: 400,
        headers: { 'content-type': 'application/json' },
      });
    },
  });

  const response = await proxy(new Request(
    'https://vault.example/api/auth-proxy/token?grant_type=password',
    {
      method: 'POST',
      headers: {
        authorization: 'Bearer browser-placeholder',
        apikey: 'browser-placeholder',
        'content-type': 'application/json',
      },
      body: '{"email":"student@example.test"}',
    },
  ));

  assert.equal(response.status, 400);
  assert.deepEqual(await response.json(), { msg: 'invalid login credentials' });
  assert.equal(forwarded.url, 'https://vault-project.example.supabase.co/auth/v1/token?grant_type=password');
  assert.equal(forwarded.headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(forwarded.headers.get('authorization'), `Bearer ${env.SUPABASE_PUBLISHABLE_KEY}`);
  assert.equal(await forwarded.text(), '{"email":"student@example.test"}');
});

test('user and logout requests forward the caller session for Supabase to validate', async () => {
  const calls = [];
  const proxy = createSupabaseAuthProxy({
    env,
    fetchImpl: async request => {
      calls.push(request);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
  });
  const sessionHeader = 'Bearer synthetic-session-fixture';

  const userResponse = await proxy(new Request('https://vault.example/api/auth-proxy/user', {
    headers: { authorization: sessionHeader },
  }));
  const logoutResponse = await proxy(new Request('https://vault.example/api/auth-proxy/logout?scope=global', {
    method: 'POST',
    headers: { authorization: sessionHeader },
  }));

  assert.equal(userResponse.status, 200);
  assert.equal(logoutResponse.status, 200);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].headers.get('authorization'), sessionHeader);
  assert.equal(calls[0].headers.get('apikey'), env.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(calls[1].url, 'https://vault-project.example.supabase.co/auth/v1/logout?scope=global');
  assert.equal(calls[1].headers.get('authorization'), sessionHeader);
});

test('unlisted Auth paths, methods, and token grants are rejected before upstream access', async () => {
  let upstreamCalls = 0;
  const proxy = createSupabaseAuthProxy({ env, fetchImpl: async () => { upstreamCalls += 1; } });

  const responses = await Promise.all([
    proxy(new Request('https://vault.example/api/auth-proxy/admin/users')),
    proxy(new Request('https://vault.example/api/auth-proxy/token?grant_type=password')),
    proxy(new Request('https://vault.example/api/auth-proxy/token?grant_type=admin', { method: 'POST' })),
    proxy(new Request('https://vault.example/api/auth-proxy/logout?scope=invalid', { method: 'POST' })),
  ]);

  assert.deepEqual(responses.map(response => response.status), [404, 405, 400, 400]);
  assert.equal(upstreamCalls, 0);
});

test('user and logout endpoints reject requests without a bearer session', async () => {
  let upstreamCalls = 0;
  const proxy = createSupabaseAuthProxy({ env, fetchImpl: async () => { upstreamCalls += 1; } });

  const userResponse = await proxy(new Request('https://vault.example/api/auth-proxy/user'));
  const logoutResponse = await proxy(new Request('https://vault.example/api/auth-proxy/logout', { method: 'POST' }));

  assert.deepEqual([userResponse.status, logoutResponse.status], [401, 401]);
  assert.equal(upstreamCalls, 0);
});

test('the Vercel adapter preserves parsed JSON bodies and Auth response status', async () => {
  let forwarded;
  const handler = createVercelAuthProxyAdapter({
    env,
    fetchImpl: async request => {
      forwarded = request;
      return new Response('{"message":"accepted"}', {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    },
  });
  const output = { headers: {}, statusCode: 0, body: null,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body.toString(); } };

  await handler({
    url: '/api/auth-proxy/token?grant_type=password',
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: { email: 'student@example.test' },
  }, output);

  assert.equal(output.statusCode, 200);
  assert.equal(output.headers['cache-control'], 'no-store');
  assert.equal(output.headers['x-content-type-options'], 'nosniff');
  assert.equal(output.body, '{"message":"accepted"}');
  assert.equal(await forwarded.text(), '{"email":"student@example.test"}');
});

test('the Vercel adapter removes its dynamic route parameter before Auth query validation', async () => {
  let upstreamCalls = 0;
  const handler = createVercelAuthProxyAdapter({
    endpoint: 'user',
    env,
    fetchImpl: async () => { upstreamCalls += 1; },
  });
  const output = { headers: {}, statusCode: 0,
    setHeader(name, value) { this.headers[name.toLowerCase()] = value; },
    end(body) { this.body = body.toString(); } };

  await handler({
    url: '/api/auth-proxy/user?endpoint=user',
    method: 'GET',
    query: { endpoint: 'user' },
    headers: {},
  }, output);

  assert.equal(output.statusCode, 401);
  assert.deepEqual(JSON.parse(output.body), { error: 'Authentication required' });
  assert.equal(upstreamCalls, 0);
});

test('the browser fetch sends only Auth calls through the same-origin proxy', async () => {
  const calls = [];
  const fetchImpl = async request => {
    calls.push(request);
    return new Response('{}', { status: 200 });
  };
  const proxiedFetch = createAuthProxyFetch({
    supabaseUrl: 'https://vault-project.example.supabase.co',
    appOrigin: 'https://vault.example',
    fetchImpl,
  });

  await proxiedFetch('https://vault-project.example.supabase.co/auth/v1/token?grant_type=password', {
    method: 'POST',
    headers: { apikey: 'browser-placeholder', authorization: 'Bearer browser-placeholder' },
    body: '{"email":"student@example.test"}',
  });
  await assert.rejects(
    proxiedFetch('https://vault-project.example.supabase.co/rest/v1/vault_notes'),
    /Only Supabase Auth requests/,
  );

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://vault.example/api/auth-proxy/token?grant_type=password');
  assert.equal(calls[0].headers.has('apikey'), false);
  assert.equal(calls[0].headers.get('authorization'), 'Bearer browser-placeholder');
  assert.equal(await calls[0].text(), '{"email":"student@example.test"}');
});
