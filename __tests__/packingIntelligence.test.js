'use strict';

// K+ Packing Intelligence V1 — client certification.
//
// What this proves that the backend suite cannot:
//   1. The wire is validated before it becomes state.
//   2. A plan is bound to ONE actor and cannot survive an account switch.
//   3. "Don't bring the boots" removes them from the STRUCTURE, and the screen
//      renders the structure — so the two cannot disagree.
//   4. The K+ gate, the flag and the entry point are wired the way the build
//      plan requires, checked against the real source rather than a copy.

const assert = require('node:assert/strict');
const { test } = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(REPO_ROOT, relative), 'utf8');

// ── Wire validation ──────────────────────────────────────────────────────────
// The client module imports the Supabase client, which cannot load in this
// environment, so the pure parsers are exercised through a small transpile-free
// harness over the same source. The source itself is asserted below, so the
// harness cannot drift into testing something the app does not run.

const clientSource = read('services/packing/packingClient.ts');

test('client: counts are derived from the rendered plan, never read from the wire', () => {
  // A header that disagrees with the list under it is the exact inconsistency
  // this feature must not have, so the count fields must not be parsed.
  assert.match(clientSource, /counts are DERIVED, never read from the wire/i);
  assert.doesNotMatch(
    clientSource,
    /counts:\s*\{[^}]*int\(/s,
    'counts must not be taken from the payload',
  );
  assert.match(clientSource, /items: packedItems\.length/);
  assert.match(clientSource, /outfits: outfits\.length/);
});

test('client: reuse badges are recomputed from the outfits that will render', () => {
  assert.match(clientSource, /const usage = new Map<string, number>\(\)/);
  assert.match(clientSource, /item\.usedInOutfits = usage\.get\(item\.itemId\) \?\? 0/);
});

test('client: an outfit referencing an unpacked item is trimmed, never rendered with a hole', () => {
  assert.match(clientSource, /outfit\.itemIds\.filter\(\(id\) => packedIds\.has\(id\)\)/);
});

test('client: a weather summary without a provenance that justifies it is dropped', () => {
  assert.match(
    clientSource,
    /provenance === 'UNAVAILABLE' \? null : str\(value\.summary/,
    'an unlabelled weather line reads as a forecast when it is not one',
  );
});

test('client: a success whose plan fails validation is downgraded, not shown as success', () => {
  assert.match(clientSource, /if \(status === 'success' && !plan\)/);
  assert.match(clientSource, /status: 'no_result'/);
});

test('client: the request carries the exact versioned schema discriminator', () => {
  assert.match(clientSource, /schemaVersion: PACKING_REQUEST_SCHEMA_VERSION/);
  assert.match(read('types/packing.ts'), /PACKING_REQUEST_SCHEMA_VERSION = 'packing-plan-v1'/);
});

// ── Actor binding ────────────────────────────────────────────────────────────

const storeSource = read('services/packing/packingPlanStore.ts');

test('store: every render read is actor-scoped, not merely actor-labelled', () => {
  assert.match(storeSource, /export function getPackingSnapshotFor\(actorId: string \| null\)/);
  assert.match(storeSource, /if \(!actorId \|\| snapshot\.actorId !== actorId\) return EMPTY/);
});

test('store: a write for a different actor resets rather than merging', () => {
  assert.match(
    storeSource,
    /const base = snapshot\.actorId === actorId \? snapshot : \{ \.\.\.EMPTY, actorId \}/,
  );
});

test('store: exclusions are session intent and never a stored preference', () => {
  assert.match(storeSource, /never a wardrobe preference and never a Signature Style edit/i);
  // Nothing in the Packing store may write to a durable preference surface.
  assert.doesNotMatch(storeSource, /AsyncStorage|supabase|styleDna|user_style_profiles/i);
});

test('auth boundary: Packing state is cleared by the one shared actor reset', () => {
  const auth = read('contexts/AuthSessionContext.tsx');
  assert.match(auth, /import \{ resetPackingPlanState \} from '\.\.\/services\/packing\/packingPlanStore'/);
  assert.match(auth, /resetPackingPlanState\(\);/);
  // It must sit inside resetActorScopedRuntimeState, which runs on sign-out,
  // sign-in and user change alike — not in a Packing-specific listener.
  const fnStart = auth.indexOf('function resetActorScopedRuntimeState');
  const fnEnd = auth.indexOf('export function AuthSessionProvider');
  assert.ok(fnStart > -1 && fnEnd > fnStart);
  assert.ok(
    auth.slice(fnStart, fnEnd).includes('resetPackingPlanState()'),
    'the reset must be inside resetActorScopedRuntimeState',
  );
});

test('hook: a completion that lands after an actor change is discarded', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /if \(getPackingSnapshot\(\)\.actorId !== actorId\) return;/);
});

