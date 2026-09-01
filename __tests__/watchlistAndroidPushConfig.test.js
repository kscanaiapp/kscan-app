// Watchlist Android push (Objective C) + Tier 2 sweep scheduling (Objective D):
// governed-configuration controls.
//
// Neither capability can be completed from a repository -- both need a
// credential only the owner can create. What CAN be proven from source, and is
// proven here, is that the repo never *claims* either is operational while its
// configuration is absent, and that both fail closed.
//
// This is the same defect class as DEF-WL-07: a complete implementation whose
// prerequisite was missing, reported by nothing. A test that merely asserted
// "the push module exists" would have passed throughout.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const exists = (rel) => fs.existsSync(path.join(ROOT, rel));

const appJson = JSON.parse(read('app.json'));
const androidConfig = appJson.expo.android ?? {};
const OPS_DOC = 'docs/watchlist-tier2-operations.md';

// ─────────────────────────────────────────── Objective C: Android FCM path ──

const APP_BUILD_GRADLE = 'android/app/build.gradle';
const ROOT_BUILD_GRADLE = 'android/build.gradle';

/**
 * Is the Android FCM path actually configured? Derived from the config, never
 * asserted as a constant, so this answers correctly the moment it changes.
 *
 * Build 34 added a THIRD mechanism, and it is the one this repository
 * actually uses. Android is NATIVE_AUTHORITATIVE, so `expo prebuild` never
 * runs for Android and `expo.android.googleServicesFile` — a CNG field —
 * would be inert: it would report "configured" while producing an AAB with no
 * Firebase configuration in it, which is precisely the silent-failure shape
 * this whole file exists to prevent. The native project materialises the file
 * from the governed EAS file secret instead, so that path counts as
 * configured too. The two CNG branches are kept because a future migration to
 * app.config.js would legitimately make them true again.
 */
function androidFcmConfigured() {
  if (typeof androidConfig.googleServicesFile === 'string' && androidConfig.googleServicesFile.trim()) {
    return true;
  }
  // app.config.js would be the mechanism if app.json (static) is replaced.
  for (const candidate of ['app.config.js', 'app.config.ts']) {
    if (exists(candidate) && /googleServicesFile/.test(read(candidate))) return true;
  }
  // Native (NATIVE_AUTHORITATIVE) wiring: the secret is copied into the app
  // module and the plugin is applied only when the file really landed.
  if (exists(APP_BUILD_GRADLE)) {
    const gradle = read(APP_BUILD_GRADLE);
    if (/GOOGLE_SERVICES_JSON/.test(gradle) && /com\.google\.gms\.google-services/.test(gradle)) {
      return true;
    }
  }
  return false;
}

test('Objective C: the Android FCM path and its EAS secret name are declared together', () => {
  // A one-sided configuration is the dangerous state: `googleServicesFile`
  // pointing at an env var nobody provisions produces an Android build that
  // looks configured and cannot send, which is worse than a build that is
  // openly unconfigured.
  const configured = androidFcmConfigured();
  const docDeclaresSecret = /GOOGLE_SERVICES_JSON/.test(read(OPS_DOC));
  assert.ok(
    docDeclaresSecret,
    'the ops doc must always name the expected EAS file secret so provisioning is a lookup, not a guess',
  );
  if (configured) {
    const doc = read(OPS_DOC);
    // Whichever mechanism is in use must be the one the doc describes. A doc
    // that still prescribes the CNG field while the build uses the native
    // path would send an operator to run `expo prebuild`, which regenerates
    // the committed Android project.
    assert.match(
      doc,
      /NATIVE_AUTHORITATIVE|expo\.android\.googleServicesFile/,
      'if FCM is wired, the ops doc must document the mechanism actually used',
    );
    assert.match(
      doc,
      new RegExp(androidConfig.package.replace(/\./g, '\\.')),
      'the ops doc must name the exact Android package the Firebase app is registered against',
    );
  }
});

// ── Build 34: the native FCM path, and the ways it can be half-wired ────────

test('Objective C: the FCM secret is materialised into the native project, not a CNG field', () => {
  const gradle = read(APP_BUILD_GRADLE);
  assert.match(gradle, /GOOGLE_SERVICES_JSON/, 'the governed EAS file secret must be read by the native build');
  assert.match(
    gradle,
    /apply plugin: 'com\.google\.gms\.google-services'/,
    'the Google Services plugin must be applied for the app to obtain an FCM token',
  );
  assert.match(
    read(ROOT_BUILD_GRADLE),
    /com\.google\.gms:google-services/,
    'the plugin classpath must be declared at the root project',
  );
  // Android is NATIVE_AUTHORITATIVE: the CNG field would be inert here and
  // its presence would mean someone believed prebuild runs for Android.
  assert.equal(
    androidConfig.googleServicesFile,
    undefined,
    'expo.android.googleServicesFile is a CNG field and must NOT be set while Android is NATIVE_AUTHORITATIVE',
  );
});

