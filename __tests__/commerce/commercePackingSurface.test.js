/**
 * Confirmed Packing gap -> Commerce, as a reachable customer journey.
 *
 * Continuation brief sections 5, 7, 8 and 9. #410 built the adapter and held
 * the surface; this is the surface, and these are the rules it must keep.
 *
 * THE GOVERNANCE QUESTION FIRST. #405's B4 lane established three things about
 * a gap: it is an unmet requirement rather than a sales opportunity, a bare
 * Closet must not become a shopping list, and the row must never read as
 * something owned. The Build 36 owner direction narrows exactly one clause --
 * a CONFIRMED gap may now offer to look for something that fills it. The other
 * protections are unchanged, and are asserted here rather than assumed.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
/**
 * Source with comments removed.
 *
 * Every scan below is asking what the CODE does. Prose explaining a rule is not
 * a violation of it, and a doc comment that names the thing being forbidden is
 * the most likely false positive these assertions have.
 */
const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

const {
  buildPackingCommerceHandoff,
  gapIsShoppable,
} = require(path.join(ROOT, 'services/packing/packingCommerceHandoff.ts'));
const incidence = require(path.join(ROOT, 'tools/activation/packingGapIncidence.js'));

const confirmedGap = (over = {}) => ({
  gapCode: 'missing_weather_layer',
  label: 'A packable rain jacket',
  certainty: 'confirmed',
  ...over,
});

// ── Certainty is the gate, and it is one-directional ───────────────────────

test('only a confirmed gap becomes a shopping request', () => {
  assert.equal(gapIsShoppable(confirmedGap()), true);
  for (const certainty of ['unconfirmed', undefined, null, '', 'CONFIRMED', 'probably']) {
    assert.equal(
      gapIsShoppable(confirmedGap({ certainty })),
      false,
      `certainty=${JSON.stringify(certainty)} must not be shoppable`,
    );
    assert.equal(buildPackingCommerceHandoff(confirmedGap({ certainty })), null);
  }
});

test('the client cannot mint certainty by relabelling a gap', () => {
  // Certainty is Packing's own word, read and never decided here.
  const source = read('services/packing/packingCommerceHandoff.ts');
  assert.doesNotMatch(source, /certainty\s*=\s*['"]confirmed['"]/, 'nothing here writes a certainty');
  assert.match(source, /gap!\.certainty === 'confirmed'/, 'it only ever reads one');
});

test('the handoff carries a shopping request and nothing about the trip', () => {
  const handoff = buildPackingCommerceHandoff(confirmedGap());
  assert.deepEqual(Object.keys(handoff).sort(), ['category', 'gapCode', 'query', 'source']);
  assert.equal(handoff.source, 'packing-gap');
  assert.equal(handoff.category, 'jacket');
  assert.match(handoff.query, /^Find me a jacket for my trip\.$/);
});

test('no trip, Closet, actor or plan identifier can ride the handoff', () => {
  const handoff = buildPackingCommerceHandoff({
    ...confirmedGap(),
    tripId: 'trip-uuid-1',
    closetItemId: 'closet-uuid-1',
    userId: 'user-uuid-1',
    departureDate: '2026-10-01',
    rationale: 'Because the forecast said rain in Lisbon on the 3rd.',
  });
  const serialized = JSON.stringify(handoff);
  for (const leak of ['trip-uuid-1', 'closet-uuid-1', 'user-uuid-1', '2026-10-01', 'Lisbon']) {
    assert.equal(serialized.includes(leak), false, `${leak} must not leave Packing`);
  }
});

// ── The surface ────────────────────────────────────────────────────────────

test('the action renders only on a confirmed gap, and only behind the flag', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /onFindOptions && gap\.certainty === 'confirmed'/);

  const screen = read('app/packing/index.tsx');
  assert.match(
    screen,
    /onFindOptions=\{ELISE_COMMERCE_ACTIVATION_V1 \? onFindOptions : undefined\}/,
    'flag off means the control does not render at all',
  );
});

test('the external-ideas list stays completely inert', () => {
  // Case B in the brief's terms: these are ungrounded suggestions, not
  // confirmed gaps, so they get no shopping action of any kind.
  const view = read('components/packing/PackingPlanView.tsx');
  const start = view.indexOf('<SectionHeader title="IDEAS TO CONSIDER" />');
  assert.ok(start > -1);
  const section = view.slice(start, view.indexOf('</View>\n  );\n}', start));
  assert.doesNotMatch(section, /Pressable|onPress/, 'nothing in the ideas list is tappable');
  assert.doesNotMatch(section, /onFindOptions/, 'and it carries no Commerce seam');
});

