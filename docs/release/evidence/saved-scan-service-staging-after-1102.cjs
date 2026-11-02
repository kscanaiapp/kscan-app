const fs=require('fs'),path=require('path'),vm=require('vm'),crypto=require('crypto');
const root='C:/b35scanack1102',ts=require(root+'/node_modules/typescript');
const {createClient}=require(root+'/node_modules/@supabase/supabase-js');
const base='https://yzqjvdfgefveprobvvyw.supabase.co',admin=process.env.B35_AUDIT_STAGING_SERVICE_ROLE,anon=process.env.B35_AUDIT_STAGING_ANON;
if(!admin||!anon)throw Error('Staging test authority unavailable');
const run=crypto.randomUUID(),actors=[],rows=[],records=[];
const record=(probe,expected,actual,ok)=>records.push({probeId:'B35-SCAN-SERVICE-'+String(records.length+1).padStart(3,'0'),probe,expected,actual,verdict:ok?'PASS':'FAIL'});
async function api(method,p,token,body){const r=await fetch(base+p,{method,headers:{apikey:token===admin?admin:anon,Authorization:'Bearer '+token,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(20000)});const text=await r.text();let json;try{json=JSON.parse(text);}catch{json=null;}return {http:r.status,json};}
const cache=new Map();let client;
function load(relative){if(cache.has(relative))return cache.get(relative);const filename=root+'/'+relative;const module={exports:{}};cache.set(relative,module.exports);const js=ts.transpileModule(fs.readFileSync(filename,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020,esModuleInterop:true}}).outputText;const localRequire=id=>{if(id==='./supabaseClient')return {supabase:client};if(id==='../constants/featureFlags')return {CLOUD_SAVED_SCANS_ENABLED:true};const portable=require(root+'/__tests__/helpers/commerceMatchContract').resolveCommerceContractImport(id);if(portable)return portable;if(id.startsWith('.'))return load(path.posix.normalize(path.posix.dirname(relative)+'/'+id)+(id.endsWith('.ts')?'':'.ts'));throw Error('Unexpected source dependency '+id);};vm.runInNewContext(js,{module,exports:module.exports,require:localRequire,URL,URLSearchParams,console,__DEV__:false},{filename});return module.exports;}
function model(id){return {id,createdAt:'2026-11-02T12:00:00.000Z',imageUri:null,thumbnailUri:null,attributes:{category:'Tops',silhouette:'Fitted',color_palette:'Navy',material_estimate:null,style_tags:[],confidence_score:null},result:'Synthetic navy top',products:[],source:'camera'};}
(async()=>{let error=null;try{
 for(const label of ['A','B']){const email='build35-scan-service-'+run+'-'+label+'@example.invalid',password=crypto.randomBytes(32).toString('hex');const created=await api('POST','/auth/v1/admin/users',admin,{email,password,email_confirm:true,app_metadata:{build35_hostile_fixture:run}});if(created.http>=300)throw Error('Synthetic creation failed '+created.http);const actor={id:created.json.id};actors.push(actor);const login=await api('POST','/auth/v1/token?grant_type=password',anon,{email,password});if(login.http>=300)throw Error('Synthetic login failed '+login.http);actor.token=login.json.access_token;}
 const [a,b]=actors;client=createClient(base,anon,{global:{headers:{Authorization:'Bearer '+a.token}},auth:{persistSession:false,autoRefreshToken:false,detectSessionInUrl:false}});
 // Source service reads cached session; database receives the actual signed Staging token.
 client.auth.getSession=async()=>({data:{session:{user:{id:a.id}}},error:null});
 const service=load('services/savedScansCloud.ts');
 const makeRow=async(owner,id,deleted)=>{const rowId=crypto.randomUUID();const out=await api('POST','/rest/v1/saved_scans',admin,{id:rowId,user_id:owner.id,local_id:id,title:'original synthetic',deleted_at:deleted});if(out.http>=300)throw Error('Synthetic scan setup failed '+out.http);rows.push(rowId);return rowId;};
 const deletedId=await makeRow(a,run+'-deleted','2026-10-31T16:00:00.000Z');
 let result=await service.saveScanToCloud(model(run+'-deleted'),client);
 let authority=await api('GET','/rest/v1/saved_scans?id=eq.'+deletedId+'&select=deleted_at,title',admin);
 record('explicit re-save of own tombstone','Success only if authoritative row becomes active',{serviceOk:result.ok,rowStillDeleted:authority.json?.[0]?.deleted_at!=null,http:authority.http},!result.ok||authority.json?.[0]?.deleted_at==null);
 const foreignId=await makeRow(b,run+'-foreign',null);
 result=await service.softDeleteCloudSavedScan(foreignId,client);
 authority=await api('GET','/rest/v1/saved_scans?id=eq.'+foreignId+'&select=deleted_at',admin);
 record('stale foreign cloud id cannot produce completed deletion','Foreign target denied and success not fabricated',{serviceOk:result.ok,foreignStillActive:authority.json?.[0]?.deleted_at==null},!result.ok&&authority.json?.[0]?.deleted_at==null);
 result=await service.saveScanToCloud(model(run+'-fresh'),client);
 authority=await api('GET','/rest/v1/saved_scans?user_id=eq.'+a.id+'&local_id=eq.'+run+'-fresh&select=id,deleted_at',admin);
 for(const row of authority.json||[])rows.push(row.id);
 record('positive acknowledged fresh save baseline','Active own scan exists after successful insert',{serviceOk:result.ok,rows:authority.json?.length},result.ok&&authority.json?.length===1&&authority.json[0].deleted_at==null);
 }catch(e){error={disposition:'HARNESS/SETUP ERROR',message:e.message};}
 finally{for(const id of rows){const out=await api('DELETE','/rest/v1/saved_scans?id=eq.'+id,admin);if(out.http>=300)record('synthetic row cleanup','delete exact tagged fixture row',{http:out.http},false);}for(const actor of actors){const out=await api('GET','/auth/v1/admin/users/'+actor.id,admin);if(out.json?.app_metadata?.build35_hostile_fixture===run){const del=await api('DELETE','/auth/v1/admin/users/'+actor.id,admin);record('tag-verified synthetic account cleanup','delete only run-tagged actor',{http:del.http},del.http<300);}else record('cleanup tag check','never delete an unverified actor',{http:out.http},false);}
 fs.writeFileSync('C:/b35readback1030/saved-scan-service-staging-after-1102-results.json',JSON.stringify({capturedAt:new Date().toISOString(),environment:'Real Staging PostgREST via actual Supabase JS SDK; synthetic cached-session provider only',sourceSha:'2c604fcf60b5a7fb09a37f4208edc3c39fd071df',serviceMatchesMobile113a:false,sourceRepairClientOnly:true,migrationUnapplied:true,records,error,productionChanges:false,providerCalls:0},null,2)+'\n');console.log(JSON.stringify({records:records.length,FAIL:records.filter(r=>r.verdict==='FAIL').length,error}));}
})().catch(()=>{console.error('Probe failed during cleanup; inspect protected fixture script and results');process.exitCode=1;});
