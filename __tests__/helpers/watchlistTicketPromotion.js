// Exact PR689 Watchlist adapter advance; all earlier source promotion identities stay immutable.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),canonical='6d96156745160d93596dd792769df6aed164e6fe',reviewed='d50b2fb3968fa305bb8ef468fe63132d5d33dc33',tree='4e9ed1080b7a35f602328672042b7329f69aef94',base='77a6b97f86b21bf619e051646b635e3ce26b7f73';
const files=['supabase/functions/commerce-watch-refresh/pushDelivery.ts','__tests__/watchlistPushTicketAcceptance.test.js'];
const note=' Exact canonical PR689/E026 Watchlist trackable Expo-ticket validation; no schema, deployment, scheduler or notification activation grant.';
const gitBlob=(f,ref=canonical)=>cp.execFileSync('git',['show',ref+':'+f],{cwd:root}),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const approved={file:files[0],sha256:hash(gitBlob(files[0])),source:canonical,reason:note.trim()};
function advance(rows){const out=rows.map(r=>({...r})),existing=out.find(r=>r.file===approved.file);if(existing)assert.deepEqual(existing,approved);else out.push({...approved});return out;}
const canonicalWatch=JSON.parse(gitBlob('config/edge-function-manifest.json')).parity.functions.find(r=>r.name==='commerce-watch-refresh');
// W2 (#700) advances the runtime AFTER the exact W1 ticket repair.
// Independently pin both steps so previous source grants never silently widen.
const w2Canonical='2846fd147fc36b72404372919ee8d1e88421da75';
const w2Index='supabase/functions/commerce-watch-refresh/index.ts';
const w2Deno='supabase/functions/commerce-watch-refresh/invalidBodyHostile.test.ts';
const canonicalW2Watch=JSON.parse(gitBlob('config/edge-function-manifest.json',w2Canonical)).parity.functions.find(r=>r.name==='commerce-watch-refresh');
const aggregate=require('../../scripts/edge-function-manifest-lib').aggregateHash;
function w2Advance(rows){return rows.map(row=>{
 if(row.name!=='commerce-watch-refresh')return row;
 assert.deepEqual(row,canonicalWatch,'W2 may only advance the approved W1 source');
 const next=structuredClone(row),index=next.files.findIndex(f=>f.path===w2Index);
 assert.ok(index>=0&&next.files[index].bundle===true,'W2 must alter the actual entrypoint');
 assert.equal(next.files.some(f=>f.path===w2Deno),false,'W2 Deno regression added exactly once');
 next.files[index].sha256=hash(gitBlob(w2Index,w2Canonical));
 next.files.splice(index+1,0,{path:w2Deno,sha256:hash(gitBlob(w2Deno,w2Canonical)),bundle:false});
 next.treeFileCount=next.files.length;
 next.treeHash=aggregate(next.files);
 next.bundleHash=aggregate(next.files.filter(f=>f.bundle));
 assert.deepEqual(next,canonicalW2Watch,'W2 may advance only its exact approved runtime/test files');
 return next;
});}
function functionAdvance(rows){const w1=rows.map(row=>{
 if(row.name!=='commerce-watch-refresh')return row;
 const next=structuredClone(row),file=next.files.find(f=>f.path===files[0]);
 assert.ok(file&&file.bundle===true);
 file.sha256=approved.sha256;
 next.treeHash=aggregate(next.files);
 next.bundleHash=aggregate(next.files.filter(f=>f.bundle));
 assert.deepEqual(next,canonicalWatch,'only the exact W1 ticket adapter may advance');
 return next;
});return w2Advance(w1);}
module.exports={root,canonical,reviewed,tree,base,files,note,approved,gitBlob,hash,advance,functionAdvance,w2Advance,w2Canonical,w2Index,w2Deno,fileCount:67};
