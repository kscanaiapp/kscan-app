// Build 5 Phase 2 — Home mount, kill switch, and render containment.
//
// SOURCE-LEVEL, deliberately. This repository runs `node --test` with no React
// renderer, so the guarantees that matter here — "the flag gate returns before
// any hook", "Home still contains every pre-Build-5 section", "the boundary is
// a class component with getDerivedStateFromError" — are proved against the
// actual source text and the transpiled flag resolver, which is exactly how the
// existing homeEliseIntegration suite proves the same class of invariant.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(...parts) {
  return fs.readFileSync(path.join(ROOT, ...parts), 'utf8');
}

function loadTsModule(relPath, env = {}) {
  const full = path.join(ROOT, relPath);
  const mod = { exports: {} };
  const source = ts.transpileModule(fs.readFileSync(full, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  vm.runInNewContext(
    source,
    {
      module: mod,
      exports: mod.exports,
      require: (r) => require(r),
      console,
      Object,
      Array,
      Map,
      Set,
      Number,
      String,
      JSON,
      process: { env },
      __DEV__: false,
    },
    { filename: full },
  );
  return mod.exports;
}

const home = read('components', 'home', 'HomeLuxuryTechV1.tsx');
const section = read('components', 'home', 'TodayWithEliseSection.tsx');
const boundary = read('components', 'home', 'TodayWithEliseBoundary.tsx');
const card = read('components', 'home', 'TodayWithEliseCard.tsx');

// ── Feature flag resolution ──────────────────────────────────────────────────

test('only the exact string "true" enables Today with Elise', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {});
  assert.equal(flags.resolveTodayWithEliseV1Enabled('true'), true);
  assert.equal(flags.resolveTodayWithEliseV1Enabled('false'), false);
  assert.equal(flags.resolveTodayWithEliseV1Enabled(undefined), false);
  assert.equal(flags.resolveTodayWithEliseV1Enabled(''), false);
});

test('malformed flag values behave as OFF', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {});
  for (const malformed of ['TRUE', 'True', '1', 'yes', 'on', ' true', 'true ', 'null']) {
    assert.equal(
      flags.resolveTodayWithEliseV1Enabled(malformed),
      false,
      `expected ${JSON.stringify(malformed)} to fail closed`,
    );
  }
});

test('an absent environment variable resolves the constant to OFF', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {});
  assert.equal(flags.TODAY_WITH_ELISE_V1, false);
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, false);
});

test('child Today flags cannot activate without the parent', () => {
  const flags = loadTsModule('constants/featureFlags.ts', {
    EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1: 'true',
    EXPO_PUBLIC_TODAY_WITH_ELISE_WEATHER_V1: 'true',
  });
  assert.equal(flags.TODAY_WITH_ELISE_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_GENERATED_GREETING_ACTIVE, false);
  assert.equal(flags.TODAY_WITH_ELISE_WEATHER_ACTIVE, false);
});

// ── Kill switch placement ────────────────────────────────────────────────────

test('the section gates on the derived Today capability, not a raw env read', () => {
  assert.match(section, /TODAY_WITH_ELISE_ACTIVE/);
  assert.doesNotMatch(section, /process\.env/);
});

test('the flag gate returns before any child is constructed', () => {
  const gateIndex = section.indexOf('if (!enabled) return null;');
  const boundaryIndex = section.indexOf('<TodayWithEliseBoundary>');
  assert.ok(gateIndex > 0, 'expected an early return for the disabled path');
  assert.ok(boundaryIndex > gateIndex, 'the surface must be constructed only after the gate');
});

