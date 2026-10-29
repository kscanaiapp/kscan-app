const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const migration = fs.readFileSync(path.join(__dirname, '../supabase/migrations/20261029125521_black_owned_discovery_v1.sql'), 'utf8');
const ADMIN = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const REVIEWER = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const USER = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
async function database() {
  const { PGlite } = await import('@electric-sql/pglite');
  const db = await PGlite.create();
  await db.exec(`create schema auth; create table auth.users(id uuid primary key);
    create role anon; create role authenticated; create role service_role;
    insert into auth.users values('${ADMIN}'),('${REVIEWER}'),('${USER}');`);
  await db.exec(migration);
  await db.query('insert into discovery_reviewers values($1,\'administrator\',true),($2,\'reviewer\',true)', [ADMIN, REVIEWER]);
  await db.exec('set role service_role');
  return db;
}
async function manage(db, action, data, actor = ADMIN) {
  return (await db.query('select discovery_manage($1,$2,$3::jsonb) as id', [actor, action, JSON.stringify(data)])).rows[0].id;
}
const future = (days) => new Date(Date.now() + days*86400000).toISOString();
async function registry(db, sandboxOnly = false) {
  const brand = await manage(db, 'register_brand', { name: 'Isolated Synthetic Brand', website: 'https://fixture-fashion.com/', categories: ['outerwear'], markets: ['US'] });
  const evidence = await manage(db, 'submit_evidence', { brand_id: brand, method: 'authorized_attestation', provenance_ref: 'fixture:attestation', corroboration_ref: 'fixture:corroboration', authorized_submission: true, expires_at: future(90), retain_until: future(120) });
  await manage(db,'request_review',{id:brand});
  await manage(db,'review_ownership',{id:brand,status:'verified',evidence_id:evidence,verified_until:future(60),policy_version:'kscan-ownership-review-v1-draft'},REVIEWER);
  await manage(db,'brand_visibility',{id:brand,public_label_allowed:true,public_permission_ref:'fixture:consent',operating_status:'active'});
  const merchantData = { brand_id: brand, sandbox_only:sandboxOnly, legal_identity_ref:'fixture:identity',identity_verified_at:new Date(Date.now()-1000).toISOString(),identity_expires_at:future(90),status:'active',catalog_status:'approved',approved_domains:['fixture-fashion.com'],image_domains:['images.fixture-fashion.com'],markets:['US'],source_kind:'authorized_json',source_authorization_ref:'fixture:feed-license',source_authorized_until:future(90) };
  const merchant = await manage(db,'merchant',merchantData);
  return { brand,evidence,merchant,merchantData };
}
function product(changes={}) { return { source_product_id:'synthetic-bomber',variant_id:'M',sku:'fixture-sku',title:'Synthetic cropped leather bomber',category:'outerwear',subtype:'bomber',attributes:{primary_color:'black',material_estimate:'leather',silhouette:'cropped'},image_url:'https://images.fixture-fashion.com/bomber.jpg',product_url:'https://fixture-fashion.com/products/bomber',price_amount:120,currency:null,availability:'in_stock',sizes:['M'],markets:['US'],source_provenance_ref:'fixture:feed-license',...changes }; }
async function ingest(db, merchant, products=[product()], key='fixture-sync-0001', complete=true) {
  await db.query('select discovery_begin_sync($1,$2)',[merchant,key]);
  return (await db.query('select discovery_ingest($1,$2,$3::jsonb,$4) as n',[merchant,key,JSON.stringify(products),complete])).rows[0].n;
}
async function candidates(db) { return (await db.query("select discovery_candidates('outerwear','bomber','US') as result")).rows[0].result; }

