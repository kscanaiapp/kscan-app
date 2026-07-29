// Phase 4 production-path, flag and regression coverage (Build 3, Commit 5).
//
// The suites in Commits 1–4 prove the units. This one proves the things that
// only hold when everything is assembled:
//
//   * the flag is nested, fails closed, and is OFF in every build profile
//   * with Phase 4 OFF the route renders no Phase 4 surface at all
//   * Phase 4 is ADDITIVE — the Phase 3.5 occasion controls are untouched
//   * no Elise state survives process death
//   * nothing about the unversioned callers changed
//
// Static route analysis is used where a renderer would be required, which is the
// established constraint here: this repository has no React test infrastructure,
// and Phase 4 was not authorized to add one.
//
// `.test.js` so scripts/run-all-tests.js discovers it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relativePath) => fs.readFileSync(path.join(ROOT, relativePath), 'utf8');

const ROUTE = read('app/stylist/dressing-room/index.tsx');
const HOOK = read('hooks/usePrivateDressingRoom.ts');
const FLAGS = read('constants/featureFlags.ts');
const UX = read('services/privateDressingRoomEliseUx.ts');
const ORCHESTRATION = read('services/privateDressingRoomEliseOrchestration.ts');

/** Comment-stripped source: these files document what they must not do. */
const code = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

// ── Feature flag ──────────────────────────────────────────────────────────────

test('the Phase 4 flag is nested under both flags it depends on', () => {
  assert.match(
    FLAGS,
    /export const PRIVATE_DRESSING_ROOM_ELISE_ACTIVE\s*=\s*\n?\s*PRIVATE_DRESSING_ROOM_INTERACTIONS_ACTIVE\s*&&\s*PRIVATE_DRESSING_ROOM_ELISE_V1/,
    'Elise must require interactions, which already require the workspace',
  );
  assert.match(
    FLAGS,
    /export const PRIVATE_DRESSING_ROOM_ELISE_V1\s*=\s*\n?\s*process\.env\.EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1 === 'true'/,
    "only the literal string 'true' may enable it",
  );
});

test('the derived flag is the only thing callers read', () => {
  // A caller reading the raw env var, or the un-nested V1 constant, would be
  // able to enable Phase 4 without its parents.
  for (const [name, source] of [
    ['hook', HOOK],
    ['route', ROUTE],
    ['orchestration', ORCHESTRATION],
    ['ux', UX],
  ]) {
    assert.equal(
      code(source).includes('EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1'),
      false,
      `${name} must not read the raw env var`,
    );
    assert.equal(
      /\bPRIVATE_DRESSING_ROOM_ELISE_V1\b/.test(code(source)),
      false,
      `${name} must not read the un-nested flag`,
    );
  }
  assert.match(code(HOOK), /PRIVATE_DRESSING_ROOM_ELISE_ACTIVE/);
});

test('the Phase 4 flag is absent from every build profile', () => {
  const eas = JSON.parse(read('eas.json'));
  for (const [profile, config] of Object.entries(eas.build ?? {})) {
    const env = config.env ?? {};
    assert.equal(
      'EXPO_PUBLIC_PRIVATE_DRESSING_ROOM_ELISE_V1' in env,
      false,
      `${profile} must not carry the Phase 4 flag`,
    );
  }
  // And it is absent from the repository's committed environment entirely.
  assert.equal(
    read('eas.json').includes('PRIVATE_DRESSING_ROOM_ELISE'),
    false,
    'no profile may reference the Phase 4 flag',
  );
});

test('the flag is a parameter everywhere it is enforced, not a module read', () => {
  // Both sides of the gate must be provable, which a module-level constant
  // cannot be. The orchestration layer therefore takes it as a dependency.
  assert.match(code(ORCHESTRATION), /eliseEnabled:\s*boolean/);
  assert.match(code(ORCHESTRATION), /if \(!deps\.eliseEnabled\)/);
  assert.match(code(UX), /eliseEnabled:\s*boolean/);
});

// ── Phase 4 OFF ───────────────────────────────────────────────────────────────

