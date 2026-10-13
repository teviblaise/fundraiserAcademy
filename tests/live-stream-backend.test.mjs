import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { EventEmitter } from 'node:events';
import { createHash } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createBackend } from '../backend.mjs';
import { quoteIsExecutable } from '../public/simulator.js';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';

const pause = milliseconds => new Promise(resolve => setTimeout(resolve, milliseconds));
async function until(predicate, message = 'Expected live account update', timeout = 3000) {
  const deadline = Date.now() + timeout;
  while (Date.now() < deadline) {
    const result = predicate();
    if (result) return result;
    await pause(5);
  }
  assert.fail(message);
}

async function harness() {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-live-account-'));
  const database = path.join(folder, 'academy.sqlite');
  const reference = createReferenceFixture();
  const options = { marketData: reference, autoTick: false, streamTickMs: 20 };
  let backend = createBackend(database, options);
  const clients = [];
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  async function request(endpoint, data, cookie, extra = {}) {
    const response = await fetch(base + endpoint, {
      method: data === undefined ? 'GET' : 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...extra },
      ...(data === undefined ? {} : { body: JSON.stringify(data) }),
    });
    return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
  }
  async function register(email = 'live-one@example.com') {
    const result = await request('/api/register', { name: 'Live Account Trader', email, password: 'a-long-live-account-test-password', market: 'I trade both', consent: true });
    assert.equal(result.status, 201);
    return result;
  }
  async function connect(symbol, cookie) {
    const controller = new AbortController();
    const response = await fetch(`${base}/api/account-stream?symbol=${symbol}`, { headers: { Cookie: cookie }, signal: controller.signal });
    assert.equal(response.status, 200);
    assert.match(response.headers.get('content-type'), /^text\/event-stream/);
    assert.match(response.headers.get('cache-control'), /no-transform/);
    assert.equal(response.headers.get('x-accel-buffering'), 'no');
    const events = [], reader = response.body.getReader(), decoder = new TextDecoder();
    const client = { events, ended: false, stop: () => controller.abort() };
    client.done = (async () => {
      let buffer = '';
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary); buffer = buffer.slice(boundary + 2);
            const name = /^event: (.+)$/m.exec(frame)?.[1];
            const data = /^data: (.+)$/m.exec(frame)?.[1];
            if (name && data) events.push({ name, data: JSON.parse(data) });
          }
        }
      } catch (error) { if (error.name !== 'AbortError') client.error = error; }
      finally { client.ended = true; }
    })();
    client.account = predicate => until(() => events.find(event => event.name === 'account' && (!predicate || predicate(event.data.account)))?.data);
    clients.push(client);
    return client;
  }
  return {
    database, reference, request, register, connect, base,
    get backend() { return backend; },
    async restart() { await backend.close(); backend = createBackend(database, options); },
    async close() {
      await backend.close();
      for (const client of clients) client.stop();
      await Promise.all(clients.map(client => client.done));
      await new Promise(resolve => server.close(resolve));
      await rm(folder, { recursive: true, force: true });
    },
  };
}

