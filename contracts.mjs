import { createHash, randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const contractConsentStatement = 'I have read this contract, agree to its terms, and intend my typed legal name to serve as my electronic signature.';
const digest = content => createHash('sha256').update(content).digest('hex');
export class ContractError extends Error { constructor(status, message) { super(message); this.status = status; } }

// A personal agreement is required only for its named recipient. Publishing a
// reinstatement for one Fundraiser must not replace everybody else's agreement.
export function requiredContractDocument(db,userId) {
  if(userId!==undefined&&userId!==null){
    if(!Number.isSafeInteger(userId)||userId<1)throw new ContractError(400,'Choose a valid agreement recipient.');
    const assigned=db.prepare('SELECT d.* FROM user_active_contract a JOIN contract_documents d ON d.id=a.contract_id WHERE a.user_id=?').get(userId);
    if(assigned){
      if(assigned.recipient_user_id!==userId)throw new ContractError(500,'The personal agreement recipient could not be verified.');
      return assigned;
    }
  }
  const global=db.prepare('SELECT d.* FROM contract_documents d JOIN active_contract a ON a.contract_id=d.id WHERE a.singleton=1').get();
  if(global&&global.recipient_user_id!==null)throw new ContractError(500,'The required agreement scope could not be verified.');
  return global;
}

// Contract bytes and signatures live in the private application database, never public/.
// Published documents are append-only; the active pointer selects the version required next.
export function createContracts(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS contract_documents (
    id TEXT PRIMARY KEY, version TEXT UNIQUE NOT NULL, title TEXT NOT NULL,
    hash TEXT NOT NULL, format TEXT NOT NULL, file_name TEXT NOT NULL,
    content BLOB NOT NULL, published_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS active_contract (
    singleton INTEGER PRIMARY KEY CHECK(singleton=1), contract_id TEXT NOT NULL REFERENCES contract_documents(id)
  );
  CREATE TABLE IF NOT EXISTS contract_signatures (
    id TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id),
    contract_id TEXT NOT NULL REFERENCES contract_documents(id), contract_version TEXT NOT NULL,
    contract_hash TEXT NOT NULL, certificate_id TEXT NOT NULL REFERENCES certificates(id),
    legal_name TEXT NOT NULL, registered_name TEXT NOT NULL, email TEXT NOT NULL,
    consent_statement TEXT NOT NULL, signed_at INTEGER NOT NULL,
    UNIQUE(user_id,contract_id)
  );
  CREATE TABLE IF NOT EXISTS contract_publication_events (
    id INTEGER PRIMARY KEY, contract_id TEXT NOT NULL REFERENCES contract_documents(id),
    created_at INTEGER NOT NULL
  );
  CREATE TRIGGER IF NOT EXISTS contract_document_no_update BEFORE UPDATE ON contract_documents
    BEGIN SELECT RAISE(ABORT, 'Published contract documents are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS contract_document_no_delete BEFORE DELETE ON contract_documents
    BEGIN SELECT RAISE(ABORT, 'Published contract documents are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS contract_signature_no_update BEFORE UPDATE ON contract_signatures
    BEGIN SELECT RAISE(ABORT, 'Contract signatures are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS contract_signature_no_delete BEFORE DELETE ON contract_signatures
    BEGIN SELECT RAISE(ABORT, 'Contract signatures are immutable'); END;`);

  if(!db.prepare('PRAGMA table_info(contract_documents)').all().some(column=>column.name==='recipient_user_id'))db.exec('ALTER TABLE contract_documents ADD COLUMN recipient_user_id INTEGER REFERENCES users(id)');
  db.exec(`CREATE TABLE IF NOT EXISTS user_active_contract (
    user_id INTEGER PRIMARY KEY REFERENCES users(id),contract_id TEXT NOT NULL REFERENCES contract_documents(id));
    CREATE TRIGGER IF NOT EXISTS global_contract_scope_insert BEFORE INSERT ON active_contract
      WHEN (SELECT recipient_user_id FROM contract_documents WHERE id=NEW.contract_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'A personal agreement cannot become the global agreement'); END;
    CREATE TRIGGER IF NOT EXISTS global_contract_scope_update BEFORE UPDATE ON active_contract
      WHEN (SELECT recipient_user_id FROM contract_documents WHERE id=NEW.contract_id) IS NOT NULL
      BEGIN SELECT RAISE(ABORT,'A personal agreement cannot become the global agreement'); END;
    CREATE TRIGGER IF NOT EXISTS personal_contract_scope_insert BEFORE INSERT ON user_active_contract
      WHEN (SELECT recipient_user_id FROM contract_documents WHERE id=NEW.contract_id) IS NOT NEW.user_id
      BEGIN SELECT RAISE(ABORT,'The personal agreement must belong to its assigned recipient'); END;
    CREATE TRIGGER IF NOT EXISTS personal_contract_scope_update BEFORE UPDATE ON user_active_contract
      WHEN NEW.user_id IS NOT OLD.user_id OR (SELECT recipient_user_id FROM contract_documents WHERE id=NEW.contract_id) IS NOT NEW.user_id
      BEGIN SELECT RAISE(ABORT,'The personal agreement must belong to its assigned recipient'); END;`);

  const active = userId => requiredContractDocument(db,userId);
  const assessment = userId => db.prepare('SELECT id AS certificateId,issued_at AS passedAt FROM certificates WHERE user_id=? AND trading_days>=3 AND profit_percent>=10 ORDER BY issued_at DESC,id LIMIT 1').get(userId);
  const metadata = row => row ? {id:row.id,title:row.title,version:row.version,hash:row.hash,format:row.format,fileName:row.file_name,publishedAt:row.published_at,recipientUserId:row.recipient_user_id??null,scope:row.recipient_user_id==null?'global':'personal',documentUrl:`/api/contracts/${row.id}/document`} : null;
  const signatureView = row => row ? {id:row.id,legalName:row.legal_name,signedAt:row.signed_at,contractId:row.contract_id,contractVersion:row.contract_version,contractHash:row.contract_hash,certificateId:row.certificate_id,consentStatement:row.consent_statement} : null;

  function status(userId) {
    const user = db.prepare('SELECT name FROM users WHERE id=?').get(userId);
    if (!user) throw new ContractError(401,'Please log in to continue.');
    const passed = assessment(userId) || null;
    const document = active(userId);
    const signed = document && db.prepare('SELECT * FROM contract_signatures WHERE user_id=? AND contract_id=?').get(userId,document.id);
    const state = !passed ? 'assessment_required' : !document ? 'awaiting_contract' : signed ? 'signed' : 'signature_required';
    const history = db.prepare('SELECT s.*,d.title,d.version,d.hash,d.format,d.file_name,d.published_at,d.recipient_user_id,d.id AS document_id FROM contract_signatures s JOIN contract_documents d ON d.id=s.contract_id WHERE s.user_id=? AND (d.recipient_user_id IS NULL OR d.recipient_user_id=s.user_id) ORDER BY s.signed_at DESC,s.id').all(userId).map(row => ({...signatureView(row),contract:metadata({...row,id:row.document_id})}));
    return {
      status:state,assessmentPassed:Boolean(passed),assessment:passed,registeredName:user.name,
      contract:passed ? metadata(document) : null,signature:signatureView(signed),history,
      consentStatement:contractConsentStatement,
      canProceedToFundingReview:state==='signed',fundingApproved:false,
      fundingStatus:state==='signed' ? 'pending_review' : state==='assessment_required' ? 'assessment_required' : 'contract_required'
    };
  }

  function publish({content,format,version,title='Fundraiser Academy Trader Agreement',fileName,recipientUserId=null,now=Date.now(),onPublish}) {
    if (onPublish !== undefined && typeof onPublish !== 'function') throw new ContractError(400,'Provide a valid publication callback.');
    if (typeof version!=='string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,79}$/.test(version)) throw new ContractError(400,'Use a contract version with 1–80 letters, digits, dots, underscores, or hyphens.');
    if (typeof title!=='string' || !title.trim() || title.trim().length>160 || /\p{Cc}/u.test(title)) throw new ContractError(400,'Enter a contract title with 1–160 characters and no control characters.');
    if (!['pdf','text'].includes(format)) throw new ContractError(400,'Publish a PDF or UTF-8 .txt contract.');
    if (!Buffer.isBuffer(content) && !(content instanceof Uint8Array)) throw new ContractError(400,'Provide the contract document bytes.');
    content=Buffer.from(content);
    if(recipientUserId!==null&&(!Number.isSafeInteger(recipientUserId)||recipientUserId<1||!db.prepare('SELECT 1 FROM users WHERE id=?').get(recipientUserId)))throw new ContractError(400,'Choose an existing registered agreement recipient.');
    if (!content.length || content.length>10*1024*1024) throw new ContractError(400,'The contract must be between 1 byte and 10 MB.');
    if (format==='pdf' && content.subarray(0,5).toString('ascii')!=='%PDF-') throw new ContractError(400,'This file is not a PDF document.');
    if (format==='text') {
      let text;
      try { text=new TextDecoder('utf-8',{fatal:true}).decode(content); } catch { throw new ContractError(400,'The text contract must use UTF-8.'); }
      if (!text.trim() || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text)) throw new ContractError(400,'The text contract must contain readable text without control characters.');
    }
    const documentText=format==='text'?content.toString('utf8'):'';
    if(/^reinstatement-/i.test(version)||/\bREINSTATEMENT ADDENDUM\b/u.test(documentText)){
      if(recipientUserId===null)throw new ContractError(400,'A reinstatement agreement must be published privately for its named Fundraiser.');
      const previous=[...documentText.matchAll(/^Previous contractual relationship: ([a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12})\r?$/gmi)];
      if(previous.length!==1||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='progressive_relationships'").get())throw new ContractError(400,'The reinstatement agreement must identify a recorded previous relationship.');
      const owner=db.prepare('SELECT user_id FROM progressive_relationships WHERE id=?').get(previous[0][1].toLowerCase());
      if(!owner||owner.user_id!==recipientUserId)throw new ContractError(400,'The reinstatement agreement recipient must own its previous contractual relationship.');
    }
    const hash=digest(content);
    const existing=db.prepare('SELECT * FROM contract_documents WHERE version=?').get(version);
    if(existing) {
      if(existing.hash!==hash || existing.format!==format || existing.title!==title.trim() || existing.recipient_user_id!==recipientUserId) throw new ContractError(409,'That version is already published with different content, metadata, or recipient. Publish a new version.');
      // Repeated startup configuration cannot reactivate a superseded contract.
      return {...metadata(existing),reused:true,active:active(recipientUserId)?.id===existing.id};
    }
    const id=randomUUID();
    const extension=format==='pdf'?'.pdf':'.txt';
    const safeName=(typeof fileName==='string'?path.basename(fileName):`fundraiser-academy-contract-${version}${extension}`).replace(/[^A-Za-z0-9._-]/g,'-').slice(0,180);
    const row={id,version,title:title.trim(),hash,format,file_name:safeName || `contract${extension}`,published_at:now,recipient_user_id:recipientUserId};
    const ownsTransaction = !db.isTransaction;
    if (ownsTransaction) db.exec('BEGIN IMMEDIATE');
    try {
      db.prepare('INSERT INTO contract_documents(id,version,title,hash,format,file_name,content,published_at,recipient_user_id) VALUES (?,?,?,?,?,?,?,?,?)').run(id,version,row.title,hash,format,row.file_name,content,now,recipientUserId);
      if(recipientUserId===null)db.prepare('INSERT INTO active_contract VALUES (1,?) ON CONFLICT(singleton) DO UPDATE SET contract_id=excluded.contract_id').run(id);
      else db.prepare('INSERT INTO user_active_contract VALUES (?,?) ON CONFLICT(user_id) DO UPDATE SET contract_id=excluded.contract_id').run(recipientUserId,id);
      db.prepare('INSERT INTO contract_publication_events(contract_id,created_at) VALUES (?,?)').run(id,now);
      if (onPublish) {
        const callbackResult = onPublish({...metadata(row),reused:false,active:true});
        if (callbackResult && typeof callbackResult.then === 'function') throw new TypeError('Contract publication callbacks must be synchronous.');
      }
      if (ownsTransaction) db.exec('COMMIT');
    } catch(error) {if (ownsTransaction) db.exec('ROLLBACK');throw error;}
    return {...metadata(row),reused:false,active:true};
  }

  function sign(userId,data,now=Date.now()) {
    // Recheck the qualification, document, and signature inside one database transaction.
    db.exec('BEGIN IMMEDIATE');
    try {
      const passed=assessment(userId);
      if(!passed)throw new ContractError(403,'Complete and pass the assessment before signing a contract.');
      const document=active(userId);
      if(!document)throw new ContractError(409,'The academy has not published your contract yet.');
      if(data.contractId!==document.id || data.contractVersion!==document.version || data.contractHash!==document.hash) throw new ContractError(409,'The contract version changed or does not match. Reload and read the current contract before signing.');
      if(data.consent!==true)throw new ContractError(400,'You must explicitly agree to the contract and electronic signature statement.');
      const rawName=typeof data.legalName==='string'?data.legalName:'';
      const legalName=rawName.trim().replace(/\s+/gu,' ');
      if(!legalName || legalName.length>100 || /\p{Cc}|\p{Cf}/u.test(rawName) || !/\p{L}/u.test(legalName))throw new ContractError(400,'Enter your full legal name, with 1–100 characters, for the contract signature. Your certificate nickname is separate.');
      const existing=db.prepare('SELECT * FROM contract_signatures WHERE user_id=? AND contract_id=?').get(userId,document.id);
      if(existing) {
        if(existing.legal_name!==legalName)throw new ContractError(409,'This contract is already signed. The recorded signature cannot be changed.');
        db.exec('COMMIT');return status(userId);
      }
      const user=db.prepare('SELECT name,email FROM users WHERE id=?').get(userId);
      const id=randomUUID();
      db.prepare('INSERT INTO contract_signatures VALUES (?,?,?,?,?,?,?,?,?,?,?)').run(id,userId,document.id,document.version,document.hash,passed.certificateId,legalName,user.name,user.email,contractConsentStatement,now);
      db.prepare('INSERT INTO events(user_id,kind,detail,created_at) VALUES (?,?,?,?)').run(userId,'contract-signed',JSON.stringify({signatureId:id,contractId:document.id,version:document.version,hash:document.hash,certificateId:passed.certificateId}),now);
      db.exec('COMMIT');
      return status(userId);
    } catch(error) {db.exec('ROLLBACK');throw error;}
  }

  function document(userId,id) {
    if(!assessment(userId))throw new ContractError(403,'Complete and pass the assessment before accessing a contract.');
    const current=active(userId);
    const ownsSignature=db.prepare('SELECT id FROM contract_signatures WHERE user_id=? AND contract_id=?').get(userId,id);
    if(current?.id!==id && !ownsSignature)throw new ContractError(404,'Contract not found.');
    const row=db.prepare('SELECT * FROM contract_documents WHERE id=?').get(id);
    if(!row)throw new ContractError(404,'Contract not found.');
    if(row.recipient_user_id!==null&&row.recipient_user_id!==userId)throw new ContractError(404,'Contract not found.');
    if(digest(row.content)!==row.hash)throw new ContractError(500,'Stored contract integrity check failed.');
    return {...metadata(row),content:Buffer.from(row.content)};
  }
  return {status,publish,sign,document,current:userId=>metadata(active(userId))};
}

export function publishContractFile(contracts,{file,version,title,recipientUserId}) {
  if(typeof file!=='string' || !file)throw new ContractError(400,'Provide the private contract file path.');
  const requested=path.resolve(file);
  const source=realpathSync(requested);
  const publicRoot=fileURLToPath(new URL('./public/',import.meta.url));
  if(requested.startsWith(publicRoot) || source.startsWith(publicRoot))throw new ContractError(400,'Keep contract source files outside public/ so access stays authenticated.');
  if(!statSync(source).isFile() || statSync(source).size>10*1024*1024)throw new ContractError(400,'Choose a regular contract file of at most 10 MB.');
  const extension=path.extname(file).toLowerCase();
  if(!['.pdf','.txt'].includes(extension))throw new ContractError(400,'Choose a PDF or UTF-8 .txt contract file.');
  return contracts.publish({content:readFileSync(file),format:extension==='.pdf'?'pdf':'text',version,title,fileName:path.basename(file),recipientUserId});
}

if(process.argv[1] && path.resolve(process.argv[1])===fileURLToPath(import.meta.url)) {
  let db;
  try {
    const [command,...args]=process.argv.slice(2);
    if(command!=='publish' || args.length%2!==0)throw new Error('Usage: node contracts.mjs publish --database data/academy.sqlite --file /private/contract.pdf --version v1 [--title "Trader Agreement"] [--recipient-user-id ID]');
    const options={};
    for(let i=0;i<args.length;i+=2) {
      const key=args[i];
      if(!['--database','--file','--version','--title','--recipient-user-id'].includes(key) || !args[i+1] || options[key])throw new Error('Invalid or duplicate publish option.');
      options[key]=args[i+1];
    }
    const database=options['--database'] || process.env.DATABASE_PATH || path.join(path.dirname(fileURLToPath(import.meta.url)),'data/academy.sqlite');
    if(!existsSync(database))throw new Error('Start the academy server first, then publish into its existing database.');
    if(!options['--file'] || !options['--version'])throw new Error('Provide --file and a unique --version.');
    const recipient=options['--recipient-user-id'];
    if(recipient!==undefined&&(!/^[1-9]\d*$/.test(recipient)||!Number.isSafeInteger(Number(recipient))))throw new Error('Provide --recipient-user-id as a positive registered user ID.');
    db=new DatabaseSync(database);db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
    const contract=publishContractFile(createContracts(db),{file:options['--file'],version:options['--version'],title:options['--title'],...(recipient!==undefined?{recipientUserId:Number(recipient)}:{})});
    console.log(JSON.stringify(contract,null,2));
  } catch(error) {console.error(error.message);process.exitCode=1;}
  finally {db?.close();}
}