test('the screen routes through the existing governed handoff, not a new one', () => {
  const screen = read('app/packing/index.tsx');
  // The same ephemeral in-memory bridge the Scanner and Dressing Room use.
  assert.match(screen, /setStyleChatHandoffContext\(\{/);
  assert.match(screen, /router\.push\('\/style-chat'\)/);
  // And it builds the payload through the adapter, never by hand.
  assert.match(screen, /buildPackingCommerceHandoff\(\{/);
  // No second Commerce results UI inside Packing.
  assert.doesNotMatch(code('app/packing/index.tsx'), /ProductShelf|CommerceProductsBlock|fetchDeferredCommerce/);
});

test('the screen forwards only the three handoff fields', () => {
  const screen = read('app/packing/index.tsx');
  const call = screen.slice(
    screen.indexOf('setStyleChatHandoffContext({'),
    screen.indexOf('router.push(\'/style-chat\')'),
  );
  assert.match(call, /source: handoff\.source/);
  assert.match(call, /query: handoff\.query/);
  assert.match(call, /category: handoff\.category/);
  assert.doesNotMatch(call, /trip|plan|closet|userId|date/i, 'nothing else travels');
});

test('the request is sent once, and only for a packing handoff', () => {
  const screen = read('app/style-chat/[sessionId].tsx');
  assert.match(
    screen,
    /handoffContext\.source !== 'packing-gap'/,
    'every other handoff source keeps its existing behaviour',
  );
  assert.match(screen, /autoSentHandoffRef/, 'the guard is a ref, not state');
  assert.match(screen, /if \(autoSentHandoffRef\.current === query\) return;/);
});

// ── No return path: Commerce can never confirm a gap ───────────────────────

test('nothing in the adapter accepts a product, a price or a Commerce outcome', () => {
  const source = read('services/packing/packingCommerceHandoff.ts');
  assert.doesNotMatch(source, /RecommendedProduct|purchaseOption|price|availability/i);
  const exported = Object.keys(require(path.join(ROOT, 'services/packing/packingCommerceHandoff.ts')));
  assert.deepEqual(
    exported.sort(),
    ['buildPackingCommerceHandoff', 'gapIsShoppable'],
    'the module exports no way to report an outcome back',
  );
});

test('B4 still holds: the gap deriver cannot reach a retailer or a product', () => {
  assert.doesNotMatch(
    code('supabase/functions/stylechat-generate/packingGaps.ts'),
    /productUrl|retailer|catalogue|purchase|checkout/i,
  );
  // And the client still drops any gap that arrives carrying commerce shape.
  const client = read('services/packing/packingClient.ts');
  assert.match(client, /raw\.price != null \|\| raw\.url != null \|\| raw\.productId != null/);
});

// ── Incidence (section 9) ──────────────────────────────────────────────────

test('confirmed-gap incidence is measured, not assumed', () => {
  const report = incidence.run();
  assert.equal(report.PACKING_FIXTURE_TRIPS, 12);
  assert.ok(report.PACKING_FIXTURE_GAPS_TOTAL > 0);
  assert.equal(
    report.PACKING_FIXTURE_CONFIRMED + report.PACKING_FIXTURE_UNCONFIRMED,
    report.PACKING_FIXTURE_GAPS_TOTAL,
  );
  assert.ok(report.PACKING_FIXTURE_UNCONFIRMED > 0, 'the corpus must contain unconfirmed gaps too');
  assert.match(report.scope, /NOT A POPULATION CLAIM/);
});

test('an unconfirmed gap in the fixtures yields no handoff', () => {
  const report = incidence.run();
  const unconfirmed = report.rows
    .flatMap((r) => r.gaps)
    .filter((g) => g.certainty === 'unconfirmed');
  assert.ok(unconfirmed.length > 0, 'the measurement must actually exercise this');
  for (const gap of unconfirmed) {
    assert.equal(
      buildPackingCommerceHandoff({ gapCode: gap.code, label: gap.label, certainty: gap.certainty }),
      null,
      `${gap.code} must not become a shopping request`,
    );
  }
});

test('every confirmed gap the fixtures produce can actually be handed off', () => {
  // A control that appears but does nothing would be worse than no control.
  const report = incidence.run();
  const confirmed = report.rows.flatMap((r) => r.gaps).filter((g) => g.certainty === 'confirmed');
  for (const gap of confirmed) {
    const handoff = buildPackingCommerceHandoff({
      gapCode: gap.code,
      label: gap.label,
      certainty: gap.certainty,
    });
    assert.ok(handoff, `${gap.code} is confirmed but produced no handoff`);
    assert.ok(handoff.query.length > 0);
  }
});

test('certainty is never raised to make the action more reachable', () => {
  // Nothing in the Commerce direction ASSIGNS a certainty. The bridge declares
  // the union as a read type, which is not the same thing, so the scan looks
  // for an assignment rather than the words.
  const bridge = code('supabase/functions/scan-identify/commercePackingBridge.ts');
  assert.doesNotMatch(
    bridge,
    /(gap|contribution|intent)[^\n]*\.certainty\s*=\s*'confirmed'/,
    'the bridge must never write a certainty',
  );
  assert.match(bridge, /gap\.certainty !== 'confirmed'/, 'it only ever refuses on one');
  // Packing itself still decides, in the branch that predates this lane.
  assert.match(
    read('supabase/functions/stylechat-generate/packingGaps.ts'),
    /certainty: 'confirmed', source: 'role'/,
  );
});
