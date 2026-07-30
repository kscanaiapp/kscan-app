// Build 5 Phase 1 — analytics, copy, weather, action routing contracts.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relPath) {
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
      __DEV__: false,
    },
    { filename: full },
  );
  return mod.exports;
}

const analytics = loadTsModule('services/todayWithElise/analytics.ts');
const copy = loadTsModule('services/todayWithElise/copyTemplates.ts');
const weather = loadTsModule('services/todayWithElise/weatherPolicy.ts');
const routing = loadTsModule('services/todayWithElise/actionRouting.ts');

test('analytics allowlist drops prohibited actor identifiers and free text', () => {
  const emitted = [];
  analytics.setTodayWithEliseAnalyticsSink((event, payload) => {
    emitted.push({ event, payload });
  });
  analytics.emitTodayWithEliseEvent('today_with_elise_impression', {
    stateId: 'today_owned_look',
    actorId: 'user-uuid-should-drop',
    email: 'a@b.com',
    prompt: 'wear the navy blazer',
    imageUri: 'file:///tmp/x.jpg',
  });
  assert.equal(emitted.length, 1);
  assert.equal(emitted[0].payload.stateId, 'today_owned_look');
  assert.equal(emitted[0].payload.actorId, undefined);
  assert.equal(emitted[0].payload.email, undefined);
  assert.equal(emitted[0].payload.prompt, undefined);
  assert.equal(emitted[0].payload.imageUri, undefined);
  analytics.resetTodayWithEliseAnalyticsSink();
});

test('impression dedupes by generation token', () => {
  analytics.__resetTodayWithEliseImpressionDedupe();
  const emitted = [];
  analytics.setTodayWithEliseAnalyticsSink((event, payload) => {
    emitted.push({ event, payload });
  });
  assert.equal(
    analytics.emitTodayWithEliseImpression({
      generationToken: 'today_1_1',
      payload: { stateId: 'fallback' },
    }),
    true,
  );
  assert.equal(
    analytics.emitTodayWithEliseImpression({
      generationToken: 'today_1_1',
      payload: { stateId: 'fallback' },
    }),
    false,
  );
  assert.equal(emitted[1].payload.deduped, true);
  analytics.resetTodayWithEliseAnalyticsSink();
});

test('prohibited payload categories are enumerated for audit', () => {
  assert.ok(analytics.TODAY_WITH_ELISE_PROHIBITED_PAYLOADS.includes('precise_location'));
  assert.ok(analytics.TODAY_WITH_ELISE_PROHIBITED_PAYLOADS.includes('raw_images'));
});

test('deterministic copy never fabricates weather details', () => {
  const withWeather = copy.resolveTodayDeterministicCopy({
    daypart: 'morning',
    weatherAvailable: true,
    stateId: 'today_owned_look',
  });
  assert.match(withWeather.explanation, /weather can refine/i);
  assert.doesNotMatch(withWeather.explanation, /\d+\s*°/);

  const without = copy.resolveTodayDeterministicCopy({
    daypart: 'evening',
    weatherAvailable: false,
    stateId: 'fallback',
  });
  assert.doesNotMatch(without.explanation, /weather/i);
});

test('stale weather is unusable and non-blocking', () => {
  const now = 1_000_000;
  const result = weather.resolveTodayWeatherSuitability({
    weatherActive: true,
    nowMs: now,
    weather: {
      temperatureC: 8,
      precipitation: 'none',
      condition: 'clear',
      capturedAtMs: now - weather.TODAY_WEATHER_FRESHNESS_MS - 1,
      source: 'cache',
    },
  });
  assert.equal(result.usable, false);
  assert.equal(result.reason, 'stale');
  assert.equal(result.copyKey, 'weather.unavailable');
});

test('weather timeout and offline do not suggest outerwear', () => {
  assert.equal(
    weather.resolveTodayWeatherSuitability({
      weatherActive: true,
      weather: null,
      nowMs: 1,
      timedOut: true,
    }).reason,
    'timeout',
  );
  assert.equal(
    weather.resolveTodayWeatherSuitability({
      weatherActive: true,
      weather: null,
      nowMs: 1,
      offline: true,
    }).reason,
    'offline',
  );
});

test('Tap to Get Ready intent preserves Build 3 handoff requirements', () => {
  const intent = routing.buildTapToGetReadyIntent({
    actorId: 'actor-a',
    itemRefs: [{ closetItemId: 'c1', slot: 'top' }],
    generationToken: 'today_1_1',
  });
  assert.equal(intent.source, 'today_with_elise');
  assert.equal(intent.automaticCommerce, false);
  assert.equal(intent.useBuild3OwnershipResolution, true);
  assert.equal(intent.loadRecommendedLookImmediately, true);
  assert.ok(routing.TAP_TO_GET_READY_REQUIREMENTS.includes('dedupe_rapid_taps'));
});

test('rapid primary taps are deduped', () => {
  routing.__resetTodayPrimaryActionDedupe();
  assert.equal(routing.shouldAcceptPrimaryActionTap('k1', 1000), true);
  assert.equal(routing.shouldAcceptPrimaryActionTap('k1', 1100), false);
  assert.equal(routing.shouldAcceptPrimaryActionTap('k1', 3000), true);
});
