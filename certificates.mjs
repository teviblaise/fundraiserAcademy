import {randomUUID} from 'node:crypto';
import {notify} from './public/simulator.js';

const escape=value=>String(value).replace(/[&<>"']/g,char=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&apos;'}[char]));
export function createCertificates(db) {
  const columns=db.prepare('PRAGMA table_info(users)').all();
  if(!columns.some(c=>c.name==='certificate_mode'))db.exec("ALTER TABLE users ADD COLUMN certificate_mode TEXT NOT NULL DEFAULT 'name'");
  if(!columns.some(c=>c.name==='certificate_nickname'))db.exec("ALTER TABLE users ADD COLUMN certificate_nickname TEXT NOT NULL DEFAULT ''");
  db.exec('CREATE TABLE IF NOT EXISTS certificates (id TEXT PRIMARY KEY,user_id INTEGER NOT NULL REFERENCES users(id),attempt TEXT NOT NULL,holder TEXT NOT NULL,issued_at INTEGER NOT NULL,initial_balance REAL NOT NULL,final_balance REAL NOT NULL,profit_percent REAL NOT NULL,UNIQUE(user_id,attempt))');
  if(!db.prepare('PRAGMA table_info(certificates)').all().some(column=>column.name==='trading_days'))db.exec('ALTER TABLE certificates ADD COLUMN trading_days INTEGER NOT NULL DEFAULT 0');
  function issue(id,state,now=Date.now()) {
    if(state.locked!=='Profit target achieved'||state.positions.length||state.balance<state.initial*1.1||state.tradingDays.length<3)return null;
    if(db.prepare('SELECT id FROM certificates WHERE user_id=? AND attempt=?').get(id,state.notificationEpoch))return null;
    const prefs=preferences(id);
    const certificate={id:randomUUID(),userId:id,attempt:state.notificationEpoch,holder:prefs.displayName,issuedAt:now,initialBalance:state.initial,finalBalance:state.balance,profitPercent:(state.balance/state.initial-1)*100};
    db.prepare('INSERT INTO certificates VALUES (?,?,?,?,?,?,?,?,?)').run(certificate.id,id,certificate.attempt,certificate.holder,now,state.initial,state.balance,certificate.profitPercent,state.tradingDays.length);
    notify(state,'Certificate issued','Your simulated trading challenge completion certificate is available in My certificates.',now);
    return certificate;
  }
  const list=id=>db.prepare('SELECT id,holder,issued_at AS issuedAt,initial_balance AS initialBalance,final_balance AS finalBalance,profit_percent AS profitPercent,trading_days AS tradingDays FROM certificates WHERE user_id=? ORDER BY issued_at DESC').all(id);
  const get=(id,certificateId)=>db.prepare('SELECT id,holder,issued_at AS issuedAt,initial_balance AS initialBalance,final_balance AS finalBalance,profit_percent AS profitPercent,trading_days AS tradingDays FROM certificates WHERE user_id=? AND id=?').get(id,certificateId);
  function preferences(id){const user=db.prepare('SELECT name,certificate_mode,certificate_nickname FROM users WHERE id=?').get(id);return {name:user.name,mode:user.certificate_mode,nickname:user.certificate_nickname,displayName:user.certificate_mode==='nickname'?user.certificate_nickname:user.name};}
  function setPreferences(id,{mode,nickname='',applyExisting=false}){
    if(!['name','nickname'].includes(mode)||typeof nickname!=='string'||typeof applyExisting!=='boolean')throw new Error('Choose a valid certificate name option.');
    nickname=nickname.trim();
    if(nickname.length>60||/\p{Cc}/u.test(nickname)||mode==='nickname'&&!nickname)throw new Error('Enter a nickname with 1–60 characters and no control characters.');
    db.exec('BEGIN');
    try{db.prepare('UPDATE users SET certificate_mode=?,certificate_nickname=? WHERE id=?').run(mode,nickname,id);if(applyExisting)db.prepare('UPDATE certificates SET holder=? WHERE user_id=?').run(preferences(id).displayName,id);db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (?,?,?,?)').run(id,'certificate-name-preference',JSON.stringify({mode,applyExisting}),Date.now());db.exec('COMMIT');}catch(error){db.exec('ROLLBACK');throw error;}
    return preferences(id);
  }
  return {issue,list,get,preferences,setPreferences};
}
export function certificateSvg(certificate) {
  const date=new Intl.DateTimeFormat('en-GB',{dateStyle:'long',timeZone:'Africa/Lagos'}).format(certificate.issuedAt);
  const holder=escape(certificate.holder);
  const size=certificate.holder.length>60?20:certificate.holder.length>45?30:certificate.holder.length>25?40:52;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 850" role="img" aria-labelledby="title"><title id="title">Fundraiser Academy simulation challenge certificate for ${holder}</title><rect width="1200" height="850" fill="#fafbf6"/><rect x="28" y="28" width="1144" height="794" rx="12" fill="none" stroke="#183c31" stroke-width="3"/><rect x="43" y="43" width="1114" height="764" rx="8" fill="none" stroke="#d5edb2"/><path d="M45 45h120v7H52v120h-7M1155 805h-120v-7h113V678h7" fill="#749751"/><g font-family="Georgia,serif" text-anchor="middle" fill="#183c31"><text x="600" y="122" font-family="Arial,sans-serif" font-size="24" font-weight="bold" letter-spacing="5">FUNDRAISER ACADEMY</text><text x="600" y="163" font-family="Arial,sans-serif" font-size="13" letter-spacing="3">YOUR SKILL. OUR BACKING.</text><text x="600" y="264" font-size="53">Certificate of Completion</text><text x="600" y="311" font-family="Arial,sans-serif" font-size="13" letter-spacing="3">SIMULATED TRADING CHALLENGE</text><text x="600" y="377" font-size="20" fill="#657269">This certifies that</text><text x="600" y="446" font-size="${size}">${holder}</text><path d="M270 470H930" stroke="#dce2d7"/><text x="600" y="518" font-size="21">completed the Fundraiser Academy practice challenge</text><text x="600" y="554" font-family="Arial,sans-serif" font-size="16" fill="#657269">10% realized-profit target · 10% total-loss limit · 5% daily-loss limit</text><text x="600" y="604" font-size="20">Realized return: ${certificate.profitPercent.toFixed(2)}% · ${certificate.tradingDays} trading days</text><text x="600" y="648" font-family="Arial,sans-serif" font-size="15">Issued ${escape(date)}</text><text x="600" y="719" font-family="Arial,sans-serif" font-size="11" fill="#657269">Certificate ID: ${escape(certificate.id)}</text><text x="600" y="751" font-family="Arial,sans-serif" font-size="11" fill="#657269">Synthetic-market practice completion. Not professional accreditation or funding approval.</text></g></svg>`;
}
