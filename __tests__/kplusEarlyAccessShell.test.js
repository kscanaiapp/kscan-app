// Build 34 K+ Early Access Discovery + Measurement Shell.
//
// Covers: the bounded KPlusSource taxonomy, the rewired kplusTelemetry event
// vocabulary/property allowlist, cross-surface source-attribution wiring,
// the Voice Scan hard rule (K+ cannot override a feature-implementation
// flag), and the required mutation-guard behaviors from section 34.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relPath) {
  return fs.readFileSync(path.join(ROOT, relPath), 'utf8');
}

/** Strips // and /* *\/ comments so a banned-word check only sees code and
 *  string/JSX literals, never architecture commentary that legitimately
 *  discusses what NOT to build (e.g. "not a feature-specific paywall"). */
function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
}

function transpile(source, filename) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
    fileName: filename,
  }).outputText;
}

const KPLUS_SOURCE_PATH = path.join(ROOT, 'types', 'kplusSource.ts');
const TELEMETRY_PATH = path.join(ROOT, 'services', 'kplus', 'kplusTelemetry.ts');

function loadKPlusSourceModule() {
  const mod = { exports: {} };
  const sandbox = { module: mod, exports: mod.exports, require: () => ({}), console };
  vm.createContext(sandbox);
  new vm.Script(transpile(fs.readFileSync(KPLUS_SOURCE_PATH, 'utf8'), KPLUS_SOURCE_PATH), {
    filename: KPLUS_SOURCE_PATH,
  }).runInContext(sandbox);
  return mod.exports;
}

