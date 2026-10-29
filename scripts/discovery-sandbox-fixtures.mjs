#!/usr/bin/env node
/** Explicit, optional NON-PRODUCTION fixture installer. Defaults to a plan.
 * Never creates Auth users, reviewers, real merchants or external partnerships. */
import { randomUUID } from 'node:crypto';
const apply = process.argv.includes('--apply');
if (!apply) {
  console.log('Plan only: one synthetic brand/merchant/catalog item/partnership/campaign in an explicitly non-production, DB-owner-enabled sandbox. No writes. Use --apply only after the Activation Runbook prerequisites.');
  process.exit(0);
}
const endpoint = new URL(process.env.SUPABASE_URL ?? '');
const environment = process.env.KSCAN_ENVIRONMENT;
const allowed = (environment === 'staging' && endpoint.href === 'https://yzqjvdfgefveprobvvyw.supabase.co/') || (['test','development'].includes(environment) && ['localhost','127.0.0.1'].includes(endpoint.hostname));
if (!allowed) throw new Error('Sandbox installation refuses production, unknown hosts, and implicit environments.');
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
const admin = process.env.DISCOVERY_SANDBOX_ADMIN_ID;
const reviewer = process.env.DISCOVERY_SANDBOX_REVIEWER_ID;
if (!key || !/^[0-9a-f-]{36}$/i.test(admin ?? '') || !/^[0-9a-f-]{36}$/i.test(reviewer ?? '') || admin === reviewer) throw new Error('Two distinct pre-authorized staff IDs and a server-only service credential are required.');
async function call(path, body) {
  const response = await fetch(`${endpoint.origin}/rest/v1/${path}`,{method:body===undefined?'GET':'POST',headers:{apikey:key,Authorization:`Bearer ${key}`,'Content-Type':'application/json'},...(body===undefined?{}:{body:JSON.stringify(body)}),signal:AbortSignal.timeout(5000),redirect:'error'});
  if (!response.ok) { void response.body?.cancel(); throw new Error('Sandbox operation rejected; no upstream body or credential is logged.'); }
  return response.status===204?null:await response.json();
}
const guard = await call('discovery_runtime_guard?select=environment');
if (!['staging','test','development'].includes(guard?.[0]?.environment)) throw new Error('DB-owner sandbox guard has not been explicitly enabled.');
if (!(await call('rpc/discovery_staff_authority',{p_actor:admin})) || !(await call('rpc/discovery_staff_authority',{p_actor:reviewer}))) throw new Error('Staff must already be authorized in the protected reviewer registry.');
const manage = (action,data,actor=admin)=>call('rpc/discovery_manage',{p_actor:actor,p_action:action,p_data:data});
const until = new Date(Date.now()+7*86400000).toISOString();
const before = new Date(Date.now()-1000).toISOString();
const brand = await manage('register_brand',{name:'SANDBOX — Synthetic Fashion Brand',website:'https://fixture-fashion.com/',categories:['outerwear'],markets:['US']});
const evidence = await manage('submit_evidence',{brand_id:brand,method:'authorized_attestation',authorized_submission:true,provenance_ref:'sandbox:synthetic-attestation',corroboration_ref:'sandbox:synthetic-corroboration',expires_at:until,retain_until:until});
await manage('request_review',{id:brand});
await manage('review_ownership',{id:brand,status:'verified',evidence_id:evidence,verified_until:until,policy_version:'kscan-ownership-review-v1-draft'},reviewer);
await manage('brand_visibility',{id:brand,public_label_allowed:true,public_permission_ref:'sandbox:synthetic-permission',operating_status:'active'});
const merchant = await manage('merchant',{brand_id:brand,sandbox_only:true,legal_identity_ref:'sandbox:synthetic-identity',identity_verified_at:before,identity_expires_at:until,status:'active',catalog_status:'approved',approved_domains:['fixture-fashion.com'],image_domains:['fixture-fashion.com'],markets:['US'],source_kind:'authorized_json',source_authorization_ref:'sandbox:synthetic-feed-license',source_authorized_until:until});
const syncKey = `sandbox-${randomUUID()}`;
await call('rpc/discovery_begin_sync',{p_merchant:merchant,p_key:syncKey});
await call('rpc/discovery_ingest',{p_merchant:merchant,p_key:syncKey,p_complete:true,p_products:[{source_product_id:'synthetic-bomber',variant_id:'M',title:'SANDBOX synthetic cropped leather bomber',category:'outerwear',subtype:'bomber',attributes:{primary_color:'black',material_estimate:'leather',silhouette:'cropped'},image_url:'https://fixture-fashion.com/sandbox-bomber.jpg',product_url:'https://fixture-fashion.com/products/sandbox-bomber',price_amount:120,currency:'USD',availability:'in_stock',sizes:['M'],markets:['US'],source_provenance_ref:'sandbox:synthetic-feed-license'}]});
const rows = await call(`discovery_products?merchant_id=eq.${merchant}&select=id`);
const partnership = {merchant_id:merchant,brand_id:brand,terms_ref:'sandbox:synthetic-agreement',contract_status:'signed',effective_from:before,effective_until:until};
const partner = await manage('partnership',partnership);
for (const status of ['contacted','evaluating','onboarding','active']) await manage('partnership',{...partnership,id:partner,status});
const campaign = await manage('campaign',{partner_id:partner,merchant_id:merchant,sandbox_only:true,approval_state:'approved',product_ids:[rows[0].id],categories:['outerwear'],markets:['US'],starts_at:before,ends_at:until,disclosure_status:'reviewed',disclosure_text:'Sponsored'});
console.log(JSON.stringify({sandbox:true,brandId:brand,merchantId:merchant,campaignId:campaign,active:false,expiresAt:until}));
