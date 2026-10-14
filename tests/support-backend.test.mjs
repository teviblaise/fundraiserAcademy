import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createBackend } from '../backend.mjs';
import { manageSupportRole } from '../support.mjs';
import { createReferenceFixture } from './helpers/reference-fixture.mjs';
import { testDeliveryOptions, confirmRegistration } from './helpers/email-fixture.mjs';

const password = 'private-support-test-password-123';
async function fixture(supportOptions = {}) {
  const folder = await mkdtemp(path.join(tmpdir(), 'fa-support-'));
  const database = path.join(folder, 'academy.sqlite');
  const options = { marketData: createReferenceFixture(), deliveryOptions: testDeliveryOptions, autoTick: false, supportOptions: { staffEmails: '', ...supportOptions } };
  let backend = createBackend(database, options);
  const server = http.createServer((req, res) => backend.handle(req, res, new URL(req.url, 'http://localhost').pathname));
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const origin = `http://127.0.0.1:${server.address().port}`;
  const app = {
    database,
    async request(endpoint, data, cookie, extra = {}) {
      const response = await fetch(origin + endpoint, { method: data === undefined ? 'GET' : 'POST', headers: { 'Content-Type': 'application/json', 'X-Requested-With': 'FundraiserAcademy', ...(cookie ? { Cookie: cookie } : {}), ...extra }, ...(data === undefined ? {} : { body: JSON.stringify(data) }) });
      return { status: response.status, body: await response.json(), cookie: response.headers.get('set-cookie')?.split(';')[0] };
    },
    async register(email = 'client@example.com', verified = false) {
      const user = await app.request('/api/register', { firstName: email.split('@')[0], otherNames: 'Trader', email, password, market: 'I trade both', consent: true });
      assert.equal(user.status, 201);
      if (verified) await confirmRegistration(database, app.request, user);
      return user;
    },
    grant(email) { const db = new DatabaseSync(database); try { return manageSupportRole(db, 'grant', email); } finally { db.close(); } },
    revoke(email) { const db = new DatabaseSync(database); try { return manageSupportRole(db, 'revoke', email); } finally { db.close(); } },
    async restart() { await backend.close(); backend = createBackend(database, options); },
    async close() { await backend.close(); await new Promise(resolve => server.close(resolve)); await rm(folder, { recursive: true, force: true }); },
  };
  return app;
}
const send = (message, extra = {}) => ({ message, clientMessageId: randomUUID(), ...extra });

test('pending clients can ask basic questions, while support transcripts remain owner-bound and protected by website origin', async () => {
  let calls = 0;
  const ai = { available: true, async reply({ messages }) { calls++; assert.deepEqual(messages, [{ role: 'user', content: 'How does the academy work?' }]); return { text: 'Qualified traders receive company-funded access after assessment and an agreement.', source: 'ai' }; } };
  const app = await fixture({ ai });
  try {
    const owner = await app.register(), other = await app.register('other@example.com');
    assert.equal((await app.request('/api/account', undefined, owner.cookie)).status, 403, 'support access must not unlock trading');
    assert.equal((await app.request('/api/support')).status, 401);
    const empty = await app.request('/api/support', undefined, owner.cookie);
    assert.equal(empty.body.conversation, null);
    assert.deepEqual(empty.body.capabilities, { aiAvailable: true, staff: false });
    const posted = await app.request('/api/support/messages', send('How does the academy work?'), owner.cookie);
    assert.equal(posted.status, 200);
    assert.equal(posted.body.conversation.status, 'ai');
    assert.equal(posted.body.conversation.messages.length, 2);
    assert.equal(posted.body.conversation.messages[1].source, 'ai');
    assert.equal(calls, 1);
    const id = posted.body.conversation.id;
    assert.equal((await app.request(`/api/support?conversationId=${id}`, undefined, other.cookie)).status, 404);
    assert.equal((await app.request('/api/support/messages', send('Steal history', { conversationId: id }), other.cookie)).status, 404);
    assert.equal((await app.request('/api/support/handoff', { conversationId: id }, other.cookie)).status, 404);
    assert.equal((await app.request('/api/support/staff/conversations', undefined, owner.cookie)).status, 403);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}`, undefined, owner.cookie)).status, 403);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/claim`, {}, owner.cookie)).status, 403);
    assert.equal((await app.request('/api/support/messages', send('Question'), owner.cookie, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.request('/api/support/messages', send('Question'), owner.cookie, { 'X-Requested-With': '' })).status, 403);
    assert.equal((await app.request('/api/support', undefined, owner.cookie, { Origin: 'https://attacker.example' })).status, 403);
    assert.equal((await app.request('/api/support/messages', send('x'.repeat(2001)), owner.cookie)).status, 400);
    assert.equal((await app.request('/api/support/messages', { message: 'Question' }, owner.cookie)).status, 400);
    assert.equal((await app.request('/api/support?conversationId=invalid', undefined, owner.cookie)).status, 400);
    assert.equal((await app.request('/api/support?before=invalid', undefined, owner.cookie)).status, 400);
  } finally { await app.close(); }
});

