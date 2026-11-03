const test = require('node:test');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const path = require('node:path');
const load = () => import(pathToFileURL(path.resolve(__dirname, '../../scripts/lib/production-recovery-health.mjs')));
const fn = 'kplus-revenuecat-webhook';
const capture = {function_name: fn, target: 'wyyuqfdxucjksghsmhry', verify_jwt: false,
  tree_digest: 'fdde08b9b39092a87ca531912e7b2d57332b3c6e22294653b75d86d560142bb4'};

test('exact restored pre-710 source accepts its original OPTIONS405 contract', async () => {
  const {recoveryHealthResult: check} = await load();
  assert.equal(check(fn, capture, 405, '{"status":"method_not_allowed"}').ok, true);
  for (const status of [200,204,401,500,503]) assert.equal(check(fn,capture,status,'').ok,false);
});
test('changed source, JWT, function or project cannot inherit legacy exception', async () => {
  const {recoveryHealthResult: check} = await load();
  for(const other of [undefined, {...capture,tree_digest:'a'.repeat(64)},
    {...capture,verify_jwt:true}, {...capture,function_name:'other'}, {...capture,target:'yzqjvdfgefveprobvvyw'}]) {
    assert.equal(check(fn,other,405,'').ok,false);
    assert.equal(check(fn,other,204,'').ok,true);
  }
  assert.equal(check('scan-identify',capture,405,'').ok,false);
});
test('legacy method refusal never permits boot errors, credential leakage or oversized bodies', async () => {
  const {recoveryHealthResult: check} = await load();
  for (const body of ['BOOT_ERROR','service_role','eyJabcdefghijklm','sbp_fixture','sb_secret_fixture','password','x'.repeat(8193)]) {
    assert.equal(check(fn,capture,405,body).ok,false);
  }
});
test('normal recovery contract still refuses outages and preserves safe 200/204', async () => {
  const {recoveryHealthResult: check} = await load();
  for(const status of [401,403,405,429,500,503])assert.equal(check(fn,null,status,'').ok,false);
  for(const status of [200,204])assert.equal(check(fn,null,status,'').ok,true);
});
