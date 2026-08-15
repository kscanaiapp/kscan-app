// Private Dressing Room route, entry points, and workspace states.
//
// Source-contract assertions in the style of this repository's other route
// tests: there is no React renderer in the suite, so the guarantees that matter
// (flag gating, which surface owns which action, what the route may pass, what
// the collaborative product keeps) are asserted against the source itself.
//
// `.test.js` rather than `.test.ts` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const ROUTE = 'app/stylist/dressing-room/index.tsx';
const STYLIST = 'app/stylist/index.tsx';
const LIBRARY = 'app/library.tsx';
const HOOK = 'hooks/usePrivateDressingRoom.ts';

// ── Route existence and shape ────────────────────────────────────────────────

test('the private workspace lives under /stylist/dressing-room', () => {
  assert.ok(fs.existsSync(path.join(ROOT, ROUTE)), 'route file must exist');
  const source = read(ROUTE);
  assert.match(source, /export default function PrivateDressingRoomScreen/);
});

test('the route does not collide with the collaborative room routes', () => {
  for (const collaborative of [
    'app/dressing-rooms/index.tsx',
    'app/dressing-rooms/[id].tsx',
    'app/(public)/rooms/[token].tsx',
  ]) {
    assert.ok(
      fs.existsSync(path.join(ROOT, collaborative)),
      `${collaborative} must still exist untouched`,
    );
  }
});

test('the route is thin: it uses the coordinator hook and never persistence', () => {
  const source = read(ROUTE);
  assert.match(source, /usePrivateDressingRoom/);
  // Asserted against IMPORTS, not the file text: the header comment names the
  // store precisely in order to say the screen does not call it.
  const imports = source.match(/^import [\s\S]*?from '[^']+';$/gm) ?? [];
  const importedFrom = imports.join('\n');
  for (const persistence of [
    'privateDressingRoomSessionStore',
    'expo-file-system',
    'closetLibrary',
  ]) {
    assert.equal(
      importedFrom.includes(persistence),
      false,
      `the screen must not import ${persistence}`,
    );
  }
  for (const call of ['startActiveSession(', 'updateActiveSession(', 'persistSessions(']) {
    assert.equal(source.includes(call), false, `the screen must not call ${call}`);
  }
});

test('the route reads no collaborative room state', () => {
  const source = read(ROUTE);
  for (const collaborative of [
    'dressingRoomCollaboration',
    'styleObjects',
    'outfitDecisions',
    'supabase',
    'addItemToDressingRoom',
  ]) {
    assert.equal(source.includes(collaborative), false, `must not use ${collaborative}`);
  }
});

// ── Flag gating ──────────────────────────────────────────────────────────────

test('the route renders nothing usable when the flag is off', () => {
  const source = read(ROUTE);
  assert.match(source, /if \(!PRIVATE_DRESSING_ROOM_V1\)/);
});