test('live account streams require authentication and isolate persisted fills, protection, and outages', async () => {
  const h = await harness();
  try {
    assert.equal((await h.request('/api/account-stream?symbol=BTCUSD')).status, 401);
    const one = await h.register(), two = await h.register('live-two@example.com');
    assert.equal((await h.request('/api/account-stream?symbol=INVALID', undefined, one.cookie)).status, 400);
    assert.equal((await h.request('/api/account-stream?symbol=BTCUSD', undefined, one.cookie, { Origin: 'https://other.example' })).status, 403);
    const a = await h.connect('BTCUSD', one.cookie), b = await h.connect('BTCUSD', two.cookie);
    const initial = await a.account();
    assert.equal(initial.symbol, 'BTCUSD'); assert.equal(initial.account.prices.BTCUSD.mid, 64000);
    assert.ok(Number.isSafeInteger(initial.account.revision)); assert.match(initial.account.streamEpoch, /^[a-f0-9-]{36}$/);
    assert.ok(Number.isFinite(initial.serverTime));
    const open = await h.request('/api/trades', { symbol: 'BTCUSD', side: 'buy', quantity: .01, stopLoss: 63500, price: 1 }, one.cookie);
    assert.equal(open.status, 200); assert.equal(open.body.account.positions[0].entry, 64000);
    await a.account(account => account.positions.length === 1);
    await b.account(account => account.revision > initial.account.revision && account.positions.length === 0);
    h.reference.failures.add('BTCUSD');
    const unavailable = await a.account(account => account.prices.BTCUSD.available === false);
    assert.equal(unavailable.account.positions.length, 1);
    assert.equal(unavailable.account.prices.BTCUSD.mid, 64000);
    assert.equal(quoteIsExecutable(unavailable.account, 'BTCUSD'), false);
    h.reference.prices.BTCUSD = 63000; h.reference.failures.delete('BTCUSD');
    const protectedAccount = await a.account(account => account.history.length === 1);
    assert.equal(protectedAccount.account.history[0].reason, 'Stop loss');
    assert.equal(protectedAccount.account.history[0].exit, 63000); assert.equal(protectedAccount.account.balance, 9990);
    const isolated = await b.account(account => account.prices.BTCUSD.mid === 63000);
    assert.equal(isolated.account.balance, 10000); assert.equal(isolated.account.history.length, 0); assert.equal(isolated.account.positions.length, 0);
    const db = new DatabaseSync(h.database);
    try {
      const saved = JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(one.body.user.id).state);
      assert.ok(saved.revision >= protectedAccount.account.revision); assert.equal(saved.history[0].exit, 63000);
    } finally { db.close(); }
  } finally { await h.close(); }
});

test('multiple live tabs share selected markets and fresh USD conversion dependencies with bounded connections', async () => {
  const h = await harness();
  try {
    const user = await h.register();
    const cross = await h.connect('EURJPY', user.cookie), crypto = await h.connect('BTCUSD', user.cookie);
    const snapshot = await crypto.account(account => account.prices.EURJPY.mid === 162.75 && account.prices.USDJPY.mid === 150);
    assert.deepEqual(new Set(h.reference.calls), new Set(['EURJPY', 'USDJPY', 'BTCUSD']));
    assert.equal(snapshot.account.prices.BTCUSD.mid, 64000);
    h.reference.failures.add('USDJPY');
    const paused = await cross.account(account => account.prices.USDJPY.available === false);
    assert.equal(paused.account.prices.EURJPY.available, true); assert.equal(quoteIsExecutable(paused.account, 'EURJPY'), false);
    h.reference.failures.delete('USDJPY');
    await cross.account(account => account.revision > paused.account.revision && quoteIsExecutable(account, 'EURJPY'));
    const extraOne = await h.connect('BTCUSD', user.cookie), extraTwo = await h.connect('BTCUSD', user.cookie);
    assert.equal((await h.request('/api/account-stream?symbol=BTCUSD', undefined, user.cookie)).status, 429);
    cross.stop(); await cross.done;
    await pause(40); h.reference.calls.length = 0;
    await until(() => h.reference.calls.length > 0);
    assert.ok(h.reference.calls.every(symbol => symbol === 'BTCUSD'), 'Closing the cross-pair tab stops its idle forex requests');
    crypto.stop(); extraOne.stop(); extraTwo.stop();
    await Promise.all([crypto.done, extraOne.done, extraTwo.done]);
  } finally { await h.close(); }
});

test('logout closes matching session streams and session expiry stops updates without revoking another login', async () => {
  const h = await harness(); let db;
  try {
    const user = await h.register();
    const anotherLogin = await h.request('/api/login', { email: 'live-one@example.com', password: 'a-long-live-account-test-password' });
    assert.equal(anotherLogin.status, 200);
    const original = await h.connect('BTCUSD', user.cookie), other = await h.connect('BTCUSD', anotherLogin.cookie);
    await original.account(); const prior = await other.account();
    assert.equal((await h.request('/api/logout', {}, user.cookie)).status, 200);
    await until(() => original.events.find(event => event.name === 'auth-expired'));
    await until(() => original.ended, 'Logged-out stream must end');
    assert.equal((await h.request('/api/account-stream?symbol=BTCUSD', undefined, user.cookie)).status, 401);
    h.reference.prices.BTCUSD = 64100;
    const continued = await other.account(account => account.revision > prior.account.revision && account.prices.BTCUSD.mid === 64100);
    assert.equal(other.ended, false); assert.equal(continued.account.positions.length, 0);
    const token = anotherLogin.cookie.split('=')[1], tokenHash = createHash('sha256').update(token).digest('hex');
    db = new DatabaseSync(h.database);
    db.prepare('UPDATE sessions SET expires=? WHERE token=?').run(Date.now() - 1, tokenHash);
    await until(() => other.events.find(event => event.name === 'auth-expired'));
    await until(() => other.ended, 'Expired stream must end');
    const endedCount = other.events.length;
    await pause(60);
    assert.equal(other.events.length, endedCount);
  } finally { db?.close(); await h.close(); }
});

