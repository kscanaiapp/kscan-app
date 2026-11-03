const { expectedReceiptAdvance } = require('./helpers/receiptQuotaPromotion');
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const root = path.resolve(__dirname,'..');
const reviewed = 'a2bf68e762342277a68c5846f1ad93c32029eb78';
const previous = '5fbccd1dbcd727827890777b9fa2d2d98c462206';
const migration = 'supabase/migrations/20261102125053_saved_scan_explicit_restore.sql';
const regression = '__tests__/savedScanRestoreSql.test.js';
const git = (sha,file) => execFileSync('git',['show',sha+':'+file],{cwd:root});
const json = file => JSON.parse(fs.readFileSync(path.join(root,file),'utf8'));
const policy = json('config/build35-hostile-source-promotion.json');
const before = JSON.parse(git(previous,'config/build35-hostile-source-promotion.json'));
const bytes = new Map([migration,regression].map(f=>[f,fs.readFileSync(path.join(root,f))]));
function verify(p,actual) {
  assert.equal(before.files.length,56);
  assert.equal(p.files.length,57);
  assert.equal(new Set(p.files.map(r=>r.file)).size,57);
  assert.deepEqual(p.files.filter(r=>r.file!==migration),expectedReceiptAdvance(before.files),'every existing56 promotion remains pinned except the exact reviewed receipt advance');
  const row=p.files.find(r=>r.file===migration);
  assert.equal(row.source,p.savedScanRestorationPromotion.canonicalSource);
  assert.equal(p.canonicalBackend,'31be5f99341b606a070bbbe0b3062588f320f089');
  const tree=sha=>execFileSync('git',['show','-s','--format=%T',sha],{cwd:root,encoding:'utf8'}).trim();
  assert.equal(tree(row.source),tree(reviewed),'promoted authority tree must equal the reviewed canonical repair');
  assert.equal(row.sha256,crypto.createHash('sha256').update(git(reviewed,migration)).digest('hex'));
  for(const file of [migration,regression])assert.ok(actual.get(file).equals(git(reviewed,file)),file+' must be exact reviewed canonical bytes');
  assert.deepEqual(p.sharedSigningRegressionRegistration,before.sharedSigningRegressionRegistration);
}
test('E018 promotes exact reviewed restore SQL and regression while preserving every prior grant',()=>{
  verify(policy,bytes);
  const authority=json('config/backend-authority.json');
  assert.equal(authority.role,'integration-convergence-non-authoritative');
  assert.equal(authority.build35CampaignConvergence.sha,policy.canonicalBackend);
});
test('unreviewed migration, regression, prior-grant or new-grant changes are refused',()=>{
  for(const file of [migration,regression]){
    const changed=new Map(bytes);changed.set(file,Buffer.concat([bytes.get(file),Buffer.from('\n-- unapproved mutation\n')]));
    assert.throws(()=>verify(policy,changed),assert.AssertionError);
  }
  const changed=structuredClone(policy);changed.files[0].sha256='0'.repeat(64);
  assert.throws(()=>verify(changed,bytes),assert.AssertionError);
  const extra=structuredClone(policy);extra.files.push({file:'supabase/unreviewed.sql'});
  assert.throws(()=>verify(extra,bytes),assert.AssertionError);
});
test('restoration remains pending in both environments with exactly the approved predecessor',()=>{
  const ledger=json('config/migration-authority-manifest.json');
  const old=JSON.parse(git(previous,'config/migration-authority-manifest.json'));
  const approved=JSON.parse(git(reviewed,'config/migration-authority-manifest.json'));
  for(const ref of ['yzqjvdfgefveprobvvyw','wyyuqfdxucjksghsmhry']){
    const rows=ledger.ledgerReconciliation.environments[ref].knownPending;
    const selected=rows.filter(r=>r.localVersion==='20261102125053');
    assert.equal(selected.length,1);
    assert.deepEqual(selected[0],approved.ledgerReconciliation.environments[ref].knownPending.find(r=>r.localVersion==='20261102125053'));
    assert.equal(selected[0].disposition,'KNOWN_FUTURE_UNAPPLIED');
    assert.deepEqual(selected[0].applyAfter,['20261031162813']);
    assert.deepEqual(rows.filter(r=>r.localVersion!=='20261102125053'),old.ledgerReconciliation.environments[ref].knownPending);
    ledger.ledgerReconciliation.environments[ref].knownPending=old.ledgerReconciliation.environments[ref].knownPending;
  }
  assert.deepEqual(ledger,old,'no other migration decision may be rewritten');
});
