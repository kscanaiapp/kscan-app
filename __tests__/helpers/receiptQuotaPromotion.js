const path=require('node:path'),crypto=require('node:crypto'),assert=require('node:assert/strict'),{execFileSync}=require('node:child_process');
const root=path.resolve(__dirname,'../..'),canonical='9512a1814f92796cd77baa6557a8a78a4fd016c5',reviewed='c524bcbdde072eaf0f416238f1bb3645b669eac1',handler='supabase/functions/purchase-import-extract/handler.ts',guard='supabase/functions/scan-identify/phase2b4CrossPath.test.ts',migration='supabase/migrations/20261103011431_provider_settlement_server_authority.sql';
const files=[handler,'__tests__/helpers/purchaseImportQuotaWorld.js','__tests__/purchaseImportDefaultQuotaAdapter.test.js'];
const gitBlob=(file,sha=canonical)=>execFileSync('git',['show',sha+':'+file],{cwd:root}),sha256=bytes=>crypto.createHash('sha256').update(bytes).digest('hex');
const approvedRow=()=>({file:handler,sha256:sha256(gitBlob(handler)),source:canonical,reason:"Exact canonical PR685/F025 trusted actor-scoped quota settlement; no client settlement fallback, migration application or deployment grant."});
const additions=()=>[guard,migration].map(file=>({file,sha256:sha256(gitBlob(file)),source:canonical,reason:"Exact canonical PR685/F025 migration or exhaustive privilege-inventory regression. Source-only; no migration application or general backend access grant."}));
function expectedReceiptAdvance(rows){const result=rows.map(r=>r.file===handler?approvedRow():r);for(const row of additions())if(!result.some(r=>r.file===row.file))result.push(row);return result;}
function expectedNonReceiptFunctions(rows){return rows.filter(r=>r.name!=='purchase-import-extract').map(row=>{if(row.name==='commerce-watch-refresh'){
  // W1 is an independently reviewed Watchlist adapter change. Admit only its
  // exact source identity; preserve every pre-existing file and grant, and
  // rebuild the bundle/tree hashes from the one authorized changed file.
  const next=structuredClone(row);
  const target='supabase/functions/commerce-watch-refresh/pushDelivery.ts';
  const file=next.files.find(f=>f.path===target);
  assert.ok(file && file.bundle===true,'Watchlist ticket adapter must be a governed bundle source');
  assert.equal(file.sha256,'f6fa42466c7ed673559c319aa6e4e973b50a4213cedc3a49512c0d97ed87fb35','only the original reviewed adapter may advance');
  const approved='6906b3ef8d7d4434a4d3cc7f6f651dfe652a4cbd3036d2866d4855857f1ad062';
  const fs=require('node:fs');
  assert.equal(sha256(fs.readFileSync(path.join(root,target))),approved,'W1 adapter must retain the exact reviewed source bytes');
  file.sha256=approved;
  const hash=require('../../scripts/edge-function-manifest-lib').aggregateHash;
  next.bundleHash=hash(next.files.filter(f=>f.bundle));
  next.treeHash=hash(next.files);
  assert.equal(next.bundleHash,'cbbfcdb0909acb1cf2e964a3830ed9b812c113dca9f5b6a4dee30b8098f5f2f1');
  assert.equal(next.treeHash,'35084daa10275f7caff245481bddb4aa96ba898f2c34c5f3c8eff04e71262cec');
  return next;
 }if(row.name!=='scan-identify')return row;const next=structuredClone(row),file=next.files.find(f=>f.path===guard);assert.ok(file);assert.equal(file.bundle,false,'only the reviewed test file may change');file.sha256=sha256(gitBlob(guard));next.treeHash=require('../../scripts/edge-function-manifest-lib').aggregateHash(next.files);return next;});}
function expectedPendingAdvance(rows,ref){const approved=JSON.parse(gitBlob('config/migration-authority-manifest.json')).ledgerReconciliation.environments[ref].knownPending.find(r=>r.localVersion==='20261103011431');assert.ok(approved);assert.equal(approved.disposition,'KNOWN_FUTURE_UNAPPLIED');return [...rows,approved];}
module.exports={root,canonical,reviewed,handler,files,gitBlob,sha256,approvedRow,expectedReceiptAdvance,expectedNonReceiptFunctions,expectedPendingAdvance};
