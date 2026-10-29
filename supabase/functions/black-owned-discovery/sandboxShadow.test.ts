import assert from 'node:assert/strict';
import { createSponsorshipSandboxHandler, sandboxPermitted } from './sponsorshipSandbox.ts';
import { createShadowEvaluator, shadowScheduler, SHADOW_TIMEOUT_MS } from './sponsorshipShadow.ts';
import { input, row } from './fixtures.test.ts';
import type { SponsorshipSnapshot } from './sponsorshipPolicy.ts';
const request = (body:unknown=input)=>new Request('https://fixture.kscan.ai/sandbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function envRig() { return {SPONSORSHIP_SANDBOX_MODE:'true',SPONSORED_PLACEMENTS_V1_ENABLED:'true',KSCAN_ENVIRONMENT:'staging',SUPABASE_URL:'https://yzqjvdfgefveprobvvyw.supabase.co'} as Record<string,string>; }
Deno.test('sandbox requires both server flags, explicit approved non-production environment, and protected staff authority',async()=>{
  const env=envRig();let staff=false;let authenticated=true;let searches=0;
  const handler=createSponsorshipSandboxHandler({env:k=>env[k],authenticate:async()=>{if(!authenticated)throw new Response(null,{status:401});return{id:'fixture-staff',isAnonymous:false};},staff:async()=>staff,claim:async()=>true,snapshot:async()=>{searches++;return{rows:[],campaigns:[],partners:[]};}});
  assert.equal((await handler(request())).status,401);assert.equal(searches,0);
  staff=true;authenticated=false;assert.equal((await handler(request())).status,401);assert.equal(searches,0);
  authenticated=true;const response=await handler(request());const body=await response.json();assert.equal(body.sandbox,true);assert.equal(body.status,'empty');assert.equal(body.disclosureTemplate.label,'Sponsored');assert.equal(searches,1);
  for(const [key,value] of [['SPONSORSHIP_SANDBOX_MODE','false'],['SPONSORED_PLACEMENTS_V1_ENABLED','false'],['KSCAN_ENVIRONMENT','production'],['KSCAN_ENVIRONMENT',''],['SUPABASE_URL','https://wyyuqfdxucjksghsmhry.supabase.co']]){
    const copy={...env,[key]:value};assert.equal(sandboxPermitted(k=>copy[k]),false,key);
  }
  assert.equal((await handler(request({...input,sandbox:true,staff:true}))).status,400);
});
Deno.test('sandbox response always marks placements and carries mandatory disclosure',async()=>{
  const env=envRig();const now=Date.now();const before=new Date(now-1000).toISOString();const after=new Date(now+3600_000).toISOString();
  const product={...row,currency:'USD',synced_at:before,expires_at:after,verified_until:after};
  const snapshot:SponsorshipSnapshot={rows:[product],partners:[{id:'fixture-partner',merchantId:row.merchant_id,status:'active',contractStatus:'signed',agreementRef:'fixture:terms',effectiveFrom:before,effectiveUntil:after}],campaigns:[{id:'fixture-campaign',partnerId:'fixture-partner',merchantId:row.merchant_id,state:'approved',productIds:[row.id],categories:[row.category],markets:['US'],startsAt:before,endsAt:after,disclosureApproved:true,disclosureText:'Sponsored'}]};
  const handler=createSponsorshipSandboxHandler({env:k=>env[k],authenticate:async()=>({id:'fixture-staff',isAnonymous:false}),staff:async()=>true,claim:async()=>true,snapshot:async()=>snapshot});
  const body=await(await handler(request())).json();assert.equal(body.sandbox,true);assert.equal(body.products[0].disclosure,'Sponsored');assert.equal(body.products[0].previewOnly,true);assert.equal(body.products[0].placementType,'sponsored');
});
Deno.test('shadow OFF schedules zero work; enabled evaluation is detached and logs only aggregate allowlisted metadata',async()=>{
  let queries=0;const events:unknown[]=[];const scheduled:Promise<void>[]=[];
  const evaluate=createShadowEvaluator({snapshot:async()=>{queries++;return{rows:[],partners:[],campaigns:[]};},emit:e=>events.push(e)});
  shadowScheduler(false,p=>scheduled.push(p),evaluate)(input);assert.equal(scheduled.length,0);assert.equal(queries,0);
  shadowScheduler(true,p=>scheduled.push(p),evaluate)(input);assert.equal(queries,0,'must not query on response turn');await Promise.all(scheduled);
  assert.equal(queries,1);assert.deepEqual(events,[{event:'sponsorship_shadow_evaluated',eligible:false,category:'outerwear',reason:'no_campaign'}]);
});
Deno.test('shadow deadline aborts work independently; failures never escape or reveal source details',async()=>{
  let aborted=false;const events:unknown[]=[];const start=performance.now();
  await createShadowEvaluator({snapshot:signalInput=>{void signalInput;return new Promise(()=>{});},emit:e=>events.push(e)})(input);
  assert.ok(performance.now()-start<SHADOW_TIMEOUT_MS+300);assert.equal((events[0] as {reason:string}).reason,'timeout');
  await createShadowEvaluator({snapshot:async(_i,signal)=>{signal.addEventListener('abort',()=>{aborted=true;});throw new Error('merchant price user private');},emit:e=>events.push(e)})(input);
  assert.ok(aborted);assert.equal(JSON.stringify(events).includes('private'),false);
});