test('actual migration: service-only grants, RLS and RPCs deny customers, zero campaigns initialized', async (t) => {
  const db=await database();
  try {
    const tables=(await db.query("select tablename from pg_tables where schemaname='public' and tablename like 'discovery_%' order by tablename")).rows;
    assert.equal(tables.length,13);
    assert.equal((await db.query('select count(*)::int as n from discovery_campaigns')).rows[0].n,0);
    assert.equal((await db.query("select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='public' and p.proname like 'discovery_%' and p.prosecdef")).rows[0].n,0);
    for (const role of ['anon','authenticated']) await t.test(`${role}: SELECT/INSERT/UPDATE/DELETE/RPC all denied`,async()=>{
      await db.exec(`reset role; set role ${role}`);
      for(const {tablename} of tables) {
        for(const sql of [`select * from ${tablename}`,`delete from ${tablename}`,`update ${tablename} set ${tablename==='discovery_runtime_guard'?"environment='staging'":tablename==='discovery_catalog_revision'?'revision=1':tablename==='discovery_reviewers'?'enabled=true':tablename==='discovery_request_limits'?'requests=1':tablename==='discovery_audit'?"action='forged'":"id=gen_random_uuid()"}`,`insert into ${tablename} default values`]) await assert.rejects(db.exec(sql),e=>e.code==='42501');
      }
      await assert.rejects(db.query("select discovery_manage($1,'register_brand','{}')",[USER]),e=>e.code==='42501');
      await assert.rejects(db.query('select discovery_claim_request($1)',[USER]),e=>e.code==='42501');
      await assert.rejects(db.exec('select * from discovery_eligible_products'),e=>e.code==='42501');
    });
  } finally { await db.close(); }
});
test('evidence review: no self-verification, no uncorroborated attestation, no unauthorized reviewer',async()=>{
  const db=await database();try{
    const brand=await manage(db,'register_brand',{name:'Synthetic Brand',website:'https://fixture-fashion.com/'});
    await assert.rejects(manage(db,'request_review',{id:brand},USER),e=>e.code==='42501');
    await manage(db,'request_review',{id:brand});
    const evidence=await manage(db,'submit_evidence',{brand_id:brand,method:'authorized_attestation',provenance_ref:'fixture:attestation',authorized_submission:true,expires_at:future(90),retain_until:future(120)});
    const decision={id:brand,status:'verified',evidence_id:evidence,verified_until:future(60),policy_version:'kscan-ownership-review-v1-draft'};
    await assert.rejects(manage(db,'review_ownership',decision,REVIEWER),e=>e.code==='23514');
    await db.query("update discovery_evidence set corroboration_ref='fixture:independent' where id=$1",[evidence]);
    await assert.rejects(manage(db,'review_ownership',decision,ADMIN),e=>e.code==='23514');
    await assert.rejects(manage(db,'review_ownership',{...decision,verified_until:null},REVIEWER),e=>e.code==='23514');
    await manage(db,'review_ownership',decision,REVIEWER);
    await assert.rejects(manage(db,'review_ownership',decision,REVIEWER));
    assert.equal((await db.query('select ownership_status from discovery_brands where id=$1',[brand])).rows[0].ownership_status,'verified');
    assert.ok((await db.query('select count(*)::int as n from discovery_audit')).rows[0].n>=4);
    await assert.rejects(db.exec("update discovery_audit set action='tampered'"),e=>e.code==='42501');
  }finally{await db.close();}
});
test('end-to-end actual registry → authorized atomic ingestion → deterministic relevance → versioned response',async()=>{
  const db=await database();try{
    const {brand,merchant}=await registry(db);assert.equal(await ingest(db,merchant),1);
    const snapshot=await candidates(db); assert.equal(snapshot.rows.length,1);assert.equal(snapshot.rows[0].brand_id,brand);assert.equal(snapshot.rows[0].currency,null);
    // Runtime import keeps Deno modules out of the mobile TypeScript graph.
    const {pathToFileURL}=require('node:url');
    const {createDiscoveryService}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/black-owned-discovery/engine.ts')).href);
    const {parseDiscoveryInput}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/black-owned-discovery/validation.ts')).href);
    const input=parseDiscoveryInput({garment:{item_type:'outerwear',subtype:'bomber',primary_color:'black',material_estimate:'leather',silhouette:'cropped'},market:'US',primaryProducts:[]});
    const service=createDiscoveryService({revision:async()=>(await candidates(db)).revision,candidates:()=>candidates(db),ownership:async()=>({})});
    const response=await service(input,{discovery:true,badges:true,sponsored:false});
    assert.equal(response.status,'ready');assert.equal(response.products[0].brandId,brand);assert.equal(response.products[0].matchType,'similar');assert.equal(response.products[0].price,'120.00');assert.equal(response.canonicalCommerce.products.length,1);
    const serialized=JSON.stringify(response);for(const key of ['provenance_ref','submitted_by','reviewer_id','terms_ref','credential','fashionMatchScore'])assert.equal(serialized.includes(key),false,key);
    await manage(db,'brand_visibility',{id:brand,public_label_allowed:false});
    assert.equal((await service(input,{discovery:true,badges:true,sponsored:false})).status,'empty');
  }finally{await db.close();}
});
test('catalog integrity: reservation, idempotency, variants, duplicate SKU, unsafe URL, missing currency, atomic removal',async()=>{
  const db=await database();try{
    const {merchant}=await registry(db);
    await assert.rejects(db.query('select discovery_ingest($1,$2,$3::jsonb,true)',[merchant,'no-reservation',JSON.stringify([product()])]));
    assert.equal(await ingest(db,merchant),1);assert.equal(await ingest(db,merchant),1);
    assert.equal((await db.query('select count(*)::int as n from discovery_products')).rows[0].n,1);
    await assert.rejects(ingest(db,merchant,[product({price_amount:5})]));
    await assert.rejects(ingest(db,merchant,[product(),product({source_product_id:'other'})],'fixture-bad-skus'));
    assert.equal((await db.query('select count(*)::int as n from discovery_products')).rows[0].n,1);
    for (const [i,url] of ['http://fixture-fashion.com/x','https://127.0.0.1/x','https://fixture-fashion.com/x?url=evil','https://fixture-fashion.com.evil.com/x'].entries()) await assert.rejects(ingest(db,merchant,[product({product_url:url})],`fixture-bad-url-${i}`));
    // Failed transactional upserts never withdraw existing inventory.
    assert.equal((await candidates(db)).rows.length,1);
    // Independent merchant for removal: no quota carried across fixtures.
    const other=await registry(db);await ingest(db,other.merchant);
    await ingest(db,other.merchant,[],'fixture-empty-snapshot');
    assert.equal((await db.query('select validation_state from discovery_products where merchant_id=$1',[other.merchant])).rows[0].validation_state,'withdrawn');
    assert.equal((await db.query('select currency from discovery_products where merchant_id=$1',[merchant])).rows[0].currency,null);
  }finally{await db.close();}
});
test('eligibility: expired/revoked/opt-out/deactivated inventory suppressed, primary ownership lookup exact, partnerships optional',async()=>{
  const db=await database();try{
    const {brand,merchant,merchantData}=await registry(db);await ingest(db,merchant);
    const id=(await candidates(db)).rows[0].id;
    const lookup=async(url)=>(await db.query('select discovery_primary_ownership($1::jsonb) as result',[JSON.stringify([{id:'primary',productUrl:url}])])).rows[0].result;
    assert.equal((await lookup(product().product_url)).primary.brandId,brand);
    assert.deepEqual(await lookup('https://fixture-fashion.com/products/unrelated'),{});
    assert.equal((await db.query('select count(*)::int as n from discovery_partnerships')).rows[0].n,0);
    await manage(db,'merchant',{...merchantData,id:merchant,status:'paused'});assert.equal((await candidates(db)).rows.length,0);
    await manage(db,'merchant',{...merchantData,id:merchant});assert.equal((await candidates(db)).rows.length,1);
    await manage(db,'withdraw_product',{id});assert.equal((await candidates(db)).rows.length,0);
    await ingest(db,merchant,[product()],'fixture-refresh-key');
    await manage(db,'review_ownership',{id:brand,status:'revoked'},REVIEWER);assert.equal((await candidates(db)).rows.length,0);assert.deepEqual(await lookup(product().product_url),{});
  }finally{await db.close();}
});
test('partnership workflow audits transitions but cannot activate campaigns; quota and retries are bounded',async()=>{
  const db=await database();try{
    const {brand,merchant}=await registry(db);
    const data={merchant_id:merchant,brand_id:brand};
    await assert.rejects(manage(db,'partnership',{...data,status:'active'}));
    const partner=await manage(db,'partnership',data);
    await manage(db,'partnership',{...data,id:partner,status:'contacted'});
    await assert.rejects(manage(db,'partnership',{...data,id:partner,status:'active'}));
    await assert.rejects(db.query("insert into discovery_campaigns(partner_id,merchant_id,approval_state) values($1,$2,'active')",[partner,merchant]));
    for(let i=0;i<30;i++)assert.equal((await db.query('select discovery_claim_request($1) as ok',[USER])).rows[0].ok,true);
    assert.equal((await db.query('select discovery_claim_request($1) as ok',[USER])).rows[0].ok,false);
    for(let i=0;i<5;i++){await db.query('select discovery_begin_sync($1,$2)',[merchant,`fixture-fail-${i}`]);await db.query("select discovery_sync_failed($1,$2,'source_unavailable')",[merchant,`fixture-fail-${i}`]);}
    await assert.rejects(db.query('select discovery_begin_sync($1,$2)',[merchant,'fixture-sixth-key']));
    await assert.rejects(db.query('select discovery_begin_sync($1,$2)',[merchant,'fixture-fail-0']));
  }finally{await db.close();}
});
test('beta prospects are operable before any brand/catalog/agreement and keep outreach records private',async()=>{
  const db=await database();try{
    const base={name:'Synthetic prospective beta partner',contact_ref:'fixture:contact',contact_channel:'referral',outreach_notes:'Synthetic internal qualification note',intake_checklist:{catalog_method:'manual_feed',disclosure_acknowledged:false}};
    const prospect=await manage(db,'prospect',base);
    assert.equal((await db.query('select count(*)::int as n from discovery_brands')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from discovery_products')).rows[0].n,0);
    await assert.rejects(manage(db,'prospect',{...base,id:prospect,status:'active'}));
    for(const status of ['contacted','evaluating','onboarding','active','paused','ended'])await manage(db,'prospect',{...base,id:prospect,status,last_contact_at:new Date().toISOString()});
    assert.equal((await db.query('select count(*)::int as n from discovery_audit where entity_id=$1',[prospect])).rows[0].n,7);
    assert.equal((await db.query('select brand_id from discovery_prospects where id=$1',[prospect])).rows[0].brand_id,null);
    await db.exec('reset role; set role authenticated');await assert.rejects(db.exec('select contact_ref,outreach_notes from discovery_prospects'),e=>e.code==='42501');
  }finally{await db.close();}
});
test('isolated DB sponsorship certification: approved relevant catalog placement requires sandbox + staff + flag and disclosure',async()=>{
  const db=await database();try{
    await db.exec("reset role;update discovery_runtime_guard set environment='test';set role service_role");
    const {brand,merchant}=await registry(db,true);await ingest(db,merchant,[product({currency:'USD'})]);
    assert.equal((await candidates(db)).rows.length,0,'sandbox fixtures never enter organic customer retrieval');
    const productId=(await db.query('select id from discovery_products where merchant_id=$1',[merchant])).rows[0].id;
    const partnership={merchant_id:merchant,brand_id:brand,terms_ref:'fixture:signed-terms',contract_status:'signed',effective_from:new Date(Date.now()-1000).toISOString(),effective_until:future(30)};
    const partner=await manage(db,'partnership',partnership);
    for(const status of ['contacted','evaluating','onboarding','active'])await manage(db,'partnership',{...partnership,id:partner,status});
    const campaignData={partner_id:partner,merchant_id:merchant,sandbox_only:true,approval_state:'draft',product_ids:[productId],categories:['outerwear'],markets:['US'],starts_at:new Date(Date.now()-1000).toISOString(),ends_at:future(10),disclosure_status:'reviewed',disclosure_text:'Sponsored'};
    const campaign=await manage(db,'campaign',campaignData);
    const {pathToFileURL}=require('node:url');
    const {createSponsorshipSandboxHandler}=await import(pathToFileURL(path.join(__dirname,'../supabase/functions/black-owned-discovery/sponsorshipSandbox.ts')).href);
    const input={garment:{item_type:'outerwear',subtype:'bomber',primary_color:'black',material_estimate:'leather',silhouette:'cropped'},market:'US',primaryProducts:[]};
    const primaryBefore=JSON.stringify(input.primaryProducts);
    const env={SPONSORSHIP_SANDBOX_MODE:'true',SPONSORED_PLACEMENTS_V1_ENABLED:'true',KSCAN_ENVIRONMENT:'test',SUPABASE_URL:'http://127.0.0.1:54321'};
    let reads=0;
    const handler=createSponsorshipSandboxHandler({env:k=>env[k],authenticate:async()=>({id:ADMIN,isAnonymous:false}),staff:async(id)=>(await db.query('select discovery_staff_authority($1) as ok',[id])).rows[0].ok,claim:async()=>true,snapshot:async()=>{reads++;return(await db.query("select discovery_sponsorship_snapshot('outerwear','bomber','US',true) as data")).rows[0].data;}});
    const response=async()=>await(await handler(new Request('https://fixture.kscan.ai/sandbox',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(input)}))).json();
    assert.equal((await response()).products.length,0,'unapproved campaign cannot place');
    await manage(db,'campaign',{...campaignData,id:campaign,approval_state:'approved'});
    const body=await response();assert.equal(body.sandbox,true);assert.equal(body.products.length,1);assert.equal(body.products[0].disclosure,'Sponsored');assert.equal(body.products[0].placementType,'sponsored');
    for(const change of [{ends_at:new Date(Date.now()-500).toISOString(),starts_at:new Date(Date.now()-1000).toISOString()},{markets:['GB']},{categories:['footwear']},{disclosure_status:'unreviewed'},{disclosure_text:null}]){
      await manage(db,'campaign',{...campaignData,id:campaign,approval_state:'approved',...change});assert.equal((await response()).products.length,0,JSON.stringify(change));
    }
    await manage(db,'campaign',{...campaignData,id:campaign,approval_state:'approved'});
    await db.query("update discovery_products set attributes='{}'::jsonb where id=$1",[productId]);assert.equal((await response()).products.length,0,'campaign approval cannot buy relevance');
    const readsBefore=reads;env.SPONSORED_PLACEMENTS_V1_ENABLED='false';assert.equal((await response()).products.length,0);assert.equal(reads,readsBefore,'flag off makes no policy/catalog call');
    assert.equal(JSON.stringify(input.primaryProducts),primaryBefore);
    assert.equal((await db.query('select count(*)::int as n from discovery_campaigns where active')).rows[0].n,0);
    await assert.rejects(db.exec('update discovery_campaigns set active=true'));
  }finally{await db.close();}
});
test('production DB guard rejects fixture writes and service credentials cannot change its environment',async()=>{
  const db=await database();try{
    await assert.rejects(registry(db,true),e=>e.code==='42501');
    await assert.rejects(db.exec("update discovery_runtime_guard set environment='test'"),e=>e.code==='42501');
    assert.equal((await db.query('select count(*)::int as n from discovery_merchants')).rows[0].n,0);
    assert.equal((await db.query('select count(*)::int as n from discovery_campaigns where active')).rows[0].n,0);
  }finally{await db.close();}
});