test('live refreshes coalesce behind provider awaits and revisions stay ordered across orders, reset, and restart', async () => {
  const h = await harness(); let release;
  try {
    const user = await h.register();
    const original = h.reference.getExecutionQuote;
    let started, enteredCount = 0, held = false;
    const gate = new Promise(resolve => { release = resolve; });
    const entered = new Promise(resolve => { started = resolve; });
    h.reference.getExecutionQuote = async symbol => {
      enteredCount++;
      if (!held) { held = true; started(); await gate; }
      return original(symbol);
    };
    const live = await h.connect('BTCUSD', user.cookie);
    await entered;
    const orderOne = h.request('/api/trades', { symbol: 'BTCUSD', side: 'buy', quantity: .01 }, user.cookie);
    const orderTwo = h.request('/api/trades', { symbol: 'BTCUSD', side: 'sell', quantity: .01 }, user.cookie);
    await pause(80);
    assert.equal(enteredCount, 1, 'Refresh interval must not enqueue unbounded provider work');
    release();
    const orders = await Promise.all([orderOne, orderTwo]);
    assert.ok(orders.every(order => order.status === 200));
    const filled = await live.account(account => account.positions.length === 2);
    assert.equal(new Set(filled.account.positions.map(position => position.id)).size, 2);
    assert.ok(orders.every(order => order.body.account.revision <= filled.account.revision));
    assert.ok(orders.every(order => order.body.account.streamEpoch === filled.account.streamEpoch));
    const reset = await h.request('/api/account/reset', {}, user.cookie);
    assert.ok(reset.body.account.revision > filled.account.revision);
    assert.equal(reset.body.account.positions.length, 0);
    const resetSnapshot = await live.account(account => account.notificationEpoch === reset.body.account.notificationEpoch);
    assert.ok(resetSnapshot.account.revision >= reset.body.account.revision);
    assert.equal(resetSnapshot.account.positions.length, 0);
    const revisions = live.events.filter(event => event.name === 'account').map(event => event.data.account.revision);
    assert.ok(revisions.every((value, index) => index === 0 || value > revisions[index - 1]));
    await h.restart(); await until(() => live.ended, 'Restart must close the old stream');
    const restarted = await h.request('/api/account?symbol=BTCUSD', undefined, user.cookie);
    assert.equal(restarted.status, 200); assert.ok(restarted.body.account.revision > resetSnapshot.account.revision);
    assert.notEqual(restarted.body.account.streamEpoch, resetSnapshot.account.streamEpoch);
  } finally { release?.(); await h.close(); }
});

test('a session revoked during a provider await receives no account payload after revocation', async () => {
  const h = await harness(); let release, db;
  try {
    const user = await h.register();
    const original = h.reference.getExecutionQuote;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    h.reference.getExecutionQuote = async symbol => { started(); await gate; return original(symbol); };
    const live = await h.connect('BTCUSD', user.cookie); await entered;
    db = new DatabaseSync(h.database);
    db.prepare('DELETE FROM sessions WHERE user_id=?').run(user.body.user.id);
    release();
    await until(() => live.events.find(event => event.name === 'auth-expired'));
    await until(() => live.ended);
    assert.equal(live.events.filter(event => event.name === 'account').length, 0);
  } finally { release?.(); db?.close(); await h.close(); }
});

test('backend shutdown ends live responses and drains in-flight refreshes before closing SQLite', async () => {
  const h = await harness(); let release;
  try {
    const user = await h.register();
    const original = h.reference.getExecutionQuote;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    h.reference.getExecutionQuote = async symbol => { started(); await gate; return original(symbol); };
    h.reference.close = () => release();
    const live = await h.connect('BTCUSD', user.cookie); await entered;
    await h.backend.close(); await until(() => live.ended);
    assert.equal(live.events.filter(event => event.name === 'account').length, 0);
    assert.equal((await h.request('/api/account?symbol=BTCUSD', undefined, user.cookie)).status, 503);
    const calls = h.reference.calls.length;
    await pause(60); assert.equal(h.reference.calls.length, calls, 'Shutdown must clear stream timers');
  } finally { release?.(); await h.close(); }
});

