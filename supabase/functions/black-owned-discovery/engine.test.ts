import assert from 'node:assert/strict';
import { discoveryFlags } from './contracts.ts';
import { createDiscoveryService, rankCatalog, DISCOVERY_TIMEOUT_MS } from './engine.ts';
import { parseDiscoveryInput, safeCatalogUrl } from './validation.ts';
import { futurePlacementRequirementsPass, selectSponsoredPlacements, sponsoredPlacementsEnabled, type FuturePlacementEvidence } from './sponsorshipPolicy.ts';
import { input, row, NOW } from './fixtures.test.ts';
const on = { discovery: true, badges: true, sponsored: false };

Deno.test('owner-directed organic and badge defaults ON; false rolls back independently; sponsorship remains closed', () => {
  assert.deepEqual(discoveryFlags(() => undefined), { discovery: true, badges: true, sponsored: false });
  const env: Record<string,string> = { KSCAN_ENVIRONMENT: 'staging', BLACK_OWNED_DISCOVERY_V1_ENABLED: 'true', SPONSORED_PLACEMENTS_V1_ENABLED: 'true' };
  assert.deepEqual(discoveryFlags((k) => env[k]), { discovery: true, badges: true, sponsored: false });
  env.KSCAN_ENVIRONMENT = 'production'; assert.equal(discoveryFlags((k) => env[k]).discovery, true);
  env.VERIFIED_OWNERSHIP_BADGE_V1_ENABLED = 'false'; assert.equal(discoveryFlags((k) => env[k]).badges, false);
  env.KSCAN_ENVIRONMENT = 'test'; env.VERIFIED_OWNERSHIP_BADGE_V1_ENABLED = 'true'; env.BLACK_OWNED_DISCOVERY_V1_ENABLED = 'false';
  assert.deepEqual(discoveryFlags((k) => env[k]), { discovery: false, badges: true, sponsored: false });
});
Deno.test('rank relevant alternatives with optional identity, truthful unknown currency, no score/exact/sponsorship', () => {
  const [product] = rankCatalog(input, [row], on, NOW);
  assert.ok(product); assert.equal(product.type, 'similar'); assert.equal(product.matchType, 'similar');
  assert.equal(product.price, '120.00'); assert.equal(product.currency, undefined);
  assert.equal(product.ownershipIdentity?.publicOwnershipLabelAllowed, true);
  assert.equal(product.placementType, 'organic');
  assert.equal('fashionMatchScore' in product, false);
  assert.equal(rankCatalog(input, [row], { ...on, badges: false }, NOW)[0].ownershipIdentity, undefined);
});
Deno.test('reject category/subtype conflicts, weak, stale, future, withdrawn, expired, invalid-link, wrong-market inventory', () => {
  for (const change of [
    { category: 'footwear' }, { subtype: 'trench' }, { attributes: {} }, { availability: 'out_of_stock' as const }, { availability: 'unknown' as const },
    { synced_at: new Date(NOW-25*3600_000).toISOString() }, { synced_at: new Date(NOW+1000).toISOString() },
    { expires_at: 'invalid' }, { expires_at: new Date(NOW).toISOString() }, { verified_until: new Date(NOW).toISOString() },
    { product_url: 'https://127.0.0.1/private' }, { image_url: null }, { markets: ['GB'] },
  ]) assert.equal(rankCatalog(input, [{ ...row, ...change }], on, NOW).length, 0, JSON.stringify(change));
  assert.deepEqual(rankCatalog(input, [], on, NOW), []);
});
Deno.test('deduplicate primary URLs, IDs, offers and variants; preserve stronger relevance', () => {
  const lower = { ...row, id: 'a', source_product_id: 'another', product_url: 'https://fixture-fashion.com/products/other', attributes: { primary_color: 'black', material_estimate: 'leather' } };
  assert.equal(rankCatalog(input, [lower, row], on, NOW)[0].id, row.id);
  assert.equal(rankCatalog({ ...input, primaryProducts: [{ id: 'primary', productUrl: `${row.product_url}?utm_source=test` }] }, [row], on, NOW).length, 0);
  assert.equal(rankCatalog({ ...input, primaryProducts: [{ id: row.id }] }, [row], on, NOW).length, 0);
  assert.equal(rankCatalog(input, [row, { ...row, id: 'variant-two', variant_id: 'two' }], on, NOW).length, 1);
});
Deno.test('OFF makes zero calls; badge-only does not retrieve catalog; failures fail safely', async () => {
  let calls = 0;
  const service = createDiscoveryService({ revision: () => { calls++; throw new Error('should not run'); }, candidates: () => { calls++; throw new Error('should not run'); }, ownership: async () => { calls++; return {}; }, now: () => NOW });
  assert.equal((await service(input, { discovery: false, badges: false, sponsored: false })).status, 'unavailable'); assert.equal(calls, 0);
  await service({ ...input, primaryProducts: [{ id: 'primary' }] }, { ...on, discovery: false }); assert.equal(calls, 1);
  assert.equal((await service(input, on)).status, 'unavailable');
});
Deno.test('cache expires and revision change immediately invalidates revoked or deactivated inventory', async () => {
  let time = NOW; let revision = 0; let searches = 0; let rows = [row];
  const service = createDiscoveryService({ revision: async () => revision, candidates: async () => { searches++; return { revision, rows, ownership: {} }; }, ownership: async () => ({}), now: () => time });
  assert.equal((await service(input, on)).status, 'ready'); await service(input, on); assert.equal(searches, 1);
  time += 31_000; await service(input, on); assert.equal(searches, 2);
  revision++; rows = []; assert.equal((await service(input, on)).status, 'empty'); assert.equal(searches, 3);
});
Deno.test('independent deadline returns unavailable even if provider ignores abort', async () => {
  let aborted = false; const started = performance.now();
  const service = createDiscoveryService({ revision: (signal) => { signal.addEventListener('abort', () => { aborted = true; }); return new Promise(() => {}); }, candidates: async () => ({ revision: 0, rows: [], ownership: {} }), ownership: async () => ({}) });
  const result = await service(input, on);
  assert.equal(result.status, 'unavailable'); assert.ok(aborted); assert.ok(performance.now()-started < DISCOVERY_TIMEOUT_MS+500);
});
Deno.test('caller abort cancels secondary work independently', async () => {
  const controller = new AbortController(); controller.abort(); let calls = 0;
  const service = createDiscoveryService({ revision: async () => { calls++; return 0; }, candidates: async () => ({ revision: 0, rows: [], ownership: {} }), ownership: async () => ({}) });
  assert.equal((await service(input, on, controller.signal)).status, 'unavailable'); assert.equal(calls, 0);
});
Deno.test('request rejects images, conversations, role claims, oversized inputs and unknown categories', () => {
  for (const bad of [{ ...input, image: 'base64' }, { ...input, role: 'admin' }, { ...input, garment: { ...input.garment, rawImage: 'photo' } }, { ...input, garment: { item_type: 'car' } }, { ...input, market: 'USA' }, { ...input, garment: { item_type: 'outerwear', pattern: 'x'.repeat(161) } }]) assert.throws(() => parseDiscoveryInput(bad));
  assert.deepEqual(parseDiscoveryInput(input), input);
});
Deno.test('URL validation rejects SSRF forms, credentials, redirectors and unapproved hosts', () => {
  for (const url of ['http://fixture-fashion.com/x','https://fixture-fashion.com.evil.com/x','https://user@fixture-fashion.com/x','https://fixture-fashion.com:8443/x','https://fixture-fashion.com/redirect?url=x','https://fixture-fashion.com/x?next=x','https://2130706433/x','https://[::ffff:7f00:1]/x','https://fixture-fashion.com\\@evil.com/x']) assert.equal(safeCatalogUrl(url, ['fixture-fashion.com']), null, url);
  assert.equal(safeCatalogUrl(row.product_url, row.approved_domains), row.product_url);
});
Deno.test('sponsorship has zero placements even when configured true; future policy requires every condition', () => {
  assert.equal(sponsoredPlacementsEnabled('true'), false); assert.deepEqual(selectSponsoredPlacements([]), []);
  const eligible: FuturePlacementEvidence = { merchantAuthorized: true, agreementEffective: true, campaignApproved: true, liveCatalogProduct: true, fashionRelevancePassed: true, trustworthyOffer: true, marketAndInventoryPassed: true, disclosureApproved: true, disclosureText: 'Sponsored', productionActivationApproved: true };
  assert.equal(futurePlacementRequirementsPass(eligible), true);
  for (const key of Object.keys(eligible).filter((k) => k !== 'disclosureText')) assert.equal(futurePlacementRequirementsPass({ ...eligible, [key]: false }), false);
  assert.equal(futurePlacementRequirementsPass({ ...eligible, disclosureText: '' }), false);
  assert.deepEqual(selectSponsoredPlacements([eligible]), []);
});
