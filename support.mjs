import { randomUUID } from 'node:crypto';
import { createSupportAI, wantsHuman } from './support-ai.mjs';

const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-5][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;
const historyLimit = 100;
export class SupportError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

export function initializeSupportSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS support_roles (
      user_id INTEGER PRIMARY KEY REFERENCES users(id), granted_at INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS support_conversations (
      id TEXT PRIMARY KEY, owner_user_id INTEGER NOT NULL REFERENCES users(id),
      status TEXT NOT NULL CHECK(status IN ('ai','waiting','assigned','closed')),
      assigned_agent_id INTEGER REFERENCES users(id), created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS support_owner ON support_conversations(owner_user_id,created_at);
    CREATE TABLE IF NOT EXISTS support_messages (
      id INTEGER PRIMARY KEY, conversation_id TEXT NOT NULL REFERENCES support_conversations(id),
      author_user_id INTEGER REFERENCES users(id),
      role TEXT NOT NULL CHECK(role IN ('user','assistant','agent','system')),
      content TEXT NOT NULL, source TEXT NOT NULL, created_at INTEGER NOT NULL,
      client_message_id TEXT, reply_to_message_id INTEGER REFERENCES support_messages(id),
      UNIQUE(author_user_id,client_message_id)
    );
    CREATE INDEX IF NOT EXISTS support_message_history ON support_messages(conversation_id,id);
    CREATE TABLE IF NOT EXISTS support_audit (
      id INTEGER PRIMARY KEY, conversation_id TEXT REFERENCES support_conversations(id),
      actor_user_id INTEGER REFERENCES users(id), action TEXT NOT NULL,
      detail TEXT NOT NULL, created_at INTEGER NOT NULL
    );
  `);
  if (!db.prepare('PRAGMA table_info(support_messages)').all().some(column => column.name === 'reply_to_message_id')) db.exec('ALTER TABLE support_messages ADD COLUMN reply_to_message_id INTEGER REFERENCES support_messages(id)');
}

export function manageSupportRole(db, action, email, now = Date.now()) {
  initializeSupportSchema(db);
  if (action === 'list') return db.prepare('SELECT users.email, users.name, support_roles.granted_at AS grantedAt FROM support_roles JOIN users ON users.id=support_roles.user_id ORDER BY users.email').all();
  if (!['grant', 'revoke'].includes(action)) throw new Error('Choose grant, revoke, or list.');
  if (typeof email !== 'string' || !email.trim()) throw new Error('Provide the registered agent email using --email.');
  const user = db.prepare('SELECT id,email,name FROM users WHERE email=?').get(email.trim().toLowerCase());
  if (!user) throw new Error('No registered account uses that email. The agent must register first.');
  db.exec('BEGIN');
  try {
    if (action === 'grant') db.prepare('INSERT INTO support_roles(user_id,granted_at) VALUES (?,?) ON CONFLICT(user_id) DO NOTHING').run(user.id, now);
    else db.prepare('DELETE FROM support_roles WHERE user_id=?').run(user.id);
    db.prepare('INSERT INTO support_audit(actor_user_id,action,detail,created_at) VALUES (?,?,?,?)').run(user.id, `role-${action}`, JSON.stringify({ operator: 'local-server' }), now);
    db.exec('COMMIT');
  } catch (error) { db.exec('ROLLBACK'); throw error; }
  return { email: user.email, name: user.name, staff: action === 'grant' };
}

export function createSupport(db, { ai: injectedAI, aiOptions, staffEmails = process.env.SUPPORT_STAFF_EMAILS || '', now = Date.now, maxConcurrent = 4 } = {}) {
  if (!Number.isInteger(maxConcurrent) || maxConcurrent < 1 || maxConcurrent > 20) throw new TypeError('Support provider concurrency must be between 1 and 20.');
  initializeSupportSchema(db);
  const ai = injectedAI ?? createSupportAI(aiOptions);
  const queues = new Map();
  const jobs = new Map();
  const controllers = new Map();
  const environmentStaff = new Set((Array.isArray(staffEmails) ? staffEmails : String(staffEmails).split(',')).map(email => String(email).trim().toLowerCase()).filter(email => email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)));
  let active = 0;
  let stopping = false;
  let closePromise;

  const audit = (conversationId, actorId, action, detail = {}) => db.prepare('INSERT INTO support_audit(conversation_id,actor_user_id,action,detail,created_at) VALUES (?,?,?,?,?)').run(conversationId, actorId, action, JSON.stringify(detail), now());
  const role = id => {
    const account = db.prepare('SELECT users.email,notification_preferences.verified FROM users LEFT JOIN notification_preferences ON notification_preferences.user_id=users.id WHERE users.id=?').get(id);
    return Boolean(account?.verified && (environmentStaff.has(account.email) || db.prepare('SELECT 1 FROM support_roles WHERE user_id=?').get(id)));
  };
  const capabilities = current => ({ aiAvailable: Boolean(ai.available), staff: role(current.id) });
  function staff(current) {
    if (!role(current.id)) throw new SupportError(403, 'This account does not have access to the support inbox.');
  }
  function validateId(id) {
    if (typeof id !== 'string' || !uuid.test(id)) throw new SupportError(400, 'Select a valid support conversation.');
    return id.toLowerCase();
  }
  function conversation(id, owner) {
    const row = db.prepare('SELECT * FROM support_conversations WHERE id=?').get(validateId(id));
    if (!row || owner !== undefined && row.owner_user_id !== owner) throw new SupportError(404, 'Support conversation not found.');
    return row;
  }
  function latest(owner, onlyActive = false) {
    return db.prepare(`SELECT * FROM support_conversations WHERE owner_user_id=? ${onlyActive ? "AND status!='closed'" : ''} ORDER BY created_at DESC,rowid DESC LIMIT 1`).get(owner);
  }
  function create(owner) {
    if (stopping) throw new SupportError(503, 'Support is restarting. Please try again shortly.');
    const recent = db.prepare('SELECT count(*) AS n FROM support_conversations WHERE owner_user_id=? AND created_at>?').get(owner, now() - 600000).n;
    if (recent >= 5) throw new SupportError(429, 'Please continue an existing support conversation or try again later.');
    const id = randomUUID(), time = now();
    db.prepare("INSERT INTO support_conversations(id,owner_user_id,status,created_at,updated_at) VALUES (?,?,'ai',?,?)").run(id, owner, time, time);
    audit(id, owner, 'opened');
    return conversation(id, owner);
  }
  function target(owner, suppliedId) {
    const row = suppliedId === undefined ? latest(owner, true) ?? create(owner) : conversation(suppliedId, owner);
    if (row.status === 'closed') throw new SupportError(409, 'This conversation is closed. Start a new conversation for more help.');
    return row;
  }
  function append(row, author, messageRole, content, source, clientMessageId = null, replyTo = null) {
    const time = now();
    const result = db.prepare('INSERT INTO support_messages(conversation_id,author_user_id,role,content,source,created_at,client_message_id,reply_to_message_id) VALUES (?,?,?,?,?,?,?,?)').run(row.id, author, messageRole, content, source, time, clientMessageId, replyTo);
    db.prepare('UPDATE support_conversations SET updated_at=? WHERE id=?').run(time, row.id);
    return Number(result.lastInsertRowid);
  }
  function text(value) {
    if (typeof value !== 'string' || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(value) || !value.trim() || value.length > 2000) throw new SupportError(400, 'Enter a support message of 1–2,000 characters.');
    return value.trim();
  }
  function requestId(value) {
    if (typeof value !== 'string' || !uuid.test(value)) throw new SupportError(400, 'A valid client message ID is required. Please refresh and try again.');
    return value.toLowerCase();
  }
  function cursor(value) {
    if (value === undefined || value === null) return null;
    if (!/^[1-9][0-9]*$/.test(String(value)) || !Number.isSafeInteger(Number(value))) throw new SupportError(400, 'Select a valid history cursor.');
    return Number(value);
  }
  function pageCursor(value) {
    if (value === undefined || value === null) return null;
    const match = /^([0-9]+):([a-f0-9-]{36})$/.exec(String(value));
    if (!match || !Number.isSafeInteger(Number(match[1])) || !uuid.test(match[2])) throw new SupportError(400, 'Select a valid conversation page.');
    return { time: Number(match[1]), id: match[2].toLowerCase() };
  }
  function view(row, before = null) {
    const messages = db.prepare(`SELECT id,role,content,source,created_at AS createdAt,client_message_id AS clientMessageId FROM support_messages WHERE conversation_id=? ${before ? 'AND id<?' : ''} ORDER BY id DESC LIMIT ?`).all(...(before ? [row.id, before, historyLimit] : [row.id, historyLimit])).reverse();
    const first = messages[0]?.id;
    const more = first && db.prepare('SELECT 1 FROM support_messages WHERE conversation_id=? AND id<? LIMIT 1').get(row.id, first);
    const agentName = row.assigned_agent_id ? db.prepare('SELECT name FROM users WHERE id=?').get(row.assigned_agent_id)?.name : null;
    return { id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, assignedAgentName: agentName ?? null, messages, olderCursor: more ? first : null };
  }
  function clientView(current, { conversationId, before } = {}) {
    const row = conversationId === undefined ? latest(current.id) : conversation(conversationId, current.id);
    return { conversation: row ? view(row, cursor(before)) : null, capabilities: capabilities(current), processing: Boolean(row?.status === 'ai' && [...jobs.values()].some(job => job.conversationId === row.id)) };
  }
  function clientList(current, { before } = {}) {
    const earlier = pageCursor(before);
    const found = db.prepare(`SELECT * FROM support_conversations WHERE owner_user_id=?
      ${earlier ? 'AND (updated_at<? OR (updated_at=? AND id<?))' : ''}
      ORDER BY updated_at DESC,id DESC LIMIT 51`).all(current.id, ...(earlier ? [earlier.time, earlier.time, earlier.id] : []));
    const rows = found.slice(0, 50), last = rows.at(-1);
    return { conversations: rows.map(row => ({ id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at })), nextCursor: found.length > 50 ? `${last.updated_at}:${last.id}` : null, capabilities: capabilities(current) };
  }
  function markWaiting(row, actor) {
    if (row.status !== 'ai') return;
    db.prepare("UPDATE support_conversations SET status='waiting',updated_at=? WHERE id=? AND status='ai'").run(now(), row.id);
    controllers.get(row.id)?.abort();
    append(row, null, 'system', 'Your request has been added to the human support queue. An Academy agent can read this conversation and reply here. A reply may take time; you are not connected to an agent yet.', 'system');
    audit(row.id, actor, 'handoff-requested');
  }
  function handoff(current, { conversationId } = {}) {
    const row = target(current.id, conversationId);
    markWaiting(row, current.id);
    return clientView(current, { conversationId: row.id });
  }
  function serialized(id, work) {
    const task = (queues.get(id) ?? Promise.resolve()).then(work);
    const settled = task.catch(() => {});
    queues.set(id, settled);
    settled.then(() => { if (queues.get(id) === settled) queues.delete(id); });
    return task;
  }
  function waitForReply(promise, signal) {
    return new Promise((resolve, reject) => {
      const abort = () => reject(Object.assign(new Error('Support response cancelled.'), { name: 'AbortError' }));
      if (signal.aborted) { abort(); return; }
      signal.addEventListener('abort', abort, { once: true });
      Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
  }
  async function answer(row, messageId) {
    if (stopping || conversation(row.id).status !== 'ai') return;
    const controller = new AbortController();
    controllers.set(row.id, controller);
    let reply;
    try {
      if (active >= maxConcurrent) reply = { source: 'academy-guide', text: 'The AI assistant is busy right now. You can try again shortly or request an Academy agent using “Talk to an agent”. Your message has been saved.' };
      else {
        active++;
        try {
          const messages = db.prepare(`SELECT role,content FROM support_messages WHERE conversation_id=? AND role IN ('user','assistant')
            AND COALESCE(reply_to_message_id,id)<=?
            ORDER BY COALESCE(reply_to_message_id,id) DESC,CASE WHEN role='assistant' THEN 1 ELSE 0 END DESC LIMIT 12`).all(row.id, messageId).reverse().map(({ role, content }) => ({ role, content }));
          // Account records, credentials, staff notes and profile details are never
          // sent to the language model. Only this owner's chat text is provided.
          reply = await waitForReply(ai.reply({ messages, signal: controller.signal }), controller.signal);
        } finally { active--; }
      }
    } catch (error) {
      if (controller.signal.aborted || stopping || error.name === 'AbortError') return;
      reply = { source: 'academy-guide', text: 'The AI assistant is temporarily unavailable. Your message has been saved. Please try again shortly, or choose “Talk to an agent” for human support.' };
    } finally { if (controllers.get(row.id) === controller) controllers.delete(row.id); }
    // An explicit handoff or agent action is synchronous and can happen while the
    // provider is awaiting network I/O. Never append a late AI answer afterward.
    if (stopping || controller.signal.aborted || conversation(row.id).status !== 'ai') return;
    if (typeof reply?.text !== 'string' || !reply.text.trim() || reply.text.length > 6000) reply = { source: 'academy-guide', text: 'The AI assistant could not provide an answer. Your message has been saved. Please try again or request an Academy agent.' };
    append(row, null, 'assistant', reply.text, reply.source === 'ai' ? 'ai' : 'academy-guide', null, messageId);
  }
  async function message(current, data) {
    const content = text(data.message), clientId = requestId(data.clientMessageId);
    const duplicate = db.prepare('SELECT conversation_id,content,role FROM support_messages WHERE author_user_id=? AND client_message_id=?').get(current.id, clientId);
    if (duplicate) {
      if (duplicate.role !== 'user' || duplicate.content !== content || data.conversationId !== undefined && validateId(data.conversationId) !== duplicate.conversation_id) throw new SupportError(409, 'This message ID was already used for a different message.');
      return clientView(current, { conversationId: duplicate.conversation_id });
    }
    const recent = db.prepare("SELECT count(*) AS n FROM support_messages WHERE author_user_id=? AND role='user' AND created_at>?").get(current.id, now() - 600000).n;
    if (recent >= 20) throw new SupportError(429, 'You have sent many support messages. Please wait a few minutes before sending more.');
    const row = target(current.id, data.conversationId);
    const id = append(row, current.id, 'user', content, 'client', clientId);
    if (row.status !== 'ai') return clientView(current, { conversationId: row.id });
    if (wantsHuman(content)) { markWaiting(row, current.id); return clientView(current, { conversationId: row.id }); }
    const job = { conversationId: row.id };
    jobs.set(id, job);
    try { await serialized(row.id, () => answer(row, id)); }
    finally { jobs.delete(id); }
    return clientView(current, { conversationId: row.id });
  }
  function staffView(current, id, before) {
    staff(current);
    const row = conversation(id);
    const client = db.prepare('SELECT name,email FROM users WHERE id=?').get(row.owner_user_id);
    return { conversation: { ...view(row, cursor(before)), canReply: row.status === 'assigned' && row.assigned_agent_id === current.id }, client, capabilities: capabilities(current) };
  }
  function staffList(current, { before, status = 'active' } = {}) {
    staff(current);
    const earlier = pageCursor(before);
    const filters = { active: ['waiting', 'assigned'], waiting: ['waiting'], assigned: ['assigned'], closed: ['closed'], all: ['waiting', 'assigned', 'closed'] };
    if (!Object.hasOwn(filters, status)) throw new SupportError(400, 'Select active, waiting, assigned, closed, or all support conversations.');
    const statuses = filters[status];
    const found = db.prepare(`SELECT support_conversations.*,users.name AS client_name,users.email AS client_email,
      (SELECT content FROM support_messages WHERE conversation_id=support_conversations.id ORDER BY id DESC LIMIT 1) AS preview
      FROM support_conversations JOIN users ON users.id=owner_user_id
      WHERE status IN (${statuses.map(() => '?').join(',')}) ${earlier ? 'AND (updated_at<? OR (updated_at=? AND support_conversations.id<?))' : ''}
      ORDER BY updated_at DESC,support_conversations.id DESC LIMIT 51`).all(...statuses, ...(earlier ? [earlier.time, earlier.time, earlier.id] : []));
    const rows = found.slice(0, 50), last = rows.at(-1);
    return { conversations: rows.map(row => ({ id: row.id, status: row.status, createdAt: row.created_at, updatedAt: row.updated_at, assignedAgentName: row.assigned_agent_id ? db.prepare('SELECT name FROM users WHERE id=?').get(row.assigned_agent_id)?.name ?? null : null, client: { name: row.client_name, email: row.client_email }, preview: row.preview ?? '' })), nextCursor: found.length > 50 ? `${last.updated_at}:${last.id}` : null, capabilities: capabilities(current) };
  }
  function staffAction(current, id, action, data = {}) {
    staff(current);
    const row = conversation(id);
    if (action === 'claim') {
      if (row.status === 'assigned' && row.assigned_agent_id === current.id) return staffView(current, id);
      if (row.status !== 'waiting') throw new SupportError(409, 'This conversation is no longer waiting for an agent.');
      db.prepare("UPDATE support_conversations SET status='assigned',assigned_agent_id=?,updated_at=? WHERE id=? AND status='waiting'").run(current.id, now(), row.id);
      append(row, null, 'system', 'An Academy agent has taken responsibility for this conversation and will reply here.', 'system');
      audit(row.id, current.id, 'claimed');
    } else {
      if (row.status !== 'assigned' || row.assigned_agent_id !== current.id) throw new SupportError(409, 'Claim this waiting conversation before replying or closing it. Only its assigned agent can manage it.');
      if (action === 'reply') {
        const content = text(data.message), clientId = requestId(data.clientMessageId);
        const duplicate = db.prepare('SELECT conversation_id,role,content FROM support_messages WHERE author_user_id=? AND client_message_id=?').get(current.id, clientId);
        if (duplicate) {
          if (duplicate.conversation_id !== row.id || duplicate.role !== 'agent' || duplicate.content !== content) throw new SupportError(409, 'This message ID was already used for a different message.');
          return staffView(current, id);
        }
        const recent = db.prepare("SELECT count(*) AS n FROM support_messages WHERE author_user_id=? AND role='agent' AND created_at>?").get(current.id, now() - 60000).n;
        if (recent >= 60) throw new SupportError(429, 'Please wait before sending more agent replies.');
        append(row, current.id, 'agent', content, 'agent', clientId);
        audit(row.id, current.id, 'replied');
      } else if (action === 'close') {
        db.prepare("UPDATE support_conversations SET status='closed',updated_at=? WHERE id=?").run(now(), row.id);
        append(row, null, 'system', 'The Academy agent closed this conversation. Your history is saved. You can start a new conversation whenever you need more help.', 'system');
        audit(row.id, current.id, 'closed');
      } else throw new SupportError(404, 'Support action not found.');
    }
    return staffView(current, id);
  }
  return {
    clientView, clientList, message, handoff, staffView, staffList, staffAction,
    close() {
      if (closePromise) return closePromise;
      stopping = true;
      for (const controller of controllers.values()) controller.abort();
      ai.close?.();
      closePromise = Promise.allSettled([...queues.values()]);
      return closePromise;
    },
  };
}
