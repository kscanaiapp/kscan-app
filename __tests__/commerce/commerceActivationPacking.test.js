/**
 * Packing -> Commerce activation (activation brief §20, §21, journeys F/G).
 *
 * The firewall is the point: a CONFIRMED gap may become a shopping request,
 * an UNCONFIRMED one may not, and nothing in this direction can change what
 * Packing decided.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));
const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const handoff = require(path.join(ROOT, 'services/packing/packingCommerceHandoff.ts'));
const gaps = chat('packingGaps.ts');
const bridge = edge('commercePackingBridge.ts');
const { buildShoppingIntent } = edge('commerceShoppingIntent.ts');
const { filterAndDedupeProducts } = edge('qualityTuneCommerce.ts');

/** Derive REAL gaps from the real deriver rather than hand-writing shapes. */
function deriveGaps(overrides = {}) {
  return gaps.derivePackingCoverageGaps({
    censusComplete: true,
    closetRoleCensus: { base: 2, bottom: 2, shoe: 1 },
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetItems: [
      { layeringRole: 'shoe', band: 'casual', rainEvidence: false, warmthEvidence: false },
      { layeringRole: 'base', band: 'casual', rainEvidence: false, warmthEvidence: false },
    ],
    slots: [],
    forecastSummary: 'Showers likely, rain through Tuesday',
    statedConditions: [],
    ...overrides,
  });
}

// ── JOURNEY F — confirmed gap ──────────────────────────────────────────────

test('JOURNEY F: a CONFIRMED gap becomes a grounded shopping request', () => {
  const derived = deriveGaps();
  const confirmed = derived.find((g) => g.certainty === 'confirmed');
  assert.ok(confirmed, 'the real deriver produced a confirmed gap');

  const h = handoff.buildPackingCommerceHandoff({
    gapCode: confirmed.code,
    label: confirmed.label,
    certainty: confirmed.certainty,
  });
  assert.ok(h, 'a confirmed gap is shoppable');
  assert.equal(h.source, 'packing-gap');
  assert.equal(h.gapCode, confirmed.code);
  assert.match(h.query, /^Find me /);

  // And the Commerce-side bridge turns it into ranking-bearing intent.
  const contribution = bridge.contributionFromPackingGap(confirmed);
  assert.equal(contribution.gapRelationship.certainty, 'confirmed');
  assert.ok(contribution.functionalRequirements.length > 0);
});

test('JOURNEY F: a confirmed rain gap actually reorders real candidates', () => {
  const derived = deriveGaps();
  const confirmed = derived.find((g) => g.certainty === 'confirmed');
  const intent = buildShoppingIntent([bridge.contributionFromPackingGap(confirmed)], null);
  const p = (id, title, price) => ({
    id, title, price, currency: 'USD', type: 'retail', source: 'Farfetch',
    imageUrl: `https://i.io/${id}.jpg`, productUrl: `https://www.farfetch.com/shopping/${id}.aspx`,
  });
  const candidates = [p('wool', 'Wool Overcoat', '$600.00'), p('rain', 'Packable Waterproof Rain Jacket', '$120.00')];

  const before = filterAndDedupeProducts(candidates, { item_type: 'outerwear', subtype: 'jacket' }, { enabled: true, categoryRoute: 'outerwear' });
  const after = filterAndDedupeProducts(candidates, { item_type: 'outerwear', subtype: 'jacket' }, {
    enabled: true, categoryRoute: 'outerwear', shoppingContext: intent, requestActorId: null,
  });
  assert.deepEqual(before.products.map((x) => x.id), ['wool', 'rain']);
  assert.deepEqual(after.products.map((x) => x.id), ['rain', 'wool'], 'the piece that answers the trip leads');
  assert.equal(after.products[0].commerceRationale.gap.certainty, 'confirmed');
});

// ── JOURNEY G — unconfirmed gap ────────────────────────────────────────────

