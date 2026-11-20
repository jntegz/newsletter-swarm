import assert from 'node:assert/strict';
import { createPublicKey, sign, verify, createPrivateKey } from 'node:crypto';
import { test } from 'node:test';
import { fillExample, parseVars, publicKeysOf } from '../setup-dev.mjs';

test('every keyring gets a random key, and other lines stay as they are', () => {
  const keys = new Map();
  let n = 0;
  const out = fillExample(
    '# comment\nAUTH_KEYS=k1:replace-me\nTURNSTILE_SECRET_KEY=1x00\n# GOOGLE_CLIENT_ID=\n',
    keys,
    () => `random${++n}`,
  );
  assert.equal(
    out,
    '# comment\nAUTH_KEYS=k1:random1\nTURNSTILE_SECRET_KEY=1x00\n# GOOGLE_CLIENT_ID=\n',
  );
});

test('a key of the same name is the same in every worker', () => {
  const keys = new Map();
  const send = parseVars(fillExample('TRACK_KEYS=k1:x\nMEMBER_KEYS=k1:x\n', keys));
  const track = parseVars(fillExample('TRACK_KEYS=k1:y\n', keys));
  assert.equal(send.get('TRACK_KEYS'), track.get('TRACK_KEYS'));
  assert.notEqual(send.get('TRACK_KEYS'), send.get('MEMBER_KEYS'));
  assert.match(send.get('TRACK_KEYS'), /^k1:[0-9a-f]{64}$/);
});

test('a key already chosen is reused', () => {
  const keys = new Map([['FIELD_KEYS', 'k1:mine']]);
  assert.equal(fillExample('FIELD_KEYS=k1:example', keys), 'FIELD_KEYS=k1:mine');
});

test('an Ed25519 keyring gets a key pair, and its verify keyring the public half', () => {
  const keys = new Map();
  const capture = parseVars(
    fillExample('MEMBER_VERIFY_KEYS=dev0:x\nASK_PAGE_SIGNING_KEYS=dev0:y\n', keys),
  );
  const send = parseVars(fillExample('MEMBER_SIGNING_KEYS=dev0:z\n', keys));
  const signing = send.get('MEMBER_SIGNING_KEYS');
  assert.match(signing, /^k1:MC4CAQAwBQYDK2VwBCIEI[\w-]{43}$/);
  assert.equal(capture.get('MEMBER_VERIFY_KEYS'), publicKeysOf(signing));
  assert.match(capture.get('MEMBER_VERIFY_KEYS'), /^k1:[\w-]{43}$/);
  // The public half really checks what the private half signs.
  const der = Buffer.from(signing.slice(3), 'base64url');
  const privateKey = createPrivateKey({ key: der, format: 'der', type: 'pkcs8' });
  const x = capture.get('MEMBER_VERIFY_KEYS').slice(3);
  const publicKey = createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x }, format: 'jwk' });
  const signature = sign(null, Buffer.from('swarm'), privateKey);
  assert.equal(verify(null, Buffer.from('swarm'), publicKey, signature), true);
  assert.match(capture.get('ASK_PAGE_SIGNING_KEYS'), /^k1:MC4CAQAwBQYDK2VwBCIEI/);
});

test('a verify keyring follows a signing keyring a worker already has', () => {
  const keys = new Map();
  fillExample('GOODS_SIGNING_KEYS=dev0:x\n', keys);
  const kept = new Map([['GOODS_SIGNING_KEYS', keys.get('GOODS_SIGNING_KEYS')]]);
  const site = parseVars(fillExample('GOODS_VERIFY_KEYS=dev0:y\n', kept));
  assert.equal(site.get('GOODS_VERIFY_KEYS'), publicKeysOf(keys.get('GOODS_SIGNING_KEYS')));
});
