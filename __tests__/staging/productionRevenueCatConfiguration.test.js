const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {pathToFileURL}=require('node:url');
const root=path.resolve(__dirname,'../..');
const load=()=>import(pathToFileURL(path.join(root,'scripts/configure-production-revenuecat.mjs')));
const env={GITHUB_ACTIONS:'true',GITHUB_REPOSITORY:'kscanaiapp/kscan-app',GITHUB_REF:'refs/heads/rebuild/backend-authority-v2',FUNCTION_NAME:'kplus-revenuecat-webhook',VERIFY_JWT:'false',SUPABASE_PRODUCTION_PROJECT_REF:'wyyuqfdxucjksghsmhry',ROTATION_CONFIRMATION:'COORDINATED RC CREDENTIAL REPLACEMENT',RC_PRODUCTION_AUTHORIZATION:'Bearer '+'a'.repeat(64),RC_PRODUCTION_SIGNING_SECRET:'b'.repeat(64)};
test('foreign project/function/ref, JWT and absent coordination refuse before a write',async()=>{
 const {configure}=await load();
 for(const [k,v] of Object.entries({GITHUB_ACTIONS:'false',GITHUB_REPOSITORY:'other/repo',GITHUB_REF:'refs/heads/master',FUNCTION_NAME:'scan-identify',VERIFY_JWT:'true',SUPABASE_PRODUCTION_PROJECT_REF:'yzqjvdfgefveprobvvyw',ROTATION_CONFIRMATION:''})){
  let calls=0;assert.throws(()=>configure({...env,[k]:v},()=>{calls++}));assert.equal(calls,0);
 }
});
test('missing/short/multiline/shared credentials refuse before a write',async()=>{
 const {configure}=await load();for(const value of ['', 'a'.repeat(31),'a'.repeat(40)+'\nINJECT=x','a'.repeat(40)+'$INJECT','a'.repeat(40)+'\\escape',' '+env.RC_PRODUCTION_AUTHORIZATION,env.RC_PRODUCTION_SIGNING_SECRET]){
 let calls=0;assert.throws(()=>configure({...env,RC_PRODUCTION_AUTHORIZATION:value},()=>{calls++}));assert.equal(calls,0);}
});
test('only two credentials written, exact digest readback required, temporary file deleted',async()=>{
 const {configure}=await load();let file,values;const calls=[];
 const result=configure(env,(bin,args,opts)=>{calls.push(args);assert.equal(bin,'supabase');assert.deepEqual(opts.stdio,['ignore','pipe','pipe']);
 if(args[1]==='set'){file=args.at(-1);values=Object.fromEntries(fs.readFileSync(file,'utf8').split('\n').map(l=>{const i=l.indexOf('=');return[l.slice(0,i),JSON.parse(l.slice(i+1))]}));return '';}
 return JSON.stringify(Object.entries(values).map(([name,value])=>({name,value:crypto.createHash('sha256').update(value).digest('hex')})));});
 assert.equal(result.verified,true);assert.equal(calls.length,2);assert.equal(Object.keys(values).length,2);assert.equal(values.KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION,env.RC_PRODUCTION_AUTHORIZATION);assert.equal(fs.existsSync(file),false);
 assert.equal(JSON.stringify(calls).includes(env.RC_PRODUCTION_AUTHORIZATION),false);
});
test('failed or ambiguous set/readback never leaks child output or retries',async()=>{
 const {configure}=await load();for(const failSet of [true,false]){let calls=0,file;assert.throws(()=>configure(env,(bin,args)=>{calls++;if(args[1]==='set'){file=args.at(-1);if(failSet)throw Error(env.RC_PRODUCTION_AUTHORIZATION);return '';}return '[]';}),error=>!error.message.includes(env.RC_PRODUCTION_AUTHORIZATION)&&/stop and coordinate/.test(error.message));assert.equal(calls,failSet?1:2);assert.equal(fs.existsSync(file),false);}
});
test('configuration is opt-in, reviewed before gate and executes only inside protected job',()=>{
 const yaml=require('js-yaml');const doc=yaml.load(fs.readFileSync(path.join(root,'.github/workflows/production-controlled-deploy.yml'),'utf8'));
 assert.equal(doc.on.workflow_dispatch.inputs.rc_credential_replacement_confirmation.default,'');
 const jobs=Object.values(doc.jobs);const owner=jobs.find(j=>j.steps?.some(s=>s.name==='Configure coordinated RevenueCat credentials'));
 assert.equal(owner.environment,'production');const s=owner.steps.find(s=>s.name==='Configure coordinated RevenueCat credentials');assert.equal(s.if,"inputs.rc_credential_replacement_confirmation != ''");assert.ok(!s['continue-on-error']);
 assert.ok(doc.jobs.preflight.steps.some(s=>s.name==='Record optional RevenueCat credential scope'));
});