test('flag OFF performs no orchestration: the gate body calls no Today hook', () => {
  // React runs a component's hooks unconditionally, so the ONLY structural way
  // to guarantee "flag OFF does nothing" is for the orchestrating hook to live
  // in a component the gate never constructs. Prove exactly that: the gate
  // function's own body contains no hook call, and the hook appears only inside
  // the surface component below it.
  const gateBody = section.slice(section.indexOf('export function TodayWithEliseSection'));
  assert.doesNotMatch(
    gateBody,
    /useTodayWithElise\(|loadCloset|loadActiveSession|emitTodayWithElise|reportTodayCardCommitted\(/,
  );

  const surfaceStart = section.indexOf('function TodayWithEliseSurface()');
  const hookCall = section.indexOf('useTodayWithElise()');
  assert.ok(surfaceStart > 0 && hookCall > surfaceStart);
  assert.ok(
    hookCall < section.indexOf('export function TodayWithEliseSection'),
    'the hook must be confined to the surface component',
  );
});

test('the section is a component, so Home never evaluates Today hooks inline', () => {
  assert.match(section, /export function TodayWithEliseSection/);
  assert.doesNotMatch(home, /useTodayWithElise/);
});

/** Normalized: line endings are a checkout artifact, not a source fact. */
const HOOK = read('hooks', 'useTodayWithElise.ts').replace(/\r\n/g, '\n');

/**
 * The hook with comments removed.
 *
 * Ordering assertions MUST run against code. The hook's own comment states that
 * the actor-transition effect is "DECLARED BEFORE `useFocusEffect(orchestrate)`",
 * so a raw search finds that sentence hundreds of lines before the call it
 * describes — and would report the correct order as broken.
 */
const HOOK_CODE = HOOK.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

/** The body of `readTodaySources`, and nothing else. */
function readSourcesBody() {
  const start = HOOK.indexOf('export async function readTodaySources');
  const endMarker = 'return { closet, session, composition, savedLooks, candidates };';
  const end = HOOK.indexOf(endMarker, start);
  assert.ok(start > 0 && end > start, 'could not isolate readTodaySources');
  return HOOK.slice(start, end + endMarker.length);
}

/** The generation runner inside the hook, up to where user actions begin. */
function orchestrationBody() {
  const start = HOOK.indexOf('const orchestrate = useCallback');
  const end = HOOK.indexOf('// ── Actions ─');
  assert.ok(start > 0 && end > start, 'could not isolate the orchestration path');
  return HOOK.slice(start, end);
}

test('orchestration is read-only: mounting Home writes to no store', () => {
  // Scoped to the ORCHESTRATION path. The user-initiated handoff below it does
  // write — that is its job — so the guarantee that matters is that merely
  // rendering Home cannot.
  const path = `${readSourcesBody()}\n${orchestrationBody()}`;
  assert.doesNotMatch(
    path,
    /startActiveSession\(|updateActiveSession\(|discardActiveSession\(|replaceCompositionSet\(|setActiveLook\(|savePrivateSavedLook\(|createClosetItem\(|applySlotOverride\(|composeAndPersistComposition\(/,
  );
});

test('each Today source is read exactly once per generation', () => {
  const body = readSourcesBody();
  for (const call of [
    'loadClosetTyped(',
    'loadActiveSession(',
    'loadCompositionSet(',
    'loadPrivateSavedLooks(',
    'listClosetCandidates(',
  ]) {
    const occurrences = body.split(call).length - 1;
    assert.equal(occurrences, 1, `${call} is invoked ${occurrences} times per generation`);
  }
});

test('the generation runner calls the source reader exactly once', () => {
  const body = orchestrationBody();
  assert.equal(body.split('readTodaySources(').length - 1, 1);
});

test('the actor-transition effect is declared BEFORE the focus effect', () => {
  // This ordering is load-bearing and has failed before in this repository:
  // React runs effects in declaration order, so on the single commit where auth
  // resolves, the actor-transition effect must invalidate the OLD actor's work
  // before the new generation claims its token. With the opposite order the new
  // generation is claimed first and immediately bumped past, its commit is
  // permanently refused, and the surface hangs in its loading state forever —
  // exactly the failure the private Dressing Room hook documents.
  const invalidation = HOOK_CODE.indexOf(
    'generationRef.current += 1;\n    handleRef.current = null;',
  );
  const focus = HOOK_CODE.indexOf('useFocusEffect(orchestrate);');
  assert.ok(invalidation > 0, 'could not find the actor-transition effect');
  assert.ok(focus > 0, 'could not find the focus effect');
  assert.ok(
    invalidation < focus,
    'the actor-transition effect must be declared before useFocusEffect(orchestrate)',
  );
});

test('the actor-transition effect is keyed on the actor, not on every render', () => {
  const effect = HOOK_CODE.slice(
    HOOK_CODE.indexOf('generationRef.current += 1;\n    handleRef.current = null;'),
  );
  assert.match(effect.slice(0, 200), /\}, \[actorKey\]\);/);
});

// ── Home is additive ─────────────────────────────────────────────────────────

test('Home mounts the Today section', () => {
  assert.match(home, /import \{ TodayWithEliseSection \} from '\.\/TodayWithEliseSection';/);
  assert.match(home, /<TodayWithEliseSection \/>/);
});

test('Today sits below the Elise introduction and above the first recommendation', () => {
  const stylist = home.indexOf('<HomeStylistCard');
  const today = home.indexOf('<TodayWithEliseSection />');
  const stylePicks = home.indexOf('home-luxury-style-picks-section');
  assert.ok(stylist > 0 && today > 0 && stylePicks > 0);
  assert.ok(today > stylist, 'Today must not replace or precede the Elise introduction');
  assert.ok(today < stylePicks, 'Today must be the first actionable recommendation');
});

test('every pre-Build-5 Home section survives the insertion', () => {
  for (const marker of [
    'home-luxury-start-scan',
    '<HomeStylistCard',
    'home-luxury-style-picks-section',
    'home-luxury-feature-recent-scans',
    'home-luxury-feature-scan',
    'home-luxury-feature-library',
    'home-luxury-feature-dressing-rooms',
    '<PrivacyFooter',
  ]) {
    assert.ok(home.includes(marker), `Home lost ${marker}`);
  }
});

test('the Scan hero still precedes the Today card', () => {
  const hero = home.indexOf('<View style={styles.heroCard}>');
  const today = home.indexOf('<TodayWithEliseSection />');
  assert.ok(hero > 0 && today > hero);
});

// ── Containment ──────────────────────────────────────────────────────────────

test('containment is a real React error boundary', () => {
  assert.match(boundary, /class TodayWithEliseBoundary extends React\.Component/);
  assert.match(boundary, /static getDerivedStateFromError/);
  assert.match(boundary, /componentDidCatch/);
});

test('a contained failure renders nothing rather than an error surface', () => {
  assert.match(boundary, /if \(this\.state\.failed\) return null;/);
  assert.doesNotMatch(boundary, /accessibilityRole="alert"/);
});

test('containment emits no Today analytics for a card that never committed', () => {
  assert.doesNotMatch(boundary, /emitTodayWithElise/);
});

test('the boundary wraps the card and not the flag gate', () => {
  const gate = section.indexOf('if (!enabled) return null;');
  const wrap = section.indexOf('<TodayWithEliseBoundary>');
  assert.ok(wrap > gate);
});

// ── Card is presentation only ────────────────────────────────────────────────

test('the card performs no orchestration', () => {
  assert.doesNotMatch(
    card,
    /loadCloset|loadActiveSession|loadPrivateSavedLooks|startActiveSession|evaluateTodayWithEliseCard/,
  );
});

test('the card exposes a stable section heading and test ids', () => {
  assert.match(card, /TODAY WITH ELISE/);
  assert.match(card, /home-today-with-elise/);
  assert.match(card, /accessibilityRole="header"/);
});
