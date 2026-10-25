import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseTrustProxyHops, requestClientAddress, applyNetworkHeaders } from '../network-security.mjs';
import { createBackend } from '../backend.mjs';

const peer = '10.0.0.2';
const request = (forwarded, extra = {}) => ({ socket: { remoteAddress: peer }, headers: { 'x-forwarded-for': forwarded }, ...extra });

test('proxy trust defaults off and accepts only a bounded exact hop count', () => {
  assert.equal(parseTrustProxyHops(undefined), 0);
  assert.equal(parseTrustProxyHops(''), 0);
  for (let count = 0; count <= 10; count++) assert.equal(parseTrustProxyHops(String(count)), count);
  for (const value of ['-1', '11', '1.0', '1e0', '01', '+1', ' 1', '1 ', true, null]) assert.throws(() => parseTrustProxyHops(value), /TRUST_PROXY_HOPS/);
  assert.equal(requestClientAddress(request('198.51.100.1')), peer);
});

test('trusted hops select from the right so an attacker-controlled prefix cannot change the client key', () => {
  assert.equal(requestClientAddress(request('198.51.100.1'), 1), '198.51.100.1');
  assert.equal(requestClientAddress(request('192.0.2.99, 198.51.100.1'), 1), '198.51.100.1');
  assert.equal(requestClientAddress(request('192.0.2.88, 198.51.100.1, 10.0.0.1'), 2), '198.51.100.1');
  assert.equal(requestClientAddress(request('2001:db8::4, 10.0.0.1'), 2), '2001:db8::4');
});

test('ambiguous, missing, excessive and malformed forwarded chains fall back to the socket peer', () => {
  for (const value of [undefined, ['198.51.100.1'], '', 'unknown', '198.51.100.1:443', '[2001:db8::4]', 'fe80::1%eth0', 'bad,198.51.100.1', '198.51.100.1,', '1'.repeat(2049), Array(65).fill('198.51.100.1').join(',')]) {
    assert.equal(requestClientAddress(request(value), 1), peer);
  }
  assert.equal(requestClientAddress(request('198.51.100.1'), 2), peer);
  assert.equal(requestClientAddress(request('198.51.100.1,203.0.113.1', { rawHeaders: ['X-Forwarded-For', '198.51.100.1', 'x-forwarded-for', '203.0.113.1'] }), 1), peer);
});

test('security headers use configured HTTPS, preserve same-origin documents, and do not restrict script or chart sources', () => {
  const headers = new Map();
  const response = { setHeader: (key, value) => headers.set(key.toLowerCase(), value) };
  applyNetworkHeaders(response, { appOrigin: 'http://localhost:3000' });
  assert.equal(headers.get('x-frame-options'), 'DENY');
  assert.equal(headers.get('referrer-policy'), 'no-referrer');
  assert.equal(headers.get('strict-transport-security'), undefined);
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.doesNotMatch(headers.get('content-security-policy'), /script-src|frame-src|default-src/);
  applyNetworkHeaders(response, { appOrigin: 'https://academy.example.invalid', sameOriginFrame: true });
  assert.equal(headers.get('x-frame-options'), 'SAMEORIGIN');
  assert.match(headers.get('content-security-policy'), /frame-ancestors 'self'/);
  assert.equal(headers.get('strict-transport-security'), 'max-age=31536000');
  assert.doesNotMatch(headers.get('strict-transport-security'), /includeSubDomains|preload/);
});

async function proxyFixture(trust) {
  const directory = await mkdtemp(path.join(tmpdir(), 'fa-proxy-security-'));
  const previous = process.env.TRUST_PROXY_HOPS;
  process.env.TRUST_PROXY_HOPS = String(trust);
  let backend;
  try { backend = createBackend(path.join(directory, 'test.sqlite'), { autoTick: false, marketData: {}, deliveryOptions: { autoFlush: false, config: {} } }); }
  finally { if (previous === undefined) delete process.env.TRUST_PROXY_HOPS; else process.env.TRUST_PROXY_HOPS = previous; }
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    async login(forwarded) {
      const response = await fetch(`http://127.0.0.1:${server.address().port}/api/login`, { method: 'POST', headers: { 'X-Requested-With': 'FundraiserAcademy', 'Content-Type': 'application/json', 'X-Forwarded-For': forwarded }, body: '{}' });
      await response.arrayBuffer();
      return response.status;
    },
    async close() { await new Promise(resolve => server.close(resolve)); await backend.close(); await rm(directory, { recursive: true, force: true }); },
  };
}

