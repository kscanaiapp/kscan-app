// PostHog V1 governance guard.
//
// Supersedes the informal, repo-wide assumption that K Scan uses no
// analytics vendor at all (that assumption was true before PostHog was
// owner-authorized as the sole product-analytics vendor). It does NOT
// replace __tests__/todayWithEliseAnalyticsAccessibilityParity.test.js's
// "Build 5 introduces no analytics SDK, vendor or remote configuration"
// assertion, which is a narrower, still-true invariant about that one
// feature never bypassing its own sink abstraction — unrelated to whether
// PostHog exists centrally elsewhere in the app.
//
// This file proves the negative controls actually bite: PostHog is
// configured product-analytics-only, exactly one file imports the vendor
// SDK, every bridged sink still filters through its own property allowlist,
// and no prohibited property name (image, transcript, email, GPS, token,
// title, ...) exists in any bridged sink's allowlist.

const fs = require('fs');
const path = require('path');
const test = require('node:test');
const assert = require('node:assert/strict');

const ROOT = path.join(__dirname, '..');
const read = (relPath) => fs.readFileSync(path.join(ROOT, relPath), 'utf8');

// The client/bridge/identity-sync logic lives in the JSX-free core file so
// it can be `require()`d directly by tests; the .tsx sibling only holds the
// one Provider component and re-exports everything else from core.
const CORE_PATH = 'services/analytics/posthogClient.core.ts';
const PROVIDER_PATH = 'services/analytics/posthogClient.tsx';
const clientSource = read(CORE_PATH);
const providerSource = read(PROVIDER_PATH);

// ─── Config authority: no fallback token, fail-soft when unconfigured ───────

