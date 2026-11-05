const test = require('node:test');
const assert = require('node:assert/strict');
const ts = require('typescript');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');

function world({ actor = 'account-a', row = null, error = null, nextActor } = {}) {
  let authCalls = 0;
  const calls = [];
  const query = {
    select(columns) { calls.push(['select', columns]); return this; },
    eq(k,v) { calls.push(['eq',k,v]); return this; },
    upsert(data) { calls.push(['upsert',data]); return this; },
    maybeSingle: async () => ({ data: row, error }),
    single: async () => ({ data: row, error }),
  };
  const supabase = {
    auth: { getSession: async () => ({ data: { session: { user: { id: authCalls++ && nextActor ? nextActor : actor } } } }) },
    from(table) { calls.push(['from', table]); return query; },
  };
  const source = fs.readFileSync(path.join(__dirname,'../services/brandSearchPreferenceService.ts'),'utf8');
  const js = ts.transpileModule(source,{ compilerOptions: { module: ts.ModuleKind.CommonJS }}).outputText;
  const exports = {};
  vm.runInNewContext(js,{ exports, require: () => ({ supabase }) });
  return { ...exports, calls };
}
test('shopping preference defaults OFF for absent/malformed rows', async () => {
  for (const row of [null, {}, { include_black_owned_brand_search:'true' }, { include_black_owned_brand_search:false }]) {
    const w=world({row}); assert.equal(await w.fetchBrandSearchPreference('account-a'),false);
    assert.deepEqual(w.calls[2],['eq','user_id','account-a']);
  }
});
test('shopping preference rejects cross-account requests before database access', async () => {
  const w=world(); await assert.rejects(w.fetchBrandSearchPreference('account-b'),/account changed/); assert.equal(w.calls.length,0);
  await assert.rejects(w.saveBrandSearchPreference('account-b',true),/account changed/); assert.equal(w.calls.length,0);
});
test('shopping preference saves the authenticated account and round-trips its boolean', async () => {
  const w=world({row:{include_black_owned_brand_search:true}});
  assert.equal(await w.saveBrandSearchPreference('account-a',true),true);
  assert.deepEqual(JSON.parse(JSON.stringify(w.calls.find(c=>c[0]==='upsert'))),['upsert',{user_id:'account-a',include_black_owned_brand_search:true}]);
});
test('shopping preference rejects stale account responses and reports database failures', async () => {
  const switched=world({nextActor:'account-b',row:{include_black_owned_brand_search:true}});
  await assert.rejects(switched.fetchBrandSearchPreference('account-a'),/account changed/);
  const failed=world({error:{message:'offline'}}); await assert.rejects(failed.fetchBrandSearchPreference('account-a'),/Could not load/);
  await assert.rejects(failed.saveBrandSearchPreference('account-a',true),/Could not save/);
});
test('shopping preference rejects non-booleans before access', async () => {
  const w=world(); await assert.rejects(w.saveBrandSearchPreference('account-a','true'),/on or off/); assert.equal(w.calls.length,0);
});
