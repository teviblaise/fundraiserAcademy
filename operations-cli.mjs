import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createOperations} from './operations.mjs';
import {createOperationalHealth} from './operational-health.mjs';
import {summarizeProgressiveProcessing} from './progressive-finance.mjs';

const usage='Usage: node operations-cli.mjs status | health | diagnose | backup | verify [--backup UUID] | restore --backup UUID --target NEW_DIRECTORY --confirmation "RESTORE TO NEW DIRECTORY"';
const [action,...args]=process.argv.slice(2);
let db,operations,health;
try{
 if(action==='--help'||action==='help'){
  if(args.length)throw new Error(usage);
  console.log(usage);
 }else{
  if(!['status','health','diagnose','backup','verify','restore'].includes(action)||args.length%2)throw new Error(usage);
  const options={};
  for(let i=0;i<args.length;i+=2){
   const option=args[i],value=args[i+1];
   if(!['--backup','--target','--confirmation'].includes(option)||Object.hasOwn(options,option)||typeof value!=='string'||!value)throw new Error(usage);
   options[option]=value;
  }
  if(['status','health','diagnose','backup'].includes(action)&&args.length||action==='verify'&&(options['--target']||options['--confirmation'])||action==='restore'&&(!options['--backup']||!options['--target']||options['--confirmation']!=='RESTORE TO NEW DIRECTORY'))throw new Error(usage);
  const databasePath=process.env.DATABASE_PATH||fileURLToPath(new URL('./data/academy.sqlite',import.meta.url));
  if(!existsSync(databasePath))throw new Error('The academy database is unavailable. Use DATABASE_PATH for an existing installation.');
  db=new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for(const table of ['users','accounts','sessions','two_factor'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Start the current academy application before running operational commands.');
  operations=createOperations(db,databasePath,{autoStart:false});
  if(action==='health'||action==='diagnose'){
   let emailAvailable=false;
   try{emailAvailable=Boolean(new URL(process.env.APP_ORIGIN||process.env.RENDER_EXTERNAL_URL).protocol==='https:'&&process.env.RESEND_API_KEY&&process.env.EMAIL_FROM);}catch{}
   health=createOperationalHealth(db,databasePath,{operations,observer:true,
    paymentProcessing:()=>summarizeProgressiveProcessing(db),
    configuration:()=>({emailAvailable,forexConfigured:Boolean(process.env.TWELVE_DATA_API_KEY)}),
    sponsored:{status:()=>({configured:Boolean(process.env.METAAPI_API_TOKEN),automaticSync:false,intervalSeconds:60})}});
  }
  const result=action==='health'?health.status():action==='diagnose'?await health.diagnose():action==='status'?operations.status():action==='backup'?await operations.backup():action==='verify'?await operations.checkRecovery(options['--backup']):await operations.restoreToDirectory(options['--backup'],{targetDirectory:options['--target'],confirmation:options['--confirmation']});
  console.log(JSON.stringify(result,null,2));
  if(action==='health'&&result.overall!=='healthy'||action==='diagnose'&&result.state!=='ok')process.exitCode=2;
 }
}catch(error){
 console.error(error.status?error.message:error.message===usage||error.message?.startsWith('The academy database')||error.message?.startsWith('Start the current academy')?error.message:'The operational command failed. Check the existing private database, backup storage, and encryption-key configuration.');
 process.exitCode=1;
}finally{
 await health?.close();
 await operations?.close();
 db?.close();
}
