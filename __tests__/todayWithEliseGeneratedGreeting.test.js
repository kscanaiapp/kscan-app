// Build 5.1 — generated (personalized) greeting for Today with Elise V1.
//
// Covers the standalone service (services/todayWithElise/generatedGreeting.ts)
// and its wiring into copyTemplates.ts's resolveTodayDeterministicCopy, which
// is what actually reaches the card headline.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const tsModuleCache = new Map();

function loadTsModule(relPath) {
  const full = path.join(ROOT, relPath);
  if (tsModuleCache.has(full)) return tsModuleCache.get(full);
  const mod = { exports: {} };
  tsModuleCache.set(full, mod.exports);
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
      require: (r) => {
        if (r.startsWith('./') || r.startsWith('../')) {
          const resolved = path.resolve(path.dirname(full), r);
          const candidate = fs.existsSync(`${resolved}.ts`) ? `${resolved}.ts` : resolved;
          return loadTsModule(path.relative(ROOT, candidate));
        }
        return require(r);
      },
      console,
      Object,
      Array,
      Map,
      Set,
      Number,
      String,
      JSON,
      __DEV__: false,
    },
    { filename: full },
  );
  tsModuleCache.set(full, mod.exports);
  return mod.exports;
}

const greeting = loadTsModule('services/todayWithElise/generatedGreeting.ts');
const copy = loadTsModule('services/todayWithElise/copyTemplates.ts');

// ── resolveGeneratedGreetingOpener: the pure service ────────────────────────

test('morning with first name personalizes', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'morning', firstName: 'Justin', active: true });
  assert.equal(r.text, 'Good morning, Justin.');
  assert.equal(r.personalized, true);
});

test('afternoon with first name personalizes', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'afternoon', firstName: 'Justin', active: true });
  assert.equal(r.text, 'Good afternoon, Justin.');
  assert.equal(r.personalized, true);
});

test('evening with first name personalizes', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'evening', firstName: 'Justin', active: true });
  assert.equal(r.text, 'Good evening, Justin.');
  assert.equal(r.personalized, true);
});

test('missing name falls back to the generic opener', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'morning', firstName: null, active: true });
  assert.equal(r.text, 'Good morning.');
  assert.equal(r.personalized, false);
});

test('whitespace-only name falls back to the generic opener', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'morning', firstName: '   ', active: true });
  assert.equal(r.text, 'Good morning.');
  assert.equal(r.personalized, false);
});

test('malformed (non-string) name falls back rather than throwing', () => {
  for (const malformed of [undefined, 42, {}, [], true]) {
    const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'morning', firstName: malformed, active: true });
    assert.equal(r.text, 'Good morning.');
    assert.equal(r.personalized, false, String(malformed));
  }
});

test('flag off (Today-inactive-derived or otherwise) never personalizes even with a valid name', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'morning', firstName: 'Justin', active: false });
  assert.equal(r.text, 'Good morning.');
  assert.equal(r.personalized, false);
});

test('control characters are stripped from the name before use', () => {
  const r = greeting.resolveGeneratedGreetingOpener({
    daypart: 'morning',
    firstName: 'Jus\x00tin',
    active: true,
  });
  assert.equal(r.text, 'Good morning, Justin.');
});

test('only the first token of a multi-word value is used', () => {
  // Defense in depth: resolveUserFirstName already returns one token before
  // this service ever sees it, but the service must not trust that silently —
  // a caller that passed a full name by mistake still surfaces one word.
  const r = greeting.resolveGeneratedGreetingOpener({
    daypart: 'morning',
    firstName: 'Justin Landes',
    active: true,
  });
  assert.equal(r.text, 'Good morning, Justin.');
});

test('same inputs always produce the same output (no randomness)', () => {
  const input = { daypart: 'afternoon', firstName: 'Justin', active: true };
  const a = greeting.resolveGeneratedGreetingOpener(input);
  const b = greeting.resolveGeneratedGreetingOpener(input);
  assert.deepEqual(a, b);
});

test('an unrecognised daypart falls back to the afternoon opener, matching copyTemplates', () => {
  const r = greeting.resolveGeneratedGreetingOpener({ daypart: 'nonexistent', firstName: null, active: true });
  assert.equal(r.text, 'Good afternoon.');
});

test('GENERIC_DAYPART_OPENERS matches the text every existing state already showed', () => {
  assert.equal(greeting.GENERIC_DAYPART_OPENERS.morning, 'Good morning.');
  assert.equal(greeting.GENERIC_DAYPART_OPENERS.afternoon, 'Good afternoon.');
  assert.equal(greeting.GENERIC_DAYPART_OPENERS.evening, 'Good evening.');
});

// ── Wiring into resolveTodayDeterministicCopy (what the card actually reads) ─

test('headline stays the plain daypart opener when generatedGreetingActive is omitted (existing callers unaffected)', () => {
  const result = copy.resolveTodayDeterministicCopy({
    daypart: 'morning',
    weatherAvailable: false,
    stateId: 'fallback',
  });
  assert.equal(result.headline, 'Good morning.');
});

test('headline personalizes when generatedGreetingActive is true and a name is present', () => {
  const result = copy.resolveTodayDeterministicCopy({
    daypart: 'morning',
    weatherAvailable: false,
    generatedGreetingActive: true,
    firstName: 'Justin',
    stateId: 'today_owned_look',
  });
  assert.equal(result.headline, 'Good morning, Justin.');
  // The state-specific line still lives in explanation — personalization
  // never replaces or removes it.
  assert.match(result.explanation, /Tap to get ready/);
});

test('headline stays generic when generatedGreetingActive is true but no name is available', () => {
  const result = copy.resolveTodayDeterministicCopy({
    daypart: 'evening',
    weatherAvailable: false,
    generatedGreetingActive: true,
    firstName: null,
    stateId: 'fallback',
  });
  assert.equal(result.headline, 'Good evening.');
});

test('personalization applies identically across every existing state, including unauthorized/unavailable', () => {
  for (const stateId of [
    'unfinished_look', 'today_owned_look', 'recent_styling', 'closet_action',
    'closet_review', 'partial_look', 'onboarding', 'fallback', 'stale',
    'unauthorized', 'unavailable', 'incompatible',
  ]) {
    const result = copy.resolveTodayDeterministicCopy({
      daypart: 'morning',
      weatherAvailable: false,
      generatedGreetingActive: true,
      firstName: 'Justin',
      stateId,
    });
    assert.equal(result.headline, 'Good morning, Justin.', `state ${stateId} did not personalize`);
  }
});
