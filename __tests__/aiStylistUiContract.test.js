// AI Stylist UI/state contract tests (manual builder + stylist flows).
// Static screen checks plus VM-sandboxed unit tests of the styleOutfits
// client service (gates, cooldown, in-flight guard, payload validation).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

const builderScreen = fs.readFileSync(path.join(ROOT, 'app', 'looks', 'create.tsx'), 'utf8');
const looksIndex = fs.readFileSync(path.join(ROOT, 'app', 'looks', 'index.tsx'), 'utf8');
const lookDetail = fs.readFileSync(path.join(ROOT, 'app', 'looks', '[id].tsx'), 'utf8');
const stylistScreen = fs.readFileSync(path.join(ROOT, 'app', 'stylist', 'index.tsx'), 'utf8');
const libraryScreen = fs.readFileSync(path.join(ROOT, 'app', 'library.tsx'), 'utf8');
const askRoomModal = fs.readFileSync(
  path.join(ROOT, 'components', 'looks', 'AskMyRoomModal.tsx'),
  'utf8',
);
const flags = fs.readFileSync(path.join(ROOT, 'constants', 'featureFlags.ts'), 'utf8');

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    Date,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (specifier in requireMap) return requireMap[specifier];
      throw new Error(`Unexpected import in ${relativePath}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return mod.exports;
}

const reasoning = loadTsModule('types/fashionReasoning.ts');

function loadStyleOutfits({ uiEnabled, backendEnabled, invoke }) {
  return loadTsModule('services/styleOutfits.ts', {
    './supabaseClient': { supabase: { functions: { invoke } } },
    '../constants/featureFlags': {
      AI_STYLIST_UI_ENABLED: uiEnabled,
      AI_STYLIST_BACKEND_ENABLED: backendEnabled,
    },
    '../types/fashionReasoning': reasoning,
    '../types/ownedClosetItem': {},
  });
}

// ── Manual builder (static) ──────────────────────────────────────────────────

test('My Looks empty state uses the required copy and CREATE A LOOK action', () => {
  assert.match(looksIndex, /Build outfits from the pieces you already own\./);
  assert.match(looksIndex, /CREATE A LOOK/);
  assert.match(looksIndex, /\/looks\/create/);
});

test('builder shows selection count, blocks above six, disables save below two', () => {
  assert.match(builderScreen, /\$\{selectedItems\.length\} selected/);
  assert.match(builderScreen, /current\.length >= LOOK_MAX_ITEMS\) return current/);
  assert.match(builderScreen, /selectedItems\.length >= LOOK_MIN_ITEMS/);
  assert.match(builderScreen, /disabled=\{!canSave\}/);
});

test('builder prevents duplicate selection via keyed set semantics', () => {
  assert.match(builderScreen, /current\.includes\(key\)\) return current\.filter/);
});

test('builder preview supports remove and clear move controls (no drag-drop dependency)', () => {
  assert.match(builderScreen, /moveSelected\(index, -1\)/);
  assert.match(builderScreen, /moveSelected\(index, 1\)/);
  assert.match(builderScreen, /onRemove/);
  assert.doesNotMatch(builderScreen, /react-native-draggable|DraxProvider|reanimated-drag/);
});

test('builder save has an in-flight guard, preserves the draft on error, blocks back-nav while saving', () => {
  assert.match(builderScreen, /if \(savingRef\.current\) return/);
  assert.match(builderScreen, /Draft state \(selection, title, context\) is intentionally preserved/);
  assert.match(builderScreen, /onBack=\{saving \? undefined : \(\) => router\.back\(\)\}/);
  assert.match(builderScreen, /router\.replace\(`\/looks\/\$\{saved\.id\}`\)/);
});

test('builder syncs local-only scans through the existing cloud path before persistence', () => {
  assert.match(builderScreen, /ensureRemoteBackedOwnedItem/);
  assert.match(builderScreen, /OwnedItemSyncError/);
});

test('look detail shows why-it-works for AI looks, Ask My Room, Style Again, and closet-safe delete copy', () => {
  assert.match(lookDetail, /WHY IT WORKS/);
  assert.match(lookDetail, /look\?\.source === 'ai' && look\.explanation/);
  assert.match(lookDetail, /Ask My Room/);
  assert.match(lookDetail, /Style Again/);
  assert.match(lookDetail, /Delete this Look\?/);
  assert.match(lookDetail, /The items in your closet will not be affected\./);
});

test('library provides restrained MY CLOSET | MY LOOKS sub-navigation without a new tab bar', () => {
  assert.match(libraryScreen, /MY CLOSET/);
  assert.match(libraryScreen, /MY LOOKS/);
  assert.match(libraryScreen, /router\.push\('\/looks'\)/);
  assert.doesNotMatch(libraryScreen, /createBottomTabNavigator|Tabs\.Screen/);
});

// ── Stylist screen (static) ──────────────────────────────────────────────────

test('stylist screen renders result cards with variation label, why-it-works, and required actions', () => {
  assert.match(stylistScreen, /VARIATION_LABELS/);
  assert.match(stylistScreen, /WHY IT WORKS/);
  assert.match(stylistScreen, /Not for Me/);
  assert.match(stylistScreen, /Save Look/);
  assert.match(stylistScreen, /Ask My Room/);
  assert.match(stylistScreen, /SWAP/);
});

test('stylist generate has a rapid-tap guard and a loading state', () => {
  assert.match(stylistScreen, /if \(generatingRef\.current \|\| isGenerationInFlight\(\)\) return/);
  assert.match(stylistScreen, /ELISE_LOADING_COPY\.stylingFromCloset/);
});

test('swap flow offers swap-in, keep-and-restyle, and per-request exclusion', () => {
  assert.match(stylistScreen, /Keep this item, restyle the rest/);
  assert.match(stylistScreen, /Don't use this item/);
  assert.match(stylistScreen, /applyLocalSwap/);
  assert.match(stylistScreen, /never a permanent global rule/i);
});

test('rejection reasons match the compact contract and record events', () => {
  const memory = fs.readFileSync(path.join(ROOT, 'services', 'styleMemoryEvents.ts'), 'utf8');
  for (const label of ['Too formal', 'Too casual', 'Not my style', 'Wrong colors', 'Not practical', 'Do not use this item']) {
    assert.ok(memory.includes(label), `missing rejection label: ${label}`);
  }
  assert.match(stylistScreen, /ai_suggestion_rejected|handleReject/);
});

test('stylist keeps the manual builder reachable and preserves anchor/context on failure', () => {
  assert.match(stylistScreen, /Build My Own/);
  assert.match(stylistScreen, /router\.push\('\/looks\/create'\)/);
  // Failure states render inline (anchor/occasion/note state stays intact);
  // the only anchor clears are the explicit user actions.
  assert.match(stylistScreen, /result && result\.status !== 'success' \? \(\s*<InlineNotice/);
  const anchorClears = stylistScreen.match(/setAnchorKey\(null\)/g) ?? [];
  assert.equal(anchorClears.length, 2, 'anchor clears only on explicit remove/exclude actions');
});

test('multi-option room share preserves canonical order and uses saved AI Looks', () => {
  assert.match(stylistScreen, /handleAskRoomAll/);
  assert.match(stylistScreen, /suggestions\.slice\(0, 3\)/);
  assert.match(stylistScreen, /saveSuggestionAsLook/);
  assert.match(askRoomModal, /shareLooksToRoom/);
});

test('AI suggestion save is idempotent per suggestion during rapid taps', () => {
  assert.match(stylistScreen, /savedLookIdBySuggestionRef = useRef<Record<string, string>>\(\{\}\)/);
  assert.match(stylistScreen, /savingSuggestionIdsRef = useRef\(new Set<string>\(\)\)/);
  assert.match(stylistScreen, /savingSuggestionIdsRef\.current\.has\(suggestion\.suggestionId\)/);
  assert.match(stylistScreen, /savingSuggestionIdsRef\.current\.add\(suggestion\.suggestionId\)/);
  assert.match(stylistScreen, /savedLookIdBySuggestionRef\.current = \{/);
  assert.match(stylistScreen, /savingSuggestionIdsRef\.current\.delete\(suggestion\.suggestionId\)/);
});

test('feature gates: aiStylist non-core key exists and screens check gates before AI use', () => {
  assert.match(flags, /'aiStylist',/);
  assert.match(flags, /AI_STYLIST_UI_ENABLED/);
  assert.match(flags, /AI_STYLIST_BACKEND_ENABLED/);
  assert.match(flags, /'outfitRemixLooks',/); // not removed or renamed
  assert.match(stylistScreen, /!AI_STYLIST_UI_ENABLED \|\| !isFeatureEnabled\('aiStylist'\)/);
  assert.match(builderScreen, /!AI_STYLIST_UI_ENABLED \|\| !isFeatureEnabled\('aiStylist'\)/);
});

// ── styleOutfits service (unit) ──────────────────────────────────────────────

test('gate off → unavailable fallback without invoking the function', async () => {
  let invoked = 0;
  const service = loadStyleOutfits({
    uiEnabled: false,
    backendEnabled: false,
    invoke: async () => {
      invoked += 1;
      return { data: {}, error: null };
    },
  });
  const result = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(result.status, 'unavailable');
  assert.match(result.message, /Elise isn't available right now/);
  assert.equal(invoked, 0);
});

test('unavailable service starts a ~30s cooldown that blocks immediate retries', async () => {
  let invoked = 0;
  const service = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => {
      invoked += 1;
      return { data: null, error: new Error('FunctionsFetchError: 404') };
    },
  });
  const first = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(first.status, 'unavailable');
  assert.equal(invoked, 1);
  assert.equal(service.isInUnavailableCooldown(), true);
  assert.equal(service.UNAVAILABLE_COOLDOWN_MS, 30000);

  const second = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(second.status, 'unavailable');
  assert.equal(invoked, 1, 'cooldown must prevent endpoint hammering');
});

test('invalid server payload becomes a safe unavailable result (no crash)', async () => {
  const service = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => ({ data: { status: '???', outfits: 'garbage' }, error: null }),
  });
  const result = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(result.status, 'unavailable');
});

test('quota and burst responses map to safe typed results', async () => {
  const quotaService = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => ({ data: { status: 'quota_exceeded' }, error: null }),
  });
  const quota = await quotaService.generateOutfits({ mode: 'style_event' });
  assert.equal(quota.status, 'quota_exceeded');

  const burstService = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => ({ data: { status: 'burst_limit', retryAfterSeconds: 42 }, error: null }),
  });
  const burst = await burstService.generateOutfits({ mode: 'style_event' });
  assert.equal(burst.status, 'burst_limit');
  assert.equal(burst.retryAfterSeconds, 42);
});

test('success payload is validated: bad refs dropped, canonical variation order kept', async () => {
  const A = '11111111-1111-4111-8111-111111111111';
  const B = '22222222-2222-4222-8222-222222222222';
  const service = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => ({
      data: {
        status: 'success',
        requestId: 'req-1',
        outfits: [
          {
            suggestionId: 's2',
            variation: 'elevated',
            itemRefs: [
              { sourceType: 'saved_scan', sourceId: A, role: 'top' },
              { sourceType: 'saved_scan', sourceId: B, role: 'shoes' },
            ],
            reason: 'Polished.',
            confidence: 'high',
          },
          {
            suggestionId: 's1',
            variation: 'reliable',
            itemRefs: [
              { sourceType: 'saved_scan', sourceId: A, role: 'top' },
              { sourceType: 'saved_scan', sourceId: B, role: 'shoes' },
            ],
            reason: 'Dependable.',
            confidence: 'high',
          },
          {
            suggestionId: 'bad',
            variation: 'something_different',
            itemRefs: [{ sourceType: 'product_match', sourceId: 'retail-1' }],
            reason: 'nope',
          },
        ],
      },
      error: null,
    }),
  });
  const result = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(result.status, 'success');
  assert.equal(result.outfits.length, 2);
  assert.equal(
    JSON.stringify(Array.from(result.outfits, (outfit) => outfit.variation)),
    JSON.stringify(['reliable', 'elevated']),
  );
});

test('kill-switch (disabled) response is safe and enters cooldown', async () => {
  const service = loadStyleOutfits({
    uiEnabled: true,
    backendEnabled: true,
    invoke: async () => ({ data: { status: 'disabled' }, error: null }),
  });
  const result = await service.generateOutfits({ mode: 'style_event' });
  assert.equal(result.status, 'unavailable');
  assert.equal(service.isInUnavailableCooldown(), true);
});

test('StyleChat bridge: occasion matcher is conservative', () => {
  assert.equal(reasoning.matchOccasionFromText('I have a wedding on Saturday'), 'event');
  assert.equal(reasoning.matchOccasionFromText('big interview tomorrow'), 'work');
  assert.equal(reasoning.matchOccasionFromText('packing for a trip'), 'travel');
  assert.equal(reasoning.matchOccasionFromText('what pairs with my blue jeans?'), null);
  assert.equal(reasoning.matchOccasionFromText(''), null);
});
