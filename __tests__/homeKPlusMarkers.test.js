// Home K+ markers (Watchlist + Pack for a Trip) -- focused source-contract
// tests, same style as __tests__/homeVoiceScanPill.test.js: this repo has no
// Jest/RTL, so the required invariants are proven against the shipped source.
//
// Build 34 final UI integration scope: visible K+ treatment on the two Home
// entries that lacked one, reusing the Voice Scan pill badge language, with
// entitlement authority preserved. Expired evidence must not block a built-in
// feature's route; certification remains required for K+ catalog claims.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

const homeV1 = read('components', 'home', 'HomeLuxuryTechV1.tsx');
const badge = read('components', 'kplus', 'KPlusMarkerBadge.tsx');
// Comment-stripped view so explanatory prose cannot satisfy a code check.
const homeCode = homeV1.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');

function sliceFn(source, startMarker, endMarker) {
  const start = source.indexOf(startMarker);
  assert.ok(start >= 0, `expected to find "${startMarker}"`);
  const end = endMarker ? source.indexOf(endMarker, start) : source.length;
  assert.ok(end > start, `expected to find "${endMarker}" after "${startMarker}"`);
  return source.slice(start, end);
}

const watchlistBlock = sliceFn(homeCode, 'testID="home-luxury-watchlist"', 'secondaryActionKPlusBadge');
const packingBlock = sliceFn(homeCode, 'title="PACK FOR A TRIP"', 'home-luxury-packing-kplus-badge');

// ── Watchlist marker ────────────────────────────────────────────────────────

test('Watchlist free/eligible state visibly identifies K+', () => {
  assert.match(homeCode, /state=\{isActive \? 'included' : 'locked'\}/);
  assert.match(badge, /'K\+'/);
});

test('Watchlist active state visibly identifies Included', () => {
  assert.match(homeCode, /testID="home-luxury-watchlist-kplus-badge"/);
  assert.match(badge, /included \? 'INCLUDED' : 'K\+'/);
});

// ── Packing marker ──────────────────────────────────────────────────────────

test('Packing free/eligible state visibly identifies K+', () => {
  const chipBlock = sliceFn(homeCode, 'title="PACK FOR A TRIP"', 'FeatureChip>');
  assert.match(chipBlock, /KPlusMarkerBadge/);
  assert.match(chipBlock, /state=\{packingKPlusActive \? 'included' : 'locked'\}/);
});

test('Packing active state visibly identifies Included', () => {
  assert.match(homeCode, /testID="home-luxury-packing-kplus-badge"/);
  assert.match(homeCode, /packingKPlusActive \? 'included' : 'locked'/);
});

// ── Resolving truth ─────────────────────────────────────────────────────────

test('resolving renders no marker on either entry (never false free, never false Included)', () => {
  assert.match(homeCode, /\{!resolving && \(/, 'watchlist badge requires a resolved entitlement');
  const chipBlock = sliceFn(homeCode, 'title="PACK FOR A TRIP"', 'FeatureChip>');
  assert.match(chipBlock, /!packingKPlusResolving && \(/, 'packing badge gated on !packingKPlusResolving');
  assert.match(homeCode, /isKPlusEntitlementUnresolved\(packingKPlusState\)/);
});

// ── Behavior unchanged ──────────────────────────────────────────────────────

test('existing Watchlist tap behavior is unchanged', () => {
  assert.match(watchlistBlock, /disabled=\{resolving\}/);
  assert.match(watchlistBlock, /if \(resolving\) return;/);
  assert.match(watchlistBlock, /if \(isActive\) router\.push\('\/watchlist'\);/);
  assert.match(watchlistBlock, /else openUpgrade\(\);/);
});

test('Watchlist keeps compact-width room for the marker and full label', () => {
  assert.match(watchlistBlock, /style=\{styles\.watchlistActionButton\}/);
  assert.match(homeCode, /watchlistActionButton:\s*\{[\s\S]*?paddingHorizontal: SPACING\.md/);
});

test('existing Packing tap behavior is unchanged (routes to the gated screen)', () => {
  assert.match(packingBlock, /router\.push\('\/packing'\)/);
  // The Packing entry must NOT grow its own gate/sheet: display state is read
  // from the shared entitlement hook, not a second KPlusGate mount.
  const chipBlock = sliceFn(homeCode, 'title="PACK FOR A TRIP"', 'FeatureChip>');
  assert.doesNotMatch(chipBlock, /KPlusGate|openUpgrade/);
});

// ── Release activation: evidence must not be confused with availability ────

test('enabled Packing route is reachable even when certification expires', () => {
  const chip = sliceFn(homeCode, 'title="PACK FOR A TRIP"', 'FeatureChip>');
  assert.match(homeCode, /\{packingEnabled && \(/, 'the build flag still controls exposure');
  assert.match(chip, /onPress=\{\(\) => router\.push\('\/packing'\)\}/);
  assert.doesNotMatch(chip, /hasRuntimeCapabilityProof|Alert\.alert|Currently unavailable/);
  // The Packing screen, not the Home chip, owns the shared K+ user gate.
  const screen = read('app', 'packing', 'index.tsx');
  assert.match(screen, /<KPlusGate source="packing">/);
});

test('enabled Watchlist entry waits for entitlement and cannot silently disable', () => {
  assert.match(homeCode, /\{watchlistEnabled && \(/, 'the build flag still controls exposure');
  assert.match(homeCode, /<KPlusGate source="watchlist">/);
  assert.match(watchlistBlock, /disabled=\{resolving\}/);
  assert.match(watchlistBlock, /if \(resolving\) return;/);
  assert.match(watchlistBlock, /if \(isActive\) router\.push\('\/watchlist'\);/);
  assert.match(watchlistBlock, /else openUpgrade\(\);/);
  assert.doesNotMatch(watchlistBlock, /hasRuntimeCapabilityProof|Alert\.alert|Smart Watchlist is unavailable/);
  // The real client and backend still have the separate availability/entitlement guards.
  const availability = read('services', 'watchlist', 'watchlistAvailability.ts');
  assert.match(availability, /return smartWatchlistActive === true;/);
  const worker = read('supabase', 'functions', 'commerce-watch-refresh', 'watchEntitlementGuard.ts');
  assert.match(worker, /if \(active !== true\) return null;/);
});

// ── Shared visual language ──────────────────────────────────────────────────

test('marker reuses the Voice Scan pill badge treatment, not a new badge family', () => {
  const pill = read('components', 'home', 'HomeVoiceScanPill.tsx');
  for (const token of ['badgeIncluded', 'badgeLocked', 'badgeTextIncluded', 'badgeTextLocked']) {
    assert.ok(badge.includes(token), `badge must carry ${token}`);
    assert.ok(pill.includes(token), `voice pill already carries ${token}`);
  }
  assert.match(badge, /LUXURY\.colors\.plumMuted/);
  assert.match(badge, /LUXURY\.colors\.plum\b/);
  // Decorative marker must never intercept taps on the underlying entry.
  assert.match(badge, /pointerEvents="none"/);
});
