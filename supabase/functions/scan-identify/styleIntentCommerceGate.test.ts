// scan-identify — style-intent commerce gate (Phase 2B.3, §42 / Addendum G).
//
// Phase 2B.1 built the gate; nothing tested it. Elise's whole V2 migration rests
// on the claim that an accepted `identify_for_style` request runs NO commerce, so
// that claim needs a test rather than a comment.
//
// Two properties are covered, and they are different:
//   1. the DECISION — `identify_for_style` never runs commerce, whatever the
//      status, and `identify_and_shop` still does exactly what it did.
//   2. the PLACEMENT — the decision is evaluated in `index.ts` before any
//      provider, catalog query or similarity matcher is constructed. Deciding
//      correctly but late would still spend the quota and the latency.
//
// Deterministic and pure: no network, no Supabase, no provider call.

import { assert, assertEquals, assertMatch } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { resolveCommerceDecision } from './v2Activation.ts';
import {
  COMMERCE_SKIPPED_STYLE_INTENT,
  shouldRunCommerce,
} from '../_shared/fashionIdentificationV2.ts';

const STATUSES = [
  'completed',
  'partial',
  'insufficient_visual_evidence',
  'non_fashion',
  'multiple_items_need_selection',
  'technical_failure',
] as const;

// ── 1. The decision ─────────────────────────────────────────────────────────

Deno.test('identify_for_style never runs commerce, for ANY status', () => {
  for (const status of STATUSES) {
    const gate = shouldRunCommerce({ intent: 'identify_for_style', status });
    assertEquals(gate.run, false, `${status} must not run commerce under style intent`);
    assertEquals(gate.skippedReason, COMMERCE_SKIPPED_STYLE_INTENT);
  }
});

Deno.test('style intent is checked BEFORE any status-based skip', () => {
  // A completed style-intent scan is the case that would leak: every other status
  // has its own independent reason to skip, so a gate that tested status first
  // would still look correct on all of them and fail only here.
  const gate = shouldRunCommerce({ intent: 'identify_for_style', status: 'completed' });
  assertEquals(gate.run, false);
  assertEquals(
    gate.skippedReason,
    COMMERCE_SKIPPED_STYLE_INTENT,
    'the reason must name the intent, not a coincidental status skip',
  );
});

Deno.test('identify_and_shop behaviour is unchanged', () => {
  // Scanner must keep working exactly as it does. A completed or partial shop
  // request runs commerce; the three no-result statuses still skip it.
  assertEquals(shouldRunCommerce({ intent: 'identify_and_shop', status: 'completed' }).run, true);
  assertEquals(shouldRunCommerce({ intent: 'identify_and_shop', status: 'partial' }).run, true);
  assertEquals(
    shouldRunCommerce({ intent: 'identify_and_shop', status: 'multiple_items_need_selection' }).run,
    true,
  );
  for (const status of ['non_fashion', 'technical_failure', 'insufficient_visual_evidence'] as const) {
    const gate = shouldRunCommerce({ intent: 'identify_and_shop', status });
    assertEquals(gate.run, false, `${status} skips commerce even when shopping`);
    assertEquals(gate.skippedReason, status);
  }
});

Deno.test('a detection request never runs commerce regardless of intent', () => {
  // Detection has not chosen an item yet, so shopping for one is meaningless.
  for (const intent of ['identify_and_shop', 'identify_for_style'] as const) {
    const decision = resolveCommerceDecision({
      intent,
      resolvedMode: 'detect_items',
      status: 'completed',
    });
    assertEquals(decision.run, false);
    assertEquals(decision.skipReason, 'detection_mode');
  }
});

Deno.test('a selected-item style request skips commerce; a shop one runs it', () => {
  const style = resolveCommerceDecision({
    intent: 'identify_for_style',
    resolvedMode: 'identify_selected_item',
    status: 'completed',
  });
  assertEquals(style.run, false);
  assertEquals(style.skipReason, COMMERCE_SKIPPED_STYLE_INTENT);

  const shop = resolveCommerceDecision({
    intent: 'identify_and_shop',
    resolvedMode: 'identify_selected_item',
    status: 'completed',
  });
  assertEquals(shop.run, true);
  assertEquals(shop.skipReason, null);
});

Deno.test('a legacy single-item style request still skips commerce', () => {
  const decision = resolveCommerceDecision({
    intent: 'identify_for_style',
    resolvedMode: 'legacy_single_item',
    status: 'completed',
  });
  assertEquals(decision.run, false);
  assertEquals(decision.skipReason, COMMERCE_SKIPPED_STYLE_INTENT);
});

// ── 2. The placement ────────────────────────────────────────────────────────

const indexSource = Deno.readTextFileSync(
  new URL('./index.ts', import.meta.url),
);

Deno.test('the decision is evaluated before any commerce construction', () => {
  const decidedAt = indexSource.indexOf('const commerceDecision = resolveCommerceDecision({');
  assert(decidedAt > 0, 'the decision must exist in index.ts');

  // Every commerce construction site must come AFTER the decision. Deciding
  // correctly but after a provider was already built would still spend the quota
  // and the third-party call that style intent exists to avoid.
  const constructionMarkers = [
    'getScanCommerceResults',
    'getShoppingResults',
    'fetchCatalogCandidates',
    'findSimilarityMatches',
  ];
  let checked = 0;
  for (const marker of constructionMarkers) {
    let from = 0;
    for (;;) {
      const at = indexSource.indexOf(`${marker}(`, from);
      if (at < 0) break;
      assert(
        at > decidedAt,
        `${marker}() is called at ${at}, before the commerce decision at ${decidedAt}`,
      );
      checked += 1;
      from = at + 1;
    }
  }
  assert(checked > 0, 'at least one commerce construction site must exist to be ordered');
});

Deno.test('the short-circuit branch constructs nothing and reports the reason', () => {
  const branchAt = indexSource.indexOf('} else if (isV2Request && !commerceDecision.run) {');
  assert(branchAt > 0, 'the V2 short-circuit branch must exist');
  // Read to the end of the branch.
  const branchEnd = indexSource.indexOf('} else if (isAnonymousImageAnalysis)', branchAt);
  assert(branchEnd > branchAt);
  const branchRaw = indexSource.slice(branchAt, branchEnd);
  // Comments stripped: this branch's own comment NAMES the clients it refuses to
  // construct ("no KicksCrew, Farfetch, Serper or Brave client, no
  // product_catalog query"). Grepping raw source would flag the documentation of
  // the rule as a violation of it.
  const branch = branchRaw
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');

  // Empty results, and no construction of anything.
  assertMatch(branch, /finalRecommendedProducts = \[\];/);
  assertMatch(branch, /finalSimilarityMatches = \[\];/);
  assertMatch(branch, /commerceSkipped: true/);
  for (const forbidden of [
    'getScanCommerceResults',
    'getShoppingResults',
    'fetchCatalogCandidates',
    'findSimilarityMatches',
    'product_catalog',
    'await',
  ]) {
    assertEquals(
      branch.includes(forbidden),
      false,
      `the short-circuit branch must not contain ${forbidden}`,
    );
  }
});

Deno.test('the skip reason reaches telemetry as a bounded value', () => {
  // A skip that is not reported is indistinguishable from commerce that returned
  // nothing, which would make the zero-commerce claim unverifiable in production.
  assertMatch(indexSource, /reason: commerceDecision\.skipReason \?\? 'unknown'/);
  assertMatch(indexSource, /commerce_skipped reason=%s intent=%s mode=%s/);
});
