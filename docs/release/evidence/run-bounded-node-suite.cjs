/* Same recursive inventory as scripts/run-all-tests.js; bounded worker count.
 * No baseline exemption: a nonzero Node test exit is a failed run.
 * Usage: node run-bounded-node-suite.cjs SOURCE_ROOT LOG_PREFIX [concurrency]
 */
const fs=require('fs'),path=require('path'),cp=require('child_process'),crypto=require('crypto');
const root=path.resolve(process.argv[2]),prefix=path.resolve(process.argv[3]);
const concurrency=Number(process.argv[4]||2);
if(!Number.isInteger(concurrency)||concurrency<1||concurrency>4)throw Error('Use 1-4 workers');
const found=[],excluded=[],reasons=new Map([['node_modules','third-party dependency tree'],['__snapshots__','snapshot fixtures, not executable tests'],['fixtures','static fixture data, not executable tests']]);
function walk(dir){
 for(const entry of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){
  const f=path.join(dir,entry.name);
  if(entry.isDirectory()){if(reasons.has(entry.name))excluded.push({file:path.relative(root,f),reason:reasons.get(entry.name)});else walk(f);}
  else if(entry.isFile()&&entry.name.endsWith('.test.js'))found.push(path.relative(root,f));
 }
}
walk(path.join(root,'__tests__'));if(!found.length)throw Error('Empty inventory');
const sourceSha=cp.execFileSync('git',['rev-parse','HEAD'],{cwd:root,encoding:'utf8'}).trim();
const inventory={sourceSha,concurrency,files:found,excluded,command:['node','--test',`--test-concurrency=${concurrency}`,...found],fileSha256:Object.fromEntries(found.map(f=>[f,crypto.createHash('sha256').update(fs.readFileSync(path.join(root,f))).digest('hex')]))};
fs.writeFileSync(prefix+'.inventory.json',JSON.stringify(inventory,null,2)+'\n');
console.log(JSON.stringify({sourceSha,executedInventory:found.length,excluded,concurrency}));
const output=fs.createWriteStream(prefix+'.log');let tail='';
const child=cp.spawn(process.execPath,['--test',`--test-concurrency=${concurrency}`,...found],{cwd:root,env:process.env,stdio:['ignore','pipe','pipe']});
function save(chunk){output.write(chunk);tail=(tail+chunk.toString('utf8')).slice(-80000);}
child.stdout.on('data',save);child.stderr.on('data',save);
child.on('error',e=>{save(Buffer.from(String(e)));process.exitCode=1;});
child.on('close',(code,signal)=>output.end(()=>{
 // Only top-level summary lines count. Failed assertions may quote a nested
 // TAP report, whose escaped "\\n# pass" must never overwrite the real total.
 const counts={};for(const key of ['tests','suites','pass','fail','cancelled','skipped','todo']){const re=new RegExp(`^[\\u2139#]\\s+${key}\\s+(\\d+)\\s*$`,'gm');let m;while((m=re.exec(tail)))counts[key]=Number(m[1]);}
 const complete=['tests','pass','fail','cancelled','skipped','todo'].every(k=>Number.isInteger(counts[k]))&&counts.tests===counts.pass+counts.fail+counts.cancelled+counts.skipped+counts.todo;
 const result={sourceSha,inventoryFiles:found.length,concurrency,exitCode:code,signal,complete,counts,verdict:complete&&code===0&&counts.fail===0?'PASS':'FAIL_OR_INCOMPLETE'};
 fs.writeFileSync(prefix+'.result.json',JSON.stringify(result,null,2)+'\n');console.log(JSON.stringify(result));process.exitCode=result.verdict==='PASS'?0:1;
}));
