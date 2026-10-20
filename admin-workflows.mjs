import { randomUUID } from 'node:crypto';
import { contractConsentStatement } from './contracts.mjs';

export class AdminWorkflowError extends Error {
  constructor(status, message, code) { super(message); this.status = status; if (code) this.code = code; }
}
const states = new Set(['pending_review','needs_information','approved','rejected']);
const validId = value => Number.isSafeInteger(value) && value > 0;
const requiredText = (value, label, max, min = 1) => {
  if (typeof value !== 'string' || /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u.test(value) || value.trim().length < min || value.trim().length > max) throw new AdminWorkflowError(400, `Provide ${label} with ${min}–${max} characters and no control characters.`);
  return value.trim();
};
const pageNumber = (value, fallback, min, max) => {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'string' && !/^\d+$/.test(value)) throw new AdminWorkflowError(400, 'Use valid administrative pagination.');
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < min || parsed > max) throw new AdminWorkflowError(400, 'Use valid administrative pagination.');
  return parsed;
};

export function createAdminWorkflows(db, { access, contracts, leaderboard, now = Date.now } = {}) {
  if (!access || !contracts) throw new TypeError('Administrator access and contracts services are required.');
  db.exec(`CREATE TABLE IF NOT EXISTS admin_notes (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),actor_user_id INTEGER NOT NULL REFERENCES users(id),
    text TEXT NOT NULL,created_at INTEGER NOT NULL);
    CREATE INDEX IF NOT EXISTS admin_notes_user ON admin_notes(user_id,created_at DESC,id DESC);
    CREATE TABLE IF NOT EXISTS sponsorship_reviews (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),id TEXT UNIQUE NOT NULL,status TEXT NOT NULL,
    revision INTEGER NOT NULL,contract_id TEXT NOT NULL REFERENCES contract_documents(id),contract_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL,certificate_id TEXT NOT NULL REFERENCES certificates(id),signature_id TEXT NOT NULL REFERENCES contract_signatures(id),
    client_message TEXT NOT NULL DEFAULT '',updated_by INTEGER NOT NULL REFERENCES users(id),updated_at INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS sponsorship_review_history (
    id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),review_id TEXT NOT NULL,
    revision INTEGER NOT NULL,status TEXT NOT NULL,contract_id TEXT NOT NULL,contract_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL,certificate_id TEXT NOT NULL,signature_id TEXT NOT NULL,reason TEXT NOT NULL,
    client_message TEXT NOT NULL,actor_user_id INTEGER NOT NULL REFERENCES users(id),created_at INTEGER NOT NULL,
    UNIQUE(user_id,revision));
    CREATE INDEX IF NOT EXISTS sponsorship_review_history_user ON sponsorship_review_history(user_id,revision DESC);
    CREATE TRIGGER IF NOT EXISTS admin_notes_no_update BEFORE UPDATE ON admin_notes
      BEGIN SELECT RAISE(ABORT,'Administrative notes are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS admin_notes_no_delete BEFORE DELETE ON admin_notes
      BEGIN SELECT RAISE(ABORT,'Administrative notes are append-only'); END;
    CREATE TRIGGER IF NOT EXISTS sponsorship_review_history_no_update BEFORE UPDATE ON sponsorship_review_history
      BEGIN SELECT RAISE(ABORT,'Sponsorship review history is immutable'); END;
    CREATE TRIGGER IF NOT EXISTS sponsorship_review_history_no_delete BEFORE DELETE ON sponsorship_review_history
      BEGIN SELECT RAISE(ABORT,'Sponsorship review history is immutable'); END;`);

  function transaction(work) {
    const owned = !db.isTransaction;
    if (owned) db.exec('BEGIN IMMEDIATE');
    try { const value = work(); if (value && typeof value.then === 'function') throw new TypeError('Administrative transactions must be synchronous.'); if (owned) db.exec('COMMIT'); return value; }
    catch (failure) { if (owned) db.exec('ROLLBACK'); throw failure; }
  }
  function target(userId) {
    if (!validId(userId)) throw new AdminWorkflowError(400, 'Choose a registered trader.');
    const row = db.prepare('SELECT id,name,email FROM users WHERE id=?').get(userId);
    if (!row) throw new AdminWorkflowError(404, 'Trader not found.');
    return row;
  }
  function callback(work, value) {
    if (!work) return null;
    if (typeof work !== 'function') throw new TypeError('Administrative callbacks must be functions.');
    const result = work(value);
    if (result && typeof result.then === 'function') throw new TypeError('Administrative callbacks must be synchronous.');
    return result;
  }
  function updateStatus(actorId, userId, data, { onRevoke } = {}) {
    return transaction(() => {
      access.require(actorId, 'traders.manage'); target(userId);
      const reason = requiredText(data?.reason, 'an administrative reason', 500, 3);
      const status = data?.status;
      if (status === 'suspended' && typeof onRevoke !== 'function') throw new TypeError('Account suspension requires synchronous session revocation.');
      access.assertAccountChange(actorId, userId, status);
      const previous = access.accountStatus(userId).status;
      const time = now();
      db.prepare(`INSERT INTO admin_account_status(user_id,status,reason,updated_by,updated_at) VALUES (?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,reason=excluded.reason,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(userId,status,reason,actorId,time);
      const revoked = status === 'suspended' ? callback(onRevoke,{userId,action:'suspended'}) : null;
      access.audit(actorId,'trader.status-changed',{targetId:userId,reason,detail:{status,previousStatus:previous,sessionsRevoked:status==='suspended',deviceNotificationsRevoked:status==='suspended'}});
      return {userId,status,reason,updatedAt:time,updatedBy:actorId,...(revoked && Number.isSafeInteger(revoked.count) ? {sessionsRevoked:revoked.count} : {})};
    });
  }
  function revokeSessions(actorId, userId, data, { onRevoke } = {}) {
    return transaction(() => {
      access.require(actorId,'traders.manage');target(userId);
      const reason = requiredText(data?.reason,'an administrative reason',500,3);
      if (typeof onRevoke !== 'function') throw new TypeError('Session revocation requires a synchronous revocation callback.');
      const revoked = callback(onRevoke,{userId,action:'sessions-revoked'});
      const count = Number.isSafeInteger(revoked?.count) ? revoked.count : 0;
      access.audit(actorId,'trader.sessions-revoked',{targetId:userId,reason,detail:{count,sessionsRevoked:true,deviceNotificationsRevoked:true}});
      return {userId,revokedCount:count};
    });
  }
  function appendNote(actorId, userId, data) {
    return transaction(() => {
      access.require(actorId,'reviews.write');target(userId);
      const text = requiredText(data?.text,'a note',2000);
      const reason = requiredText(data?.reason,'an administrative reason',500,3);
      const id=randomUUID(),time=now();
      db.prepare('INSERT INTO admin_notes(id,user_id,actor_user_id,text,created_at) VALUES (?,?,?,?,?)').run(id,userId,actorId,text,time);
      access.audit(actorId,'trader.note-added',{targetId:userId,reason,detail:{subjectType:'internal-note'}});
      return {id,userId,actorId,actorName:target(actorId).name,text,createdAt:time};
    });
  }
  function notes(userId,{limit=50,offset=0}={}) {
    target(userId);limit=pageNumber(limit,50,1,100);offset=pageNumber(offset,0,0,1000000);
    const total=db.prepare('SELECT count(*) total FROM admin_notes WHERE user_id=?').get(userId).total;
    const entries=db.prepare('SELECT n.id,n.user_id AS userId,n.actor_user_id AS actorId,u.name AS actorName,n.text,n.created_at AS createdAt FROM admin_notes n JOIN users u ON u.id=n.actor_user_id WHERE n.user_id=? ORDER BY n.created_at DESC,n.id DESC LIMIT ? OFFSET ?').all(userId,limit,offset);
    return {entries,total,limit,offset};
  }
  function eligibility(userId) {
    target(userId);
    if (access.isSuspended(userId)) return {eligible:false,status:'account_suspended'};
    const qualifying=db.prepare("SELECT initial_balance,final_balance,profit_percent,trading_days,issued_at FROM certificates WHERE user_id=? AND price_mode='reference' AND trading_days>=3 AND profit_percent>=10").all(userId).some(certificate=>{
      const result=(certificate.final_balance/certificate.initial_balance-1)*100;
      return Number.isFinite(certificate.initial_balance)&&certificate.initial_balance>0&&Number.isFinite(certificate.final_balance)&&Number.isFinite(certificate.profit_percent)&&Number.isFinite(result)&&result>=10&&Math.abs(result-certificate.profit_percent)<=Math.max(1e-8,Math.abs(result)*1e-10)&&Number.isSafeInteger(certificate.trading_days)&&Number.isSafeInteger(certificate.issued_at)&&certificate.issued_at>0;
    });
    if (!qualifying) return {eligible:false,status:'assessment_required'};
    const document=db.prepare('SELECT d.id,d.version,d.hash,d.published_at FROM contract_documents d JOIN active_contract a ON a.contract_id=d.id WHERE a.singleton=1').get();
    if (!document) return {eligible:false,status:'awaiting_contract'};
    const row=db.prepare(`SELECT s.id AS signature_id,s.user_id,s.contract_id,s.contract_version,s.contract_hash,s.certificate_id,s.consent_statement,s.signed_at,
      c.user_id AS certificate_owner,c.price_mode,c.initial_balance,c.final_balance,c.profit_percent,c.trading_days,c.issued_at
      FROM contract_signatures s LEFT JOIN certificates c ON c.id=s.certificate_id WHERE s.user_id=? AND s.contract_id=?`).get(userId,document.id);
    if (!row) return {eligible:false,status:'signature_required',contractId:document.id,contractVersion:document.version,contractHash:document.hash};
    const result=(row.final_balance/row.initial_balance-1)*100;
    if(row.certificate_owner!==userId || row.price_mode!=='reference' || !Number.isFinite(row.initial_balance) || row.initial_balance<=0 || !Number.isFinite(row.final_balance) || !Number.isFinite(row.profit_percent) || row.profit_percent<10 || !Number.isFinite(result) || result<10 || Math.abs(result-row.profit_percent)>Math.max(1e-8,Math.abs(result)*1e-10) || !Number.isSafeInteger(row.trading_days) || row.trading_days<3 || !Number.isSafeInteger(row.issued_at) || row.issued_at<=0 || row.contract_version!==document.version || row.contract_hash!==document.hash || row.consent_statement!==contractConsentStatement || !Number.isSafeInteger(row.signed_at) || row.signed_at<Math.max(row.issued_at,document.published_at)) return {eligible:false,status:'assessment_required',contractId:document.id,contractVersion:document.version,contractHash:document.hash};
    // The same immutable qualifying snapshot drives the public ranking. There is
    // no browser-supplied score or current practice-account balance in this gate.
    if (leaderboard?.preferences && !leaderboard.preferences(userId).eligibility?.eligible) return {eligible:false,status:'assessment_required',contractId:document.id,contractVersion:document.version,contractHash:document.hash};
    const emailVerified=Boolean(db.prepare('SELECT verified FROM notification_preferences WHERE user_id=?').get(userId)?.verified);
    return {eligible:emailVerified,qualified:true,status:emailVerified?'eligible':'email_confirmation_required',userId,contractId:document.id,contractVersion:document.version,contractHash:document.hash,certificateId:row.certificate_id,signatureId:row.signature_id};
  }
  function stored(userId) {return db.prepare('SELECT * FROM sponsorship_reviews WHERE user_id=?').get(userId);}
  function history(userId) {
    return db.prepare('SELECT id,review_id AS reviewId,revision,status,contract_id AS contractId,contract_version AS contractVersion,contract_hash AS contractHash,certificate_id AS certificateId,signature_id AS signatureId,reason,client_message AS clientMessage,actor_user_id AS actorId,created_at AS createdAt FROM sponsorship_review_history WHERE user_id=? ORDER BY revision DESC LIMIT 100').all(userId);
  }
  function review(userId,{includeHistory=true}={}) {
    const user=target(userId), current=eligibility(userId), row=stored(userId);
    const stale=Boolean(row && (!current.qualified || row.status==='approved'&&!current.eligible || row.contract_id!==current.contractId || row.contract_version!==current.contractVersion || row.contract_hash!==current.contractHash || row.certificate_id!==current.certificateId || row.signature_id!==current.signatureId));
    return {id:row?.id??null,userId,name:user.name,email:user.email,status:row&&!stale?row.status:current.eligible?'pending_review':current.status,storedStatus:row?.status??null,revision:row?.revision??0,eligibility:{eligible:current.eligible,status:current.status},contractId:current.contractId??row?.contract_id??null,contractVersion:current.contractVersion??row?.contract_version??null,contractHash:current.contractHash??row?.contract_hash??null,certificateId:current.certificateId??row?.certificate_id??null,signatureId:current.signatureId??row?.signature_id??null,clientMessage:!stale?row?.client_message??'':'',updatedAt:row?.updated_at??null,updatedBy:row?.updated_by??null,stale,...(includeHistory?{history:history(userId)}:{})};
  }
  function reviews({status,search='',limit=50,offset=0}={}) {
    limit=pageNumber(limit,50,1,100);offset=pageNumber(offset,0,0,1000000);
    if (status!==undefined && status!=='' && !states.has(status) && status!=='stale') throw new AdminWorkflowError(400,'Choose a valid review status.');
    if (typeof search!=='string' || search.length>254 || /[\p{Cc}\p{Cf}]/u.test(search)) throw new AdminWorkflowError(400,'Use a search of at most 254 characters.');
    const found=reviewEntries(search).filter(item=>!status || (status==='stale'?item.stale:item.status===status));
    return {entries:found.slice(offset,offset+limit),total:found.length,limit,offset};
  }
  function reviewEntries(search='') {
    // Qualifying signers and past cases form the queue. No fake pending cases
    // are materialized merely by opening the administrator dashboard.
    const users=db.prepare(`SELECT u.id FROM users u WHERE u.id IN (SELECT user_id FROM sponsorship_reviews UNION SELECT s.user_id FROM contract_signatures s JOIN active_contract a ON a.contract_id=s.contract_id)
      AND (instr(lower(u.name),lower(?))>0 OR instr(lower(u.email),lower(?))>0) ORDER BY u.id`).all(search.trim(),search.trim());
    return users.map(row=>review(row.id,{includeHistory:false})).sort((a,b)=>(b.updatedAt??0)-(a.updatedAt??0)||a.userId-b.userId);
  }
  function summary() {
    const counts={pending_review:0,needs_information:0,approved:0,rejected:0,stale:0,total:0};
    for(const row of reviewEntries()) {counts.total++;counts[row.status]=(counts[row.status]??0)+1;if(row.stale)counts.stale++;}
    return {counts,total:counts.total};
  }
  function decideReview(actorId,userId,data) {
    return transaction(() => {
      access.require(actorId,'reviews.write');target(userId);
      if (!states.has(data?.status)) throw new AdminWorkflowError(400,'Choose a valid review decision.');
      const reason=requiredText(data.reason,'an administrative reason',500,3);
      const clientMessage=data.clientMessage===undefined||data.clientMessage===''?'':requiredText(data.clientMessage,'a client message',500);
      if (!Number.isSafeInteger(data.expectedRevision) || data.expectedRevision<0) throw new AdminWorkflowError(400,'Reload the review before saving a decision.');
      const current=eligibility(userId);
      if(!current.eligible && !(current.qualified && current.status==='email_confirmation_required' && data.status!=='approved'))throw new AdminWorkflowError(409,'A verified email, valid reference-priced assessment, and current signed agreement are required before sponsorship approval.','SPONSORSHIP_NOT_ELIGIBLE');
      if(data.expectedContractId!==current.contractId || data.expectedCertificateId!==current.certificateId)throw new AdminWorkflowError(409,'The agreement or qualifying assessment changed. Refresh this review before saving.','ADMIN_REVIEW_BASIS_CHANGED');
      const old=stored(userId);
      if((old?.revision??0)!==data.expectedRevision)throw new AdminWorkflowError(409,'Another administrator changed this review. Refresh before saving.','ADMIN_REVIEW_CONFLICT');
      const id=old?.id??randomUUID(),revision=(old?.revision??0)+1,time=now();
      db.prepare(`INSERT INTO sponsorship_reviews(user_id,id,status,revision,contract_id,contract_version,contract_hash,certificate_id,signature_id,client_message,updated_by,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(user_id) DO UPDATE SET status=excluded.status,revision=excluded.revision,contract_id=excluded.contract_id,contract_version=excluded.contract_version,contract_hash=excluded.contract_hash,certificate_id=excluded.certificate_id,signature_id=excluded.signature_id,client_message=excluded.client_message,updated_by=excluded.updated_by,updated_at=excluded.updated_at`).run(userId,id,data.status,revision,current.contractId,current.contractVersion,current.contractHash,current.certificateId,current.signatureId,clientMessage,actorId,time);
      db.prepare('INSERT INTO sponsorship_review_history(id,user_id,review_id,revision,status,contract_id,contract_version,contract_hash,certificate_id,signature_id,reason,client_message,actor_user_id,created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)').run(randomUUID(),userId,id,revision,data.status,current.contractId,current.contractVersion,current.contractHash,current.certificateId,current.signatureId,reason,clientMessage,actorId,time);
      access.audit(actorId,'sponsorship.review-decided',{targetId:userId,reason,detail:{reviewId:id,revision,decision:data.status,previousDecision:old?.status??null,contractId:current.contractId,contractVersion:current.contractVersion,certificateId:current.certificateId,documentHash:current.contractHash}});
      return review(userId);
    });
  }
  function requireApproved(userId) {
    const current=eligibility(userId),row=stored(userId);
    if (!current.eligible || !row || row.status!=='approved' || row.contract_id!==current.contractId || row.contract_version!==current.contractVersion || row.contract_hash!==current.contractHash || row.certificate_id!==current.certificateId || row.signature_id!==current.signatureId) throw new AdminWorkflowError(409,'An approved review for the current signed agreement and qualifying assessment is required.','SPONSORSHIP_APPROVAL_REQUIRED');
    return {userId,reviewId:row.id,reviewRevision:row.revision,...current};
  }
  function clientView(userId) {
    const item=review(userId);
    return {status:item.status,eligible:item.eligibility.eligible,eligibility:item.eligibility,review:item.id?{id:item.id,status:item.status,revision:item.revision,clientMessage:item.clientMessage,updatedAt:item.updatedAt,stale:item.stale}:null,fundingApproved:false,message:item.status==='approved'?'Your sponsorship review is approved. The academy must complete any external account arrangements separately.':item.clientMessage||null};
  }
  function publishContract(actorId,data) {
    return transaction(() => {
      access.require(actorId,'contracts.publish');
      const reason=requiredText(data?.reason,'an administrative reason',500,3);
      if(typeof data.contentBase64!=='string' || data.contentBase64.length>13981016 || data.contentBase64.length%4!==0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(data.contentBase64))throw new AdminWorkflowError(400,'Provide a PDF or UTF-8 text document encoded as base64, up to 10 MB.');
      const content=Buffer.from(data.contentBase64,'base64');
      if(!content.length||content.length>10*1024*1024||content.toString('base64')!==data.contentBase64)throw new AdminWorkflowError(400,'Provide a document of 1 byte to 10 MB.');
      const published=contracts.publish({content,format:data.format,version:data.version,title:data.title,fileName:data.fileName,now:now()});
      access.audit(actorId,'contract.published',{reason,detail:{contractId:published.id,contractVersion:published.version,documentHash:published.hash,fileName:published.fileName,format:published.format,title:published.title,source:published.reused?'existing-version':'admin-dashboard'}});
      return {contract:published,reused:published.reused,active:published.active};
    });
  }
  return {updateStatus,revokeSessions,appendNote,notes,eligibility,reviews,review,summary,decideReview,clientView,requireApproved,publishContract};
}
