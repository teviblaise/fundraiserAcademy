import {DatabaseSync} from 'node:sqlite';
import {existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {createOperations} from './operations.mjs';

const usage='Usage: node operations-cli.mjs status | backup | verify [--backup UUID] | restore --backup UUID --target NEW_DIRECTORY --confirmation "RESTORE TO NEW DIRECTORY"';
const [action,...args]=process.argv.slice(2);
let db,operations;
try{
 if(action==='--help'||action==='help'){
  if(args.length)throw new Error(usage);
  console.log(usage);
 }else{
  if(!['status','backup','verify','restore'].includes(action)||args.length%2)throw new Error(usage);
  const options={};
  for(let i=0;i<args.length;i+=2){
   const option=args[i],value=args[i+1];
   if(!['--backup','--target','--confirmation'].includes(option)||Object.hasOwn(options,option)||typeof value!=='string'||!value)throw new Error(usage);
   options[option]=value;
  }
  if((action==='status'||action==='backup')&&args.length||action==='verify'&&(options['--target']||options['--confirmation'])||action==='restore'&&(!options['--backup']||!options['--target']||options['--confirmation']!=='RESTORE TO NEW DIRECTORY'))throw new Error(usage);
  const databasePath=process.env.DATABASE_PATH||fileURLToPath(new URL('./data/academy.sqlite',import.meta.url));
  if(!existsSync(databasePath))throw new Error('The academy database is unavailable. Use DATABASE_PATH for an existing installation.');
  db=new DatabaseSync(databasePath);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000;');
  for(const table of ['users','accounts','sessions','two_factor'])if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table))throw new Error('Start the current academy application before running operational commands.');
  operations=createOperations(db,databasePath,{autoStart:false});
  const result=action==='status'?operations.status():action==='backup'?await operations.backup():action==='verify'?await operations.checkRecovery(options['--backup']):await operations.restoreToDirectory(options['--backup'],{targetDirectory:options['--target'],confirmation:options['--confirmation']});
  console.log(JSON.stringify(result,null,2));
 }
}catch(error){
 console.error(error.status?error.message:error.message===usage||error.message?.startsWith('The academy database')||error.message?.startsWith('Start the current academy')?error.message:'The operational command failed. Check the existing private database, backup storage, and encryption-key configuration.');
 process.exitCode=1;
}finally{
 await operations?.close();
 db?.close();
}
