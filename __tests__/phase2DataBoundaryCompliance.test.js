// PHASE 2 DATA-BOUNDARY COMPLIANCE (Build 25 Phase 2 addendum).
//
// Narrow Google Play compliance guards for the boundaries Phase 2 actually
// touched: image intake, thumbnail derivation, Closet state, and the commerce
// handoff. Each property below was verified to hold when these were written;
// none of them had a test, which is the only reason they are here.
//
// Deliberately NOT in scope: moderation, Dressing Rooms, account deletion,
// authentication architecture, and the retailer destination quality that BUG-02
// covers in Phase 3.
//
// A note on what is NOT a finding: every Supabase call carries an
// `Authorization: Bearer <access_token>` header applied by supabase-js, and that
// JWT contains the actor id. That is how an authenticated API works — the guards
// below are about payload minimization, not about removing authentication.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

/** Every module that owns Closet state, Closet media, or Recent Scan media. */
const OFFLINE_LAYER = [
  'services/library.js',
  'services/closetLibrary.js',
  'services/closetCandidateMedia.js',
  'services/closetCandidatePromotion.js',
  'services/closetCandidateLibrary.js',
  'services/closetPromotion.js',
  'services/closetIntakeRouting.js',
  'services/closetItemProjection.ts',
  'hooks/useCloset.js',
  'hooks/useClosetCandidates.js',
].filter(exists);

const PROTECTED_PROJECT_REFS = ['yzqjvdfgefveprobvvyw', 'wyyuqfdxucjksghsmhry'];

// ── The Closet and media layer never talks to the network ────────────────────

