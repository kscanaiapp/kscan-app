// Offline actual-source endpoint execution. No network permission is granted.
// Only deletion/common (Auth + DB transport) is substituted; provider parser,
// reconciler, endpoint, webhook normalizer and authenticator are real source.
import assert from 'node:assert/strict';
import { handleRevenueCatWebhook } from '../../../../supabase/functions/_shared/revenuecat/revenueCatWebhookHandler.ts';
import { computeRevenueCatWebhookSignature, REVENUECAT_WEBHOOK_SIGNATURE_HEADER } from '../../../../supabase/functions/_shared/revenuecat/revenueCatWebhookAuth.ts';
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const root = new URL('../../../../', import.meta.url);
const results: unknown[] = [];
let actor = A;
let calls: { fn: string; args: Record<string, unknown> }[] = [];
let providerCalls = 0;
let mode = 'empty';
let lease = 'claimed';
const config: Record<string, string> = {
  REVENUECAT_RECONCILE_SECRET_API_KEY: 'synthetic-only', REVENUECAT_PROJECT_ID: 'proj_fixture',
  KPLUS_REVENUECAT_RECONCILE_ENVIRONMENT: 'production',
  KPLUS_REVENUECAT_PRODUCT_CLASSIFICATION: JSON.stringify({ version: 1, products: [
    { store: 'apple', productId: 'fixture.apple.monthly', class: 'MONTHLY_SUBSCRIPTION' },
  ] }),
};
for (const [k,v] of Object.entries(config)) Deno.env.set(k,v);
const json = (x: unknown, status=200) => new Response(JSON.stringify(x), {status});
(globalThis as any).__issue704 = {
  requireUser: () => ({id: actor}),
  rpc: async (fn: string, args: Record<string, unknown>) => {
    calls.push({fn,args});
    if (fn === 'claim_kplus_provider_reconciliation') return json({classification:lease,claimToken:'fixture-lease',retryAfterSeconds:30});
    if (fn === 'list_kplus_provider_grants_for_reconciliation') return json([]);
    if (fn === 'finish_kplus_provider_reconciliation') return json({classification:'finished'});
    if (fn.includes('product_cache')) return json([]);
    throw new Error('unexpected mutation: '+fn);
  },
};
const shim = `const s=globalThis.__issue704;
export const requireUser=async()=>s.requireUser();
export const rpc=(...args)=>s.rpc(...args);
export const assertAccountActive=async()=>{};
export const isEligibleAccountActor=()=>true;
export const corsHeaders={}; export const logEvent=()=>{}; export const shortUserId=()=>"synthetic";
export const json=(x,status=200)=>new Response(JSON.stringify(x),{status});`;
let callback: (r: Request) => Promise<Response>;
(globalThis as any).__capture704 = (fn: typeof callback) => { callback=fn; };
const endpoint = new URL('supabase/functions/kplus-revenuecat-pull-reconcile/index.ts',root);
let source = await Deno.readTextFile(endpoint);
source = source.replace("'../_shared/deletion/common.ts'", JSON.stringify('data:text/javascript,'+encodeURIComponent(shim)))
  .replace('Deno.serve(', 'globalThis.__capture704(')
  .replaceAll(/'\.\.\/_shared\/([^']+)'/g, (_,p) => JSON.stringify(new URL('supabase/functions/_shared/'+p,root).href));
