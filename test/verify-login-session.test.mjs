import assert from 'node:assert/strict';
import test from 'node:test';
import { createLoginVerifier } from '../src/verify-login.mjs';

const config = {
  judgeIssuer: 'https://aleph-judge-production.up.railway.app/defense/judge',
  publicAppUrl: 'https://vault-test.vercel.app',
  identityProvider: {
    issuer: 'https://vault-test-project.supabase.co/auth/v1',
    audience: 'authenticated',
    jwksUrl: 'https://vault-test-project.supabase.co/auth/v1/.well-known/jwks.json',
  },
};
const userId = '11111111-1111-4111-8111-111111111111';
const sessionId = '22222222-2222-4222-8222-222222222222';
const MISSING = Symbol('missing');
const token = `eyJhbGciOiJub25lIn0.${Buffer.from(JSON.stringify({
  iss: config.identityProvider.issuer,
})).toString('base64url')}.signature`;

function makeVerifier(sessionClaim = sessionId) {
  let verifiedToken;
  const verifier = createLoginVerifier({
    config,
    judgeKeySet: async () => null,
    supabaseClient: {
      auth: {
        async getClaims(value) {
          verifiedToken = value;
          const claims = {
              iss: config.identityProvider.issuer,
              aud: 'authenticated',
              role: 'authenticated',
              sub: userId,
              exp: Math.floor(Date.now() / 1000) + 300,
            };
          if (sessionClaim !== MISSING) claims.session_id = sessionClaim;
          return {
            error: null,
            data: { claims },
          };
        },
      },
    },
  });
  return { verifier, getVerifiedToken: () => verifiedToken };
}

test('student principal returns only the session_id from server-verified Supabase claims', async () => {
  const { verifier, getVerifiedToken } = makeVerifier();

  const principal = await verifier(`Bearer ${token}`);

  assert.equal(getVerifiedToken(), token);
  assert.deepEqual(principal, { kind: 'student', userId, sessionId });
});

test('missing or malformed verified session_id rejects the login principal', async t => {
  for (const value of [MISSING, '', 'not-a-uuid', '33333333-3333-4333-8333-33333333333x']) {
    await t.test(String(value), async () => {
      const { verifier } = makeVerifier(value);
      assert.equal(await verifier(`Bearer ${token}`), null);
    });
  }
});
