import test from 'node:test';
import assert from 'node:assert/strict';
import { createAccountOrderGuard, createAccountFeed } from '../public/account-feed.js';

const snapshot = (revision, streamEpoch = 'server-a', extra = {}) => ({ revision, streamEpoch, ...extra });

test('older HTTP responses cannot roll back streamed account state or a reset', () => {
  const guard = createAccountOrderGuard(snapshot(12));
  assert.equal(guard.accept(snapshot(13, 'server-a', { balance: 10250 })), true);
  assert.equal(guard.accept(snapshot(12, 'server-a', { balance: 10000 })), false);
  assert.equal(guard.accept(snapshot(14, 'server-a', { notificationEpoch: 'reset-attempt' })), true);
  assert.equal(guard.accept(snapshot(13, 'server-a', { notificationEpoch: 'previous-attempt' })), false);
  assert.equal(guard.accept(snapshot(14, 'server-a', { fetchedAt: 1001 })), true);
});

test('a new server epoch can restart revisions after storage reset and retires previous streams', () => {
  const guard = createAccountOrderGuard(snapshot(25));
  assert.equal(guard.accept(snapshot(24, 'server-a')), false);
  assert.equal(guard.accept(snapshot(0, 'server-b')), true);
  assert.equal(guard.accept(snapshot(100, 'server-a')), false);
  assert.equal(guard.accept(snapshot(1, 'server-b')), true);
  assert.equal(guard.accept(snapshot(0, 'server-b')), false);
  assert.equal(guard.accept(snapshot(0, 'server-c')), true);
  assert.equal(guard.accept(snapshot(200, 'server-b')), false);
  assert.equal(guard.accept(snapshot(1, 'server-c')), true);
});

test('unversioned fixture accounts work until a real versioned snapshot has been accepted', () => {
  const guard = createAccountOrderGuard({ balance: 10000 });
  assert.equal(guard.accept({ balance: 10020 }), true);
  assert.equal(guard.accept(snapshot(0)), true);
  assert.equal(guard.accept({ balance: 5000 }), false);
  for (const invalid of [
    snapshot(-1), snapshot(0.5), snapshot('1'), snapshot(1, ''),
    { revision: 1 }, { streamEpoch: 'server-b' }, null,
  ]) assert.equal(guard.accept(invalid), false);
  assert.equal(guard.accept(snapshot(1)), true);
});

class EventTargetFixture {
  listeners = new Map();
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type).add(listener);
  }
  removeEventListener(type, listener) { this.listeners.get(type)?.delete(listener); }
  emit(type, event = {}) {
    for (const listener of [...(this.listeners.get(type) || [])]) listener({ type, ...event });
  }
  get listenerCount() { return [...this.listeners.values()].reduce((count, listeners) => count + listeners.size, 0); }
}

class ClockFixture {
  time = 0;
  nextId = 1;
  timers = new Map();
  setInterval = (callback, delay) => {
    assert.ok(delay > 0, 'intervals need a positive delay');
    const id = this.nextId++;
    this.timers.set(id, { callback, delay, next: this.time + delay });
    return id;
  };
  clearInterval = id => { this.timers.delete(id); };
  advance(duration) {
    const end = this.time + duration;
    for (;;) {
      let dueId;
      let due;
      for (const [id, timer] of this.timers) {
        if (timer.next <= end && (!due || timer.next < due.next)) { dueId = id; due = timer; }
      }
      if (!due) break;
      this.time = due.next;
      due.next += due.delay;
      if (this.timers.has(dueId)) due.callback();
    }
    this.time = end;
  }
}

const flush = () => new Promise(resolve => setImmediate(resolve));

function fixture({ hidden = false, noEventSource = false, pollImpl, inactivityTimeoutMs } = {}) {
  const sources = [], accounts = [], statuses = [];
  const clock = new ClockFixture();
  const document = new EventTargetFixture(); document.hidden = hidden;
  const window = new EventTargetFixture();
  let symbol = 'EURUSD', polls = 0, unauthorized = 0;
  class Source extends EventTargetFixture {
    constructor(url) { super(); this.url = url; this.closed = false; sources.push(this); }
    close() { this.closed = true; }
    account(account = snapshot(1), selected = symbol) {
      this.emit('account', { data: JSON.stringify({ account, symbol: selected, serverTime: clock.time }) });
    }
  }
  const feed = createAccountFeed({
    getSymbol: () => symbol,
    onAccount: (account, payload) => accounts.push({ account, payload }),
    onStatus: status => statuses.push(status),
    onUnauthorized: () => { unauthorized++; },
    poll: async () => { polls++; await pollImpl?.(); },
    EventSourceImpl: noEventSource ? null : Source,
    documentImpl: document,
    windowImpl: window,
    setIntervalImpl: clock.setInterval,
    clearIntervalImpl: clock.clearInterval,
    nowImpl: () => clock.time,
    inactivityTimeoutMs,
  });
  return {
    feed, sources, accounts, statuses, clock, document, window,
    get polls() { return polls; }, get unauthorized() { return unauthorized; },
    select(next) { symbol = next; feed.selectSymbol(); },
    visibility(hidden) { document.hidden = hidden; document.emit('visibilitychange'); },
  };
}