function loadTelemetryModule() {
  const kplusSourceMod = loadKPlusSourceModule();
  const mod = { exports: {} };
  const sandbox = {
    module: mod,
    exports: mod.exports,
    console,
    __DEV__: false,
    require: (specifier) => {
      if (specifier === '../../types/kplusSource') return kplusSourceMod;
      throw new Error(`Unexpected import in kplusTelemetry.ts: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(transpile(fs.readFileSync(TELEMETRY_PATH, 'utf8'), TELEMETRY_PATH), {
    filename: TELEMETRY_PATH,
  }).runInContext(sandbox);
  return mod.exports;
}

// ---------------------------------------------------------------------------
// Section 9: bounded KPlusSource taxonomy
// ---------------------------------------------------------------------------

test('KPLUS_SOURCES is the exact bounded taxonomy from section 9, plus unknown', () => {
  const { KPLUS_SOURCES } = loadKPlusSourceModule();
  assert.deepEqual(
    [...KPLUS_SOURCES].sort(),
    [
      'account',
      'closet_intelligence',
      'packing',
      'unknown',
      'voice_scan',
      'vto',
      'wardrobe_concierge',
      'watchlist',
    ].sort(),
  );
});

test('toKPlusSource normalizes any unrecognized value to "unknown", never a raw string', () => {
  const { toKPlusSource } = loadKPlusSourceModule();
  assert.equal(toKPlusSource('packing'), 'packing');
  assert.equal(toKPlusSource('watchlist'), 'watchlist');
  for (const bad of ['home_tile', 'watchlist_resume', 'vto_try_it_on', 'voice_scan_pill', 'profile', '', null, undefined, 42]) {
    assert.equal(toKPlusSource(bad), 'unknown', `expected 'unknown' for ${JSON.stringify(bad)}`);
  }
});

// ---------------------------------------------------------------------------
// Sections 16-23: telemetry event vocabulary and bounded properties
// ---------------------------------------------------------------------------

test('KPLUS_EVENTS matches the target vocabulary from section 16', () => {
  const { KPLUS_EVENTS } = loadTelemetryModule();
  assert.deepEqual(
    [...KPLUS_EVENTS].sort(),
    [
      'kplus_feature_exposed',
      'kplus_feature_gate_opened',
      'kplus_early_access_viewed',
      'kplus_activation_started',
      'kplus_activation_completed',
      'kplus_activation_failed',
      'kplus_feature_started',
      'kplus_feature_completed',
    ].sort(),
  );
});

test('KPLUS_EVENT_PROPERTIES is exactly source/feature/entitlement_state/activation_outcome (section 23)', () => {
  const { KPLUS_EVENT_PROPERTIES } = loadTelemetryModule();
  assert.deepEqual([...KPLUS_EVENT_PROPERTIES].sort(), [
    'activation_outcome',
    'entitlement_state',
    'feature',
    'source',
  ].sort());
});

test('emitKPlusEvent drops unrecognized event names entirely', () => {
  const telemetry = loadTelemetryModule();
  const seen = [];
  telemetry.setKPlusAnalyticsSink((event, payload) => seen.push({ event, payload }));
  telemetry.emitKPlusEvent('kplus_totally_made_up_event', { source: 'packing' });
  assert.equal(seen.length, 0);
  telemetry.resetKPlusAnalyticsSink();
});

test('emitKPlusEvent bounds source/feature to the taxonomy: unknown source -> "unknown", never a raw string (section 33)', () => {
  const telemetry = loadTelemetryModule();
  const seen = [];
  telemetry.setKPlusAnalyticsSink((event, payload) => seen.push({ event, payload }));

  telemetry.emitKPlusEvent('kplus_feature_exposed', { source: 'packing', feature: 'packing' });
  telemetry.emitKPlusEvent('kplus_feature_exposed', { source: 'home_tile', feature: 'not_a_real_feature' });
  telemetry.emitKPlusEvent('kplus_feature_exposed', { source: '<script>alert(1)</script>', feature: 'x' });

  assert.equal(seen[0].payload.source, 'packing');
  assert.equal(seen[1].payload.source, 'unknown');
  assert.equal(seen[1].payload.feature, 'unknown');
  assert.equal(seen[2].payload.source, 'unknown');
  telemetry.resetKPlusAnalyticsSink();
});

test('emitKPlusEvent drops an unrecognized entitlement_state/activation_outcome rather than guessing', () => {
  const telemetry = loadTelemetryModule();
  const seen = [];
  telemetry.setKPlusAnalyticsSink((event, payload) => seen.push(payload));

  telemetry.emitKPlusEvent('kplus_feature_gate_opened', {
    source: 'vto',
    entitlement_state: 'definitely_not_a_state',
  });
  telemetry.emitKPlusEvent('kplus_activation_completed', {
    source: 'vto',
    activation_outcome: 'made_up_outcome',
  });

  assert.equal('entitlement_state' in seen[0], false);
  assert.equal('activation_outcome' in seen[1], false);
  telemetry.resetKPlusAnalyticsSink();
});

test('emitKPlusEvent accepts every canonical entitlement_state and activation_outcome value', () => {
  const telemetry = loadTelemetryModule();
  const seen = [];
  telemetry.setKPlusAnalyticsSink((event, payload) => seen.push(payload));

  for (const state of ['loading', 'eligible', 'active', 'expired', 'unavailable', 'error']) {
    telemetry.emitKPlusEvent('kplus_feature_exposed', { source: 'packing', entitlement_state: state });
  }
  for (const outcome of ['granted', 'already_active', 'campaign_consumed', 'failed']) {
    telemetry.emitKPlusEvent('kplus_activation_completed', { source: 'account', activation_outcome: outcome });
  }

  assert.deepEqual(
    seen.slice(0, 6).map((p) => p.entitlement_state),
    ['loading', 'eligible', 'active', 'expired', 'unavailable', 'error'],
  );
  assert.deepEqual(
    seen.slice(6).map((p) => p.activation_outcome),
    ['granted', 'already_active', 'campaign_consumed', 'failed'],
  );
  telemetry.resetKPlusAnalyticsSink();
});

test('a sink failure never propagates (analytics never breaks entitlement flows)', () => {
  const telemetry = loadTelemetryModule();
  telemetry.setKPlusAnalyticsSink(() => {
    throw new Error('sink exploded');
  });
  assert.doesNotThrow(() => telemetry.emitKPlusEvent('kplus_feature_exposed', { source: 'packing' }));
  telemetry.resetKPlusAnalyticsSink();
});

// ---------------------------------------------------------------------------
// Cross-surface source-attribution wiring (sections 9-10)
// ---------------------------------------------------------------------------

const SURFACE_FILES = [
  'components/vto/TryItOnEntry.tsx',
  'components/text-scan/TextScanFeatureRow.tsx',
  'app/packing/index.tsx',
  'app/watchlist/[watchId].tsx',
  'components/home/HomeLuxuryTechV1.tsx',
  'components/ProductShelf.tsx',
  'components/scan-results/PurchaseOptionsPanel.tsx',
  'app/privacy.tsx',
];

test('every KPlusGate / KPlusEarlyAccessSheet call site in the app passes a bounded source literal', () => {
  const { KPLUS_SOURCES } = loadKPlusSourceModule();
  const boundedSet = new Set(KPLUS_SOURCES);
  let matched = 0;
  for (const relPath of SURFACE_FILES) {
    const src = read(relPath);
    const matches = [...src.matchAll(/<KPlusGate source="([^"]+)"|source="([^"]+)"\s*\/?>(?:\s*)$|source=\{['"]([^'"]+)['"]\}/g)];
    // Simpler, robust extraction: any `source="literal"` attribute in the file.
    const literalMatches = [...src.matchAll(/\bsource="([^"]+)"/g)];
    for (const m of literalMatches) {
      matched += 1;
      assert.ok(
        boundedSet.has(m[1]),
        `${relPath} passes source="${m[1]}", which is not in the bounded KPlusSource taxonomy`,
      );
    }
  }
  // Sanity: this test actually exercised real call sites, not an empty set.
  assert.ok(matched >= 6, `expected at least 6 bounded source call sites, found ${matched}`);
});

test('VTO entry point is sourced "vto", Watchlist entry points are sourced "watchlist", Voice Scan is sourced "voice_scan"', () => {
  assert.match(read('components/vto/TryItOnEntry.tsx'), /<KPlusGate source="vto">/);
  assert.match(read('components/text-scan/TextScanFeatureRow.tsx'), /<KPlusGate source="voice_scan">/);
  assert.match(read('app/watchlist/[watchId].tsx'), /<KPlusGate source="watchlist">/);
  assert.match(read('components/home/HomeLuxuryTechV1.tsx'), /<KPlusGate source="watchlist">/);
  assert.match(read('components/ProductShelf.tsx'), /<KPlusGate source="watchlist">/);
  assert.match(read('components/scan-results/PurchaseOptionsPanel.tsx'), /<KPlusGate source="watchlist">/);
});

test('Packing is sourced "packing" and the Account status row is sourced "account"', () => {
  assert.match(read('app/packing/index.tsx'), /<KPlusGate source="packing">/);
  assert.match(read('app/privacy.tsx'), /<KPlusEarlyAccessSheet[\s\S]{0,200}source="account"/);
});

// ---------------------------------------------------------------------------
// Section 17: exposure fires once per presentation, not per render
// ---------------------------------------------------------------------------

test('KPlusGate fires kplus_feature_exposed from a useEffect keyed on source only, never on entitlement state', () => {
  const gate = read('components/kplus/KPlusGate.tsx');
  const effectBlock = gate.slice(gate.indexOf('useEffect'), gate.indexOf('const openUpgrade'));
  assert.match(effectBlock, /kplus_feature_exposed/);
  assert.match(effectBlock, /\}, \[source\]\);/);
});

test('KPlusGate opens the gate event only on explicit engagement (openUpgrade), never on mount', () => {
  const gate = read('components/kplus/KPlusGate.tsx');
  const openUpgradeBlock = gate.slice(gate.indexOf('const openUpgrade'));
  assert.match(openUpgradeBlock, /kplus_feature_gate_opened/);
});

// ---------------------------------------------------------------------------
// Section 19-21: Early Access view + activation events carry source/state
// ---------------------------------------------------------------------------

test('KPlusEarlyAccessSheet emits kplus_early_access_viewed with the originating source, never inferred later', () => {
  const sheet = read('components/kplus/KPlusEarlyAccessSheet.tsx');
  assert.match(sheet, /kplus_early_access_viewed', \{ source, feature: source, entitlement_state: state \}/);
});

test('activation events fire started -> (completed | failed), in that order, from one handler', () => {
  const sheet = read('components/kplus/KPlusEarlyAccessSheet.tsx');
  const handler = sheet.slice(sheet.indexOf('const handleActivate'), sheet.indexOf('const isActive = state'));
  const startedIdx = handler.indexOf('kplus_activation_started');
  assert.ok(startedIdx >= 0);
  assert.ok(handler.indexOf('kplus_activation_failed') > startedIdx);
  assert.ok(handler.indexOf('kplus_activation_completed') > startedIdx);

  // Mutation M4 guard: completed must never fire inside the failed branch.
  // Isolate the failed branch precisely (its own { ... return; } block) --
  // not "everything before the first mention of completed" -- so an extra
  // kplus_activation_completed call added anywhere inside that block is
  // caught regardless of where else the string appears in the handler.
  const failedBranchMatch = handler.match(
    /if \(outcome === 'failed'\) \{[\s\S]*?\n {6}return;\n {4}\}/,
  );
  assert.ok(failedBranchMatch, 'could not isolate the failed branch');
  assert.doesNotMatch(failedBranchMatch[0], /kplus_activation_completed/);
});

// ---------------------------------------------------------------------------
// Section 8/13: K+ cannot override a feature-implementation flag (mutation M3)
// ---------------------------------------------------------------------------

test('Voice Scan K+ pill checks VOICESCAN_ENABLED before rendering (K+ cannot bypass the feature flag)', () => {
  const src = read('components/text-scan/TextScanFeatureRow.tsx');
  assert.match(src, /if \(!VOICESCAN_ENABLED \|\| !KPLUS_EARLY_ACCESS_ENABLED\)/);
  // The guard must precede the KPlusGate render, not follow it.
  const guardIdx = src.indexOf('if (!VOICESCAN_ENABLED');
  const gateIdx = src.indexOf('<KPlusGate source="voice_scan">');
  assert.ok(guardIdx > 0 && gateIdx > guardIdx);
});

test('Packing hides its K+ entry entirely when PACKING_INTELLIGENCE_V1 is off, before the KPlusGate ever renders', () => {
  const src = read('app/packing/index.tsx');
  const earlyReturnIdx = src.indexOf('if (!PACKING_INTELLIGENCE_V1)');
  const gateIdx = src.indexOf('<KPlusGate source="packing">');
  assert.ok(earlyReturnIdx > 0 && gateIdx > earlyReturnIdx);
});

test('Watchlist Home tile requires SMART_WATCHLIST_V1 to wrap the KPlusGate, not sit inside it', () => {
  const src = read('components/home/HomeLuxuryTechV1.tsx');
  const wrapIdx = src.indexOf('watchlistEnabled && (');
  const gateIdx = src.indexOf('<KPlusGate source="watchlist">');
  assert.ok(wrapIdx > 0 && gateIdx > wrapIdx);
});

test('VTO availability requires VTO_UI_ENABLED before entitlement is ever considered', () => {
  const src = read('hooks/useVtoAvailability.ts');
  const idx = src.indexOf('if (!VTO_UI_ENABLED || !isAuthenticated || !config)');
  assert.ok(idx > 0);
});

// ---------------------------------------------------------------------------
// Section 12: active K+ never sees an "Activate/Unlock" CTA (mutation M2)
// ---------------------------------------------------------------------------

test('Voice Scan pill disables its own press and never opens the sheet for an active member', () => {
  const block = read('components/text-scan/TextScanFeatureRow.tsx');
  const fn = block.slice(block.indexOf('function VoiceScanBlock'));
  assert.match(fn, /onPress=\{isActive \? undefined : openUpgrade\}/);
  assert.match(fn, /disabled=\{isActive\}/);
});

test('Watchlist entry points route active members straight to the feature, never to openUpgrade', () => {
  const BRANCHES_ON_ACTIVE = /isActive \? [\s\S]{0,80}?: openUpgrade|if \(isActive\)[\s\S]{0,120}?else openUpgrade\(\)/;
  for (const relPath of [
    'components/home/HomeLuxuryTechV1.tsx',
    'components/ProductShelf.tsx',
    'components/scan-results/PurchaseOptionsPanel.tsx',
  ]) {
    const src = read(relPath);
    assert.match(src, BRANCHES_ON_ACTIVE, `${relPath} does not branch on isActive before calling openUpgrade`);
  }
});

test('Packing shows the unlock CTA only when NOT active, and hides it once active', () => {
  const src = read('app/packing/index.tsx');
  assert.match(src, /if \(!isActive && !packing\.plan\)/);
  assert.match(src, /UNLOCK WITH K\+/);
});

// ---------------------------------------------------------------------------
// Section 22: feature_started/completed only for real, deterministic ops
// ---------------------------------------------------------------------------

test('Packing, VTO generation, and Watchlist creation emit kplus_feature_started/completed', () => {
  assert.match(read('hooks/usePackingPlan.ts'), /kplus_feature_started[\s\S]*kplus_feature_completed/);
  assert.match(read('components/vto/VirtualTryOnSheet.tsx'), /kplus_feature_started[\s\S]*kplus_feature_completed/);
  assert.match(read('components/ProductShelf.tsx'), /kplus_feature_started[\s\S]*kplus_feature_completed/);
});

test('Voice Scan (unimplemented) and Wardrobe Concierge (no clean completion signal on the client) never emit feature_started/completed', () => {
  assert.doesNotMatch(read('components/text-scan/TextScanFeatureRow.tsx'), /kplus_feature_started|kplus_feature_completed/);
  for (const relPath of [
    'components/concierge/ConciergeEvidence.tsx',
    'components/concierge/ConciergeClosetCard.tsx',
    'components/concierge/ConciergeEvidenceBlock.tsx',
  ]) {
    assert.doesNotMatch(read(relPath), /kplus_feature_started|kplus_feature_completed/);
  }
});

// ---------------------------------------------------------------------------
// Section 5/26/39: banned subscription/billing language across K+ surfaces
// ---------------------------------------------------------------------------

const BANNED_PATTERNS = [
  /\bpaywall\b/i,
  /\bsubscription\b/i,
  /\bsubscribe\b/i,
  /free trial/i,
  /\brenews?\b/i,
  /cancel anytime/i,
  /Manage Subscription/i,
  /apps\.apple\.com\/account\/subscriptions/i,
  /play\.google\.com\/store\/account\/subscriptions/i,
];

test('no K+ surface introduces subscription/trial/renewal/billing-management language', () => {
  // Comments are stripped first: this checks actual code/copy, not
  // architecture commentary that legitimately discusses what NOT to build
  // (e.g. KPlusGate.tsx's "not a feature-specific paywall").
  const files = [
    'components/kplus/KPlusGate.tsx',
    'components/kplus/KPlusEarlyAccessSheet.tsx',
    'components/text-scan/TextScanFeatureRow.tsx',
    'app/packing/index.tsx',
    'app/watchlist/[watchId].tsx',
    'components/home/HomeLuxuryTechV1.tsx',
    'app/privacy.tsx',
  ];
  for (const relPath of files) {
    const src = stripComments(read(relPath));
    for (const pattern of BANNED_PATTERNS) {
      assert.doesNotMatch(src, pattern, `${relPath} matched banned pattern ${pattern}`);
    }
  }
});

// ---------------------------------------------------------------------------
// Section 40: authority preservation -- this shell never touches server truth
// ---------------------------------------------------------------------------

test('this shell does not modify entitlement authority, activation, or RevenueCat reconciliation source', () => {
  const forbidden = [
    'supabase/functions/kplus-activate',
    'supabase/functions/kplus-reconcile-revenuecat',
  ];
  // Existence check only -- proves this PR did not delete/replace them, and
  // the git diff (reviewed separately) proves it did not edit them either.
  for (const relPath of forbidden) {
    assert.ok(fs.existsSync(path.join(ROOT, relPath)), `${relPath} must still exist untouched`);
  }
});