test('configured proxy clients have isolated auth budgets and forged prefixes cannot evade a budget', async () => {
  const app = await proxyFixture(1);
  try {
    for (let count = 0; count < 20; count++) assert.equal(await app.login('192.0.2.88,198.51.100.1'), 400);
    assert.equal(await app.login('192.0.2.99,198.51.100.1'), 429);
    assert.equal(await app.login('203.0.113.1'), 400);
  } finally { await app.close(); }
});

test('default direct-server mode ignores forged addresses instead of letting them bypass auth throttles', async () => {
  const app = await proxyFixture(0);
  try {
    for (let count = 0; count < 20; count++) assert.equal(await app.login(`198.51.100.${count + 1}`), 400);
    assert.equal(await app.login('203.0.113.1'), 429);
  } finally { await app.close(); }
});

test('actual server protects public pages, private API errors, missing files, malformed paths and agreement iframes', { timeout: 15000 }, async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'fa-headers-security-'));
  const reservation = http.createServer();
  await new Promise(resolve => reservation.listen(0, '127.0.0.1', resolve));
  const port = reservation.address().port;
  await new Promise(resolve => reservation.close(resolve));
  const root = fileURLToPath(new URL('../', import.meta.url));
  // Only a local temporary database and disabled provider configuration; no
  // production secret or API transport is inherited by this child server.
  const child = spawn(process.execPath, ['server.mjs'], { cwd: root, env: { PATH: process.env.PATH, PORT: String(port), DATABASE_PATH: path.join(directory, 'test.sqlite'), APP_ORIGIN: 'https://academy.example.invalid', TRUST_PROXY_HOPS: '0', CRYPTO_STREAMING_ENABLED: 'false' }, stdio: ['ignore', 'pipe', 'pipe'] });
  let output = '';
  child.stdout.on('data', chunk => output += chunk);
  child.stderr.on('data', chunk => output += chunk);
  try {
    const deadline = Date.now() + 8000;
    while (!output.includes('listening on port')) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Local test server did not start.');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    const base = `http://127.0.0.1:${port}`;
    for (const [endpoint, status] of [['/', 200], ['/dashboard.html', 200], ['/certificates.html', 200], ['/contract.html', 200], ['/reset-password.html', 200], ['/healthz', 200], ['/api/admin/connections', 401], ['/.env', 404], ['/%ZZ', 404]]) {
      const response = await fetch(base + endpoint, { headers: { 'X-Forwarded-Proto': 'http', Host: 'attacker.invalid' } });
      assert.equal(response.status, status, endpoint);
      assert.equal(response.headers.get('x-frame-options'), 'DENY', endpoint);
      assert.match(response.headers.get('content-security-policy'), /frame-ancestors 'none'/, endpoint);
      assert.equal(response.headers.get('x-content-type-options'), 'nosniff', endpoint);
      assert.equal(response.headers.get('referrer-policy'), 'no-referrer', endpoint);
      assert.equal(response.headers.get('strict-transport-security'), 'max-age=31536000', endpoint);
      await response.arrayBuffer();
    }
    const document = await fetch(base + '/api/contracts/00000000-0000-0000-0000-000000000000/document');
    assert.equal(document.status, 401);
    assert.equal(document.headers.get('x-frame-options'), 'SAMEORIGIN');
    assert.match(document.headers.get('content-security-policy'), /frame-ancestors 'self'/);
    await document.arrayBuffer();
  } finally {
    if (child.exitCode === null) { const stopped = once(child, 'exit'); child.kill('SIGTERM'); await stopped; }
    await rm(directory, { recursive: true, force: true });
  }
});
