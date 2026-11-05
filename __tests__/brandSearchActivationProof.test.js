const test=require('node:test');
const assert=require('node:assert/strict');
const {budget,withPreference,expansionEvents}=require('../security/release/run-brand-search-activation-proof');
test('paid proof reserves before dispatch, counts earlier uncertain attempts, and refuses beyond the owner-approved retry',()=>{
  assert.equal(budget(0,0).reservedCalls,6);
  assert.equal(budget(6,.06).reservedCalls,6);
  assert.equal(budget(12,.12).reservedCalls,6);
  assert.throws(()=>budget(18,.18),/exhausted/);
  assert.throws(()=>budget(0,4.7),/exhausted/);
  for(const args of [[-1,0],[0,NaN],[1.5,0]])assert.throws(()=>budget(...args));
});
test('authenticated preference is restored even when provider work fails',async()=>{
  let value=false,called=0;
  await assert.rejects(withPreference(async()=>value,async v=>{value=v;},async()=>{called++;assert.equal(value,true);throw Error('provider_failure');}));
  assert.equal(value,false);assert.equal(called,1);
});
test('proof rejects cached/malformed source telemetry and never treats it as an actual provider query',()=>{
  const event=(revision,providerCalls)=>({event_message:'[brand-search-expansion] '+JSON.stringify({revision,providerCalls})});
  assert.equal(expansionEvents([event(1,0),event('1',1),{event_message:'broken'}]).length,0);
  assert.equal(expansionEvents([event(1,1)]).length,1);
});