test('the Closet and media layer performs no network call at all', () => {
  assert.ok(OFFLINE_LAYER.length >= 8, 'the offline layer should not have shrunk');
  for (const rel of OFFLINE_LAYER) {
    const source = stripComments(read(rel));
    assert.equal(/\bsupabase\b/.test(source), false, `${rel} reaches Supabase`);
    assert.equal(/\bfetch\s*\(/.test(source), false, `${rel} performs a fetch`);
    assert.equal(/\.invoke\s*\(/.test(source), false, `${rel} invokes an Edge Function`);
  }
});

test('BUG-05 did not introduce an upload path', () => {
  // The thumbnail repair raised a local derivative's size. It must not have
  // turned a local file into something that is transmitted.
  for (const rel of ['services/library.js', 'services/closetLibrary.js', 'services/closetCandidateMedia.js']) {
    const source = stripComments(read(rel));
    assert.equal(/\.upload\s*\(/.test(source), false, `${rel} uploads media`);
    assert.equal(/createSignedUrl|getPublicUrl/.test(source), false, `${rel} publishes media`);
  }
});

test('a local file path never reaches the cloud scan row', () => {
  // This is the one line keeping device paths out of cloud metadata.
  const source = read('services/savedScansCloud.ts');
  assert.match(source, /image_uri: null/, 'the cloud row must null the local image path');
  assert.match(source, /thumbnail_uri: null/, 'the cloud row must null the local thumbnail path');
});

// ── Commerce and product search receive no image and no identity ─────────────

test('the commerce request builders send text, never an image or an identifier', () => {
  const builders = [
    'services/secondhand.js',
    'services/productSearchDeals.ts',
    'services/sneakers/providers/kickscrewRapidApi.ts',
  ].filter(exists);
  assert.ok(builders.length >= 2, 'expected the commerce builders to still exist');

  const forbidden = [
    /imageBase64/,
    /\bbase64\b/,
    /data:image\//,
    /file:\/\//,
    /\buserId\b/,
    /\bemail\b/,
    /accessToken|refreshToken/,
    /deviceId|installId/,
    /latitude|longitude/,
  ];
  for (const rel of builders) {
    const source = stripComments(read(rel));
    for (const pattern of forbidden) {
      assert.equal(
        pattern.test(source),
        false,
        `${rel} mentions ${pattern} — a commerce request must carry only search terms`,
      );
    }
  }
});

test('a Closet intake cannot ask the scanner to shop', () => {
  // The intent is the structural boundary: Closet classification declares
  // identify_for_closet and the request validator rejects anything else, so an
  // owned-item intake cannot reach the commerce router at all.
  const source = read('services/closetIdentificationV2.ts');
  assert.match(source, /identify_for_closet/);
  assert.equal(
    /identify_and_shop/.test(stripComments(source)),
    false,
    'the Closet intent must never be the shopping intent',
  );
});

// ── Logging and secrets ──────────────────────────────────────────────────────

test('the Closet and media layer logs nothing', () => {
  // Not "logs nothing sensitive" — logs nothing. These modules handle local
  // image paths and account-scoped records, and a bounded rule is the only one
  // that stays true as they change.
  for (const rel of OFFLINE_LAYER) {
    const source = stripComments(read(rel));
    assert.equal(
      /console\.(log|warn|error|info|debug)/.test(source),
      false,
      `${rel} logs; this layer handles local media paths and account records`,
    );
  }
});

test('no credential, token or raw image is logged on the touched surfaces', () => {
  const surfaces = [
    'app/library.tsx',
    'components/scan-results/ScanResultV2.tsx',
    'components/scan-results/ScanResultActionRow.tsx',
    'components/scan-results/ScanResultHero.tsx',
    'components/closet/ClosetCandidateStatusPanel.tsx',
  ].filter(exists);

  for (const rel of surfaces) {
    const source = stripComments(read(rel));
    for (const line of source.split('\n')) {
      if (!/console\.(log|warn|error|info|debug)/.test(line)) continue;
      assert.equal(
        /token|Authorization|apikey|api_key|secret|password|base64|imageBase64|service_role/i.test(
          line,
        ),
        false,
        `${rel} logs a credential or a raw image: ${line.trim()}`,
      );
    }
  }
});

test('no service-role key is present in client source', () => {
  for (const rel of [...OFFLINE_LAYER, 'services/supabaseClient.ts'].filter(exists)) {
    assert.equal(
      /service_role|SERVICE_ROLE/.test(read(rel)),
      false,
      `${rel} references a service-role credential`,
    );
  }
});

test('the Closet failure message is curated copy, not a diagnostic', () => {
  // app/library.tsx renders closet.error.message directly, which is only safe
  // because the loader produces user-facing copy and never exception text.
  const loader = read('services/closetLibrary.js');
  const fails = [...loader.matchAll(/fail\(\s*CLOSET_LOAD_CODES\.\w+,\s*(['"`])([\s\S]*?)\1/g)];
  assert.ok(fails.length >= 3, 'expected the typed loader to produce curated messages');
  for (const [, , message] of fails) {
    assert.equal(/\/|\\|Error:|at\s|SELECT |RLS/.test(message), false, `leaky message: ${message}`);
  }
});

// ── Endpoint isolation ───────────────────────────────────────────────────────

test('no protected project ref is hardcoded in Phase 2 source', () => {
  const touched = [
    ...OFFLINE_LAYER,
    'app/library.tsx',
    'components/scan-results/ScanResultV2.tsx',
    'services/savedScansCloud.ts',
    'services/supabaseClient.ts',
  ].filter(exists);

  for (const rel of touched) {
    const source = read(rel);
    for (const ref of PROTECTED_PROJECT_REFS) {
      assert.equal(source.includes(ref), false, `${rel} hardcodes the hosted project ${ref}`);
    }
  }
});

test('the Supabase endpoint comes from the build environment and fails closed', () => {
  // Preserved, not replaced: __tests__/authEnvironment.test.js owns the profile
  // posture. This asserts the property that matters for a LOCAL runtime — an
  // absent configuration must not resolve to a real project.
  const source = read('services/supabaseClient.ts');
  assert.match(source, /process\.env\.EXPO_PUBLIC_SUPABASE_URL/);
  assert.match(source, /process\.env\.EXPO_PUBLIC_SUPABASE_ANON_KEY/);
  for (const ref of PROTECTED_PROJECT_REFS) {
    assert.equal(source.includes(ref), false, 'the client must not name a hosted project');
  }
  assert.match(
    source,
    /missing-supabase-url/,
    'the fallback must be an unresolvable sentinel, never a real project',
  );
});

test('no runtime env file exists to point a local build at a hosted project', () => {
  // Expo loads .env* at build time; a stray one silently overrides the local
  // Docker configuration and sends a "local" runtime at a hosted project.
  //
  // The *.example files are NOT checked here. They are templates that Expo never
  // loads, and .env.e2e.example does name the production project on active
  // lines — that is a real hygiene item, but it belongs to the E2E tooling and
  // not to a Phase 2 data path, so it is reported rather than edited here.
  for (const name of [
    '.env',
    '.env.local',
    '.env.development',
    '.env.production',
    '.env.staging',
    '.env.e2e',
  ]) {
    assert.equal(exists(name), false, `${name} must not exist in the worktree`);
  }
});

// ── Permission and dependency non-regression ─────────────────────────────────

test('Phase 2 adds no permission, plugin or native capability', () => {
  const app = JSON.parse(read('app.json'));
  const config = app.expo ?? app;

  // RECORD_AUDIO excluded from this Phase-2-scoped list as of Build 34
  // Voice Scan V1: it is now a real, flag-gated permission added by a
  // later, unrelated feature -- not a Phase 2 regression. See
  // __tests__/androidPermissionBlocklist.test.js for its own coverage.
  const androidPermissions = config.android?.permissions ?? [];
  for (const forbidden of [
    'android.permission.ACCESS_FINE_LOCATION',
    'android.permission.ACCESS_BACKGROUND_LOCATION',
    'android.permission.READ_EXTERNAL_STORAGE',
    'com.google.android.gms.permission.AD_ID',
  ]) {
    assert.equal(
      androidPermissions.includes(forbidden),
      false,
      `Phase 2 must not add ${forbidden}`,
    );
  }

  const plugins = JSON.stringify(config.plugins ?? []);
  for (const tracker of ['facebook', 'appsflyer', 'segment', 'amplitude', 'firebase-analytics']) {
    assert.equal(plugins.toLowerCase().includes(tracker), false, `a tracking SDK appeared: ${tracker}`);
  }
});

test('Phase 2 adds no dependency', () => {
  const pkg = JSON.parse(read('package.json'));
  const all = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  for (const forbidden of [
    'react-native-fbsdk-next',
    '@react-native-firebase/analytics',
    'react-native-device-info',
    '@react-native-ml-kit/face-detection',
    'expo-tracking-transparency',
  ]) {
    assert.equal(forbidden in all, false, `Phase 2 must not add ${forbidden}`);
  }
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the offline and logging gates detect what they forbid', () => {
  // Exactly the shapes the gates above scan for, proven to be caught.
  const withFetch = "const r = await fetch('https://example.test');";
  assert.equal(/\bfetch\s*\(/.test(withFetch), true);

  const withInvoke = "await supabase.functions.invoke('scan-identify', { body });";
  assert.equal(/\.invoke\s*\(/.test(withInvoke), true);
  assert.equal(/\bsupabase\b/.test(withInvoke), true);

  const tokenLog = "console.log('auth', session.access_token);";
  assert.equal(/console\.(log|warn|error|info|debug)/.test(tokenLog), true);

  const imageLog = "console.log('payload', imageBase64);";
  assert.equal(
    /token|Authorization|apikey|api_key|secret|password|base64|imageBase64|service_role/i.test(
      imageLog,
    ),
    true,
    'a raw-image log must be caught',
  );
});

test('NEGATIVE CONTROL: a protected project ref in configuration is detected', () => {
  const leaked = 'EXPO_PUBLIC_SUPABASE_URL=https://wyyuqfdxucjksghsmhry.supabase.co';
  assert.equal(
    PROTECTED_PROJECT_REFS.some((ref) => leaked.includes(ref)),
    true,
    'a production ref in local runtime configuration must be caught',
  );
  const staging = 'EXPO_PUBLIC_SUPABASE_URL=https://yzqjvdfgefveprobvvyw.supabase.co';
  assert.equal(PROTECTED_PROJECT_REFS.some((ref) => staging.includes(ref)), true);
  // And a genuinely local runtime passes.
  assert.equal(
    PROTECTED_PROJECT_REFS.some((ref) => 'http://127.0.0.1:54321'.includes(ref)),
    false,
  );
});

test('NEGATIVE CONTROL: an image or identifier in a commerce body is detected', () => {
  const leakedImage = 'const body = { q: query, imageBase64: compressed };';
  assert.equal(/imageBase64/.test(leakedImage), true);

  const leakedUser = 'const body = { q: query, userId: session.user.id };';
  assert.equal(/\buserId\b/.test(leakedUser), true);

  const leakedPath = "const body = { q: query, source: 'file:///data/user/0/img.jpg' };";
  assert.equal(/file:\/\//.test(leakedPath), true);

  // A legitimate text-only body is not flagged.
  const clean = 'const body = { q: query, limit, country };';
  for (const pattern of [/imageBase64/, /\buserId\b/, /file:\/\//, /\bbase64\b/]) {
    assert.equal(pattern.test(clean), false);
  }
});
