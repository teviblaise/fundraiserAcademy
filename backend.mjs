import { DatabaseSync } from 'node:sqlite';
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { createAccount, advanceMarket, openTrade, closeTrade, refreshRisk, MARKETS, ensureTools, setLimits, updateStops, placeLimit, addAlert, notify } from './public/simulator.js';
import { createDelivery } from './delivery.mjs';
import {createCertificates,certificateSvg} from './certificates.mjs';

const scrypt = promisify(scryptCallback);
const hash = value => createHash('sha256').update(value).digest('hex');
const sessionLifetime = 7 * 86400000;
class RequestError extends Error { constructor(status, message) { super(message); this.status = status; } }
export function createBackend(databasePath) {
  mkdirSync(path.dirname(databasePath), { recursive: true });
  const db = new DatabaseSync(databasePath);
  db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
    CREATE TABLE IF NOT EXISTS users (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL, market TEXT NOT NULL, password TEXT NOT NULL, created_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), expires INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS accounts (user_id INTEGER PRIMARY KEY REFERENCES users(id), state TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS events (id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id), kind TEXT NOT NULL, detail TEXT NOT NULL, created_at INTEGER NOT NULL);`);
  db.prepare('DELETE FROM sessions WHERE expires < ?').run(Date.now());
  const delivery=createDelivery(db,databasePath);
  const certificates=createCertificates(db);
  const rates = new Map();
  const respond = (res, status, data) => { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); res.end(JSON.stringify(data)); };
  function limit(req, group, max, duration) {
    const key = `${req.socket.remoteAddress}:${group}`;
    const now = Date.now(); const value = rates.get(key);
    if (!value || value.until < now) rates.set(key, { count: 1, until: now + duration });
    else if (++value.count > max) throw new RequestError(429, 'Too many requests. Please try again later.');
    if (rates.size > 10000) for (const [k, v] of rates) if (v.until < now) rates.delete(k);
  }
  async function body(req) {
    if (req.headers['x-requested-with'] !== 'FundraiserAcademy' || !req.headers['content-type']?.startsWith('application/json')) throw new RequestError(403, 'Use the website to submit this request.');
    const origin = req.headers.origin;
    const allowed = process.env.APP_ORIGIN;
    if (origin && (allowed ? origin !== allowed : new URL(origin).host !== req.headers.host)) throw new RequestError(403, 'Request origin is not allowed.');
    let content = '';
    for await (const chunk of req) { content += chunk; if (Buffer.byteLength(content) > 16384) throw new RequestError(413, 'Request is too large.'); }
    try { const data = JSON.parse(content); if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error(); return data; }
    catch { throw new RequestError(400, 'Invalid JSON request.'); }
  }
  function cookie(res, token, maxAge = sessionLifetime / 1000) {
    res.setHeader('Set-Cookie', `fa_session=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${process.env.COOKIE_SECURE === 'true' ? '; Secure' : ''}`);
  }
  function user(req) {
    const token = /(?:^|;\s*)fa_session=([a-f0-9]{64})(?:;|$)/.exec(req.headers.cookie || '')?.[1];
    if (!token) throw new RequestError(401, 'Please log in to continue.');
    const row = db.prepare('SELECT users.id, users.email, users.name, users.market FROM sessions JOIN users ON users.id=sessions.user_id WHERE sessions.token=? AND sessions.expires>?').get(hash(token), Date.now());
    if (!row) throw new RequestError(401, 'Your session has expired. Please log in again.');
    return row;
  }
  function session(res, id) { const token = randomBytes(32).toString('hex'); db.prepare('INSERT INTO sessions VALUES (?,?,?)').run(hash(token), id, Date.now() + sessionLifetime); cookie(res, token); }
  const load = id => ensureTools(JSON.parse(db.prepare('SELECT state FROM accounts WHERE user_id=?').get(id).state));
  const save = (id, state) => db.prepare('UPDATE accounts SET state=? WHERE user_id=?').run(JSON.stringify(state), id);
  const event = (id, kind, detail) => db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (?,?,?,?)').run(id, kind, JSON.stringify(detail), Date.now());
  function commit(id, state, kind, detail) {
    const previous=load(id);
    const oldNotices=new Set(previous.notifications.map(n=>`${n.createdAt}:${n.id}`));
    db.exec('BEGIN');
    try { certificates.issue(id,state); const fresh=state.notifications.filter(n=>!oldNotices.has(`${n.createdAt}:${n.id}`)); save(id,state); event(id,kind,detail); delivery.enqueue(id,state,fresh); db.exec('COMMIT'); }
    catch (error) { db.exec('ROLLBACK'); throw error; }
  }
  // Existing passed attempts also receive a certificate after this feature is installed.
  for(const row of db.prepare('SELECT user_id,state FROM accounts').all()) {
    const state=ensureTools(JSON.parse(row.state));save(row.user_id,state);
    if(state.locked==='Profit target achieved')commit(row.user_id,state,'certificate-check',{});
  }
  const timer = setInterval(() => {
    try {
      // Only accounts with an active session advance; all fills and risk checks run on the server.
      const rows = db.prepare('SELECT accounts.user_id,accounts.state FROM accounts WHERE EXISTS (SELECT 1 FROM sessions WHERE sessions.user_id=accounts.user_id AND sessions.expires>?)').all(Date.now());
      for (const row of rows) {
        const state = ensureTools(JSON.parse(row.state));
        if (state.locked) { refreshRisk(state); save(row.user_id,state); if (state.locked) continue; }
        const count = state.history.length;
        const notices = state.nextNotice;
        advanceMarket(state);
        if (state.nextNotice !== notices || state.history.length !== count || state.locked) commit(row.user_id,state,'simulation-event',{ tick:state.ticks, closedTrades:state.history.slice(0,state.history.length-count), notifications:state.notifications.filter(n=>n.id>=notices), status:state.locked });
        else save(row.user_id,state);
      }
    } catch (error) { console.error('Simulation tick failed:', error.message); }
  }, 1500);
  timer.unref();

  async function handle(req, res, pathname) {
    try {
      if(req.method==='POST' && pathname==='/api/email/verify') {
        limit(req,'verification',30,600000);
        const data=await body(req);
        try {delivery.verify(data.token);}catch(error){throw new RequestError(400,error.message);}
        respond(res,200,{message:'Email confirmed. Trade and price-alert emails are enabled. You can disable them in your dashboard.'});return;
      }
      if (req.method === 'POST' && ['/api/register','/api/login'].includes(pathname)) {
        limit(req,'auth',20,600000);
        const data = await body(req);
        const email = typeof data.email === 'string' ? data.email.trim().toLowerCase() : '';
        const password = typeof data.password === 'string' ? data.password : '';
        if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 || password.length < 12 || password.length > 128) throw new RequestError(400,'Enter a valid email and a password with 12–128 characters.');
        if (pathname === '/api/register') {
          const name = typeof data.name === 'string' ? data.name.trim() : '';
          if (!name || name.length > 100 || !['I trade forex','I trade crypto','I trade both'].includes(data.market) || data.consent !== true) throw new RequestError(400,'Enter your name, select your market, and accept the registration notice.');
          const salt = randomBytes(16).toString('hex');
          const passwordHash = (await scrypt(password,salt,64)).toString('hex');
          let id;
          db.exec('BEGIN');
          try {
            id = Number(db.prepare('INSERT INTO users(email,name,market,password,created_at) VALUES (?,?,?,?,?)').run(email,name,data.market,`${salt}:${passwordHash}`,Date.now()).lastInsertRowid);
            db.prepare('INSERT INTO accounts VALUES (?,?)').run(id,JSON.stringify(createAccount()));
            event(id,'registration',{}); db.exec('COMMIT');
          } catch (error) { db.exec('ROLLBACK'); if (error.code?.includes('CONSTRAINT') || error.message.includes('UNIQUE')) throw new RequestError(409,'Unable to register this email. Try logging in.'); throw error; }
          session(res,id); respond(res,201,{user:{id,name,email,market:data.market}}); return;
        }
        const row = db.prepare('SELECT * FROM users WHERE email=?').get(email);
        const [salt, stored] = (row?.password || '00000000000000000000000000000000:' + '0'.repeat(128)).split(':');
        const actual = await scrypt(password,salt,64);
        if (!row || !timingSafeEqual(actual,Buffer.from(stored,'hex'))) throw new RequestError(401,'Email or password is incorrect.');
        session(res,row.id); respond(res,200,{user:{id:row.id,name:row.name,email:row.email,market:row.market}}); return;
      }
      const current = user(req);
      if (req.method === 'GET' && pathname === '/api/me') { respond(res,200,{user:current}); return; }
      if(req.method==='GET' && pathname==='/api/certificates'){respond(res,200,{certificates:certificates.list(current.id)});return;}
      if(req.method==='GET' && pathname==='/api/certificate-preferences'){respond(res,200,certificates.preferences(current.id));return;}
      if(req.method==='POST' && pathname==='/api/certificate-preferences'){
        limit(req,'certificate-preferences',30,600000);const data=await body(req);
        try{respond(res,200,certificates.setPreferences(current.id,data));}catch(error){throw new RequestError(400,error.message);}return;
      }
      const certificatePath=/^\/api\/certificates\/([a-f0-9-]{36})(\.svg)?$/.exec(pathname);
      if(req.method==='GET' && certificatePath){
        const certificate=certificates.get(current.id,certificatePath[1]);
        if(!certificate)throw new RequestError(404,'Certificate not found.');
        if(certificatePath[2]){res.writeHead(200,{'Content-Type':'image/svg+xml; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff','Content-Security-Policy':"default-src 'none'; style-src 'unsafe-inline'"});res.end(certificateSvg(certificate));}
        else respond(res,200,{certificate});return;
      }
      if(req.method==='GET' && pathname==='/api/notification-settings') {respond(res,200,delivery.status(current.id));return;}
      if(req.method==='POST' && ['/api/push/subscribe','/api/push/unsubscribe','/api/email/request-verification','/api/email/preferences'].includes(pathname)) {
        limit(req,'notification-settings',20,600000);
        const data=await body(req);
        try {
          if(pathname==='/api/push/subscribe')delivery.subscribe(current.id,data.subscription);
          else if(pathname==='/api/push/unsubscribe')delivery.unsubscribe(current.id,data.endpoint);
          else if(pathname==='/api/email/request-verification')await delivery.requestVerification(current.id);
          else {if(typeof data.enabled!=='boolean')throw new Error('Select a valid email preference.');delivery.setEmail(current.id,data.enabled);}
        }catch(error){throw new RequestError(400,error.message);}
        respond(res,200,delivery.status(current.id));return;
      }
      if (req.method === 'POST' && pathname === '/api/logout') {
        const data=await body(req);
        if(typeof data.endpoint==='string')delivery.unsubscribe(current.id,data.endpoint);
        const token = /fa_session=([a-f0-9]{64})/.exec(req.headers.cookie || '')?.[1];
        db.prepare('DELETE FROM sessions WHERE token=?').run(hash(token)); cookie(res,'',0); respond(res,200,{ok:true}); return;
      }
      if (req.method === 'GET' && pathname === '/api/account') { respond(res,200,{account:load(current.id)}); return; }
      if (req.method === 'GET' && pathname === '/api/journal') { respond(res,200,{notice:'Server-recorded synthetic trading simulation; not proof of real-market trading ability.',exportedAt:new Date().toISOString(),account:load(current.id)}); return; }
      if (req.method==='POST' && ['/api/limits','/api/trades/protection','/api/orders','/api/orders/cancel','/api/alerts','/api/alerts/remove','/api/notifications/read'].includes(pathname)) {
        limit(req,'trades',120,60000);
        const data=await body(req); const state=load(current.id);
        try {
          if(pathname==='/api/limits') setLimits(state,data);
          else if(pathname==='/api/trades/protection') updateStops(state,data.id,data.stopLoss??null,data.takeProfit??null);
          else if(pathname==='/api/orders') placeLimit(state,data);
          else if(pathname==='/api/alerts') addAlert(state,data);
          else if(pathname==='/api/notifications/read') for(const n of state.notifications) n.read=true;
          else {
            const key=pathname==='/api/orders/cancel'?'pending':'alerts';
            if(!Number.isInteger(data.id) || !state[key].some(item=>item.id===data.id)) throw new Error('This item no longer exists.');
            state[key]=state[key].filter(item=>item.id!==data.id);
            if(key==='pending') notify(state,'Limit order cancelled',`Pending order #${data.id} cancelled.`);
          }
          commit(current.id,state,pathname.slice(5),data);
        } catch(error) { throw new RequestError(400,error.message); }
        respond(res,200,{account:state}); return;
      }
      if (req.method === 'POST' && ['/api/trades','/api/trades/close','/api/account/reset'].includes(pathname)) {
        limit(req,'trades',120,60000);
        const data = await body(req);
        let state = load(current.id);
        if (pathname === '/api/account/reset') {
          event(current.id,'reset-archive',state);
          state = createAccount(); commit(current.id,state,'reset',{});
          respond(res,200,{account:state,message:'Practice account reset. Earlier attempts remain in the server audit record.'}); return;
        }
        try {
          if (pathname === '/api/trades') {
            if (!MARKETS[data.symbol]) throw new Error('Select a supported market.');
            const trade = openTrade(state,{symbol:data.symbol,side:data.side,quantity:data.quantity,stopLoss:data.stopLoss ?? null,takeProfit:data.takeProfit ?? null});
            commit(current.id,state,'trade-open',trade);
          } else {
            if (!Number.isInteger(data.id)) throw new Error('Select a valid position.');
            closeTrade(state,data.id); refreshRisk(state);
            commit(current.id,state,'trade-close',state.history[0]);
          }
        } catch (error) { if (!(error instanceof RequestError)) throw new RequestError(400,error.message); throw error; }
        respond(res,200,{account:state}); return;
      }
      throw new RequestError(404,'API endpoint not found.');
    } catch (error) { if (!error.status) console.error('API request failed:',error.message); respond(res,error.status || 500,{error:error.status ? error.message : 'Server error. Please try again.'}); }
  }
  return { handle, close() { clearInterval(timer); delivery.close(); db.close(); } };
}
