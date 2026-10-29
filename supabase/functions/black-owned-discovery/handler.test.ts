import assert from 'node:assert/strict';
import { createDiscoveryHandler, type HandlerDependencies } from './handler.ts';
import { emptyResponse } from './engine.ts';
import { input } from './fixtures.test.ts';
const request = (body: unknown = input) => new Request('https://fixture.kscan.ai/discovery',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)});
function rig() {
  const calls: string[]=[];
  const deps: HandlerDependencies = { flags:()=>({discovery:true,badges:true,sponsored:false}),authenticate:async()=>{calls.push('auth');return{id:'fixture-account',isAnonymous:false};},claim:async()=>{calls.push('limit');return true;},discover:async()=>{calls.push('discovery');return emptyResponse('empty',Date.now());} };
  return {calls,deps};
}
Deno.test('endpoint OFF has zero I/O and leaves primary untouched',async()=>{
  const {calls,deps}=rig();deps.flags=()=>({discovery:false,badges:false,sponsored:false});
  const response=await createDiscoveryHandler(deps)(request());assert.equal(response.status,200);assert.equal((await response.json()).status,'unavailable');assert.deepEqual(calls,[]);
});
Deno.test('endpoint accepts sanitized attributes only and returns an additive versioned empty response',async()=>{
  const {calls,deps}=rig();const response=await createDiscoveryHandler(deps)(request());const result=await response.json();
  assert.equal(result.version,'black-owned-discovery-v1');assert.deepEqual(result.products,[]);assert.deepEqual(calls,['auth','limit','discovery']);assert.equal(response.headers.get('cache-control'),'no-store');
});
Deno.test('endpoint rejects unauthenticated, anonymous, oversized, unsafe fields, and quota exhaustion',async()=>{
  const {deps}=rig();const handler=createDiscoveryHandler(deps);
  deps.authenticate=async()=>{throw new Response(null,{status:401});};assert.equal((await handler(request())).status,401);
  deps.authenticate=async()=>({id:'fixture-account',isAnonymous:true});assert.equal((await handler(request())).status,403);
  deps.authenticate=async()=>({id:'fixture-account',isAnonymous:false});
  assert.equal((await handler(request({...input,image:'secret raw photo'}))).status,400);
  assert.equal((await handler(request({data:'x'.repeat(17000)}))).status,400);
  deps.claim=async()=>false;assert.equal((await handler(request())).status,429);
});
