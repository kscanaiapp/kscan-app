const assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm');
const ROOT=path.resolve(__dirname,'../..');
function runModule(rel,deps){const m={exports:{}};const js=ts.transpileModule(read(rel),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;vm.runInThisContext('(function(exports,module,require){'+js+'\n})',{filename:rel})(m.exports,m,s=>{assert.ok(s in deps,'Unconfigured import '+s);return deps[s];});return m.exports;}
const ts=require(path.join(ROOT,'node_modules/typescript'));
const {PGlite}=require(path.join(ROOT,'node_modules/@electric-sql/pglite'));
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const read=p=>fs.readFileSync(path.join(ROOT,p),'utf8').replace(/\r\n/g,'\n');
const wait=()=>new Promise(r=>setImmediate(r));
const deferred=()=>{let resolve;const promise=new Promise(r=>resolve=r);return{promise,resolve};};

async function world(){
 const db=await PGlite.create();
 await db.exec(`create role anon;create role authenticated;create role service_role bypassrls;create schema auth;create table auth.users(id uuid primary key);
 create function auth.uid()returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
 grant usage on schema auth to authenticated,anon;
 alter default privileges in schema public grant all on tables to authenticated,anon;
 insert into auth.users values('${A}'),('${B}');`);
 for(const name of ['20260803020000_provider_request_security.sql','20260803020100_provider_request_security_revoke_anon.sql'])await db.exec(read('supabase/migrations/'+name));
 await db.exec(read('supabase/migrations/20261103011431_provider_settlement_server_authority.sql'));
 await db.exec(`insert into provider_request_limits(function_name,provider_category,rolling_limit,daily_limit,concurrent_limit,reservation_ttl_seconds)values('purchase-import-extract','vision_ai',1,1,1,60)on conflict(function_name)do update set rolling_limit=1,daily_limit=1,concurrent_limit=1,reservation_ttl_seconds=60;`);
 await db.query("select set_config('request.jwt.claim.sub',$1,false)",[A]);await db.exec('set role authenticated');
 const rpcCalls=[],providerCalls=[],gate=deferred();let hold=false;
 const sdk={createClient:(_url,key)=>({rpc:async(name,p)=>{
   const role=key==='synthetic-service-key'?'service_role':'authenticated';rpcCalls.push({name,p,role});
   try{const r=await db.transaction(async tx=>{
    await tx.exec(role==='service_role'?'set local role service_role':'set local role authenticated');
    if(name==='reserve_provider_request')return tx.query('select * from reserve_provider_request($1,$2,$3::uuid,$4,$5::numeric)',[p.p_function_name,p.p_provider_category,p.p_request_id,p.p_request_fingerprint,p.p_cost_units]);
    if(name==='complete_provider_request')return tx.query('select complete_provider_request($1::uuid) value',[p.p_reservation_id]);
    if(name==='release_provider_request')return tx.query('select release_provider_request($1::uuid,$2) value',[p.p_reservation_id,p.p_reason]);
    if(name==='settle_provider_request_for_actor')return tx.query('select settle_provider_request_for_actor($1::uuid,$2::uuid,$3,$4::boolean) value',[p.p_user_id,p.p_reservation_id,p.p_function_name,p.p_billable]);
    throw Error('unexpected RPC '+name);
   });
    return{data:name==='reserve_provider_request'?r.rows:r.rows[0].value,error:null};
   }catch(e){return{data:null,error:{message:e.message,code:e.code}};}
 }})};
 const cache=new Map();const external={'npm:@supabase/supabase-js@2':sdk};
 function load(rel){if(cache.has(rel))return cache.get(rel);const source=read(rel),compiled=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText;const deps={...external};for(const[,s]of compiled.matchAll(/require\(["']([^"']+)["']\)/g)){if(s.startsWith('.')){const file=path.posix.normalize(path.posix.join(path.posix.dirname(rel),s));deps[s]=load(file);}else assert.ok(s in deps,'Unexpected dependency '+s);}const mod=runModule(rel,deps);cache.set(rel,mod);return mod;}
 const previousDeno=global.Deno;global.Deno={env:{get:name=>({SUPABASE_URL:'https://synthetic.invalid',SUPABASE_ANON_KEY:'synthetic-public-key',SUPABASE_SERVICE_ROLE_KEY:'synthetic-service-key'}[name])}};
 const handler=load('supabase/functions/purchase-import-extract/handler.ts');
 const data=ts.createSourceFile('fixture.ts',read('supabase/functions/purchase-import-extract/handler.test.ts'),ts.ScriptTarget.Latest,true);
 const helperText=data.statements.filter(n=>ts.isFunctionDeclaration(n)&&['modelJson','envelope'].includes(n.name?.text)).map(n=>n.getText(data)).join('\n');
 const m={exports:{}};vm.runInNewContext(ts.transpileModule(helperText+'\nmodule.exports={modelJson,envelope};',{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText,{module:m,exports:m.exports,JSON});
 const responseText=m.exports.envelope(m.exports.modelJson());
 const deps={requireUser:async()=>({id:A,accessToken:'synthetic-verified-actor',isAnonymous:false}),assertAccountActive:async()=>{},checkGeminiConsent:async()=>null,isEnabled:()=>true,
   callProvider:async()=>{providerCalls.push('dispatch');if(hold)await gate.promise;return{ok:true,status:200,text:responseText,retryAfter:null};},sleep:async()=>{},attemptTimeoutMs:10000};
 const request=id=>new Request('https://synthetic.invalid/purchase-import-extract',{method:'POST',headers:{'Content-Type':'application/json',Authorization:'Bearer synthetic'},body:JSON.stringify({contractVersion:'purchase-import-v1',requestId:id,inputTier:'order_confirmation',imageBase64:'/9j/'+'A'.repeat(400)})});
 return{db,rpcCalls,providerCalls,gate,handler,deps,hold:()=>hold=true,extract:id=>handler.handlePurchaseImportRequest(request(id),deps),async pump(n){for(let i=0;i<100&&providerCalls.length<n;i++)await wait();},async close(){gate.resolve();global.Deno=previousDeno;await db.close();}};
}

module.exports={world,A,B};
