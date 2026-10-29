import assert from 'node:assert/strict';
import { previewSponsoredPlacements, type TestCampaign, type TestPartner } from './sponsorshipPolicy.ts';
import { input, row, NOW } from './fixtures.test.ts';
const context = { environment: 'test', isolatedFixtures: true, staffAuthenticated: true, sponsoredEnabled: true, sandboxEnabled: true };
const before = new Date(NOW-1000).toISOString(); const after = new Date(NOW+3_600_000).toISOString();
const partner: TestPartner = { id:'fixture-partner',merchantId:row.merchant_id,status:'active',contractStatus:'signed',agreementRef:'fixture:agreement',effectiveFrom:before,effectiveUntil:after };
const campaign: TestCampaign = { id:'fixture-campaign',partnerId:partner.id,merchantId:row.merchant_id,state:'approved',productIds:[row.id],categories:[row.category],markets:['US'],startsAt:before,endsAt:after,disclosureApproved:true,disclosureText:'Sponsored' };
const product = { ...row, currency:'USD' };
Deno.test('sponsorship integration preview: actual relevant product + authorized agreement + approved campaign + disclosure',()=>{
  const primaryBefore=JSON.stringify(input.primaryProducts);
  const [placement]=previewSponsoredPlacements(context,input,[product],partner,campaign,NOW);
  assert.ok(placement); assert.equal(placement.placementType,'sponsored');assert.equal('disclosure' in placement && placement.disclosure,'Sponsored');assert.equal(placement.matchType,'similar');assert.equal('previewOnly' in placement && placement.previewOnly,true);
  assert.equal(JSON.stringify(input.primaryProducts),primaryBefore);
});
Deno.test('sponsorship preview refuses production, staging and non-isolated data',()=>{
  for(const changes of [{environment:'production'},{environment:''},{isolatedFixtures:false},{staffAuthenticated:false},{sponsoredEnabled:false},{sandboxEnabled:false}])assert.deepEqual(previewSponsoredPlacements({...context,...changes},input,[product],partner,campaign,NOW),[]);
});
Deno.test('payment never buys relevance: category, subtype, weak visuals and stale or unavailable catalog fail',()=>{
  for(const changes of [{category:'footwear'},{subtype:'trench'},{attributes:{}},{availability:'out_of_stock' as const},{expires_at:before},{price_amount:null},{currency:null},{product_url:'https://127.0.0.1/private'}])assert.deepEqual(previewSponsoredPlacements(context,input,[{...product,...changes}],partner,campaign,NOW),[]);
});
Deno.test('sponsorship preview rejects unapproved, undisclosed, wrong-market or expired campaigns',()=>{
  for(const changes of [{state:'draft' as const},{disclosureApproved:false},{disclosureText:''},{markets:['GB']},{productIds:[]},{endsAt:before},{startsAt:after},{merchantId:'other'}])assert.deepEqual(previewSponsoredPlacements(context,input,[product],partner,{...campaign,...changes},NOW),[]);
  for(const changes of [{status:'paused' as const},{contractStatus:'none' as const},{agreementRef:null},{effectiveUntil:before}])assert.deepEqual(previewSponsoredPlacements(context,input,[product],{...partner,...changes},campaign,NOW),[]);
});
