import test from 'node:test';
import assert from 'node:assert/strict';
import { createHmac, generateKeyPairSync, createPublicKey, verify as nodeVerify } from 'node:crypto';
import { verifySignature, generateJWT } from '../src/crypto.js';

test('verifySignature accepts a correct HMAC and rejects a wrong one', async () => {
  const secret = 'top-secret';
  const body = JSON.stringify({ hello: 'world' });
  const good = 'sha256=' + createHmac('sha256', secret).update(body).digest('hex');

  assert.equal(await verifySignature(body, good, secret), true);
  assert.equal(await verifySignature(body, good, 'wrong-secret'), false);
  assert.equal(await verifySignature(body, 'sha1=deadbeef', secret), false);
  assert.equal(await verifySignature(body, 'sha256=nothex', secret), false);
  assert.equal(await verifySignature(body, '', secret), false);
});

test('generateJWT produces three parts with the app id as issuer', async () => {
  const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const pem = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const jwt = await generateJWT('12345', pem);
  const [header, payload, signature] = jwt.split('.');
  assert.equal(jwt.split('.').length, 3);

  const decodedHeader = JSON.parse(Buffer.from(header, 'base64url').toString());
  const decodedPayload = JSON.parse(Buffer.from(payload, 'base64url').toString());
  assert.deepEqual(decodedHeader, { alg: 'RS256', typ: 'JWT' });
  assert.equal(decodedPayload.iss, '12345');
  assert.ok(decodedPayload.exp > decodedPayload.iat);

  const verified = nodeVerify(
    'RSA-SHA256',
    Buffer.from(`${header}.${payload}`),
    createPublicKey(pem),
    Buffer.from(signature, 'base64url')
  );
  assert.equal(verified, true);
});
