// Phase 3 (v126) commerce provider modernization — router-level contract lock.
//
// This suite cannot exercise live HTTP behavior: the governed backend test
// runner grants only --allow-read (see scripts/run-backend-tests.js) so every
// suite in this directory stays deterministic — no Supabase, no provider, no
// network. Live provider behavior (auth failures, timeouts, malformed
// responses, real latency) was instead verified by controlled live probes
// against App Staging during implementation — see the Phase 3 report, not a
// unit test, for those results. What this file locks down is the
// orchestration contract: what gets imported, how candidates flow, what stays
// bounded, and that v124/v125 are untouched.

import assert from 'node:assert/strict';
import {
  getScanCommerceResults,
  isSneakerIdentification,
  type ScanCommerceInput,
} from './scanCommerceRouter.ts';

function baseInput(overrides: Partial<ScanCommerceInput> = {}): ScanCommerceInput {
  return {
    identification: {
      item_type: 'jacket',
      brand_guess: 'Saint Laurent',
      primary_color: 'black',
      searchQueries: ['Saint Laurent L01 leather motorcycle jacket'],
    },
    attributes: {},
    searchQueries: ['Saint Laurent L01 leather motorcycle jacket'],
    mode: 'image',
    ...overrides,
  };
}

// ── Orchestration: no provider disabled/no-key state ever throws ───────────

Deno.test('getScanCommerceResults: resolves cleanly with every Phase 3 provider unconfigured', async () => {
  const result = await getScanCommerceResults(baseInput());
  assert.equal(result.provider, 'none');
  assert.deepEqual(result.products, []);
  // Serper is always attempted (unconditional discovery leg); Poshmark is
  // attempted whenever the discovery fan-out runs, same as Serper.
  assert.ok(result.providersTried.includes('serper'));
});

Deno.test('getScanCommerceResults: sneaker query does not throw and does not force KicksCrew without a URL', async () => {
  const result = await getScanCommerceResults(baseInput({
    identification: { item_type: 'sneakers', brand_guess: 'Nike' },
    searchQueries: ['Nike Air Jordan 1 Retro'],
  }));
  assert.equal(result.provider, 'none');
  // KicksCrew cannot be "tried" without a discovered kickscrew.com URL — none
  // exists here because Serper/Poshmark are both unconfigured in this suite.
  assert.equal(result.providersTried.includes('kickscrew'), false);
});

// ── Structural: retired provider fully gone from the active router ─────────

Deno.test('scanCommerceRouter: the retired legacy Farfetch adapter is not imported', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.equal(source.includes('./farfetchProvider.ts'), false);
  assert.equal(source.includes('farfetch-data.p.rapidapi.com'), false);
  assert.equal(source.includes('searchFarfetchProducts'), false);
  assert.equal(source.includes('searchKicksCrewProducts'), false);
});

Deno.test('scanCommerceRouter: new providers are imported and wired', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.ok(source.includes('./farfetch3Provider.ts'));
  assert.ok(source.includes('./poshmarkProvider.ts'));
  assert.ok(source.includes('enrichFarfetchProductByUrl'));
  assert.ok(source.includes('enrichKicksCrewProductByUrl'));
  assert.ok(source.includes('searchPoshmarkProducts'));
});

// ── Orchestration shape: parallel discovery, bounded enrichment ────────────

Deno.test('scanCommerceRouter: discovery is parallel (Promise.all), not sequential early-exit', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.ok(/Promise\.all\(\[\s*withDeadline/.test(source), 'Serper/Brave and Poshmark must race together');
});

Deno.test('scanCommerceRouter: enrichment is bounded, never unbounded fan-out', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  assert.ok(source.includes('MAX_FARFETCH_ENRICH'));
  assert.ok(source.includes('MAX_KICKSCREW_ENRICH'));
  assert.ok(source.includes('.slice(0, opts.cap)'));
});

Deno.test('scanCommerceRouter: KicksCrew enrichment stays gated behind isSneaker', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  const kicksBlock = source.slice(source.indexOf('KicksCrew stays sneaker-gated'));
  assert.ok(/if \(isSneaker\) \{/.test(kicksBlock.slice(0, 400)));
});

Deno.test('scanCommerceRouter: withDeadline degrades to a safe empty result, never rejects', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  // Promise constructor never calls reject() — a timeout resolves to the
  // caller-supplied fallback value instead, which is how partial-result
  // salvage works: Promise.all cannot fail because a sibling call raced past
  // the deadline.
  assert.ok(source.includes('function withDeadline'));
  assert.equal(/withDeadline[\s\S]{0,400}reject\(/.test(source), false);
});

// ── Retailer neutrality: provider identity carries no ranking weight ───────

Deno.test('scanCommerceRouter: no provider name appears in a scoring/ranking expression', async () => {
  const source = await Deno.readTextFile(new URL('./scanCommerceRouter.ts', import.meta.url));
  for (const name of ['Farfetch', 'KicksCrew', 'Poshmark']) {
    const pattern = new RegExp(`['"]${name}['"][\\s\\S]{0,60}(\\+|-|score|bonus|penalt)`, 'i');
    assert.equal(pattern.test(source), false, `${name} must not carry a ranking bonus/penalty`);
  }
});

// ── isSneakerIdentification is unchanged (v124/v125 routing gate) ──────────

Deno.test('isSneakerIdentification: unchanged sneaker routing gate still exported and correct', () => {
  assert.equal(
    isSneakerIdentification({ item_type: 'sneakers', brand_guess: 'Nike' }, {}, ['Nike Dunk Low']),
    true,
  );
  assert.equal(
    isSneakerIdentification({ item_type: 'handbag', brand_guess: 'Gucci' }, {}, ['Gucci tote bag']),
    false,
  );
});
