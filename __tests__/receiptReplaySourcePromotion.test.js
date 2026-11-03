const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),cp=require('node:child_process');
const {root,canonical,reviewed,handler,gitBlob,approvedRow,expectedReceiptAdvance}=require('./helpers/receiptQuotaPromotion');
const base='892f9ef08b29bbce68edffb96298b0a8bf65814a',files=["supabase/functions/purchase-import-extract/handler.ts","__tests__/purchaseImportReplayDispatch.test.js"],meta={"canonicalSource":"31be5f99341b606a070bbbe0b3062588f320f089","reviewedSource":"184395bc8899904946ce0c86e8c0a64ebef03b76","sourceTree":"1b6dbc86d3f7fe8a4c562da5aaae65a16fa75068","files":["supabase/functions/purchase-import-extract/handler.ts","__tests__/purchaseImportReplayDispatch.test.js"],"runtimeRepairSource":"26d5fae291ffcdbb1a56e312524013c6939ab152","fixtureCorrectionPr":684};
const json=f=>JSON.parse(fs.readFileSync(root+'/'+f,'utf8')),before=JSON.parse(gitBlob('config/build35-hostile-source-promotion.json',base)),oldManifest=JSON.parse(gitBlob('config/edge-function-manifest.json',base)),canonicalManifest=JSON.parse(gitBlob('config/edge-function-manifest.json'));
const policy=json('config/build35-hostile-source-promotion.json'),actual=new Map(files.map(f=>[f,fs.readFileSync(root+'/'+f)]));
function verify(p,bytes,manifest){
 assert.equal(canonical,meta.canonicalSource);assert.equal(reviewed,meta.reviewedSource);
 assert.equal(p.canonicalBackend,canonical);assert.equal(p.files.length,57);assert.deepEqual(p.files,expectedReceiptAdvance(before.files));assert.deepEqual(p.files.find(r=>r.file===handler),approvedRow());
 assert.deepEqual(p.receiptQuotaReplayPromotion,meta);const prior={...p};delete prior.receiptQuotaReplayPromotion;assert.deepEqual(prior,{...before,canonicalBackend:canonical,files:expectedReceiptAdvance(before.files)});
 for(const f of files)assert.ok(bytes.get(f).equals(gitBlob(f)),f+' must match merged canonical source');
 const getTree=sha=>cp.execFileSync('git',['show','-s','--format=%T',sha],{cwd:root,encoding:'utf8'}).trim();assert.equal(getTree(canonical),meta.sourceTree);assert.equal(getTree(reviewed),meta.sourceTree);
 const receipt=m=>m.parity.functions.find(f=>f.name==='purchase-import-extract');assert.deepEqual(receipt(manifest),receipt(canonicalManifest));assert.deepEqual(manifest.parity.functions.filter(f=>f.name!=='purchase-import-extract'),oldManifest.parity.functions.filter(f=>f.name!=='purchase-import-extract'));
}
test('F024 promotes exact replay repair/regression while retaining all historical grants and C023 provenance',()=>{verify(policy,actual,json('config/edge-function-manifest.json'));const a=json('config/backend-authority.json');assert.equal(a.role,'integration-convergence-non-authoritative');assert.equal(a.build35CampaignConvergence.sha,canonical);});
test('F024 refuses source, prior grant, historical provenance, wildcard or unrelated function mutations',()=>{
 for(const f of files){const bytes=new Map(actual);bytes.set(f,Buffer.concat([bytes.get(f),Buffer.from('\n// unauthorized\n')]));assert.throws(()=>verify(policy,bytes,json('config/edge-function-manifest.json')),assert.AssertionError);}
 for(const mutate of [p=>{p.files[0].sha256='0'.repeat(64);},p=>{p.files.find(r=>r.file===handler).source='0'.repeat(40);},p=>{p.receiptQuotaIdPromotion.canonicalSource='0'.repeat(40);},p=>{p.receiptQuotaReplayPromotion.files.push('*');}]){const bad=structuredClone(policy);mutate(bad);assert.throws(()=>verify(bad,actual,json('config/edge-function-manifest.json')),assert.AssertionError);}
 const bad=json('config/edge-function-manifest.json');bad.parity.functions.find(f=>f.name!=='purchase-import-extract').bundleHash='0'.repeat(64);assert.throws(()=>verify(policy,actual,bad),assert.AssertionError);
});