test('large legitimate journals continue to stream to fast readers without a reconnect loop', async () => {
  const h = await harness(); let db;
  try {
    const user = await h.register();
    const opened = await h.request('/api/trades', { symbol: 'EURJPY', side: 'buy', lots: .01 }, user.cookie);
    assert.equal(opened.status, 200);
    const closed = await h.request('/api/trades/close', { id: opened.body.account.positions[0].id }, user.cookie);
    assert.equal(closed.status, 200);
    const account = closed.body.account;
    const completedTrade = account.history[0];
    account.history = Array.from({ length: 500 }, (_, index) => ({ ...completedTrade, id: index + 1 }));
    account.nextId = 501;
    assert.ok(Buffer.byteLength(JSON.stringify(account)) > 262144, 'Fixture must exceed the old per-frame cutoff');
    db = new DatabaseSync(h.database);
    db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(account), user.body.user.id);
    const live = await h.connect('EURJPY', user.cookie);
    const initial = await live.account(state => state.history.length === 500);
    h.reference.prices.EURJPY = 163.15;
    const updated = await live.account(state => state.revision > initial.account.revision && state.prices.EURJPY.mid === 163.15);
    assert.equal(updated.account.history.length, 500);
    assert.equal(live.ended, false, 'A fast reader must keep its existing live connection');
  } finally { db?.close(); await h.close(); }
});

test('a backed-up live response disconnects without blocking account work or further polling', async () => {
  const h = await harness(); let release;
  try {
    const user = await h.register();
    const original = h.reference.getExecutionQuote;
    const gate = new Promise(resolve => { release = resolve; });
    let started;
    const entered = new Promise(resolve => { started = resolve; });
    h.reference.getExecutionQuote = async symbol => { started(); await gate; return original(symbol); };
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url: '/api/account-stream?symbol=BTCUSD', headers: { cookie: user.cookie, host: new URL(h.base).host }, socket: { remoteAddress: '127.0.0.1' } });
    const res = new EventEmitter();
    Object.assign(res, {
      writableLength: 0, destroyed: false, writableEnded: false,
      writeHead() {}, flushHeaders() {}, write() { return false; },
      end() { this.writableEnded = true; this.emit('close'); },
      destroy() { this.destroyed = true; this.emit('close'); },
    });
    await h.backend.handle(req, res, '/api/account-stream'); await entered;
    res.writableLength = 262144; release();
    await until(() => res.destroyed, 'Slow client must be disconnected');
    const calls = h.reference.calls.length;
    await pause(60); assert.equal(h.reference.calls.length, calls);
    const order = await h.request('/api/trades', { symbol: 'BTCUSD', side: 'buy', quantity: .01 }, user.cookie);
    assert.equal(order.status, 200); assert.equal(order.body.account.positions.length, 1);
  } finally { release?.(); await h.close(); }
});

test('a slow reader buffers at most one account snapshot even below the byte cutoff', async () => {
  const h = await harness();
  try {
    const user = await h.register();
    const req = new EventEmitter();
    Object.assign(req, { method: 'GET', url: '/api/account-stream?symbol=BTCUSD', headers: { cookie: user.cookie, host: new URL(h.base).host }, socket: { remoteAddress: '127.0.0.1' } });
    const frames = [], res = new EventEmitter();
    Object.assign(res, {
      writableLength: 0, destroyed: false, writableEnded: false,
      writeHead() {}, flushHeaders() {},
      write(frame) {
        frames.push(frame);
        if (frame.startsWith('event: account\n')) { this.writableLength = 65536; return false; }
        return true;
      },
      end() { this.writableEnded = true; this.emit('close'); },
      destroy() { this.destroyed = true; this.emit('close'); },
    });
    await h.backend.handle(req, res, '/api/account-stream');
    await until(() => res.destroyed, 'A snapshot remaining in the buffer must disconnect the slow reader');
    assert.equal(frames.filter(frame => frame.startsWith('event: account\n')).length, 1);
    const calls = h.reference.calls.length;
    await pause(60); assert.equal(h.reference.calls.length, calls);
  } finally { await h.close(); }
});
