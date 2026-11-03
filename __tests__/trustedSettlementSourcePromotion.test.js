const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const {root,canonical,reviewed,gitBlob,expectedReceiptAdvance,expectedNonReceiptFunctions}=require('./helpers/receiptQuotaPromotion');
const base='09f0abad1a443c2601aaddc9c26e85b636c216c4',source='9512a1814f92796cd77baa6557a8a78a4fd016c5',review='c524bcbdde072eaf0f416238f1bb3645b669eac1',tree='102f117a04c6ee41f1ee42d2dec88f294f6515e0';
const files=['supabase/functions/purchase-import-extract/handler.ts','supabase/functions/scan-identify/phase2b4CrossPath.test.ts','supabase/migrations/20261103011431_provider_settlement_server_authority.sql','__tests__/helpers/purchaseImportQuotaWorld.js','__tests__/providerSettlementAuthority.test.js','__tests__/purchaseImportReplayDispatch.test.js','docs/security/provider-cost-controls.md'];
const meta={canonicalSource:source,reviewedSource:review,sourceTree:tree,files,migrationVersion:'20261103011431',migrationDisposition:'KNOWN_FUTURE_UNAPPLIED'};
const json=f=>JSON.parse(fs.readFileSync(root+'/'+f,'utf8')),before=JSON.parse(gitBlob('config/build35-hostile-source-promotion.json',base)),oldManifest=JSON.parse(gitBlob('config/edge-function-manifest.json',base));
const policy=json('config/build35-hostile-source-promotion.json'),bytes=new Map(files.map(f=>[f,fs.readFileSync(root+'/'+f)]));
const registryBefore=JSON.parse(gitBlob('config/migration-authority-manifest.json',base)),canonicalRegistry=JSON.parse(gitBlob('config/migration-authority-manifest.json'));
const stagingPath='__tests__/staging/stagingMigrationReconciliation.test.js',stagingBefore=gitBlob(stagingPath,base).toString('utf8'),anchor="['20261102125053', 'KNOWN_FUTURE_UNAPPLIED'],";
function verify(p,actual,manifest,registry,staging){
 assert.equal(canonical,source);assert.equal(reviewed,review);assert.equal(p.canonicalBackend,source);assert.equal(before.files.length,57);assert.equal(p.files.length,59);assert.deepEqual(p.files,expectedReceiptAdvance(before.files));assert.deepEqual(p.trustedQuotaSettlementPromotion,meta);
 const prior={...p};delete prior.trustedQuotaSettlementPromotion;assert.deepEqual(prior,{...before,canonicalBackend:source,files:expectedReceiptAdvance(before.files)},'preserve C023/F024 and all prior ownership metadata');
 for(const f of files)assert.ok(actual.get(f).equals(gitBlob(f)),f+' must equal merged canonical bytes');
 const getTree=sha=>cp.execFileSync('git',['show','-s','--format=%T',sha],{cwd:root,encoding:'utf8'}).trim();assert.equal(getTree(source),tree);assert.equal(getTree(review),tree);
 const receipt=m=>m.parity.functions.find(f=>f.name==='purchase-import-extract');assert.deepEqual(receipt(manifest),receipt(JSON.parse(gitBlob('config/edge-function-manifest.json'))));assert.deepEqual(manifest.parity.functions.filter(f=>f.name!=='purchase-import-extract'),expectedNonReceiptFunctions(oldManifest.parity.functions),'only the canonical scan test tree may advance outside receipt runtime');
 const expected=structuredClone(registryBefore);for(const project of ['yzqjvdfgefveprobvvyw','wyyuqfdxucjksghsmhry'])expected.ledgerReconciliation.environments[project].knownPending.push(canonicalRegistry.ledgerReconciliation.environments[project].knownPending.find(r=>r.localVersion===meta.migrationVersion));assert.deepEqual(registry,expected,'append exact pending declaration; preserve all mobile registry differences');
 assert.equal(staging,stagingBefore.replace(anchor,anchor+"\n      ['20261103011431', 'KNOWN_FUTURE_UNAPPLIED'],"));assert.equal(fs.existsSync(root+'/__tests__/staging/productionMigrationReconciliation.test.js'),false,'do not import backend deployment governance');
}
test('F025 copies exact scoped source and preserves mobile governance, prior promotions and runtime bundle boundaries',()=>{
 verify(policy,bytes,json('config/edge-function-manifest.json'),json('config/migration-authority-manifest.json'),fs.readFileSync(root+'/'+stagingPath,'utf8'));
 const a=json('config/backend-authority.json');assert.equal(a.role,'integration-convergence-non-authoritative');assert.equal(a.build35CampaignConvergence.sha,source);
 for(const f of ['app.json','eas.json'])assert.equal(fs.readFileSync(root+'/'+f,'utf8').replace(/\r\n/g,'\n'),gitBlob(f,base).toString('utf8').replace(/\r\n/g,'\n'));
});
test('F025 refuses unrelated grants, source mutations, historical provenance drift, migration approval and scan runtime changes',()=>{
 const manifest=json('config/edge-function-manifest.json'),registry=json('config/migration-authority-manifest.json'),staging=fs.readFileSync(root+'/'+stagingPath,'utf8');
 for(const f of files){const bad=new Map(bytes);bad.set(f,Buffer.concat([bad.get(f),Buffer.from('\n// unauthorized\n')]));assert.throws(()=>verify(policy,bad,manifest,registry,staging),assert.AssertionError);}
 for(const mutate of [p=>{p.files[0].sha256='0'.repeat(64);},p=>{p.files.push({file:'supabase/unreviewed.sql'});},p=>{p.receiptQuotaReplayPromotion.canonicalSource=source;},p=>{p.trustedQuotaSettlementPromotion.files.push('*');}]){const bad=structuredClone(policy);mutate(bad);assert.throws(()=>verify(bad,bytes,manifest,registry,staging),assert.AssertionError);}
 const badManifest=structuredClone(manifest);badManifest.parity.functions.find(f=>f.name==='scan-identify').bundleHash='0'.repeat(64);assert.throws(()=>verify(policy,bytes,badManifest,registry,staging),assert.AssertionError);
 const badRegistry=structuredClone(registry);badRegistry.ledgerReconciliation.environments.yzqjvdfgefveprobvvyw.knownPending.find(r=>r.localVersion===meta.migrationVersion).disposition='APPLIED';assert.throws(()=>verify(policy,bytes,manifest,badRegistry,staging),assert.AssertionError);
});
