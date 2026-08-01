// Build 5.1 — weather on Today with Elise.
//
// Covers the three pieces this feature actually adds:
//   1. the backend projection from the EXISTING classifier verdict to the
//      compact Today contract (asserted against the deployed source text, since
//      the Edge Function is Deno and cannot be imported here);
//   2. the client store that validates and shares that payload;
//   3. describeTodayWeather, which turns a usable reading into the card line.
//
// The rule under test throughout: weather never fabricates, and every failure
// mode renders nothing rather than an error.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const tsModuleCache = new Map();

function loadTsModule(relPath, extraGlobals = {}) {
  const full = path.join(ROOT, relPath);
  // Keyed on the injection identity, not just the path: each makeStore() needs
  // its OWN module instance bound to its own AsyncStorage, or every test after
  // the first would silently reuse the first test's storage.
  const cacheKey = full + '::' + (extraGlobals.__cacheNonce ?? 'default');
  if (tsModuleCache.has(cacheKey)) return tsModuleCache.get(cacheKey);
  const mod = { exports: {} };
  tsModuleCache.set(cacheKey, mod.exports);
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
          return loadTsModule(path.relative(ROOT, candidate), extraGlobals);
        }
        if (extraGlobals.__modules && extraGlobals.__modules[r]) return extraGlobals.__modules[r];
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
      Date,
      isNaN,
      __DEV__: false,
      ...extraGlobals,
    },
    { filename: full },
  );
  tsModuleCache.set(cacheKey, mod.exports);
  return mod.exports;
}

const policy = loadTsModule('services/todayWithElise/weatherPolicy.ts');

// ── In-memory AsyncStorage so the store can be exercised without a device ────

let storeNonce = 0;

function makeStore() {
  const backing = new Map();
  const asyncStorage = {
    getItem: async (k) => (backing.has(k) ? backing.get(k) : null),
    setItem: async (k, v) => {
      backing.set(k, v);
    },
    removeItem: async (k) => {
      backing.delete(k);
    },
  };
  const mod = loadTsModule('services/weather/todayWeatherStore.ts', {
    __cacheNonce: `store-${(storeNonce += 1)}`,
    __modules: {
      // __esModule matters: without it, TypeScript's __importDefault helper wraps
      // the mock a SECOND time, so `AsyncStorage.setItem` resolves to undefined
      // and the store's own try/catch swallows the failure into a silent no-op.
      '@react-native-async-storage/async-storage': {
        __esModule: true,
        default: asyncStorage,
      },
    },
  });
  return { mod, backing };
}

const FRESH = () => new Date().toISOString();

// ── 1. Backend projection (source-level, Deno cannot be imported) ────────────

const EDGE = fs.readFileSync(
  path.join(ROOT, 'supabase', 'functions', 'stylechat-generate', 'index.ts'),
  'utf8',
);

test('the backend exposes weather additively and only when it resolved', () => {
  assert.match(EDGE, /function weatherContextResponseFields\(\)/);
  assert.match(EDGE, /if \(!weatherContext\) return \{\};/);
  // Present at BOTH response exit points, or v1 clients silently lose weather.
  const uses = EDGE.match(/\.\.\.weatherContextResponseFields\(\)/g) ?? [];
  assert.equal(uses.length, 2, 'weather must be attached to both response shapes');
});

