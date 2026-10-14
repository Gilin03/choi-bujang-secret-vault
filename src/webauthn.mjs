import { createHash, createPublicKey, verify as verifySignature } from 'node:crypto';

const BASE64URL = /^[A-Za-z0-9_-]+$/u;
const MAX_CREDENTIAL_BYTES = 16_384;

function decodeBase64url(value, label, maxBytes = MAX_CREDENTIAL_BYTES) {
  if (typeof value !== 'string' || !BASE64URL.test(value) || value.length > maxBytes * 2) {
    throw new TypeError(`invalid_webauthn_${label}`);
  }
  const bytes = Buffer.from(value, 'base64url');
  if (!bytes.length || bytes.length > maxBytes || bytes.toString('base64url') !== value) {
    throw new TypeError(`invalid_webauthn_${label}`);
  }
  return bytes;
}

function readCbor(bytes, start = 0, depth = 0) {
  if (depth > 16 || start >= bytes.length) throw new TypeError('invalid_webauthn_cbor');
  const initial = bytes[start];
  const major = initial >> 5;
  const additional = initial & 0x1f;
  let offset = start + 1;
  let length;
  if (additional < 24) length = additional;
  else if (additional === 24 && offset + 1 <= bytes.length) length = bytes[offset++];
  else if (additional === 25 && offset + 2 <= bytes.length) {
    length = bytes.readUInt16BE(offset); offset += 2;
  } else if (additional === 26 && offset + 4 <= bytes.length) {
    length = bytes.readUInt32BE(offset); offset += 4;
  } else {
    throw new TypeError('invalid_webauthn_cbor_length');
  }
  if (!Number.isSafeInteger(length) || length > MAX_CREDENTIAL_BYTES) {
    throw new TypeError('invalid_webauthn_cbor_length');
  }
  if (major === 0) return { value: length, offset };
  if (major === 1) return { value: -1 - length, offset };
  if (major === 2 || major === 3) {
    const end = offset + length;
    if (end > bytes.length) throw new TypeError('invalid_webauthn_cbor_length');
    const value = bytes.subarray(offset, end);
    return { value: major === 2 ? value : value.toString('utf8'), offset: end };
  }
  if (major === 4) {
    const values = [];
    for (let index = 0; index < length; index += 1) {
      const child = readCbor(bytes, offset, depth + 1);
      values.push(child.value);
      offset = child.offset;
    }
    return { value: values, offset };
  }
  if (major === 5) {
    const values = new Map();
    for (let index = 0; index < length; index += 1) {
      const key = readCbor(bytes, offset, depth + 1);
      const value = readCbor(bytes, key.offset, depth + 1);
      values.set(key.value, value.value);
      offset = value.offset;
    }
    return { value: values, offset };
  }
  if (major === 7 && additional === 20) return { value: false, offset };
  if (major === 7 && additional === 21) return { value: true, offset };
  if (major === 7 && additional === 22) return { value: null, offset };
  throw new TypeError('invalid_webauthn_cbor_type');
}

function requireClientData(credential, { challenge, origin, ceremony }) {
  if (!credential || credential.type !== 'public-key' || credential.id !== credential.rawId
      || !credential.response || typeof credential.response !== 'object') {
    throw new TypeError('invalid_webauthn_credential');
  }
  const clientDataJSON = decodeBase64url(credential.response.clientDataJSON, 'client_data', 4096);
  let clientData;
  try { clientData = JSON.parse(clientDataJSON.toString('utf8')); } catch {
    throw new TypeError('invalid_webauthn_client_data');
  }
  if (!clientData || clientData.type !== `webauthn.${ceremony}`
      || clientData.challenge !== challenge || clientData.origin !== origin
      || clientData.crossOrigin === true) {
    throw new TypeError('invalid_webauthn_origin_or_challenge');
  }
  return clientDataJSON;
}

export function challengeFromCredential(credential) {
  if (!credential || !credential.response || typeof credential.response !== 'object') {
    throw new TypeError('invalid_webauthn_credential');
  }
  const clientDataJSON = decodeBase64url(credential.response.clientDataJSON, 'client_data', 4096);
  let clientData;
  try { clientData = JSON.parse(clientDataJSON.toString('utf8')); } catch {
    throw new TypeError('invalid_webauthn_client_data');
  }
  if (typeof clientData?.challenge !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(clientData.challenge)) {
    throw new TypeError('invalid_webauthn_challenge');
  }
  return clientData.challenge;
}