test('an explicit human request is persisted before any provider call; waiting messages remain in the human queue', async () => {
  let calls = 0;
  const app = await fixture({ ai: { available: true, async reply() { calls++; return { text: 'AI answer', source: 'ai' }; } } });
  try {
    const owner = await app.register();
    const response = await app.request('/api/support/messages', send('I want to talk to an agent'), owner.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.conversation.status, 'waiting');
    assert.equal(calls, 0);
    assert.match(response.body.conversation.messages[1].content, /not connected to an agent yet/);
    const id = response.body.conversation.id;
    const queued = await app.request('/api/support/messages', send('My email confirmation did not arrive.', { conversationId: id }), owner.cookie);
    assert.equal(queued.body.conversation.status, 'waiting');
    assert.equal(queued.body.conversation.messages.length, 3);
    assert.equal(calls, 0);
    const again = await app.request('/api/support/handoff', { conversationId: id }, owner.cookie);
    assert.equal(again.body.conversation.messages.length, 3, 'repeated handoff must not duplicate queue events');
    await app.restart();
    const restored = await app.request('/api/support', undefined, owner.cookie);
    assert.equal(restored.body.conversation.id, id);
    assert.equal(restored.body.conversation.status, 'waiting');
    assert.equal(restored.body.conversation.messages.length, 3);
  } finally { await app.close(); }
});

test('idempotent retries never duplicate user messages or call the AI twice, including while the first request is in flight', async () => {
  let resolveAnswer, started;
  const called = new Promise(resolve => { started = resolve; });
  let calls = 0;
  const app = await fixture({ ai: { available: true, reply() { calls++; started(); return new Promise(resolve => { resolveAnswer = resolve; }); } } });
  try {
    const owner = await app.register(), data = send('What is the profit target?');
    const first = app.request('/api/support/messages', data, owner.cookie);
    await called;
    const duplicate = await app.request('/api/support/messages', data, owner.cookie);
    assert.equal(duplicate.status, 200);
    assert.equal(duplicate.body.processing, true);
    assert.equal(duplicate.body.conversation.messages.length, 1);
    assert.equal(calls, 1);
    resolveAnswer({ text: 'The assessment profit target is 10%.', source: 'ai' });
    assert.equal((await first).body.conversation.messages.length, 2);
    assert.equal((await app.request('/api/support/messages', data, owner.cookie)).body.conversation.messages.length, 2);
    assert.equal(calls, 1);
    assert.equal((await app.request('/api/support/messages', { ...data, message: 'Different message' }, owner.cookie)).status, 409);
  } finally { await app.close(); }
});

test('handoff during an AI request discards the late answer and does not block other client operations', async () => {
  let resolveAnswer, started;
  const called = new Promise(resolve => { started = resolve; });
  const app = await fixture({ ai: { available: true, reply() { started(); return new Promise(resolve => { resolveAnswer = resolve; }); } } });
  try {
    const owner = await app.register();
    const first = app.request('/api/support/messages', send('Please explain qualifications'), owner.cookie);
    await called;
    const current = await app.request('/api/support', undefined, owner.cookie);
    const id = current.body.conversation.id;
    const profile = await app.request('/api/profile', { otherNames: 'Updated' }, owner.cookie);
    assert.equal(profile.status, 200, 'support provider waits must not hold the trading/account queue');
    const queued = await app.request('/api/support/handoff', { conversationId: id }, owner.cookie);
    assert.equal(queued.body.conversation.status, 'waiting');
    assert.equal((await first).body.conversation.status, 'waiting', 'handoff abort should release the outstanding request');
    resolveAnswer({ text: 'A late AI reply that must never be stored.', source: 'ai' });
    await new Promise(resolve => setImmediate(resolve));
    const final = await app.request('/api/support', undefined, owner.cookie);
    assert.equal(final.body.conversation.messages.some(message => message.role === 'assistant'), false);
    assert.equal(final.body.processing, false);
  } finally { await app.close(); }
});

