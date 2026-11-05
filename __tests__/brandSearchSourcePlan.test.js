const test=require('node:test');
const assert=require('node:assert/strict');
const source={id:'fixture',brand_name:'Research Fixture',official_website:'https://fixture-fashion.com/',canonical_domain:'fixture-fashion.com',categories:['outerwear'],us_eligible:false,enabled:false,review_status:'review'};
test('ordinary source plan retains research leads disabled and escapes SQL text',async()=>{
  const {sourcePlan}=await import('../scripts/brand-search-source-plan.mjs');
  const sql=sourcePlan([{...source,source_notes:"a'; drop table x; --"}]);
  assert.match(sql,/a''; drop table x; --/); assert.match(sql,/false,false,'review'/);
  assert.doesNotMatch(sql,/insert into public\.discovery_/);
});
test('ordinary source plan rejects implicit activation, duplicate identities and unknown merchant/product fields',async()=>{
  const {sourcePlan}=await import('../scripts/brand-search-source-plan.mjs');
  for(const rows of [[{...source,enabled:true}],[source,source],[{...source,products:[]}],[{...source,review_status:'verified'}],[{...source,canonical_domain:'127.0.0.1'}],[{...source,categories:['beauty']}]] ) assert.throws(()=>sourcePlan(rows));
});