test('Objective C: the plugin is applied CONDITIONALLY, so an unprovisioned build still succeeds', () => {
  // An unconditional `apply plugin` fails the build with "File
  // google-services.json is missing" for every developer and every profile
  // without the secret -- including production, which must stay unchanged.
  const gradle = read(APP_BUILD_GRADLE);
  assert.match(
    gradle,
    /if \(googleServicesConfigured\) \{\s*apply plugin: 'com\.google\.gms\.google-services'/,
    'the plugin must be applied only when a real google-services.json is present',
  );
  assert.match(gradle, /googleServicesConfigured=/, 'the build must state the resolved FCM configuration');
});

test('Objective C: no Firebase product beyond messaging configuration is introduced', () => {
  // Play Data Safety and the app's own privacy posture both depend on this:
  // enabling FCM must not smuggle in Analytics, Ads, or Crashlytics.
  const gradle = read(APP_BUILD_GRADLE) + read(ROOT_BUILD_GRADLE);
  for (const forbidden of [
    'firebase-analytics',
    'firebase-crashlytics',
    'firebase-perf',
    'play-services-ads',
    'com.google.firebase.crashlytics',
    'com.android.installreferrer',
  ]) {
    assert.ok(!gradle.includes(forbidden), `${forbidden} must not be added merely to enable FCM`);
  }
});

test('Objective C SECURITY CONTROL: google-services.json is never committed', () => {
  // This repository is public. The Firebase config carries the API key and
  // app identifiers.
  assert.ok(!exists('android/app/google-services.json'), 'google-services.json must not exist in the tree');
  assert.ok(exists('android/app/.gitignore'), 'the app module must carry a .gitignore');
  assert.match(
    read('android/app/.gitignore'),
    /google-services\.json/,
    'google-services.json must be git-ignored so it cannot be committed by accident',
  );
});

test('Objective C: the package identity and Play signing lineage are untouched by the FCM work', () => {
  assert.equal(androidConfig.package, 'com.kscanai.app');
  const gradle = read(APP_BUILD_GRADLE);
  assert.match(gradle, /applicationId 'com\.kscanai\.app'/);
  assert.match(gradle, /Release signing is managed by EAS Build/,
    'release signing must still be delegated to EAS credentials, not redefined');
  // Only the debug keystore may be declared in source. A `release` entry
  // inside signingConfigs would take over signing from EAS credentials and
  // break the Play signing lineage. Scoped to the signingConfigs block: a
  // naive whole-file scan matches the unrelated `release` build type.
  const signingBlock = gradle.slice(
    gradle.indexOf('signingConfigs {'),
    gradle.indexOf('buildTypes {'),
  );
  assert.ok(signingBlock.includes('debug {'), 'the signingConfigs block must be located');
  assert.doesNotMatch(signingBlock, /\brelease\s*\{/,
    'no release signingConfig may be introduced in source -- EAS owns Play signing');
});

test('Objective C NEGATIVE CONTROL: nothing may claim Android Watchlist push works while FCM is absent', () => {
  // The control that bites. If someone later flips an Android push capability on
  // without wiring FCM, this fails on that commit.
  if (androidFcmConfigured()) return; // configured — nothing to guard.

  const push = read('services/watchlist/pushRegistration.ts');
  assert.doesNotMatch(
    push,
    /androidPushSupported\s*=\s*true|ANDROID_PUSH_READY\s*=\s*true/,
    'no source may declare Android push ready while google-services config is absent',
  );

  // And the gap must be recorded where an operator will find it, naming the
  // package the Firebase app has to be registered against.
  const doc = read(OPS_DOC);
  assert.match(doc, /OWNER CREDENTIAL REQUIRED/, 'the blocker must be stated plainly');
  assert.match(doc, new RegExp(androidConfig.package.replace(/\./g, '\\.')),
    'the ops doc must name the exact Android package the Firebase app needs');
  assert.match(doc, /expo config --type introspect/, 'a validation command must be given');
});

test('Objective C: iOS aps configuration is untouched', () => {
  const ios = appJson.expo.ios ?? {};
  const entitlements = ios.entitlements ?? {};
  assert.ok(
    'aps-environment' in entitlements || ios.usesAppleSignIn !== undefined,
    'iOS config must remain present and unmodified by the Android work',
  );
  assert.equal(
    androidConfig.package,
    'com.kscanai.app',
    'the Android package must not drift while wiring push',
  );
});

// ───────────────────────────────── Objective D: Tier 2 sweep, fail-closed ──

const WORKFLOW = '.github/workflows/watchlist-tier2-sweep.yml';

test('Objective D: a scheduler exists for the sweep, and it is not a second framework', () => {
  assert.ok(exists(WORKFLOW), 'the Tier 2 sweep must have an invoker');
  const wf = read(WORKFLOW);
  assert.match(wf, /commerce-watch-refresh/, 'it must call the governed endpoint');
  assert.match(
    wf,
    /x-watchlist-worker-secret/,
    'it must use the header the worker actually authenticates on',
  );
  assert.doesNotMatch(wf, /x-worker-secret:/, 'the deletion worker header name would 401 here');
});

test('Objective D: no hard-coded worker secret anywhere', () => {
  const wf = read(WORKFLOW);
  assert.match(wf, /secrets\.WATCHLIST_WORKER_SECRET/, 'the secret must come from the secret store');
  // Nothing that looks like a literal value may sit beside the header.
  assert.doesNotMatch(
    wf,
    /x-watchlist-worker-secret:\s*[A-Za-z0-9+/=]{12,}/,
    'the secret must never be inlined',
  );
  const fn = read('supabase/functions/commerce-watch-refresh/index.ts');
  assert.match(fn, /envOptional\('WATCHLIST_WORKER_SECRET'\)/);
  assert.doesNotMatch(fn, /WATCHLIST_WORKER_SECRET\s*=\s*'/, 'no default value may exist in source');
});

test('Objective D NEGATIVE CONTROL: the sweep fails closed when unprovisioned', () => {
  const wf = read(WORKFLOW);
  // An unconfigured sweep that exits 0 is indistinguishable from one that ran
  // and found nothing -- exactly how this feature looked healthy while never
  // running. It must exit non-zero instead.
  assert.match(wf, /NOT provisioned/, 'the unprovisioned case must be reported');
  assert.match(wf, /exit 1/, 'and must fail the job rather than pass quietly');

  // The function refuses without a secret, independently of the workflow.
  const fn = read('supabase/functions/commerce-watch-refresh/index.ts');
  assert.match(
    fn,
    /if \(!expected \|\| !provided\) return false;/,
    'an absent secret must refuse, never authorise',
  );
});

test('Objective D: enablement is governed by app_config and seeded OFF (no production activation)', () => {
  const migration = 'supabase/migrations/20260831000100_watchlist_worker_enablement.sql';
  assert.ok(exists(migration), 'the kill-switch row must exist as a governed migration');
  const sql = read(migration);
  assert.match(sql, /watchlist_worker_enabled/);
  assert.match(sql, /"enabled":\s*false/, 'it must be seeded OFF — this activates nothing');
  assert.match(sql, /on conflict \(key\) do nothing/, 'it must never overwrite an owner decision');

  const fn = read('supabase/functions/commerce-watch-refresh/index.ts');
  assert.match(
    fn,
    /readAppConfigFlag\('watchlist_worker_enabled'\)/,
    'the worker must read the governed flag, not an env var or request field',
  );
});

test('Objective D: the schedule is inert and production is not targeted', () => {
  const wf = read(WORKFLOW);
  const uncommented = wf
    .split('\n')
    .filter((line) => !line.trim().startsWith('#'))
    .join('\n');
  assert.doesNotMatch(uncommented, /^\s*schedule:/m, 'the cron schedule must remain commented out');
  assert.doesNotMatch(uncommented, /PRODUCTION|wyyuqfdxucjksghsmhry/i,
    'the production project must never be targeted from this workflow');
  assert.match(uncommented, /SUPABASE_STAGING_FUNCTIONS_URL/, 'staging is the only configured target');
});

test('Objective D: no provider work runs from the scheduler, and retailer neutrality holds', () => {
  const wf = read(WORKFLOW);
  for (const retailer of ['farfetch', 'kickscrew', 'asos', 'poshmark', 'vinted', 'serper', 'brave']) {
    assert.doesNotMatch(
      wf.toLowerCase(),
      new RegExp(retailer),
      `no retailer may be named in the scheduler (${retailer})`,
    );
  }
  // It posts one request and reads counts; it must not fetch listings itself.
  assert.doesNotMatch(wf, /rapidapi|https:\/\/api\./i, 'provider calls belong server-side only');
});

test('Objective D: the worker secret name is recorded in the secret-name manifest', () => {
  // The audit found WATCHLIST_WORKER_SECRET absent from the manifest, so an
  // operator rebuilding an environment had no way to know it was needed.
  const manifest = read('docs/staging-rebuild/secret-name-manifest.md');
  assert.match(
    manifest,
    /WATCHLIST_WORKER_SECRET/,
    'a secret the code reads must appear in the names manifest',
  );
});