test('simultaneous questions are answered once in order with prior assistant context and bounded provider concurrency', async () => {
  let release, firstStarted, calls = 0;
  const started = new Promise(resolve => { firstStarted = resolve; });
  const histories = [];
  const app = await fixture({ ai: { available: true, async reply({ messages }) {
    histories.push(messages); calls++;
    if (calls === 1) { firstStarted(); await new Promise(resolve => { release = resolve; }); }
    return { text: `Answer ${calls}`, source: 'ai' };
  } } });
  try {
    const owner = await app.register();
    const first = app.request('/api/support/messages', send('First question'), owner.cookie);
    await started;
    const second = app.request('/api/support/messages', send('Second question'), owner.cookie);
    // Read until the second request has persisted before releasing the first
    // provider result. No timing assumption about HTTP scheduling is required.
    for (let attempt = 0; attempt < 20; attempt++) {
      const state = await app.request('/api/support', undefined, owner.cookie);
      if (state.body.conversation.messages.length === 2) break;
      if (attempt === 19) assert.fail('Second user message was not persisted');
    }
    assert.equal(calls, 1, 'only one provider request may run per conversation');
    release();
    await first; await second;
    assert.equal(calls, 2);
    assert.deepEqual(histories[1], [
      { role: 'user', content: 'First question' },
      { role: 'assistant', content: 'Answer 1' },
      { role: 'user', content: 'Second question' },
    ]);
  } finally { await app.close(); }
});

test('only verified operator-designated staff can claim, reply and close; records and roles survive restart', async () => {
  const app = await fixture({ ai: { available: false, async reply() { return { text: 'Academy guide', source: 'academy-guide' }; } } });
  try {
    const owner = await app.register(), agent = await app.register('agent@example.com'), otherAgent = await app.register('second-agent@example.com', true);
    app.grant('agent@example.com'); app.grant('second-agent@example.com');
    assert.equal((await app.request('/api/support/staff/conversations', undefined, agent.cookie)).status, 403, 'role alone cannot override unverified email');
    await confirmRegistration(app.database, app.request, agent);
    const waiting = await app.request('/api/support/handoff', {}, owner.cookie), id = waiting.body.conversation.id;
    const list = await app.request('/api/support/staff/conversations', undefined, agent.cookie);
    assert.equal(list.status, 200); assert.equal(list.body.conversations.length, 1);
    assert.equal(list.body.conversations[0].client.email, 'client@example.com');
    const claimed = await app.request(`/api/support/staff/conversations/${id}/claim`, {}, agent.cookie);
    assert.equal(claimed.body.conversation.status, 'assigned'); assert.equal(claimed.body.conversation.canReply, true);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/claim`, {}, otherAgent.cookie)).status, 409);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}`, undefined, otherAgent.cookie)).body.conversation.canReply, false);
    const answer = send('We are investigating your confirmation email.');
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/reply`, answer, agent.cookie)).status, 200);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/reply`, answer, agent.cookie)).body.conversation.messages.filter(message => message.role === 'agent').length, 1);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/reply`, send('Wrong agent'), otherAgent.cookie)).status, 409);
    const userReply = await app.request('/api/support/messages', send('Thank you', { conversationId: id }), owner.cookie);
    assert.equal(userReply.body.conversation.messages.at(-1).role, 'user');
    await app.restart();
    const restored = await app.request(`/api/support/staff/conversations/${id}`, undefined, agent.cookie);
    assert.equal(restored.body.conversation.canReply, true);
    assert.equal(restored.body.conversation.messages.find(message => message.role === 'agent').content, answer.message);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/close`, {}, otherAgent.cookie)).status, 409);
    assert.equal((await app.request(`/api/support/staff/conversations/${id}/close`, {}, agent.cookie)).body.conversation.status, 'closed');
    assert.equal((await app.request('/api/support/messages', send('More', { conversationId: id }), owner.cookie)).status, 409);
    const fresh = await app.request('/api/support/messages', send('A new question'), owner.cookie);
    assert.notEqual(fresh.body.conversation.id, id);
    assert.equal(fresh.body.conversation.status, 'ai');
    assert.equal((await app.request(`/api/support?conversationId=${id}`, undefined, owner.cookie)).body.conversation.status, 'closed');
    assert.equal((await app.request('/api/support/conversations', undefined, owner.cookie)).body.conversations.length, 2);
    app.revoke('agent@example.com');
    assert.equal((await app.request('/api/support/staff/conversations', undefined, agent.cookie)).status, 403);
  } finally { await app.close(); }
});