await import('data:application/typescript,'+encodeURIComponent(source));
globalThis.fetch = async (_input, init) => {
  providerCalls++;
  if (mode==='timeout') return await new Promise((_resolve,reject)=>init!.signal!.addEventListener('abort',()=>reject(new DOMException('fixture timeout','AbortError')),{once:true}));
  if (mode==='500'||mode==='429') return json({},Number(mode));
  if (mode==='malformed') return new Response('{');
  if (mode==='blank') return new Response('');
  if (mode==='schema') return json({items:'invalid'});
  if (mode==='foreign') return json({items:[{object:'subscription',id:'sub_fixture',customer_id:B,original_customer_id:B}],next_page:null});
  return json({items:[],next_page:null});
};
async function probe(id: string, input: string, fn: ()=>Promise<unknown>) {
  calls=[]; providerCalls=0; actor=A; mode='empty'; lease='claimed';
  try { const actual=await fn(); results.push({probeId:id,input,verdict:'PASS',actual}); }
  catch(e) {results.push({probeId:id,input,verdict:'FAIL',actual:String(e)});}
}
async function pull(body='{}') {
  const response=await callback(new Request('https://fixture.invalid/pull',{method:'POST',body}));
  return {http:response.status,body:await response.json(),rpc:calls.map(x=>({fn:x.fn,args:x.args})),providerCalls};
}
await probe('B35-MAND-0432','actor A valid empty-provider baseline',async()=>{
  const r=await pull(); assert.equal(r.http,200); assert.equal(r.body.canonicalRefreshRequired,true);
  assert.equal(calls[0].args.p_user_id,A); assert.equal(calls.at(-1)!.args.p_user_id,A); return r;
});
await probe('B35-MAND-0433','actor A injects B selector',async()=>{const r=await pull(JSON.stringify({userId:B}));assert.equal(r.http,400);assert.equal(calls.length,0);assert.equal(providerCalls,0);return r;});
for (const [id,body,http] of [['0442','null',400],['0444','x'.repeat(20481),413]] as const) {
  await probe('B35-MAND-'+id,'invalid body '+id,async()=>{const r=await pull(body);assert.equal(r.http,http);assert.equal(calls.length,0);assert.equal(providerCalls,0);return r;});
}
for (const [id,m,http,status] of [
  ['0460','500',503,'provider_unavailable'],['0461','429',429,'provider_throttled'],
  ['0462','timeout',503,'provider_unavailable'],['0463','malformed',502,'provider_malformed'],
  ['0464','blank',502,'provider_malformed'],['0465','schema',502,'provider_malformed'],
] as const) await probe('B35-MAND-'+id,'provider '+m,async()=>{
  mode=m;const r=await pull(); assert.equal(r.http,http);assert.equal(r.body.status,status);
  assert.equal('access' in r.body,false);assert.equal('summary' in r.body,false);assert.equal(calls.length,2);
  assert.equal(calls.at(-1)!.fn,'finish_kplus_provider_reconciliation');return r;
});
await probe('B35-MAND-0453','existing in-flight lease prevents provider calls',async()=>{lease='in_flight';const r=await pull();assert.equal(r.http,429);assert.equal(calls.length,1);assert.equal(providerCalls,0);return r;});
await probe('B35-MAND-0459','A then B uses distinct authenticated claim/finish scopes',async()=>{
  const first=await pull();actor=B;const second=await pull();assert.equal(first.http,200);assert.equal(second.http,200);
  assert.deepEqual(calls.filter(x=>x.fn.startsWith('claim_')).map(x=>x.args.p_user_id),[A,B]);return {claims:calls.filter(x=>x.fn.startsWith('claim_')),providerCalls};
});
const auth='Bearer fixture-authorization-01234567890123456789';
function webhookBody(){const now=Date.now();return JSON.stringify({api_version:'1.0',event:{id:'evt-fixture',type:'INITIAL_PURCHASE',event_timestamp_ms:now,app_user_id:A,original_app_user_id:A,product_id:'fixture.apple.monthly',period_type:'NORMAL',purchased_at_ms:now-1000,expiration_at_ms:now+86400000,environment:'PRODUCTION',store:'APP_STORE',transaction_id:'fixture-txn',original_transaction_id:'fixture-original'}});}
async function webhook(body: string, authorization: string|null=auth, rpcStatus=200, duplicate=false, signing: string|null=null, signature: string|null=null) {
  const headers=new Headers(authorization?{authorization}:{});
  if(signature) headers.set(REVENUECAT_WEBHOOK_SIGNATURE_HEADER,signature);
  const r=await handleRevenueCatWebhook(new Request('https://fixture.invalid/webhook',{method:'POST',headers,body}),{
    env:k=>k==='KPLUS_REVENUECAT_WEBHOOK_AUTHORIZATION'?auth:k==='KPLUS_REVENUECAT_WEBHOOK_SIGNING_SECRET'?signing:(config[k]??null), now:()=>Date.now(),
    callRpc:async(fn,args)=>{calls.push({fn,args});return {ok:rpcStatus===200,status:rpcStatus,body:rpcStatus===200?{classification:duplicate?'duplicate':'applied'}:null};},log:()=>{},alert:()=>{},
  });return {http:r.status,body:await r.json(),transitionCalls:calls.length};
}
for(const [id,body,authorization,http] of [
  ['0474','{',null,401],['0485','null',auth,400],['0486','{',auth,400],['0487','x'.repeat(2621441),auth,413],
] as const) await probe('B35-MAND-'+id,'webhook auth/body '+id,async()=>{const r=await webhook(body,authorization);assert.equal(r.http,http);assert.equal(calls.length,0);return r;});
await probe('B35-MAND-0482','webhook forged JWT and configured HMAC controls',async()=>{
  const body=webhookBody();const secret='fixture-signing-secret-0123456789-abcdef';
  const t=String(Math.floor(Date.now()/1000));const signature=`t=${t},v1=${await computeRevenueCatWebhookSignature(secret,t,body)}`;
  const forged=await webhook(body,'Bearer fixture-user-jwt');
  const missing=await webhook(body,auth,200,false,secret);
  const tampered=await webhook(body+' ',auth,200,false,secret,signature);
  const old=String(Number(t)-3600);const stale=await webhook(body,auth,200,false,secret,`t=${old},v1=${await computeRevenueCatWebhookSignature(secret,old,body)}`);
  assert.deepEqual([forged.http,missing.http,tampered.http,stale.http],[401,401,401,401]);assert.equal(calls.length,0);
  const valid=await webhook(body,auth,200,false,secret,signature);assert.equal(valid.http,200);assert.equal(calls.length,1);
  return {forged,missing,tampered,stale,valid};
});
await probe('B35-MAND-0509','webhook database 401',async()=>{const r=await webhook(webhookBody(),auth,401);assert.equal(r.http,503);assert.equal(calls.length,1);return r;});
await probe('B35-MAND-0513','duplicate RPC acknowledgment preserves normalized event identity',async()=>{const body=webhookBody();const one=await webhook(body,auth,200,true);const two=await webhook(body,auth,200,true);assert.equal(one.body.status,'duplicate');assert.equal(two.body.status,'duplicate');assert.deepEqual(calls[0],calls[1]);return {one,two,identicalArguments:true};});
for(const r of results) console.log(JSON.stringify(r));
console.log(JSON.stringify({summary:{total:results.length,passed:results.filter((x:any)=>x.verdict==='PASS').length,failed:results.filter((x:any)=>x.verdict==='FAIL').length},environment:'offline Deno; real endpoint source; synthetic Auth/RPC/provider; network denied'}));
if(results.some((x:any)=>x.verdict==='FAIL')) Deno.exit(1);