test('the Stylist entry is flag-gated', () => {
  const source = read(STYLIST);
  assert.match(source, /\{PRIVATE_DRESSING_ROOM_V1 \? \(/);
  assert.match(source, /testID="private-dressing-room-entry"/);
});

test('the Closet item entry is flag-gated', () => {
  const source = read(LIBRARY);
  assert.match(source, /PRIVATE_DRESSING_ROOM_V1\s*\?\s*\{/);
  assert.match(source, /viewLabel: 'Build an outfit'/);
});

// ── Stylist entry ────────────────────────────────────────────────────────────

test('the Stylist entry says Start or Resume based on an active session', () => {
  const source = read(STYLIST);
  assert.match(source, /hasActiveDressingRoom \? 'Resume Dressing Room' : 'Start a Dressing Room'/);
  assert.match(source, /usePrivateDressingRoomStatus/);
});

test('the Stylist entry navigates to the private route', () => {
  const source = read(STYLIST);
  assert.match(source, /router\.push\('\/stylist\/dressing-room'\)/);
});

test('the active-session probe reads only the private domain and never mutates', () => {
  const source = read(HOOK);
  const probe = source.slice(
    source.indexOf('export function usePrivateDressingRoomStatus'),
    source.indexOf('type ClosetSnapshot'),
  );
  assert.ok(probe.length > 0);
  assert.match(probe, /loadActiveSession/);
  for (const mutation of [
    'startActiveSession',
    'updateActiveSession',
    'discardActiveSession',
    'resetCorruptSession',
    'loadCloset',
  ]) {
    assert.equal(probe.includes(mutation), false, `the probe must not call ${mutation}`);
  }
});

// ── Closet item entry ────────────────────────────────────────────────────────

test('the Closet entry passes only the selected closetItemId', () => {
  const source = read(LIBRARY);
  const action = source.slice(
    source.indexOf('const closetOutfitAction'),
    source.indexOf('const handleDeleteClosetItem'),
  );
  assert.match(action, /pathname: '\/stylist\/dressing-room'/);
  assert.match(action, /params: \{ closetItemId: id \}/);
  // No actor id, no ownerId, no provenance may ride along in the route.
  for (const leak of ['ownerId', 'actorId', 'sourceCandidateId', 'savedScanId', 'userId']) {
    assert.equal(action.includes(leak), false, `route params must not carry ${leak}`);
  }
});

test('the collaborative Add to Room action is unchanged', () => {
  const source = read(LIBRARY);
  // Both inspiration render paths keep the action: the single-item card and
  // the grid card. This counted 3 while the grid duplicated its card JSX for a
  // hardcoded pair of items; the iPad column fix renders one card per item, so
  // the count measured duplication rather than reach.
  const addToRoom = (source.match(/viewLabel="Add to Room"/g) ?? []).length;
  assert.equal(addToRoom, 2, 'one per render path: single card and grid card');
  assert.match(
    source,
    /inspirationRows\.map\([\s\S]{0,600}?viewLabel="Add to Room"/,
    'every grid inspiration keeps Add to Room',
  );
  assert.match(source, /handleAddInspirationToRoom\(item\)/, 'wired to the room handler');
});

test('the Closet entry is additive: delete stays on the same card', () => {
  const source = read(LIBRARY);
  // The contract is that ONE Closet card carries both the outfit entry and its
  // own delete — the entry is additive, not a replacement. It used to be
  // asserted as "2 of each" only because the grid duplicated its card JSX for a
  // hardcoded pair; there is now a single card render per item.
  const closetCards = (source.match(/testID="closet-card"/g) ?? []).length;
  const outfitActions = (source.match(/closetOutfitAction\(/g) ?? []).length;
  assert.equal(closetCards, 1, 'one card render, used for every Closet item');
  assert.equal(outfitActions, 1, 'that card gets the outfit entry');
  // Both actions must live on the SAME card render.
  assert.match(
    source,
    /testID="closet-card"[\s\S]{0,700}?onDelete=\{\(\) => handleDeleteClosetItem\(item\.id\)\}[\s\S]{0,200}?closetOutfitAction\(item\.id\)/,
    'delete and the outfit entry stay on the same Closet card',
  );
});

// ── Workspace states ─────────────────────────────────────────────────────────

test('every coordinator status has a rendered branch', () => {
  const source = read(ROUTE);
  for (const status of [
    'actor_loading',
    'actor_unavailable',
    'closet_loading',
    'closet_failed',
    'session_unrecoverable',
    'no_session',
    'active',
  ]) {
    assert.match(source, new RegExp(`case '${status}':`), `missing branch for ${status}`);
  }
});

test('the unrecoverable state offers reset and a way back', () => {
  const source = read(ROUTE);
  assert.match(source, /testID="reset-session-button"/);
  assert.match(source, /title="Go back"/);
  assert.match(source, /futureSchema/);
});

test('a recovered session shows a non-blocking notice, not a blocking state', () => {
  const source = read(ROUTE);
  assert.match(source, /recoveredFromBackup \? \(/);
  assert.match(source, /variant="info"/);
});

test('a missing anchor is explained without reconstructing garment metadata', () => {
  const source = read(ROUTE);
  assert.match(source, /anchorMissing \? \(/);
  assert.match(source, /PRIVATE_WORKSPACE_COPY\.anchorMissing/);
  // The anchor card only renders when a real projection resolved.
  assert.match(source, /\{anchor \? \(/);
});

test('an unavailable route item is surfaced', () => {
  const source = read(ROUTE);
  assert.match(source, /routeItemUnavailable \? \(/);
});

test('discard is confirmed before it happens', () => {
  const source = read(ROUTE);
  assert.match(source, /confirmingDiscard/);
  assert.match(source, /testID="confirm-discard-button"/);
  assert.match(source, /Discard this Dressing Room\?/);
  assert.match(source, /title="Keep it"/);
});

// ── Phase 1 scope ────────────────────────────────────────────────────────────

test('Phase 1 offers no generation, no Continue, and no placeholder Looks', () => {
  const source = read(ROUTE);
  // Asserted on ACTION TITLES, not the file text: "Sign in to continue" is
  // explanatory copy for a blocked state, not a Phase 2 destination.
  const titles = [...source.matchAll(/title=(?:"([^"]*)"|\{([^}]*)\})/g)].map(
    (m) => m[1] ?? m[2],
  );
  for (const title of titles) {
    assert.equal(
      /^\s*(Continue|Generate|Create outfit|Build outfit)\s*$/i.test(title),
      false,
      `Phase 1 must not offer an action titled ${title}`,
    );
  }
  for (const forbidden of ['generateOutfits', 'createLookFrom', 'OutfitSuggestion']) {
    assert.equal(source.includes(forbidden), false, `Phase 1 must not offer ${forbidden}`);
  }
  assert.match(source, /savedLooksEnabled \? \([\s\S]*?Save Look/);
});

test('the ready state renders real outfit options', () => {
  // Phase 1 showed a passive "ready for the next step" notice because there was
  // no next step yet. Phase 2 replaced it with the composed outfits themselves.
  const source = read(ROUTE);
  assert.match(source, /testID="composition-ready"/);
  assert.match(source, /testID="look-card"/);
  assert.match(source, /testID="active-look-detail"/);
});

// ── Accessibility and layout ─────────────────────────────────────────────────

test('every interactive control has an accessibility label', () => {
  const source = read(ROUTE);
  const controls = source.match(/<(PrimaryButton|SecondaryButton|TouchableOpacity)\b/g) ?? [];
  const labels = source.match(/accessibilityLabel=/g) ?? [];
  assert.ok(controls.length >= 6, 'expected the workspace controls');
  assert.ok(
    labels.length >= controls.length,
    `every control needs a label (${controls.length} controls, ${labels.length} labels)`,
  );
});

test('every selectable control exposes accessibility state', () => {
  const source = read(ROUTE);
  const selectable = (source.match(/accessibilityRole="button"/g) ?? []).length;
  const states = (source.match(/accessibilityState=\{\{ selected/g) ?? []).length;
  // Anchor options, occasion options, Phase 2 look cards, and (Phase 3)
  // slot-swap, fill, missing-item and candidate controls.
  assert.ok(selectable >= 3, `expected the selectable controls, found ${selectable}`);
  assert.ok(
    states >= 3,
    `every selectable control that can be chosen reports it (${states} of ${selectable})`,
  );
});

test('loading states are announced to a screen reader', () => {
  const source = read(ROUTE);
  const live = (source.match(/accessibilityLiveRegion="polite"/g) ?? []).length;
  assert.ok(live >= 2, 'actor and Closet loading are announced');
});

test('touch targets meet the 48dp minimum', () => {
  const source = read(ROUTE);
  const minHeights = source.match(/minHeight: (\d+)/g) ?? [];
  assert.ok(minHeights.length >= 2, 'tappable chips declare a minimum height');
  for (const declaration of minHeights) {
    const value = Number(declaration.split(':')[1].trim());
    assert.ok(value >= 48, `touch target ${value} is below 48dp`);
  }
});

test('the screen uses the shared luxury system and safe area', () => {
  const source = read(ROUTE);
  assert.match(source, /from '\.\.\/\.\.\/\.\.\/components\/luxury'/);
  assert.match(source, /<LuxuryScreen safeArea scrollable/);
});

test('wide content scrolls rather than forcing the page sideways', () => {
  const source = read(ROUTE);
  assert.match(source, /horizontal\s+showsHorizontalScrollIndicator=\{false\}/);
  assert.match(source, /flexWrap: 'wrap'/, 'occasion chips wrap on small screens');
});

test('back behaviour cannot trap a deep-linked user', () => {
  const source = read(ROUTE);
  assert.match(source, /goBackOrHome\(router\)/);
});

// ── Collaborative product preservation ───────────────────────────────────────

test('the collaborative dressing room screens are not modified by this route', () => {
  for (const collaborative of ['app/dressing-rooms/index.tsx', 'app/dressing-rooms/[id].tsx']) {
    const source = read(collaborative);
    assert.equal(
      source.includes('stylist/dressing-room'),
      false,
      `${collaborative} must not reference the private route`,
    );
    assert.equal(
      source.includes('PRIVATE_DRESSING_ROOM_V1'),
      false,
      `${collaborative} must not read the private flag`,
    );
  }
});