function verifyRpIdHash(authenticatorData, rpId) {
  if (authenticatorData.length < 37) throw new TypeError('invalid_webauthn_authenticator_data');
  const expected = createHash('sha256').update(rpId, 'utf8').digest();
  if (!authenticatorData.subarray(0, 32).equals(expected)) {
    throw new TypeError('invalid_webauthn_rp_id');
  }
  const flags = authenticatorData[32];
  if ((flags & 0x05) !== 0x05) throw new TypeError('webauthn_user_verification_required');
  return flags;
}

export function verifyRegistrationCredential({ credential, challenge, origin, rpId }) {
  requireClientData(credential, { challenge, origin, ceremony: 'create' });
  const rawId = decodeBase64url(credential.rawId, 'credential_id', 1024);
  const attestationBytes = decodeBase64url(credential.response.attestationObject, 'attestation', 8192);
  const decoded = readCbor(attestationBytes);
  if (decoded.offset !== attestationBytes.length || !(decoded.value instanceof Map)
      || decoded.value.get('fmt') !== 'none'
      || !(decoded.value.get('attStmt') instanceof Map)
      || decoded.value.get('attStmt').size !== 0) {
    throw new TypeError('unsupported_webauthn_attestation');
  }
  const authData = decoded.value.get('authData');
  if (!Buffer.isBuffer(authData)) throw new TypeError('invalid_webauthn_authenticator_data');
  const flags = verifyRpIdHash(authData, rpId);
  if ((flags & 0x40) === 0 || (flags & 0x80) !== 0) {
    throw new TypeError('invalid_webauthn_registration_flags');
  }
  const credentialLength = authData.readUInt16BE(53);
  const credentialEnd = 55 + credentialLength;
  if (credentialLength !== rawId.length || !authData.subarray(55, credentialEnd).equals(rawId)
      || credentialEnd >= authData.length) {
    throw new TypeError('invalid_webauthn_credential_id');
  }
  const cose = readCbor(authData, credentialEnd);
  if (cose.offset !== authData.length || !(cose.value instanceof Map)
      || cose.value.get(1) !== 2 || cose.value.get(3) !== -7 || cose.value.get(-1) !== 1) {
    throw new TypeError('unsupported_webauthn_public_key');
  }
  const x = cose.value.get(-2);
  const y = cose.value.get(-3);
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) {
    throw new TypeError('invalid_webauthn_public_key');
  }
  return {
    credentialId: rawId.toString('base64url'),
    publicKey: {
      kty: 'EC', crv: 'P-256', alg: 'ES256', use: 'sig',
      x: x.toString('base64url'), y: y.toString('base64url'),
    },
    signCount: authData.readUInt32BE(33),
  };
}

export function verifyAssertionCredential({ credential, challenge, origin, rpId,
  publicKey, previousCounter = 0 }) {
  const clientDataJSON = requireClientData(credential, { challenge, origin, ceremony: 'get' });
  const rawId = decodeBase64url(credential.rawId, 'credential_id', 1024);
  const authenticatorData = decodeBase64url(credential.response.authenticatorData,
    'authenticator_data', 2048);
  verifyRpIdHash(authenticatorData, rpId);
  const signature = decodeBase64url(credential.response.signature, 'signature', 1024);
  if (!publicKey || publicKey.kty !== 'EC' || publicKey.crv !== 'P-256'
      || typeof publicKey.x !== 'string' || typeof publicKey.y !== 'string') {
    throw new TypeError('invalid_webauthn_public_key');
  }
  const counter = authenticatorData.readUInt32BE(33);
  if (!Number.isInteger(previousCounter) || previousCounter < 0
      || (counter > 0 && previousCounter > 0 && counter <= previousCounter)) {
    throw new TypeError('invalid_webauthn_signature_counter');
  }
  const signedData = Buffer.concat([
    authenticatorData,
    createHash('sha256').update(clientDataJSON).digest(),
  ]);
  let valid = false;
  try {
    const key = createPublicKey({ key: publicKey, format: 'jwk' });
    valid = verifySignature('sha256', signedData, { key, dsaEncoding: 'der' }, signature);
  } catch {
    throw new TypeError('invalid_webauthn_public_key');
  }
  if (!valid) throw new TypeError('invalid_webauthn_signature');
  return { credentialId: rawId.toString('base64url'), signCount: counter };
}