test('server email allowlists require a verified registered identity and cannot be set through public profile or signup data', async () => {
  const app = await fixture({ staffEmails: ' AGENT@EXAMPLE.COM,invalid-entry ' });
  try {
    const owner = await app.register(), agent = await app.register('agent@example.com');
    assert.equal((await app.request('/api/support', undefined, owner.cookie)).body.capabilities.staff, false);
    assert.equal((await app.request('/api/support/staff/conversations', undefined, agent.cookie)).status, 403);
    await confirmRegistration(app.database, app.request, agent);
    assert.equal((await app.request('/api/support/staff/conversations', undefined, agent.cookie)).status, 200);
    assert.equal((await app.request('/api/profile', { staff: true, supportRole: 'agent' }, owner.cookie)).status, 400);
    assert.equal((await app.request('/api/support/staff/conversations', undefined, owner.cookie)).status, 403);
    const db = new DatabaseSync(app.database);
    try { assert.equal(db.prepare('SELECT count(*) AS n FROM support_roles').get().n, 0, 'environment allowlists are not silently persisted as permanent grants'); }
    finally { db.close(); }
  } finally { await app.close(); }
});

test('missing AI configuration and provider failures save messages and offer an honest guide or human handoff', async () => {
  const app = await fixture({ aiOptions: { apiKey: '' } });
  try {
    const owner = await app.register();
    const response = await app.request('/api/support/messages', send('What are the challenge rules?'), owner.cookie);
    assert.equal(response.status, 200);
    assert.equal(response.body.capabilities.aiAvailable, false);
    assert.equal(response.body.conversation.messages[0].role, 'user');
    assert.equal(response.body.conversation.messages[1].source, 'academy-guide');
    assert.match(response.body.conversation.messages[1].content, /10%/);
  } finally { await app.close(); }
  const failing = await fixture({ ai: { available: true, async reply() { throw new Error('Private provider failure key=never-expose'); } } });
  try {
    const owner = await failing.register();
    const response = await failing.request('/api/support/messages', send('Hello'), owner.cookie);
    assert.equal(response.status, 200);
    assert.match(response.body.conversation.messages[1].content, /temporarily unavailable/);
    assert.ok(!JSON.stringify(response.body).includes('never-expose'));
    assert.equal((await failing.request('/api/support/handoff', {}, owner.cookie)).body.conversation.status, 'waiting');
  } finally { await failing.close(); }
});

test('support is bounded per user and transcript pagination keeps old persisted messages accessible', async () => {
  const app = await fixture({ ai: { available: false, async reply() { return { text: 'Guide', source: 'academy-guide' }; } } });
  try {
    const owner = await app.register();
    const first = await app.request('/api/support/messages', send('First question'), owner.cookie);
    const id = first.body.conversation.id;
    const db = new DatabaseSync(app.database);
    try {
      const insert = db.prepare("INSERT INTO support_messages(conversation_id,author_user_id,role,content,source,created_at) VALUES (?,?,'user',?,'client',?)");
      for (let index = 0; index < 120; index++) insert.run(id, owner.body.user.id, `Old message ${index}`, Date.now() - 3600000);
    } finally { db.close(); }
    const newest = await app.request('/api/support', undefined, owner.cookie);
    assert.equal(newest.body.conversation.messages.length, 100);
    assert.ok(newest.body.conversation.olderCursor);
    const older = await app.request(`/api/support?conversationId=${id}&before=${newest.body.conversation.olderCursor}`, undefined, owner.cookie);
    assert.equal(older.body.conversation.messages.length, 22);
    assert.equal(older.body.conversation.messages[0].content, 'First question');
    assert.equal(older.body.conversation.olderCursor, null);
    for (let index = 0; index < 19; index++) assert.equal((await app.request('/api/support/messages', send(`New question ${index}`), owner.cookie)).status, 200);
    assert.equal((await app.request('/api/support/messages', send('One too many'), owner.cookie)).status, 429);
  } finally { await app.close(); }
});

