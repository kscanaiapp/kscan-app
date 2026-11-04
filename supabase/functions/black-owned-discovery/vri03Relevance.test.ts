import assert from 'node:assert/strict';
import { rankCatalog, createDiscoveryService } from './engine.ts';
import { discoverySubtypeKeys, subtypeMatchKeys } from './validation.ts';
import { createDiscoveryHandler } from './handler.ts';
import { input, row, NOW } from './fixtures.test.ts';
import type { CatalogRow, DiscoveryFlags, DiscoveryInput } from './contracts.ts';

const on: DiscoveryFlags = { discovery: true, badges: true, sponsored: false };
const vri: DiscoveryFlags = { ...on, vri03SubtypeSynonyms: true };
const moto: DiscoveryInput = { ...input, garment: { ...input.garment, subtype: 'moto jacket' } };
const biker: CatalogRow = { ...row, id: 'biker-row', subtype: 'biker jacket', title: 'Synthetic black leather cropped biker jacket' };

Deno.test('H4b OFF: keys and ranking are exactly the existing behavior', () => {
  assert.deepEqual(discoverySubtypeKeys('moto jacket', false), subtypeMatchKeys('moto jacket'));
  assert.deepEqual(discoverySubtypeKeys('moto jacket', undefined), subtypeMatchKeys('moto jacket'));
  assert.deepEqual(rankCatalog(moto, [biker], on, NOW), []);
});

Deno.test('H4b ON: a synonym subtype (moto ↔ biker) now matches; a different head noun still never does', () => {
  const keys = discoverySubtypeKeys('moto jacket', true);
  assert.ok(keys.includes('biker jacket'));
  assert.ok(keys.length <= 6);
  const [p] = rankCatalog(moto, [biker], vri, NOW);
  assert.equal(p?.id, 'biker-row');
  assert.equal(rankCatalog(moto, [{ ...biker, subtype: 'biker boot', category: 'outerwear' }], vri, NOW).length, 0);
});

Deno.test('H4b ON never relaxes eligibility, verification, freshness, market or link controls', () => {
  for (const change of [
    { verified_until: new Date(NOW - 1000).toISOString() },
    { expires_at: new Date(NOW - 1000).toISOString() },
    { eligible_until: new Date(NOW - 1000).toISOString() },
    { synced_at: new Date(NOW - 25 * 3600_000).toISOString() },
    { availability: 'out_of_stock' as const },
    { markets: ['GB'] },
    { product_url: 'https://not-approved.example/p' },
    { attributes: {} },
  ]) {
    assert.deepEqual(rankCatalog(moto, [{ ...biker, ...change } as CatalogRow], vri, NOW), [], JSON.stringify(change));
  }
});

Deno.test('H4b ON: ownership labels only on eligible rows, and only when badges are on', () => {
  const [labeled] = rankCatalog(moto, [biker], vri, NOW);
  assert.equal(labeled.ownershipIdentity?.publicOwnershipLabelAllowed, true);
  const [unlabeled] = rankCatalog(moto, [biker], { ...vri, badges: false }, NOW);
  assert.equal(unlabeled.ownershipIdentity, undefined);
  // Every returned product is an input catalog row — nothing is synthesized.
  assert.equal(labeled.productUrl, biker.product_url);
});

Deno.test('H4b: candidates receive the request flags; cohort and non-cohort never share a cache entry', async () => {
  const seen: (boolean | undefined)[] = [];
  const discover = createDiscoveryService({
    revision: async () => 1,
    candidates: async (_i, _s, flags) => { seen.push(flags?.vri03SubtypeSynonyms); return { revision: 1, rows: [biker], ownership: {} }; },
    ownership: async () => ({}),
    now: () => NOW,
  });
  const a = await discover(moto, on);
  const b = await discover(moto, vri);
  const c = await discover(moto, on);
  assert.deepEqual(seen, [undefined, true]); // third call is a cache hit on the OFF entry
  assert.equal(a.products.length, 0);
  assert.equal(b.products.length, 1);
  assert.equal(c.products.length, 0);
});

Deno.test('handler: resolveRequestFlags is applied per authenticated actor; omitted → process flags unchanged', async () => {
  const got: DiscoveryFlags[] = [];
  const deps = {
    flags: () => on,
    authenticate: async () => ({ id: 'actor-1', isAnonymous: false }),
    claim: async () => true,
    discover: async (_i: DiscoveryInput, flags: DiscoveryFlags) => { got.push(flags); return { status: 'empty' } as never; },
  };
  const req = () => new Request('https://x.test/', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ garment: moto.garment, market: 'US', primaryProducts: [] }) });
  await createDiscoveryHandler(deps)(req());
  await createDiscoveryHandler({ ...deps, resolveRequestFlags: (f, actor) => ({ ...f, vri03SubtypeSynonyms: actor === 'actor-1' }) })(req());
  assert.deepEqual(got[0], on);
  assert.equal(got[1].vri03SubtypeSynonyms, true);
});
