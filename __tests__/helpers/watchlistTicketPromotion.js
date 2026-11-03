// Exact PR689 Watchlist adapter advance; all earlier source promotion identities stay immutable.
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),crypto=require('node:crypto'),cp=require('node:child_process');
const root=path.resolve(__dirname,'../..'),canonical='6d96156745160d93596dd792769df6aed164e6fe',reviewed='d50b2fb3968fa305bb8ef468fe63132d5d33dc33',tree='4e9ed1080b7a35f602328672042b7329f69aef94',base='77a6b97f86b21bf619e051646b635e3ce26b7f73';
const files=['supabase/functions/commerce-watch-refresh/pushDelivery.ts','__tests__/watchlistPushTicketAcceptance.test.js'];
const note=' Exact canonical PR689/E026 Watchlist trackable Expo-ticket validation; no schema, deployment, scheduler or notification activation grant.';
const gitBlob=(f,ref=canonical)=>cp.execFileSync('git',['show',ref+':'+f],{cwd:root}),hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const approved={file:files[0],sha256:hash(gitBlob(files[0])),source:canonical,reason:note.trim()};
function advance(rows){const out=rows.map(r=>({...r})),existing=out.find(r=>r.file===approved.file);if(existing)assert.deepEqual(existing,approved);else out.push({...approved});return out;}
const canonicalWatch=JSON.parse(gitBlob('config/edge-function-manifest.json')).parity.functions.find(r=>r.name==='commerce-watch-refresh');
function functionAdvance(rows){return rows.map(row=>{if(row.name!=='commerce-watch-refresh')return row;const next=structuredClone(row),file=next.files.find(f=>f.path===files[0]);assert.ok(file&&file.bundle===true);file.sha256=approved.sha256;const aggregate=require('../../scripts/edge-function-manifest-lib').aggregateHash;next.treeHash=aggregate(next.files);next.bundleHash=aggregate(next.files.filter(f=>f.bundle));assert.deepEqual(next,canonicalWatch,'only the exact ticket adapter may advance; preserve all other Watchlist source');return next;});}
module.exports={root,canonical,reviewed,tree,base,files,note,approved,gitBlob,hash,advance,functionAdvance,fileCount:67};
