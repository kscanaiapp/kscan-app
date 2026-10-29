const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');
function load(file) {
  const source=fs.readFileSync(path.join(__dirname,'..',file),'utf8');
  const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS}}).outputText;
  const module={exports:{}};vm.runInNewContext(js,{exports:module.exports,module,require,Date,Set,Promise,AbortController,setTimeout,clearTimeout});return module.exports;
}
const {hasVerifiedOwnership,requestBlackOwnedDiscovery}=load('services/blackOwnedDiscovery.ts');
const input={garment:{item_type:'outerwear',subtype:'bomber'},market:'US',primaryProducts:[]};
test('identity is optional, verified, permissioned and unexpired',()=>{
  const identity={brandId:'fixture',brandName:'Synthetic Brand',ownershipVerificationStatus:'verified',publicOwnershipLabelAllowed:true,verifiedUntil:'2099-01-01T00:00:00Z'};
  assert.equal(hasVerifiedOwnership(),false);assert.equal(hasVerifiedOwnership(identity),true);
  for(const overrides of [{ownershipVerificationStatus:'pending_review'},{publicOwnershipLabelAllowed:false},{verifiedUntil:'2020-01-01'},{verifiedUntil:'invalid'},{brandId:''}])assert.equal(hasVerifiedOwnership({...identity,...overrides}),false);
});
test('client defaults OFF and cannot start secondary work until primary settles',async()=>{
  let calls=0;const invoke=async()=>{calls++;return{data:null,error:null};};
  await requestBlackOwnedDiscovery(invoke,input);await requestBlackOwnedDiscovery(invoke,input,{enabled:true});assert.equal(calls,0);
  await requestBlackOwnedDiscovery(invoke,input,{enabled:true,primarySettled:true});assert.equal(calls,1);
});
test('client sends only garment attributes, no raw image or primary response mutation',async()=>{
  const richer={...input,image:'private',garment:{...input.garment,image:'private'},primaryProducts:[{id:'primary',productUrl:'https://fixture-fashion.com/p',image:'private'}]};
  const before=JSON.stringify(richer);
  const result=await requestBlackOwnedDiscovery(async(name,{body})=>{assert.equal(name,'black-owned-discovery');assert.equal(JSON.stringify(body).includes('private'),false);return{data:{version:'black-owned-discovery-v1',status:'empty',products:[],primaryOwnership:{},generatedAt:new Date().toISOString()},error:null};},richer,{enabled:true,primarySettled:true});
  assert.equal(result.status,'empty');assert.equal(JSON.stringify(richer),before);
});
test('client failure and cancellation leave secondary absent',async()=>{
  assert.equal(await requestBlackOwnedDiscovery(async()=>{throw new Error('offline');},input,{enabled:true,primarySettled:true}),undefined);
  const controller=new AbortController();controller.abort();assert.equal(await requestBlackOwnedDiscovery(async()=>{throw new Error('must not run');},input,{enabled:true,primarySettled:true,signal:controller.signal}),undefined);
});
test('telemetry allowlists events, removes arbitrary properties, never equates click with purchase',()=>{
  const telemetry=load('services/blackOwnedDiscoveryTelemetry.ts');const events=[];
  telemetry.setBlackOwnedDiscoveryAnalyticsSink((event,payload)=>events.push({event,payload}));
  telemetry.trackBlackOwnedDiscovery('black_owned_shop',{position:1,image:'secret',contact:'private'});
  telemetry.trackBlackOwnedDiscovery('confirmed_purchase',{});assert.equal(events.length,1);
  assert.deepEqual(JSON.parse(JSON.stringify(events[0].payload)),{lane:'black_owned',placement_type:'organic',position:1});
});
test('prepared shelf remains unmounted, hides zero results, and existing card actions remain',()=>{
  const shelf=fs.readFileSync(path.join(__dirname,'../components/scan-results/BlackOwnedDiscoveryShelf.tsx'),'utf8');
  assert.match(shelf,/enabled = false/);assert.match(shelf,/if \(!visible \|\| !response\) return null/);assert.match(shelf,/openExternalUrl/);assert.match(shelf,/onAddToRoom=/);
  const routes=fs.readdirSync(path.join(__dirname,'../app')).filter(f=>f.endsWith('.tsx'));for(const route of routes)assert.equal(fs.readFileSync(path.join(__dirname,'../app',route),'utf8').includes('BlackOwnedDiscoveryShelf'),false);
});
