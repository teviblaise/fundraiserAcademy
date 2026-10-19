import test from 'node:test';
import assert from 'node:assert/strict';
import { scryptSync } from 'node:crypto';
import { createPasswordManager } from '../passwords.mjs';

const password = '  orchard pebble lantern silver  ';
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };

test('native reset hashes encode the approved stronger parameters and verify exact passphrases', async () => {
  const passwords = createPasswordManager();
  try {
    const encoded = await passwords.encode(password);
    assert.match(encoded, /^scrypt\$32768\$8\$3\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
    assert.ok(!encoded.includes(password));
    const [, n, r, p, salt, hash] = encoded.split('$');
    const expected = scryptSync(password, salt, 64, { N: Number(n), r: Number(r), p: Number(p), maxmem: 64 * 1024 * 1024 }).toString('hex');
    assert.equal(hash, expected, 'the stored format must describe the actual native derivation');
    assert.equal(await passwords.verify(password, encoded), true);
    assert.equal(await passwords.verify(password.trim(), encoded), false);
    assert.equal(await passwords.verify('a wrong long passphrase', encoded), false);
    assert.notEqual(await passwords.encode(password), encoded, 'new encodings must use independent random salts');
  } finally { await passwords.close(); }
});

test('native legacy hashes and long Unicode passwords remain usable alongside the stronger format', async () => {
  const passwords = createPasswordManager();
  try {
    const salt = '0123456789abcdef0123456789abcdef';
    const legacyPassword = '🌱'.repeat(6);
    const legacy = `${salt}:${scryptSync(legacyPassword, salt, 64).toString('hex')}`;
    assert.equal(await passwords.verify(legacyPassword, legacy), true);
    assert.equal(await passwords.verify('another value', legacy), false);
    const generatedLegacy = await passwords.encodeLegacy(password);
    assert.match(generatedLegacy, /^[a-f0-9]{32}:[a-f0-9]{128}$/);
    assert.equal(await passwords.verify(password, generatedLegacy), true);
    const unicode = Array.from({ length: 128 }, (_, index) => String.fromCodePoint(0x1f300 + index)).join('');
    const encoded = await passwords.encode(unicode);
    assert.equal(await passwords.verify(unicode, encoded), true);
    assert.equal(await passwords.verify(unicode.slice(0, -2), encoded), false);
  } finally { await passwords.close(); }
});

test('unknown, malformed, legacy, and strong credentials perform the same two fixed workloads', async () => {
  const calls = [];
  const passwords = createPasswordManager({ async scrypt(value, salt, length, options) {
    calls.push({ salt, length, ...options });
    return Buffer.alloc(length, value === 'correct' ? 1 : 2);
  } });
  try {
    const salt = '0123456789abcdef0123456789abcdef';
    const expected = '01'.repeat(64);
    const legacy = `${salt}:${expected}`;
    const strong = `scrypt$32768$8$3$${salt}$${expected}`;
    for (const encoded of [undefined, null, '', `${salt}:bad`, `scrypt$1073741824$8$3$${salt}$${expected}`, `scrypt$32768$8$9999999$${salt}$${expected}`, legacy, strong]) {
      calls.length = 0;
      assert.equal(await passwords.verify('correct', encoded), encoded === legacy || encoded === strong);
      assert.deepEqual(calls.map(({ N, r, p, length, maxmem }) => ({ N, r, p, length, maxmem })), [
        { N: 16384, r: 8, p: 1, length: 64, maxmem: 64 * 1024 * 1024 },
        { N: 32768, r: 8, p: 3, length: 64, maxmem: 64 * 1024 * 1024 },
      ]);
    }
    assert.equal(await passwords.verify('wrong', legacy), false);
    assert.equal(await passwords.verify('wrong', strong), false);
  } finally { await passwords.close(); }
});

test('password processing runs at most two jobs and rejects work beyond sixteen waiting jobs', async () => {
  const gate = deferred();
  let active = 0; let maximum = 0; let calls = 0;
  const passwords = createPasswordManager({ async scrypt(value, salt, length) {
    calls++; active++; maximum = Math.max(maximum, active);
    await gate.promise;
    active--;
    return Buffer.alloc(length, 1);
  } });
  const jobs = Array.from({ length: 18 }, () => passwords.encode(password));
  try {
    await Promise.resolve();
    assert.equal(calls, 2);
    await assert.rejects(passwords.encode(password), error => error.status === 503 && error.code === 'PASSWORD_PROCESSING_BUSY' && !error.message.includes(password));
    assert.equal(calls, 2, 'rejected jobs must not reach the native KDF');
    gate.resolve();
    const encoded = await Promise.all(jobs);
    assert.equal(encoded.length, 18);
    assert.equal(maximum, 2);
    assert.equal(calls, 18);
  } finally { gate.resolve(); await passwords.close(); }
});

test('closing drains running and queued password jobs while rejecting new submissions', async () => {
  const gate = deferred();
  const passwords = createPasswordManager({ async scrypt(value, salt, length) { await gate.promise; return Buffer.alloc(length, 1); } });
  const jobs = Array.from({ length: 4 }, () => passwords.encode(password));
  let closed = false;
  const closing = passwords.close().then(() => { closed = true; });
  try {
    assert.equal(passwords.close(), passwords.close(), 'shutdown must be idempotent');
    await Promise.resolve();
    assert.equal(closed, false);
    await assert.rejects(passwords.verify(password, undefined), error => error.status === 503);
    gate.resolve();
    await Promise.all(jobs);
    await closing;
    assert.equal(closed, true);
  } finally { gate.resolve(); await passwords.close(); }
});
