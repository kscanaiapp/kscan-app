const test=require('node:test'),assert=require('node:assert/strict');
const {world}=require('./helpers/purchaseImportQuotaWorld');
const A='11111111-1111-4111-8111-111111111111',B='22222222-2222-4222-8222-222222222222';
const settleSql='select settle_provider_request_for_actor($1::uuid,$2::uuid,$3,$4::boolean) value';

test('an authenticated caller cannot release in-flight work to bypass a one-request quota',async()=>{
 const w=await world();let first,second,started,duplicated;
 const firstStarted=new Promise(r=>started=r),secondStarted=new Promise(r=>duplicated=r);
 try{
  w.hold();const provider=w.deps.callProvider;w.deps.callProvider=(...args)=>{const result=provider(...args);if(w.providerCalls.length===1)started();else duplicated();return result;};
  first=w.extract('first-session');await Promise.race([firstStarted,first.then(()=>assert.fail('baseline ended before dispatch'))]);
  const id=(await w.db.query("select id from provider_request_reservations where status='reserved'")).rows[0].id;
  let denied=false;try{await w.db.query('select release_provider_request($1,$2)',[id,'untrusted-client']);}catch(e){assert.equal(e.code,'42501');denied=true;}
  second=w.extract('second-session');
  const outcome=await Promise.race([second.then(r=>r.status),secondStarted.then(()=> 'duplicate-dispatch')]);
  assert.equal(w.providerCalls.length,1,'caller must not free an active provider reservation');
  assert.equal(denied,true,'legacy client settlement execution must be revoked');assert.equal(outcome,429);
  w.gate.resolve();assert.equal((await first).status,200);
 }finally{w.gate.resolve();await Promise.allSettled([first,second]);await w.close();}
});

test('only service role can settle; actor/function scope and replay are enforced by SQL',async()=>{
 const w=await world();try{
  const reservation=await w.handler.defaultPurchaseImportDeps.reserve('synthetic','scope-session',A);const id=reservation.reservationId;
  for(const role of ['authenticated','anon']){
   await w.db.exec('reset role;set role '+role);
   await w.db.query("select set_config('request.jwt.claim.role','service_role',false)");
   await assert.rejects(w.db.query(settleSql,[A,id,'purchase-import-extract',false]),e=>e.code==='42501');
  }
  await w.db.exec('reset role;set role authenticated');
  await w.db.query("select set_config('request.jwt.claim.sub',$1,false)",[B]);
  await assert.rejects(w.db.query(settleSql,[A,id,'purchase-import-extract',false]),e=>e.code==='42501');
  await w.db.query("select set_config('request.jwt.claim.sub',$1,false)",[A]);
  await w.db.exec('reset role;set role service_role');
  for(const params of [[B,id,'purchase-import-extract',true],[A,id,'other-function',false],[null,id,'purchase-import-extract',false],[A,id,'purchase-import-extract',null]])assert.equal((await w.db.query(settleSql,params)).rows[0].value,false);
  assert.equal((await w.db.query(settleSql,[A,id,'purchase-import-extract',true])).rows[0].value,true);
  assert.equal((await w.db.query(settleSql,[A,id,'purchase-import-extract',false])).rows[0].value,false);
  await w.db.exec('reset role;set role authenticated');
  assert.equal((await w.db.query('select status from provider_request_reservations')).rows[0].status,'completed');
 }finally{await w.close();}
});

test('two trusted releases change one row once; genuine retry is then allowed',async()=>{
 const w=await world();try{
  const reservation=await w.handler.defaultPurchaseImportDeps.reserve('synthetic','release-session',A);
  await w.db.exec('reset role;set role service_role');
  const results=await Promise.all([w.db.query(settleSql,[A,reservation.reservationId,'purchase-import-extract',false]),w.db.query(settleSql,[A,reservation.reservationId,'purchase-import-extract',false])]);
  assert.deepEqual(results.map(r=>r.rows[0].value).sort(),[false,true]);
  await w.db.exec('reset role;set role authenticated');
  assert.equal((await w.extract('release-session')).status,200);
  assert.deepEqual((await w.db.query('select status from provider_request_reservations order by status')).rows,[{status:'completed'},{status:'released'}]);
 }finally{await w.close();}
});

test('default handler settles using verified actor and service SDK authority, never caller token',async()=>{
 const w=await world();try{
  assert.equal((await w.extract('server-session')).status,200);
  const call=w.rpcCalls.find(x=>x.name==='settle_provider_request_for_actor');assert.ok(call);assert.equal(call.role,'service_role');assert.equal(call.p.p_user_id,A);assert.equal(call.p.p_function_name,'purchase-import-extract');assert.equal(call.p.p_billable,true);
  assert.equal(w.rpcCalls.some(x=>['complete_provider_request','release_provider_request'].includes(x.name)),false);
 }finally{await w.close();}
});

test('SQL settlement failure retains reservation and does not fall back to client authority',async()=>{
 const w=await world();try{
  await w.db.exec('reset role;revoke execute on function settle_provider_request_for_actor(uuid,uuid,text,boolean) from service_role;set role authenticated');
  assert.equal((await w.extract('failed-settle-session')).status,200);
  assert.equal((await w.db.query('select status from provider_request_reservations')).rows[0].status,'reserved');
  assert.equal((await w.extract('another-session')).status,429);
  assert.equal(w.providerCalls.length,1);
  assert.equal(w.rpcCalls.some(x=>['complete_provider_request','release_provider_request'].includes(x.name)),false);
 }finally{await w.close();}
});

for(const [name,sql]of[
 ['complete','select complete_provider_request($1::uuid)'],
 ['release',"select release_provider_request($1::uuid,'caller')"]
])test('authenticated '+name+' authority is denied by actual PostgreSQL privileges',async()=>{
 const w=await world();try{
  const reservation=await w.handler.defaultPurchaseImportDeps.reserve('synthetic','authority-session','11111111-1111-4111-8111-111111111111');assert.equal(reservation.allowed,true);
  await assert.rejects(w.db.query(sql,[reservation.reservationId]),e=>e.code==='42501');
  assert.equal((await w.db.query('select status from provider_request_reservations')).rows[0].status,'reserved');
 }finally{await w.close();}
});