test('every Phase 4 surface in the route is behind the affordance gate', () => {
  // Each Phase 4 element renders only through a value derived from
  // eliseAffordances / eliseStatus, both of which are false / idle when OFF.
  for (const [element, guard] of [
    ['occasion-other-option', /eliseAffordances\.showOccasionEntry \? \(/],
    ['elise-more-casual', /eliseAffordances\.showMakeMoreCasual \? \(/],
    ['elise-status', /\{eliseStatusMessage \? \(/],
  ]) {
    assert.ok(ROUTE.includes(element), `${element} must exist`);
    assert.match(ROUTE, guard, `${element} must be gated`);
  }
  // The sheet is driven by a control that only renders when the gate is open.
  assert.match(ROUTE, /visible=\{occasionSheetOpen\}/);
  assert.match(ROUTE, /setOccasionSheetOpen\(true\)/);
});

test('with Phase 4 OFF the affordance resolver hides everything', () => {
  // The behavioural proof lives in the orchestration suite; this pins that the
  // route asks the resolver rather than deciding for itself.
  assert.match(ROUTE, /resolveEliseAffordances\(\{\s*\n\s*eliseEnabled,/);
  assert.equal(
    code(ROUTE).includes('PRIVATE_DRESSING_ROOM_ELISE_ACTIVE'),
    false,
    'the route must take the flag from the hook, not read it again',
  );
});

// ── Additive: Phase 3.5 preservation ─────────────────────────────────────────

test('the existing occasion chips are unchanged and still governed', () => {
  assert.match(ROUTE, /const OCCASIONS = \['Work', 'Dinner', 'Weekend', 'Event', 'Travel'\]/);
  // Still the same manual behaviour: select sets, re-select clears, through the
  // governed context-change path.
  assert.match(ROUTE, /occasion: selected \? null : occasion,/);
  assert.match(ROUTE, /testID="occasion-option"/);
  // "Other…" is APPENDED: it appears after the chip map closes.
  const mapEnd = ROUTE.indexOf('testID="occasion-option"');
  const other = ROUTE.indexOf('testID="occasion-other-option"');
  assert.ok(mapEnd > 0 && other > mapEnd, 'Other… must come after the existing chips');
  // Both live in the same horizontally-wrapping row, so scrolling is unchanged.
  assert.match(ROUTE, /occasionRow: \{ flexDirection: 'row', flexWrap: 'wrap'/);
});

test('Phase 4 adds no chat surface and no unrestricted Ask Elise entry', () => {
  const routeCode = code(ROUTE);
  for (const forbidden of ['messages', 'conversation', 'chatHistory', 'transcript']) {
    assert.equal(routeCode.includes(forbidden), false, `route must not add ${forbidden}`);
  }
  // The one submit control is inside the bounded occasion sheet, not a free
  // standing assistant entry.
  const submits = routeCode.match(/testID="elise-occasion-submit"/g) ?? [];
  assert.equal(submits.length, 1);
  assert.equal(
    (routeCode.match(/interpretOccasion|askElise/g) ?? []).length > 0,
    true,
    'the entry point exists',
  );
});

test('the status region cannot obscure or intercept the looks', () => {
  const statusIndex = ROUTE.indexOf('testID="elise-status"');
  const outfitsIndex = ROUTE.indexOf('{renderOutfits()}');
  assert.ok(statusIndex > 0 && outfitsIndex > statusIndex, 'status sits above the looks');
  const region = ROUTE.slice(statusIndex - 500, statusIndex);
  assert.match(region, /pointerEvents="none"/, 'the status must not intercept taps');
  assert.match(region, /accessibilityLiveRegion=/, 'the status must be announced');
});

// ── Ephemeral lifecycle ───────────────────────────────────────────────────────

test('no Elise state is persisted, so none can survive process death', () => {
  for (const relativePath of [
    'services/privateDressingRoomEliseProjection.ts',
    'services/privateDressingRoomEliseClient.ts',
    'services/privateDressingRoomEliseOrchestration.ts',
    'services/privateDressingRoomEliseUx.ts',
  ]) {
    const source = code(read(relativePath));
    for (const forbidden of [
      /\bAsyncStorage\b/,
      /\bSecureStore\b/,
      /\bFileSystem\b/,
      /\bsetItem\s*\(/,
      /privateDressingRoomSessionStore/,
      /privateDressingRoomCompositionStore/,
      /privateDressingRoomInteractionStore/,
    ]) {
      assert.doesNotMatch(source, forbidden, `${relativePath} matches ${forbidden}`);
    }
  }
  // The hook holds the coordinator in a ref, so a remount starts a fresh one
  // and no pending request or alias map is restored.
  assert.match(code(HOOK), /useRef\(createEliseRequestCoordinator\(\)\)/);
  assert.match(code(HOOK), /coordinator\.dispose\(\)/);
});

test('the alias map never reaches the interaction record or analytics', () => {
  const orchestrationCode = code(ORCHESTRATION);
  assert.equal(orchestrationCode.includes('aliases'), true, 'it resolves aliases');
  // …but only to compare, never to store: the only writes it performs go through
  // requestContextChange, which takes an occasion or a Closet id, never an alias.
  assert.match(orchestrationCode, /requestContextChange\(\{\s*kind: 'occasion', occasion/);
  assert.match(orchestrationCode, /kind: 'anchor',\s*\n?\s*anchorClosetItemId: input\.anchorClosetItemId,/);
  assert.equal(orchestrationCode.includes('analytics'), false);
  assert.equal(orchestrationCode.includes('track('), false);
});

// ── Backward compatibility, client side ───────────────────────────────────────

test('the existing unversioned style-outfit client is untouched by Phase 4', () => {
  const styleOutfits = read('services/styleOutfits.ts');
  // Still the same function, the same contract version, the same flags.
  assert.match(styleOutfits, /export const STYLE_OUTFIT_FUNCTION_NAME = 'style-outfit-generate'/);
  assert.match(styleOutfits, /contractVersion: FASHION_REASONING_CONTRACT_VERSION/);
  assert.match(styleOutfits, /AI_STYLIST_UI_ENABLED \|\| !AI_STYLIST_BACKEND_ENABLED/);
  // And it knows nothing about Phase 4.
  const styleOutfitsCode = code(styleOutfits);
  assert.equal(styleOutfitsCode.includes('schemaVersion'), false);
  assert.equal(styleOutfitsCode.includes('privateDressingRoom'), false);
});

test('the Phase 4 client targets the same function without disturbing the old one', () => {
  const client = read('services/privateDressingRoomEliseClient.ts');
  assert.match(client, /export const ELISE_FUNCTION_NAME = 'style-outfit-generate'/);
  // It sends schemaVersion and never a legacy `mode`, so the two request shapes
  // cannot be confused by the function's dispatch.
  const clientCode = code(client);
  assert.equal(clientCode.includes("mode:"), false);
  assert.equal(clientCode.includes('contractVersion'), false);
});

test('Phase 4 reuses the established invoke budget rather than inventing one', () => {
  const client = read('services/privateDressingRoomEliseClient.ts');
  assert.match(client, /export const ELISE_INVOKE_TIMEOUT_MS = 20_000/);
  assert.match(read('services/scanIdentification.ts'), /INVOKE_TIMEOUT_MS = 20_000/);
  // Same abort wiring as the established caller, including the already-aborted
  // case that addEventListener would silently drop.
  assert.match(client, /if \(external\.aborted\) controller\.abort\(\);/);
});

// ── Domain constraints ────────────────────────────────────────────────────────

test('Elise stays fashion-scoped and retailer-neutral', () => {
  const surfaces = [ORCHESTRATION, UX, read('services/privateDressingRoomEliseProjection.ts')];
  for (const source of surfaces) {
    const surfaceCode = code(source);
    for (const forbidden of [
      'amazon',
      'affiliate',
      'retailer',
      'checkout',
      'price',
      'purchase',
      'merchant',
    ]) {
      assert.equal(
        surfaceCode.toLowerCase().includes(forbidden),
        false,
        `Phase 4 must stay retailer-neutral: ${forbidden}`,
      );
    }
  }
});

test('the composition is always produced by the deterministic composer', () => {
  const orchestrationCode = code(ORCHESTRATION);
  // Elise never composes: there is no composer call here at all, because the
  // only way a look is built is through the governed context change.
  assert.equal(orchestrationCode.includes('composePrivateOutfits'), false);
  assert.equal(orchestrationCode.includes('rankSlotCandidates'), false);
  // And no response field can carry a finished look into the app.
  const contract = read('types/privateDressingRoomElise.ts');
  assert.equal(code(contract).includes('looks'), false);
  assert.equal(code(contract).includes('outfits'), false);
});
