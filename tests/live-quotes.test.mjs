import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { createLiveQuotes } from '../live-quotes.mjs';

const NOW = Date.parse('2026-10-13T12:00:00Z');
class FakeSocket extends EventEmitter {
  readyState = 0;
  sent = [];
  terminated = false;
  open() { this.readyState = 1; this.emit('open'); }
  send(value) { this.sent.push(JSON.parse(value)); }
  message(value) { this.emit('message', typeof value === 'string' ? value : JSON.stringify(value)); }
  drop() { this.readyState = 3; this.emit('close'); }
  terminate() { this.terminated = true; this.readyState = 3; this.emit('close'); }
}
function harness(overrides = {}) {
  let clock = NOW, nextId = 1;
  const tasks = new Map(), sockets = [];
  const schedule = (fn, delay, repeat = false) => { const id = nextId++; tasks.set(id, { fn, at: clock + delay, repeat: repeat ? delay : null }); return id; };
  const advance = milliseconds => {
    const end = clock + milliseconds;
    while (true) {
      const next = [...tasks.entries()].filter(([, task]) => task.at <= end).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      const [id, task] = next; clock = task.at;
      if (task.repeat !== null) task.at += task.repeat; else tasks.delete(id);
      task.fn();
    }
    clock = end;
  };
  const live = createLiveQuotes({ now: () => clock, socketFactory: url => {
    assert.equal(url, 'wss://ws-feed.exchange.coinbase.com');
    const socket = new FakeSocket(); sockets.push(socket); return socket;
  }, setTimeoutFn: (fn, delay) => schedule(fn, delay), clearTimeoutFn: id => tasks.delete(id), setIntervalFn: (fn, delay) => schedule(fn, delay, true), clearIntervalFn: id => tasks.delete(id), ...overrides });
  const tick = (socket, product = 'BTC-USD', price = '64000.123', time = clock, sequence = 1) => socket.message({ type: 'ticker', product_id: product, price, time: new Date(time).toISOString(), sequence });
  return { live, sockets, tasks, advance, tick, now: () => clock };
}

test('crypto streaming starts lazily, shares one public socket, and publishes independent native-price snapshots', () => {
  const h = harness();
  try {
    assert.equal(h.live.get('EURUSD'), null);
    assert.equal(h.sockets.length, 0);
    assert.equal(h.live.get('BTCUSD'), null);
    assert.equal(h.live.get('ETHUSD'), null);
    assert.equal(h.sockets.length, 1);
    const socket = h.sockets[0]; socket.open();
    assert.deepEqual(socket.sent, [{ type: 'subscribe', product_ids: ['BTC-USD', 'ETH-USD'], channels: ['ticker', 'heartbeat'] }]);
    const events = [];
    const unsubscribe = h.live.subscribe(value => { events.push(value); value.price = 0; });
    h.tick(socket);
    const quote = h.live.get('BTCUSD');
    assert.equal(quote.price, 64000.123);
    assert.equal(quote.asOf, NOW / 1000);
    assert.equal(quote.fetchedAt, NOW);
    assert.equal(quote.deliveryMode, 'streaming');
    assert.equal(quote.executable, true);
    assert.equal(quote.baseCurrency, 'BTC');
    assert.equal(quote.quoteCurrency, 'USD');
    assert.equal(events.length, 1);
    quote.price = -1;
    assert.equal(h.live.get('BTCUSD').price, 64000.123);
    unsubscribe(); h.tick(socket, 'ETH-USD', '3000.456');
    assert.equal(events.length, 1);
    assert.equal(h.live.get('ETHUSD').price, 3000.456);
  } finally { h.live.close(); }
});

test('malformed, future, stale, unknown, duplicate, and older ticks cannot change a trusted quote', () => {
  const h = harness();
  try {
    h.live.get('BTCUSD'); const socket = h.sockets[0]; socket.open(); h.tick(socket, 'BTC-USD', '64000', NOW, 10);
    const first = h.live.get('BTCUSD');
    const invalid = [
      { price: 0 }, { price: -1 }, { price: true }, { price: '' }, { price: 'NaN' }, { time: 'not a date' },
      { time: new Date(NOW + 6000).toISOString() }, { time: new Date(NOW - 121000).toISOString() },
      { product_id: 'DOGE-USD' }, { type: 'heartbeat' }, { type: 'subscriptions' },
      { time: new Date(NOW - 1000).toISOString(), sequence: 11 }, { sequence: 9 }, { sequence: 10 },
    ];
    for (const extra of invalid) socket.message({ type: 'ticker', product_id: 'BTC-USD', price: '65000', time: new Date(NOW).toISOString(), sequence: 11, ...extra });
    socket.message('{invalid json');
    assert.deepEqual(h.live.get('BTCUSD'), first);
    h.advance(1000); h.tick(socket, 'BTC-USD', '64100', h.now(), 12);
    assert.equal(h.live.get('BTCUSD').price, 64100);
    assert.equal(h.live.get('BTCUSD').fetchedAt, NOW + 1000);
  } finally { h.live.close(); }
});