test('the backend reuses the single existing classifier and adds no second one', () => {
  // Exactly one place interprets provider data.
  assert.equal((EDGE.match(/function resolveCondition\(/g) ?? []).length, 1);
  // The projection consumes the classifier's verdict, never raw provider fields.
  const projection = EDGE.slice(
    EDGE.indexOf('function projectTodayWeatherContext'),
    EDGE.indexOf('const WEATHER_STYLING_INSTRUCTION'),
  );
  assert.ok(projection.length > 0, 'projection function not found');
  assert.doesNotMatch(projection, /weather_code|weatherCode|wind_speed|SNOW_CODES|RAIN_CODES/);
  assert.doesNotMatch(projection, /fetch\(/);
});

test('the projected payload carries no coordinates and no raw provider body', () => {
  const projection = EDGE.slice(
    EDGE.indexOf('function projectTodayWeatherContext'),
    EDGE.indexOf('const WEATHER_STYLING_INSTRUCTION'),
  );
  assert.doesNotMatch(projection, /roundedLat|roundedLon|latitude|longitude/);
  // Only the four compact fields are returned.
  assert.match(projection, /temperatureC:/);
  assert.match(projection, /temperatureF:/);
  assert.match(projection, /precipitation,/);
  assert.match(projection, /condition,/);
  assert.match(projection, /observedAt: ctx\.observedAt/);
});

test('temperature-only verdicts never become a fabricated sky condition', () => {
  const projection = EDGE.slice(
    EDGE.indexOf('function projectTodayWeatherContext'),
    EDGE.indexOf('const WEATHER_STYLING_INSTRUCTION'),
  );
  // 'hot'/'cold' must fall to the default branch (unknown sky), not to 'clear'.
  assert.doesNotMatch(projection, /case 'hot'/);
  assert.doesNotMatch(projection, /case 'cold'/);
});

test('the existing chat weather behaviour is untouched', () => {
  assert.match(EDGE, /WEATHER_STYLING_INSTRUCTION/);
  assert.match(EDGE, /function buildWeatherContextBlock/);
  assert.match(EDGE, /const OPEN_METEO_BASE\s+= 'https:\/\/api\.open-meteo\.com\/v1\/forecast'/);
  assert.match(EDGE, /fetchWeatherStylingContext\(weatherLocation\)/);
});

// ── 2. Client store: validation, isolation, retention ────────────────────────

test('a well-formed payload round-trips into the policy input shape', async () => {
  const { mod } = makeStore();
  await mod.saveTodayWeather('actor-a', {
    temperatureC: 8,
    temperatureF: 46,
    precipitation: 'none',
    condition: 'rain',
    observedAt: FRESH(),
  });
  const read = await mod.readTodayWeather('actor-a');
  assert.equal(read.condition, 'rain');
  assert.equal(read.temperatureC, 8);
  assert.equal(read.temperatureF, 46);
  // Always 'cache' — Home never performed a live read of its own.
  assert.equal(read.source, 'cache');
  assert.ok(Number.isFinite(read.capturedAtMs));
});

test('a reading never crosses accounts', async () => {
  const { mod } = makeStore();
  await mod.saveTodayWeather('actor-a', {
    temperatureC: 8,
    temperatureF: 46,
    precipitation: 'none',
    condition: 'clear',
    observedAt: FRESH(),
  });
  assert.equal(await mod.readTodayWeather('actor-b'), null);
  assert.notEqual(await mod.readTodayWeather('actor-a'), null);
});

test('malformed payloads are rejected rather than stored or thrown', async () => {
  const { mod, backing } = makeStore();
  const malformed = [
    null,
    undefined,
    42,
    'rain',
    {},
    { condition: 'rain' },
    { condition: 'volcano', precipitation: 'none', observedAt: FRESH() },
    { condition: 'rain', precipitation: 'sideways', observedAt: FRESH() },
    { condition: 'rain', precipitation: 'none', observedAt: 'not-a-date' },
    { condition: 'rain', precipitation: 'none', observedAt: FRESH(), temperatureC: 'cold' },
    { condition: 'rain', precipitation: 'none', observedAt: FRESH(), temperatureC: NaN },
  ];
  for (const payload of malformed) {
    await mod.saveTodayWeather('actor-a', payload);
    assert.equal(backing.size, 0, `stored a malformed payload: ${JSON.stringify(payload)}`);
  }
  assert.equal(await mod.readTodayWeather('actor-a'), null);
});

test('a null temperature is valid — the provider may omit it', async () => {
  const { mod } = makeStore();
  await mod.saveTodayWeather('actor-a', {
    temperatureC: null,
    temperatureF: null,
    precipitation: 'unknown',
    condition: 'rain',
    observedAt: FRESH(),
  });
  const read = await mod.readTodayWeather('actor-a');
  assert.equal(read.temperatureC, null);
  assert.equal(read.condition, 'rain');
});

test('a reading past the retention ceiling is dropped', async () => {
  const { mod } = makeStore();
  const now = Date.now();
  await mod.saveTodayWeather('actor-a', {
    temperatureC: 8,
    temperatureF: 46,
    precipitation: 'none',
    condition: 'clear',
    observedAt: new Date(now).toISOString(),
  });
  const beyond = now + mod.TODAY_WEATHER_RETENTION_MS + 1;
  assert.equal(await mod.readTodayWeather('actor-a', beyond), null);
});

test('corrupted storage reads as no-weather instead of throwing', async () => {
  const { mod, backing } = makeStore();
  backing.set(mod.TODAY_WEATHER_KEY, '{ not json');
  assert.equal(await mod.readTodayWeather('actor-a'), null);
});

test('clearing removes the reading', async () => {
  const { mod } = makeStore();
  await mod.saveTodayWeather('actor-a', {
    temperatureC: 8,
    temperatureF: 46,
    precipitation: 'none',
    condition: 'clear',
    observedAt: FRESH(),
  });
  await mod.clearTodayWeather();
  assert.equal(await mod.readTodayWeather('actor-a'), null);
});

// ── 3. The card line ────────────────────────────────────────────────────────

function suitabilityFor(weather, overrides = {}) {
  return policy.resolveTodayWeatherSuitability({
    weatherActive: true,
    weather,
    nowMs: Date.now(),
    ...overrides,
  });
}

test('a usable cold, wet reading produces a summary and a styling cue', () => {
  const weather = {
    temperatureC: 3,
    temperatureF: 37,
    precipitation: 'unknown',
    condition: 'rain',
    capturedAtMs: Date.now(),
    source: 'cache',
  };
  const line = policy.describeTodayWeather(weather, suitabilityFor(weather));
  assert.match(line.summary, /37°/);
  assert.match(line.summary, /Rain/);
  assert.equal(line.cue, 'Layer up and pick closed shoes.');
});

test('a mild clear reading shows the summary with no cue', () => {
  const weather = {
    temperatureC: 22,
    temperatureF: 72,
    precipitation: 'none',
    condition: 'clear',
    capturedAtMs: Date.now(),
    source: 'cache',
  };
  const line = policy.describeTodayWeather(weather, suitabilityFor(weather));
  assert.equal(line.summary, '72° · Clear');
  assert.equal(line.cue, null);
});

test('every unusable state renders no line at all', () => {
  const stale = {
    temperatureC: 3,
    temperatureF: 37,
    precipitation: 'none',
    condition: 'rain',
    capturedAtMs: Date.now() - policy.TODAY_WEATHER_FRESHNESS_MS - 1,
    source: 'cache',
  };
  assert.equal(policy.describeTodayWeather(stale, suitabilityFor(stale)), null);

  // flag off, absent, timeout, offline
  assert.equal(
    policy.describeTodayWeather(
      null,
      policy.resolveTodayWeatherSuitability({ weatherActive: false, weather: null, nowMs: 1 }),
    ),
    null,
  );
  assert.equal(policy.describeTodayWeather(null, suitabilityFor(null)), null);
  assert.equal(
    policy.describeTodayWeather(null, suitabilityFor(null, { timedOut: true })),
    null,
  );
  assert.equal(
    policy.describeTodayWeather(null, suitabilityFor(null, { offline: true })),
    null,
  );
});

test('an unknown condition with no temperature renders nothing rather than an empty line', () => {
  const weather = {
    temperatureC: null,
    temperatureF: null,
    precipitation: 'unknown',
    condition: 'unknown',
    capturedAtMs: Date.now(),
    source: 'cache',
  };
  assert.equal(policy.describeTodayWeather(weather, suitabilityFor(weather)), null);
});

test('the cue is read from the policy verdict, never recomputed from raw values', () => {
  const src = fs.readFileSync(
    path.join(ROOT, 'services', 'todayWithElise', 'weatherPolicy.ts'),
    'utf8',
  );
  const fn = src.slice(src.indexOf('export function describeTodayWeather'));
  assert.match(fn, /suitability\.suggestOuterwear/);
  assert.match(fn, /suitability\.suggestClosedFootwear/);
  // No independent threshold logic inside the describe function.
  assert.doesNotMatch(fn, /<=\s*\d|>=\s*\d/);
});

test('Fahrenheit is displayed as measured, never converted from Celsius', () => {
  const weather = {
    temperatureC: 14, // 14C would render as 57F if converted; the measured value is 58
    temperatureF: 58,
    precipitation: 'none',
    condition: 'clear',
    capturedAtMs: Date.now(),
    source: 'cache',
  };
  const line = policy.describeTodayWeather(weather, suitabilityFor(weather));
  assert.match(line.summary, /58°/);
});