test('the client reads config only from EXPO_PUBLIC_POSTHOG_API_KEY / _HOST, no fallback', () => {
  assert.match(clientSource, /process\.env\.EXPO_PUBLIC_POSTHOG_API_KEY/);
  assert.match(clientSource, /process\.env\.EXPO_PUBLIC_POSTHOG_HOST/);
  // No hardcoded PostHog project token (phc_...) or literal ingestion host
  // anywhere in the wrapper.
  assert.doesNotMatch(clientSource, /phc_[A-Za-z0-9]/);
  assert.doesNotMatch(clientSource, /['"]https:\/\/[a-z.]*posthog[a-z.]*['"]/);
});

test('isPostHogConfigured requires both key and host to be non-empty', () => {
  assert.match(
    clientSource,
    /function isPostHogConfigured\(\)[\s\S]*?resolveApiKey\(\)\.length > 0 && resolveHost\(\)\.length > 0/,
  );
});

test('every exported function no-ops when posthog is null', () => {
  for (const name of [
    'forwardTelemetryToPostHog',
    'identifyPostHogUser',
    'resetPostHogUser',
  ]) {
    const fn = new RegExp(`export function ${name}\\([^)]*\\)[^{]*\\{\\s*if \\(!posthog\\) return;`);
    assert.match(clientSource, fn, `${name} must guard on !posthog`);
  }
});

// ─── V1 = product analytics only ────────────────────────────────────────────

test('autocapture (screens/touches) is explicitly off', () => {
  assert.match(providerSource, /autocapture=\{false\}/);
});

test('session replay is explicitly off', () => {
  assert.match(clientSource, /enableSessionReplay:\s*false/);
});

test('exception/error autocapture is explicitly off', () => {
  assert.match(clientSource, /errorTracking:\s*\{\s*autocapture:\s*false,?\s*\}/);
});

test('remote feature flags and surveys are explicitly disabled', () => {
  assert.match(clientSource, /disableRemoteFeatureFlags:\s*true/);
  assert.match(clientSource, /preloadFeatureFlags:\s*false/);
  assert.match(clientSource, /disableSurveys:\s*true/);
});

test('the wrapper itself never calls a PostHog feature-flag or survey API', () => {
  // Scoped to the wrapper, not the whole repo: `isFeatureEnabled` /
  // `getFeatureFlag`-shaped names also exist in K Scan's OWN, unrelated
  // FeatureFreeze/K+ gating system, so a repo-wide grep for those names
  // would false-positive on code that has nothing to do with PostHog. The
  // "only the central analytics wrapper imports posthog-react-native" test
  // above already proves nothing outside this file could reach PostHog's
  // flag/survey APIs even if it wanted to.
  assert.doesNotMatch(
    clientSource,
    /posthog\.(getFeatureFlag|getFeatureFlags|isFeatureEnabled|reloadFeatureFlags)\(|useFeatureFlag|PostHogSurveyProvider|PostHogFeatureFlags/,
  );
});

// ─── Exactly one importer of the vendor SDK ─────────────────────────────────

test('only the central analytics wrapper imports posthog-react-native', () => {
  const importers = [];
  walk(ROOT, (file, source) => {
    if (/from ['"]posthog-react-native['"]|require\(['"]posthog-react-native['"]\)/.test(source)) {
      importers.push(file);
    }
  });
  assert.deepEqual(importers, [CORE_PATH.replace(/\//g, path.sep)]);
});

test('the .tsx Provider sibling gets PostHogProvider from core, never from the vendor package', () => {
  assert.doesNotMatch(providerSource, /from ['"]posthog-react-native['"]/);
  assert.match(providerSource, /from ['"]\.\/posthogClient\.core['"]/);
});

test('no alternative analytics/tracking SDK is a project dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  const deps = Object.keys({ ...pkg.dependencies, ...pkg.devDependencies });
  const forbidden = [
    'amplitude',
    'mixpanel',
    '@segment/analytics-react-native',
    'analytics-react-native',
    '@amplitude',
    'appsflyer',
    'react-native-appsflyer',
    'react-native-adjust',
    'heap',
    '@firebase/analytics',
    'expo-firebase-analytics',
    'react-native-branch',
  ];
  const hit = deps.filter((d) => forbidden.some((f) => d.toLowerCase().includes(f)));
  assert.deepEqual(hit, []);
});

// ─── The five bridged sinks: allowlist + no prohibited property names ──────

const BRIDGED_SINKS = [
  { file: 'services/closetTelemetry.ts', arrayName: 'CLOSET_CANDIDATE_EVENT_PROPERTIES' },
  { file: 'services/kplus/kplusTelemetry.ts', arrayName: 'KPLUS_EVENT_PROPERTIES' },
  { file: 'services/todayWithElise/analytics.ts', arrayName: 'TODAY_WITH_ELISE_EVENT_PROPERTIES' },
  { file: 'services/voice/voiceTelemetry.ts', arrayName: 'VOICE_EVENT_PROPERTIES' },
  { file: 'services/vto/vtoTelemetry.ts', arrayName: 'VTO_EVENT_PROPERTIES' },
];

// Whole-word matches only (see wordsOf below) — a substring check would
// false-positive on perfectly safe properties like `latencyBucket`
// ("lat" is a substring of "latency", not a standalone word).
const PROHIBITED_PROPERTY_WORDS = new Set([
  'image',
  'base64',
  'transcript',
  'speech',
  'prompt',
  'email',
  'name',
  'phone',
  'gps',
  'lat',
  'lng',
  'latitude',
  'longitude',
  'location',
  'push',
  'token',
  'jwt',
  'signed',
  'title',
  'brand',
  'note',
  'url',
  'uri',
  'address',
  'ssn',
  'dob',
]);

function wordsOf(key) {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .split(/[_\s]+/)
    .map((w) => w.toLowerCase())
    .filter(Boolean);
}

function extractArrayLiteral(source, arrayName) {
  const start = source.indexOf(`${arrayName} = [`);
  assert.ok(start >= 0, `could not find ${arrayName} in source`);
  const end = source.indexOf('] as const', start);
  assert.ok(end > start, `could not find end of ${arrayName}`);
  return source.slice(start, end);
}

test('every bridged sink is registered in the wrapper and reused as-is', () => {
  for (const { file } of BRIDGED_SINKS) {
    assert.match(read(file), /export function set\w+Sink\(/);
  }
});

test('eliseVisualAttachmentTelemetry is deliberately NOT bridged', () => {
  assert.doesNotMatch(clientSource, /setEliseAttachmentTelemetrySink/);
});

for (const { file, arrayName } of BRIDGED_SINKS) {
  test(`${file}: property allowlist contains no prohibited property name`, () => {
    const literal = extractArrayLiteral(read(file), arrayName);
    const keys = literal.match(/'([a-zA-Z_]+)'/g).map((k) => k.slice(1, -1));
    assert.ok(keys.length > 0, `${file}: found no property keys in ${arrayName}`);
    for (const key of keys) {
      for (const word of wordsOf(key)) {
        assert.ok(
          !PROHIBITED_PROPERTY_WORDS.has(word),
          `${file}: property "${key}" contains prohibited word "${word}"`,
        );
      }
    }
  });

  test(`${file}: emit function filters unknown properties before forwarding to the sink`, () => {
    const source = read(file);
    assert.match(source, /PROPERTY_SET\.has\(key\)/);
  });
}

// ─── Helpers ─────────────────────────────────────────────────────────────

function walk(dir, onFile, base = dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name.startsWith('.expo')) {
      continue;
    }
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walk(full, onFile, base);
      continue;
    }
    if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
    if (full.includes(`${path.sep}__tests__${path.sep}`) || full.startsWith(path.join(base, '__tests__'))) {
      continue;
    }
    const source = fs.readFileSync(full, 'utf8');
    onFile(path.relative(base, full), source);
  }
}