test('heartbeats keep transport alive without refreshing the last price observation or receipt time', () => {
  const h = harness();
  try {
    h.live.get('BTCUSD'); const socket = h.sockets[0]; socket.open(); h.tick(socket);
    const first = h.live.get('BTCUSD');
    for (let index = 0; index < 7; index++) { h.advance(5000); socket.message({ type: 'heartbeat', product_id: 'BTC-USD', time: new Date(h.now()).toISOString() }); }
    assert.equal(socket.terminated, false);
    assert.equal(h.live.status('BTCUSD').connected, true);
    assert.equal(h.live.status('BTCUSD').fresh, false);
    assert.equal(h.live.get('BTCUSD'), null);
    assert.equal(first.asOf, NOW / 1000);
    assert.equal(first.fetchedAt, NOW);
  } finally { h.live.close(); }
});

test('outages invalidate stream execution immediately and reconnect with bounded delay before requiring a new-generation price', () => {
  const h = harness({ reconnectBaseMs: 1000, reconnectMaxMs: 4000 });
  try {
    h.live.get('BTCUSD'); let socket = h.sockets[0]; socket.open(); h.tick(socket); socket.drop();
    assert.equal(h.live.get('BTCUSD'), null);
    h.advance(999); assert.equal(h.sockets.length, 1);
    h.advance(1); assert.equal(h.sockets.length, 2);
    socket = h.sockets[1]; socket.open(); socket.message({ type: 'subscriptions', channels: [] });
    assert.equal(h.live.get('BTCUSD'), null, 'A new connection cannot replay the previous connection snapshot');
    socket.drop(); h.advance(1999); assert.equal(h.sockets.length, 2);
    h.advance(1); assert.equal(h.sockets.length, 3);
    socket = h.sockets[2]; socket.open(); socket.drop(); h.advance(4000);
    assert.equal(h.sockets.length, 4);
    socket = h.sockets[3]; socket.open(); socket.drop(); h.advance(4000);
    assert.equal(h.sockets.length, 5, 'Subsequent reconnect delays stay at the configured maximum');
    socket = h.sockets[4]; socket.open(); h.tick(socket, 'BTC-USD', '64100', h.now(), 2);
    assert.equal(h.live.get('BTCUSD').price, 64100);
  } finally { h.live.close(); }
  assert.equal(h.tasks.size, 0);
  assert.equal(h.sockets.at(-1).terminated, true);
});

test('missing heartbeats and a stalled handshake retire sockets, while close cancels retries and safely absorbs late errors', () => {
  const h = harness({ heartbeatTimeoutMs: 3000, healthIntervalMs: 1000, handshakeTimeoutMs: 1500 });
  h.live.get('BTCUSD'); const socket = h.sockets[0]; socket.open(); h.tick(socket);
  h.advance(4000);
  assert.equal(socket.terminated, true);
  assert.equal(h.live.get('BTCUSD'), null);
  h.advance(1000); assert.equal(h.sockets.length, 2);
  h.advance(1500); assert.equal(h.sockets[1].terminated, true);
  h.live.close(); assert.equal(h.tasks.size, 0);
  socket.emit('error', new Error('Late private transport error'));
  h.advance(60000);
  assert.equal(h.sockets.length, 2);
  assert.equal(h.live.get('BTCUSD'), null);
  assert.equal(h.live.status('BTCUSD').state, 'closed');
});

test('socket constructor and provider error messages are never forwarded into public stream status', () => {
  let calls = 0;
  const h = harness({ socketFactory: () => { calls++; throw new Error('https://private-user:private-password@proxy.example Secret transport details'); } });
  try {
    assert.equal(h.live.get('BTCUSD'), null);
    assert.match(h.live.status('BTCUSD').error, /temporarily unavailable/);
    assert.equal(JSON.stringify(h.live.status('BTCUSD')).includes('private'), false);
    h.advance(1000); assert.equal(calls, 2);
  } finally { h.live.close(); }
});