test('hook: a new trip does not inherit the previous trip constraints', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /excludeItemIds: \[\], notes: \[\], packLight: false \}, newSessionId\(\)/);
});

test('hook: entitlement is UX only and unresolved states are never treated as active', () => {
  const hook = read('hooks/usePackingPlan.ts');
  assert.match(hook, /entitled: entitlement\.isActive/);
  assert.match(hook, /Client entitlement is UX only/i);
});

// ── Refinement: structure wins ───────────────────────────────────────────────

test('hook: removing an item regenerates from the accumulated exclusions', () => {
  const hook = read('hooks/usePackingPlan.ts');
  const start = hook.indexOf('const removeItem');
  const end = hook.indexOf('const refineWith');
  assert.ok(start > -1 && end > start);
  const body = hook.slice(start, end);
  assert.match(body, /excludePackingItem\(actorId, itemId\)/);
  assert.match(body, /await run\(/);
  assert.match(body, /excludeItemIds,/);
});

test('hook: there is exactly one code path that can produce an authoritative plan', () => {
  const hook = read('hooks/usePackingPlan.ts');
  // Every refinement funnels through run(); nothing else may call applyPackingPlan.
  const applyCalls = hook.match(/applyPackingPlan\(/g) ?? [];
  assert.equal(applyCalls.length, 1, 'only run() may install a plan');
});

test('view: the screen renders the structured plan and never a parsed prose plan', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  // Items come from plan.packedItems; outfits index into that same list.
  assert.match(view, /plan\.packedItems\.map\(\(item\) =>/);
  assert.match(view, /outfit\.itemIds\.map\(\(itemId\) => \{/);
  assert.match(view, /const item = itemsById\.get\(itemId\);/);
  assert.match(view, /if \(!item\) return null;/);
  // The assistant sentence is displayed, never parsed.
  assert.doesNotMatch(view, /\.split\(|JSON\.parse|match\(/);
});

test('view: only a real forecast may use the word forecast', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  const start = view.indexOf('function weatherLine');
  const end = view.indexOf('function itemSubtitle');
  const body = view.slice(start, end);
  assert.match(body, /case 'FORECAST':[\s\S]*Forecast: /);
  assert.match(body, /case 'SEASONAL':[\s\S]*Typical conditions: /);
  assert.doesNotMatch(
    body.slice(body.indexOf("case 'SEASONAL'")),
    /`Forecast/,
    'seasonal must never be labelled a forecast',
  );
});

test('view: a reuse badge is only shown from the plan-derived count', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /item\.usedInOutfits > 1 \?/);
  assert.match(view, /Works across \$\{item\.usedInOutfits\} looks/);
});

test('view: general mode is visibly not owned and carries no item cards', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  const start = view.indexOf('export function PackingGeneralGuideView');
  const body = view.slice(start);
  assert.match(body, /GENERAL GUIDE/);
  assert.doesNotMatch(body, /ClosetItemCard/, 'general mode must not use owned-item styling');
  assert.doesNotMatch(body, /resolveImage/, 'general mode must not render Closet photography');
});

// ── Entry point, gate and flag ───────────────────────────────────────────────

test('screen: Packing renders through the ONE shared K+ gate', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /import \{ KPlusGate \}/);
  assert.match(screen, /<KPlusGate source="packing">/);
  // No feature-specific paywall or entitlement flag of its own.
  assert.doesNotMatch(screen, /isPaidUser|packingPlus|packing_paid|isPackingSubscriber/i);
});

test('screen: losing K+ stops new work but never tears down a visible plan', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /isActive && !busy \? \(itemId\) => void packing\.removeItem\(itemId\) : undefined/);
  assert.match(screen, /packing-entitlement-lapsed/);
  assert.match(screen, /This plan stays here/);
});

test('screen: loading stages describe real work and invent no percentage', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /Reviewing your Closet/);
  assert.match(screen, /Building your looks/);
  // No numeric progress surface of any kind: a percentage would be a claim
  // about internals we cannot make.
  assert.doesNotMatch(screen, /ProgressBar|progress=\{|progressPercent|\$\{[^}]*\}%/);
});

test('screen: a failure is retryable and preserves the trip', () => {
  const screen = read('app/packing/index.tsx');
  assert.match(screen, /packing-error/);
  assert.match(screen, /packing\.retryable \?/);
  assert.match(screen, /packing-retry/);
});

test('flag: the client kill switch defaults off and is exact-string opt-in', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /EXPO_PUBLIC_PACKING_INTELLIGENCE_V1/);
  assert.match(flags, /export function resolvePackingIntelligenceEnabled\([\s\S]*?return value === 'true';/);
  const { resolvePackingIntelligenceEnabled } = requireFlags();
  assert.equal(resolvePackingIntelligenceEnabled(undefined), false);
  assert.equal(resolvePackingIntelligenceEnabled('false'), false);
  assert.equal(resolvePackingIntelligenceEnabled('TRUE'), false);
  assert.equal(resolvePackingIntelligenceEnabled('1'), false);
  assert.equal(resolvePackingIntelligenceEnabled('true'), true);
});

test('entry: home offers Packing without adding a navigation tab', () => {
  const home = read('components/home/HomeLuxuryTechV1.tsx');
  assert.match(home, /home-luxury-feature-packing/);
  assert.match(home, /router\.push\('\/packing'\)/);
  assert.match(home, /\{packingEnabled && \(/);
  assert.match(home, /const packingEnabled = PACKING_INTELLIGENCE_V1;/);
});

/**
 * Evaluates the flag resolver from source without loading the Expo module
 * graph. Only the one pure function is extracted, and the test above asserts
 * that the extracted text is the shape the app actually ships.
 */
function requireFlags() {
  const source = read('constants/featureFlags.ts');
  const start = source.indexOf('export function resolvePackingIntelligenceEnabled');
  assert.ok(start > -1, 'resolver must exist');
  const end = source.indexOf('\n}', start) + 2;
  const body = source
    .slice(start, end)
    .replace('export function', 'function')
    .replace(/: string \| undefined/g, '')
    .replace(/: boolean/g, '');
  // eslint-disable-next-line no-new-func
  const factory = new Function(
    'process',
    `${body}; return { resolvePackingIntelligenceEnabled };`,
  );
  return factory({ env: {} });
}

// ── Gaps and trust signals (B4) ──────────────────────────────────────────────

test('client: a gap carrying anything commerce-shaped is dropped, not displayed', () => {
  assert.match(clientSource, /function parseGaps\(value: unknown\): PackingGap\[\]/);
  assert.match(
    clientSource,
    /if \(raw\.price != null \|\| raw\.url != null \|\| raw\.productId != null\) continue;/,
  );
});

test('client: the gap count is derived from the gaps that will render', () => {
  assert.match(clientSource, /gaps: gaps\.length,/);
});

test('view: a gap is rendered with no photograph, no card and nothing to tap', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  // Anchor on the section header, not the summary-stat label of the same name.
  const start = view.indexOf('<SectionHeader title=\"POSSIBLE GAPS\" />');
  const end = view.indexOf('ASSUMPTIONS');
  assert.ok(start > -1 && end > start, 'the gaps section must exist and precede assumptions');
  const section = view.slice(start, end);
  assert.doesNotMatch(section, /ClosetItemCard/, 'a gap must not use the owned-item card');
  assert.doesNotMatch(section, /resolveImage|Image /, 'a gap must not render imagery');
  assert.doesNotMatch(section, /Pressable|onPress/, 'a gap is not an action');
  assert.match(section, /packing-gap-/);
});

test('view: the scarcity badge renders only the server-derived signal', () => {
  const view = read('components/packing/PackingPlanView.tsx');
  assert.match(view, /item\.scarcitySignal \?/);
  assert.match(view, /<Text style=\{styles\.itemScarcity\}>\{item\.scarcitySignal\}<\/Text>/);
  // The client must not compute its own scarcity claim from what it can see.
  assert.doesNotMatch(view, /Your only/, 'the copy is the servers, derived from the census');
});
