import {createHash} from 'node:crypto';
import {createAccountControls} from './account-controls.mjs';
import {createSponsoredSync} from './sponsored-sync.mjs';
import {createPerformanceReports} from './performance-reports.mjs';
import {createOperations} from './operations.mjs';
import {createOperationalHealth} from './operational-health.mjs';

const digest=value=>createHash('sha256').update(value).digest('hex');
const failure=(status,message,code)=>Object.assign(new Error(message),{status,code});
const reason=value=>{
  if(typeof value!=='string'||value.trim().length<3||value.trim().length>500||/[\p{Cc}\p{Cf}]/u.test(value))throw failure(400,'Provide a reason of 3–500 characters without control characters.');
  return value.trim();
};
const userId=value=>{
  if(!/^[1-9]\d*$/.test(String(value))||!Number.isSafeInteger(Number(value)))throw failure(400,'Choose a valid client ID.');
  return Number(value);
};

export function createAccountPlatform(db,databasePath,{admin,access,sessions,twoFactor,user,sessionHash,reauthenticate,
  body,respond,requireOrigin,limit,revokeAccount,closeRevokedStreams,configuration,now=Date.now,options={}}){
  const controls=createAccountControls(db,{access,now});
  const sponsored=createSponsoredSync(db,{access,workflows:admin.workflows,now,...options.sponsored});
  const reports=createPerformanceReports(db,{now,sponsoredSync:sponsored});
  const operations=createOperations(db,databasePath,{now,autoStart:false,deletionLedger:()=>controls.exportDeletionLedger(),...options.operations});
  const health=createOperationalHealth(db,databasePath,{now,operations,sponsored,configuration,...options.health});
  db.exec(`CREATE TABLE IF NOT EXISTS account_tool_privileges (
    token TEXT NOT NULL REFERENCES sessions(token) ON DELETE CASCADE,
    purpose TEXT NOT NULL CHECK(purpose IN ('export','delete','payout')),
    user_id INTEGER NOT NULL REFERENCES users(id),fingerprint TEXT NOT NULL,expires INTEGER NOT NULL,
    PRIMARY KEY(token,purpose));`);
  function fingerprint(id){const state=twoFactor.snapshot(id);return digest(JSON.stringify({password:digest(state.password),factor:state.version,generation:state.sessionVersion}));}
  function privilege(req,id,purpose){
    if(user(req).id!==id)throw failure(401,'Please sign in again.');
    const row=db.prepare('SELECT fingerprint,expires FROM account_tool_privileges WHERE token=? AND purpose=? AND user_id=?').get(sessionHash(req),purpose,id);
    if(!row||row.expires<=now()||row.fingerprint!==fingerprint(id))throw failure(403,'Confirm your password and a fresh second factor before continuing.','ACCOUNT_REAUTH_REQUIRED');
  }
  function clearSession(res){res.setHeader('Set-Cookie',`fa_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0${process.env.COOKIE_SECURE==='true'?'; Secure':''}`);}
  const clientPaths=new Set(['/api/account/status','/api/account/authorize','/api/account/export','/api/account/delete','/api/account/delete/cancel','/api/payouts','/api/payouts/request','/api/performance','/api/sponsored-accounts']);
  async function handle(req,res,pathname,current){
    const adminPath=pathname.startsWith('/api/admin/');
    const connection=/^\/api\/admin\/connections\/([a-f0-9-]{36})\/(link|unlink|sync)$/.exec(pathname);
    const completion=/^\/api\/admin\/privacy\/([1-9]\d*)\/complete$/.exec(pathname);
    const resolution=/^\/api\/admin\/errors\/([a-f0-9]{64})\/resolve$/.exec(pathname);
    const adminKnown=['/api/admin/connections','/api/admin/performance','/api/admin/operations','/api/admin/errors','/api/admin/operations/backup','/api/admin/operations/check','/api/admin/operations/diagnose','/api/admin/privacy'].includes(pathname)||connection||completion||resolution;
    if(!clientPaths.has(pathname)&&!adminKnown)return false;
    requireOrigin(req);const id=current.id;
    const query=Object.fromEntries(new URL(req.url,'http://localhost').searchParams);
    limit(req,`account-platform:${id}`,240,60000);
    if(adminPath){
      access.require(id,'overview.read');
      const permission=pathname.startsWith('/api/admin/connections')?'finance.read':pathname==='/api/admin/performance'?'reports.export':pathname.startsWith('/api/admin/privacy')?'traders.manage':'system.read';
      access.require(id,permission);
      if(req.method==='GET'){
        let result;
        if(pathname==='/api/admin/connections'){
          const page=admin.finance.accounts(query);
          result={...page,accounts:page.accounts.map(account=>({...account,connection:sponsored.readAccount(account.id)})),provider:sponsored.status()};
        }else if(pathname==='/api/admin/performance'){const {userId:target,...filters}=query;result=reports.admin(userId(target),filters);}
        else if(pathname==='/api/admin/operations')result={...operations.status(),health:health.status()};
        else if(pathname==='/api/admin/errors')result=operations.errors(query);
        else if(pathname==='/api/admin/privacy')result=controls.requests(query);
        else throw failure(405,'Use POST to perform this action.');
        user(req);access.require(id,permission);respond(res,200,result);return true;
      }
      if(req.method!=='POST')throw failure(405,'Use GET or POST.');
      const writePermission=connection?'finance.write':completion?'traders.manage':'system.read';
      admin.privileged(req,id,writePermission);
      const input=await body(req);admin.privileged(req,id,writePermission);
      let result;
      if(connection){
        const target=connection[1],action=connection[2];
        if(action==='link')result=sponsored.linkAccount(id,target,input);
        else if(action==='unlink')result=sponsored.unlinkAccount(id,target,input);
        else result=await sponsored.syncAccount(id,target,{guard:()=>admin.privileged(req,id,'finance.write')});
      }else if(completion){
        const target=userId(completion[1]);const explanation=reason(input.reason);
        if(target===id)throw failure(409,'Use your personal account controls to request your own account deletion.');
        db.exec('BEGIN IMMEDIATE');
        try{
          result=controls.completeDeletion(target,{onRevoke:()=>revokeAccount(target)});
          access.audit(id,'account.deletion-reviewed',{targetId:target,reason:explanation,detail:{status:result.status,source:'admin-dashboard'}});
          db.exec('COMMIT');
        }catch(error){db.exec('ROLLBACK');throw error;}
        if(result.status==='deleted')closeRevokedStreams(target,'This account has been closed.');
      }else if(resolution){
        const explanation=reason(input.reason);
        db.exec('BEGIN IMMEDIATE');
        try{result=operations.resolveError(resolution[1]);access.audit(id,'operations.error-resolved',{reason:explanation,detail:{source:'admin-dashboard',subjectType:resolution[1]}});db.exec('COMMIT');}
        catch(error){db.exec('ROLLBACK');throw error;}
      }else if(pathname==='/api/admin/operations/diagnose'){
        const explanation=reason(input.reason);
        limit(req,`operations-diagnostic:${id}`,6,600000);
        access.audit(id,'operations.diagnostic-requested',{reason:explanation,detail:{source:'admin-dashboard'}});
        result=await health.diagnose();
        admin.privileged(req,id,'system.read');
        access.audit(id,'operations.diagnostic-completed',{reason:explanation,detail:{source:'admin-dashboard',status:result.state}});
      }else if(pathname==='/api/admin/operations/backup'||pathname==='/api/admin/operations/check'){
        const explanation=reason(input.reason);
        access.audit(id,pathname.endsWith('/backup')?'operations.backup-requested':'operations.recovery-check-requested',{reason:explanation,detail:{source:'admin-dashboard'}});
        result=pathname.endsWith('/backup')?await operations.backup({reason:explanation}):await operations.checkRecovery(input.backupId);
        admin.privileged(req,id,'system.read');
      }else throw failure(404,'Administrative action not found.');
      respond(res,200,result);return true;
    }
    if(req.method==='GET'){
      let result;
      if(pathname==='/api/account/status')result={...controls.status(id),twoFactorEnabled:twoFactor.snapshot(id).enabled};
      else if(pathname==='/api/payouts')result=admin.finance.clientView(id);
      else if(pathname==='/api/performance')result=reports.client(id,query);
      else if(pathname==='/api/sponsored-accounts')result={funding:admin.finance.clientView(id),connections:sponsored.clientView(id)};
      else throw failure(405,'Use POST for this account action.');
      user(req);respond(res,200,result);return true;
    }
    if(req.method!=='POST')throw failure(405,'Use GET or POST.');
    const input=await body(req);user(req);
    if(pathname==='/api/account/authorize'){
      if(!['export','delete','payout'].includes(input.purpose))throw failure(400,'Choose an account action to authorize.');
      limit(req,`account-tool-authorize:${id}`,10,600000);
      const expected=await reauthenticate(req,id,input.password);let expiresAt;
      twoFactor.authorize(id,expected,input.code,{onAuthorized(){
        user(req);expiresAt=now()+5*60000;
        db.prepare('INSERT INTO account_tool_privileges(token,purpose,user_id,fingerprint,expires) VALUES (?,?,?,?,?) ON CONFLICT(token,purpose) DO UPDATE SET user_id=excluded.user_id,fingerprint=excluded.fingerprint,expires=excluded.expires')
          .run(sessionHash(req),input.purpose,id,fingerprint(id),expiresAt);
      }});
      respond(res,200,{expiresAt,purpose:input.purpose});return true;
    }
    const purpose=pathname==='/api/account/export'?'export':pathname==='/api/payouts/request'?'payout':'delete';
    privilege(req,id,purpose);let result;
    if(pathname==='/api/account/export')result=controls.exportData(id,{offset:input.offset,limit:input.limit,fingerprint:input.fingerprint});
    else if(pathname==='/api/account/delete'){
      result=controls.requestDeletion(id,input,{onRevoke:()=>revokeAccount(id)});
      if(result.status==='deleted'){clearSession(res);closeRevokedStreams(id,'Your account has been closed.');}
    }else if(pathname==='/api/account/delete/cancel')result=controls.cancelDeletion(id);
    else if(pathname==='/api/payouts/request')result=admin.finance.createClientPayout(id,input);
    else throw failure(405,'Use GET for this resource.');
    respond(res,200,result);return true;
  }
  return {handle,controls,sponsored,reports,operations,health,
    start(){sponsored.start();operations.start();},
    async close(){await Promise.allSettled([sponsored.close(),operations.close(),health.close()]);},
    capture(error,metadata){try{return operations.capture(error,metadata);}catch{return null;}}
  };
}