test('the account feed starts explicitly and receives the selected authenticated market stream', () => {
  const f = fixture();
  assert.equal(f.sources.length, 0); assert.equal(f.clock.timers.size, 0);
  f.feed.start();
  assert.equal(f.sources.length, 1);
  const url = new URL(f.sources[0].url, 'https://academy.example');
  assert.equal(url.pathname, '/api/account-stream'); assert.equal(url.searchParams.get('symbol'), 'EURUSD');
  f.sources[0].emit('open'); assert.equal(f.statuses.at(-1), 'connecting');
  const next = snapshot(2, 'server-a', { balance: 10100 });
  f.sources[0].account(next);
  assert.deepEqual(f.accounts[0].account, next); assert.equal(f.accounts[0].payload.symbol, 'EURUSD');
  assert.equal(f.statuses.at(-1), 'live');
  f.clock.advance(1500); assert.equal(f.polls, 0, 'a healthy live stream should not also poll the account');
  f.feed.stop();
});

test('switching markets discards late accounts, errors and auth events from the previous connection', () => {
  const f = fixture(); f.feed.start();
  const eur = f.sources[0]; f.select('USDJPY');
  assert.equal(eur.closed, true); assert.equal(f.sources.length, 2);
  const jpy = f.sources[1];
  assert.equal(new URL(jpy.url, 'https://academy.example').searchParams.get('symbol'), 'USDJPY');
  eur.account(snapshot(100), 'EURUSD'); eur.account(snapshot(101), 'USDJPY');
  eur.emit('error'); eur.emit('auth-expired');
  jpy.account(snapshot(102), 'EURUSD');
  assert.equal(f.accounts.length, 0); assert.equal(f.unauthorized, 0); assert.equal(jpy.closed, false);
  jpy.account(snapshot(103), 'USDJPY');
  assert.equal(f.accounts.length, 1); assert.equal(f.accounts[0].account.revision, 103);
  f.feed.stop();
});

test('malformed messages cannot replace account state or interrupt later valid stream updates', () => {
  const f = fixture(); f.feed.start();
  const source = f.sources[0];
  for (const data of ['{', 'null', '{}', '{"symbol":"EURUSD"}']) source.emit('account', { data });
  assert.equal(f.accounts.length, 0); assert.equal(source.closed, false);
  source.account(snapshot(2));
  assert.equal(f.accounts.length, 1); assert.equal(f.statuses.at(-1), 'live');
  f.feed.stop();
});

for (const failure of ['error', 'stream-error']) test(`${failure} events fall back to polling and reconnect without accepting the abandoned source`, async () => {
  const f = fixture(); f.feed.start();
  const abandoned = f.sources[0]; abandoned.emit('open'); abandoned.emit(failure);
  assert.equal(abandoned.closed, true); assert.equal(f.statuses.at(-1), 'polling');
  const pollsBefore = f.polls;
  f.clock.advance(1500); await flush(); assert.ok(f.polls > pollsBefore);
  f.clock.advance(1500); await flush();
  assert.equal(f.sources.length, 2);
  const recovered = f.sources[1]; recovered.emit('open'); recovered.account(snapshot(5));
  abandoned.account(snapshot(999));
  assert.deepEqual(f.accounts.map(({ account }) => account.revision), [5]);
  const pollsAtRecovery = f.polls;
  f.clock.advance(3000); await flush();
  assert.equal(f.polls, pollsAtRecovery); assert.equal(f.sources.length, 2);
  f.feed.stop();
});

test('fallback polling does not overlap unresolved account requests', async () => {
  let finish;
  const pending = new Promise(resolve => { finish = resolve; });
  const f = fixture({ noEventSource: true, pollImpl: () => pending }); f.feed.start();
  f.clock.advance(4500); await flush();
  assert.equal(f.polls, 1);
  finish(); await flush();
  f.clock.advance(1500); await flush();
  assert.equal(f.polls, 2); assert.equal(f.sources.length, 0);
  f.feed.stop();
});

for (const lifecycle of ['stop', 'hide']) test(`${lifecycle} prevents queued fallback work from starting after the lifecycle change`, async () => {
  const f = fixture({ noEventSource: true }); f.feed.start();
  f.clock.advance(1500);
  if (lifecycle === 'stop') f.feed.stop(); else f.visibility(true);
  await flush();
  assert.equal(f.polls, 0, 'a poll queued before the lifecycle change must recheck whether work is still allowed');
  if (lifecycle === 'hide') {
    f.visibility(false); f.clock.advance(1500); await flush();
    assert.equal(f.polls, 1, 'skipping queued work must not block subsequent visible-page polling');
  }
  f.feed.stop();
});