test('signout during provider work prevents the outstanding request from returning private chat history', async () => {
  let resolveAnswer, started;
  const called = new Promise(resolve => { started = resolve; });
  const app = await fixture({ ai: { available: true, reply() { started(); return new Promise(resolve => { resolveAnswer = resolve; }); } } });
  try {
    const owner = await app.register();
    const request = app.request('/api/support/messages', send('A private support question'), owner.cookie);
    await called;
    assert.equal((await app.request('/api/logout', {}, owner.cookie)).status, 200);
    resolveAnswer({ text: 'Private answer', source: 'ai' });
    const response = await request;
    assert.equal(response.status, 401);
    assert.ok(!JSON.stringify(response.body).includes('Private answer'));
  } finally { await app.close(); }
});

test('inbox filters keep waiting requests visible and conversation pagination includes tied timestamps without exposing other owners', async () => {
  const app = await fixture({ aiOptions: { apiKey: '' } });
  try {
    const owner = await app.register(), other = await app.register('other-owner@example.com'), agent = await app.register('agent@example.com', true);
    app.grant('agent@example.com');
    const db = new DatabaseSync(app.database);
    let waitingId;
    try {
      const insert = db.prepare('INSERT INTO support_conversations(id,owner_user_id,status,created_at,updated_at) VALUES (?,?,?,?,?)');
      waitingId = randomUUID(); insert.run(waitingId, owner.body.user.id, 'waiting', 1000, 1000);
      for (let index = 0; index < 105; index++) insert.run(randomUUID(), owner.body.user.id, 'closed', 2000, 2000);
      insert.run(randomUUID(), other.body.user.id, 'closed', 2000, 2000);
    } finally { db.close(); }
    const active = await app.request('/api/support/staff/conversations', undefined, agent.cookie);
    assert.equal(active.body.conversations.length, 1);
    assert.equal(active.body.conversations[0].id, waitingId);
    const closed = await app.request('/api/support/staff/conversations?status=closed', undefined, agent.cookie);
    assert.equal(closed.body.conversations.length, 50);
    assert.ok(closed.body.nextCursor);
    assert.equal((await app.request('/api/support/staff/conversations?status=anything', undefined, agent.cookie)).status, 400);
    assert.equal((await app.request('/api/support/staff/conversations?before=invalid', undefined, agent.cookie)).status, 400);
    const found = new Set(); let before;
    do {
      const page = await app.request('/api/support/conversations' + (before ? `?before=${encodeURIComponent(before)}` : ''), undefined, owner.cookie);
      assert.equal(page.status, 200);
      for (const row of page.body.conversations) { assert.equal(found.has(row.id), false); found.add(row.id); }
      before = page.body.nextCursor;
    } while (before);
    assert.equal(found.size, 106);
    assert.ok(found.has(waitingId));
    assert.equal((await app.request('/api/support/conversations', undefined, other.cookie)).body.conversations.length, 1);
  } finally { await app.close(); }
});

test('provider concurrency is bounded across clients without losing overflow messages or locking another account', async () => {
  let resolveAnswer, started, calls = 0;
  const called = new Promise(resolve => { started = resolve; });
  const app = await fixture({ maxConcurrent: 1, ai: { available: true, reply() { calls++; started(); return new Promise(resolve => { resolveAnswer = resolve; }); } } });
  try {
    const first = await app.register(), second = await app.register('another@example.com');
    const pending = app.request('/api/support/messages', send('First question'), first.cookie);
    await called;
    const overflow = await app.request('/api/support/messages', send('Another question'), second.cookie);
    assert.equal(overflow.status, 200);
    assert.equal(overflow.body.conversation.messages[0].content, 'Another question');
    assert.match(overflow.body.conversation.messages[1].content, /busy right now/);
    assert.equal(calls, 1);
    assert.equal((await app.request('/api/profile', { otherNames: 'Independent' }, second.cookie)).status, 200);
    resolveAnswer({ text: 'An answer', source: 'ai' });
    assert.equal((await pending).status, 200);
  } finally { await app.close(); }
});

test('shutdown aborts hanging support work without leaving SQLite operations running after close', async () => {
  let started;
  const called = new Promise(resolve => { started = resolve; });
  const app = await fixture({ ai: { available: true, reply() { started(); return new Promise(() => {}); } } });
  try {
    const owner = await app.register();
    const request = app.request('/api/support/messages', send('A question'), owner.cookie);
    await called;
    await app.restart();
    await request;
    const restored = await app.request('/api/support', undefined, owner.cookie);
    assert.equal(restored.status, 200);
    assert.equal(restored.body.conversation.messages[0].content, 'A question');
  } finally { await app.close(); }
});