test('JOURNEY G: an UNCONFIRMED gap keeps its uncertainty and is not shoppable', () => {
  const derived = gaps.derivePackingCoverageGaps({
    censusComplete: true,
    closetRoleCensus: { base: 2, bottom: 2, shoe: 1, outer: 1 },
    requiredRoles: ['base', 'bottom', 'shoe'],
    closetItems: [
      { layeringRole: 'outer', band: 'casual', rainEvidence: false, warmthEvidence: false },
      { layeringRole: 'shoe', band: 'casual', rainEvidence: false, warmthEvidence: false },
    ],
    slots: [],
    forecastSummary: 'Showers likely, rain through Tuesday',
    statedConditions: [],
  });
  const unconfirmed = derived.find((g) => g.certainty === 'unconfirmed');
  assert.ok(unconfirmed, 'the real deriver produced an unconfirmed gap');

  assert.equal(handoff.gapIsShoppable(unconfirmed && { ...unconfirmed, gapCode: unconfirmed.code }), false);
  assert.equal(
    handoff.buildPackingCommerceHandoff({ gapCode: unconfirmed.code, label: unconfirmed.label, certainty: unconfirmed.certainty }),
    null,
    'no shopping request is built from an absence nobody proved',
  );

  // Certainty survives verbatim into Commerce intent, and carries no weight.
  const contribution = bridge.contributionFromPackingGap(unconfirmed);
  assert.equal(contribution.gapRelationship.certainty, 'unconfirmed');
  assert.equal(contribution.category, undefined);
  assert.equal(contribution.functionalRequirements, undefined);
});

test('the external-ideas surface stays inert; the confirmed-gap surface is the one that opened', () => {
  // #410 held this seam because the only surface considered for it was "IDEAS
  // TO CONSIDER", which #407 made deliberately inert and pinned with an
  // explicit assertion (packingPlannerV2Client.test.js :: "with nothing to
  // tap"). The hold was on the wrong object: those rows are ungrounded
  // suggestions, and the shoppable thing is the CONFIRMED GAP itself.
  //
  // Build 36 connects the confirmed gap and leaves the ideas list exactly as
  // #407 pinned it -- that test passes unmodified.
  const view = src('components/packing/PackingPlanView.tsx');
  const ideas = view.slice(view.indexOf('IDEAS TO CONSIDER'));
  assert.equal(/Pressable/.test(ideas), false, "#407's no-tap contract is intact");
  assert.equal(/onFindOptions/.test(ideas), false, 'and it carries no Commerce seam');

  // The action exists, on the confirmed gap, and nowhere else.
  assert.match(view, /packing-gap-find-\$\{gap\.code\}/, 'the confirmed-gap action is surfaced');
  assert.match(view, /onFindOptions && gap\.certainty === 'confirmed'/);

  const deriver = src('supabase/functions/stylechat-generate/packingGaps.ts');
  assert.match(deriver, /if \(gap\.certainty !== 'confirmed'\) continue;/, 'only confirmed gaps become ideas');
});

// ── §20 firewall ───────────────────────────────────────────────────────────

test('§20: Commerce can consume gap confidence and can never modify it', () => {
  const handoffSrc = src('services/packing/packingCommerceHandoff.ts');
  // Structural: nothing in this direction accepts a product or a result.
  assert.equal(/RecommendedProduct|purchaseOptions|CommerceHydrationResult/.test(handoffSrc), false);
  assert.deepEqual(
    Object.keys(handoff).sort(),
    ['buildPackingCommerceHandoff', 'gapIsShoppable'],
    'no return path may be added without failing this test',
  );
});

test('§21: no third Commerce results UI was built inside Packing', () => {
  // Comments stripped: the screen now explains in prose that Elise owns the
  // ProductShelf journey, and prose naming the rule is not a breach of it.
  const stripComments = (text) =>
    text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  const view = stripComments(src('components/packing/PackingPlanView.tsx'));
  assert.equal(/ProductShelf|purchaseOptions|commerce_products/.test(view), false, 'no third Commerce results UI');
  const screen = stripComments(src('app/packing/index.tsx'));
  assert.equal(/fetchDeferredCommerce|ProductShelf/.test(screen), false);
});

test('the handoff adapter targets the EXISTING chat destination when it is surfaced', () => {
  // Proven now so the held surface is a one-line wiring change later, not a
  // design question: the adapter emits exactly what the existing
  // `setStyleChatHandoffContext` seam accepts.
  const h = handoff.buildPackingCommerceHandoff({
    gapCode: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed',
  });
  const handoffTypes = src('services/style-chat/styleChatHandoffContext.ts');
  assert.match(handoffTypes, /'packing-gap'/, 'the source is registered on the existing seam');
  assert.equal(h.source, 'packing-gap');
  assert.equal(typeof h.query, 'string');
});

test('§21: a handoff carries a shopping request and nothing else', () => {
  const h = handoff.buildPackingCommerceHandoff({
    gapCode: 'missing_weather_layer', label: 'A light rain layer', certainty: 'confirmed',
  });
  assert.deepEqual(Object.keys(h).sort(), ['category', 'gapCode', 'query', 'source']);
  const payload = JSON.stringify(h);
  for (const forbidden of ['itemId', 'userId', 'tripId', 'uuid', 'closet']) {
    assert.equal(payload.toLowerCase().includes(forbidden.toLowerCase()), false, `handoff must not carry ${forbidden}`);
  }
});