test('an opened stream that never sends an account snapshot falls back and reconnects', async () => {
  const f = fixture({ inactivityTimeoutMs: 6000 }); f.feed.start();
  const silent = f.sources[0]; silent.emit('open');
  f.clock.advance(6000); await flush();
  assert.equal(silent.closed, true, 'an open event alone must not suppress account refresh indefinitely');
  assert.ok(f.polls > 0, 'the dashboard keeps updating through fallback HTTP account refresh');
  f.clock.advance(3000); await flush();
  assert.ok(f.sources.length >= 2, 'a silent connection is replaced by a new selected-market stream');
  silent.account(snapshot(999)); assert.equal(f.accounts.length, 0);
  f.sources.at(-1).account(snapshot(1));
  assert.equal(f.accounts.length, 1); assert.equal(f.statuses.at(-1), 'live');
  f.feed.stop();
});

test('regular account snapshots keep a healthy stream live beyond the inactivity timeout', async () => {
  const f = fixture({ inactivityTimeoutMs: 6000 }); f.feed.start();
  const source = f.sources[0]; source.emit('open'); source.account(snapshot(1));
  for (let revision = 2; revision <= 5; revision++) {
    f.clock.advance(3000); await flush(); source.account(snapshot(revision));
  }
  assert.equal(source.closed, false); assert.equal(f.sources.length, 1);
  assert.equal(f.polls, 0); assert.equal(f.statuses.at(-1), 'live');
  assert.deepEqual(f.accounts.map(({ account }) => account.revision), [1, 2, 3, 4, 5]);
  f.feed.stop();
});

test('expired authentication stops reconnection and invokes the unauthorized callback once', async () => {
  const f = fixture(); f.feed.start();
  const source = f.sources[0]; source.emit('auth-expired'); source.emit('auth-expired'); source.emit('error');
  assert.equal(f.unauthorized, 1); assert.equal(source.closed, true);
  assert.equal(f.clock.timers.size, 0);
  f.clock.advance(9000); await flush(); f.feed.start(); f.select('GBPUSD');
  assert.equal(f.sources.length, 1); assert.equal(f.polls, 0);
});

test('hidden pages close their stream and resume only on becoming visible', async () => {
  const f = fixture({ hidden: true }); f.feed.start();
  assert.equal(f.sources.length, 0);
  f.clock.advance(6000); await flush(); assert.equal(f.polls, 0);
  f.visibility(false); assert.equal(f.sources.length, 1);
  const hiddenSource = f.sources[0]; f.visibility(true);
  assert.equal(hiddenSource.closed, true); assert.equal(f.statuses.at(-1), 'paused');
  hiddenSource.account(snapshot(200)); assert.equal(f.accounts.length, 0);
  f.clock.advance(6000); await flush();
  assert.equal(f.sources.length, 1); assert.equal(f.polls, 0);
  f.select('EURJPY'); assert.equal(f.sources.length, 1);
  f.visibility(false); assert.equal(f.sources.length, 2);
  assert.equal(new URL(f.sources[1].url, 'https://academy.example').searchParams.get('symbol'), 'EURJPY');
  f.feed.stop();
});

test('pagehide closes the stream and a back-forward-cache pageshow reconnects it', () => {
  const f = fixture(); f.feed.start();
  const previous = f.sources[0]; f.window.emit('pagehide', { persisted: true });
  assert.equal(previous.closed, true);
  f.clock.advance(6000); assert.equal(f.sources.length, 1); assert.equal(f.polls, 0);
  f.window.emit('pageshow', { persisted: true }); assert.equal(f.sources.length, 2);
  previous.account(snapshot(300)); assert.equal(f.accounts.length, 0);
  f.sources[1].account(snapshot(301)); assert.equal(f.accounts.length, 1);
  f.feed.stop();
});

test('stop removes lifecycle listeners and timers and permanently ignores all subsequent work', async () => {
  const f = fixture(); f.feed.start(); f.feed.start();
  assert.equal(f.sources.length, 1);
  const source = f.sources[0]; f.feed.stop(); f.feed.stop();
  assert.equal(source.closed, true); assert.equal(f.clock.timers.size, 0);
  assert.equal(f.document.listenerCount, 0); assert.equal(f.window.listenerCount, 0);
  source.account(snapshot(500)); source.emit('error'); source.emit('auth-expired');
  f.feed.start(); f.select('BTCUSD'); f.visibility(false); f.window.emit('pageshow');
  f.clock.advance(9000); await flush();
  assert.equal(f.sources.length, 1); assert.equal(f.accounts.length, 0);
  assert.equal(f.polls, 0); assert.equal(f.unauthorized, 0); assert.equal(f.statuses.at(-1), 'stopped');
});
