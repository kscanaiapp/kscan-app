// REG-KPLUS-003 — eas.json must have no duplicate keys, and the staging profile
// must be one deterministic object.
//
// JSON permits duplicate keys and silently resolves them last-wins. eas.json had
// TWO `build.staging` objects: a merge (3a7e563 "converge iOS B3 lineage")
// concatenated the iOS line's newer governed staging profile with the older
// Aug-4 profile instead of merging them. Because the newer one was written
// FIRST, last-wins made the OLDER one effective and silently discarded the newer
// one — including EXPO_PUBLIC_ENVIRONMENT="staging" itself.
//
// Nothing detected it: every JSON.parse in the repo, and EAS itself, sees only
// the survivor.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const EAS_PATH = path.join(ROOT, 'eas.json');
const RAW = fs.readFileSync(EAS_PATH, 'utf8');

/**
 * Collects every duplicated key in a JSON document.
 *
 * JSON.parse cannot report duplicates — it silently keeps the last value — and
 * Node has no object_pairs_hook, so this scans the raw text: track a Set of keys
 * per open object, and flag any key seen twice at the same level.
 */
function findDuplicateKeys(raw) {
  const duplicates = [];
  const objects = [];
  let i = 0;
  while (i < raw.length) {
    const ch = raw[i];
    if (ch === '"') {
      let j = i + 1;
      let text = '';
      while (j < raw.length) {
        if (raw[j] === '\\') { text += raw[j + 1]; j += 2; continue; }
        if (raw[j] === '"') break;
        text += raw[j];
        j += 1;
      }
      // A string followed by ':' is a key, not a value.
      let k = j + 1;
      while (k < raw.length && /\s/.test(raw[k])) k += 1;
      if (raw[k] === ':' && objects.length > 0) {
        const level = objects[objects.length - 1];
        if (level.has(text)) duplicates.push({ key: text, depth: objects.length });
        level.add(text);
      }
      i = j + 1;
      continue;
    }
    if (ch === '{') objects.push(new Set());
    else if (ch === '}') objects.pop();
    i += 1;
  }
  return duplicates;
}

test('eas.json contains no duplicate keys anywhere', () => {
  const duplicates = findDuplicateKeys(RAW);
  assert.deepEqual(
    duplicates,
    [],
    `duplicate JSON keys silently drop configuration: ${JSON.stringify(duplicates)}`,
  );
});

test('the duplicate detector actually detects a duplicate (self-check)', () => {
  // Without this, the test above would pass on a broken detector.
  const broken = '{"build":{"staging":{"a":1},"staging":{"a":2}}}';
  const found = findDuplicateKeys(broken);
  assert.equal(found.length, 1);
  assert.equal(found[0].key, 'staging');
});

test('there is exactly ONE build.staging profile', () => {
  const occurrences = RAW.match(/^\s{4}"staging":\s*\{/gm) ?? [];
  assert.equal(occurrences.length, 1, 'a second staging profile silently wins over the first');
});

// ── Effective staging values (snapshot) ──────────────────────────────────────

const eas = JSON.parse(RAW);
const staging = eas.build.staging;

test('the staging profile keeps its release-style artifact shape', () => {
  // Unchanged from what builds actually produced before the de-duplication, so
  // the merge cannot alter the artifact.
  assert.equal(staging.distribution, 'internal');
  assert.equal(staging.autoIncrement, true);
  assert.equal(staging.android.buildType, 'apk');
  assert.equal(staging.ios.buildConfiguration, 'Release');
});

test('staging declares itself as staging and targets the staging project', () => {
  // EXPO_PUBLIC_ENVIRONMENT lived only in the discarded block, so the effective
  // staging profile did not know it was staging.
  assert.equal(staging.env.EXPO_PUBLIC_ENVIRONMENT, 'staging');
  assert.equal(
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'https://yzqjvdfgefveprobvvyw.supabase.co',
    'staging must never point at the production project',
  );
});

test('the six flags the bad merge discarded are restored', () => {
  for (const flag of [
    'EXPO_PUBLIC_ELISE_IDENTIFICATION_V2_ENABLED',
    'EXPO_PUBLIC_ENVIRONMENT',
    'EXPO_PUBLIC_AVATAR_MOTION_V1',
    'EXPO_PUBLIC_ELISE_V10',
    'EXPO_PUBLIC_ELISE_SPEECH',
    'EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED',
  ]) {
    assert.ok(flag in staging.env, `${flag} must be present in the merged staging profile`);
  }
});

test('no secret-shaped value is introduced, and the anon key stays an anon key', () => {
  const anon = staging.env.EXPO_PUBLIC_SUPABASE_ANON_KEY;
  assert.ok(typeof anon === 'string' && anon.length > 0);
  const payload = JSON.parse(Buffer.from(anon.split('.')[1], 'base64').toString('utf8'));
  assert.equal(payload.role, 'anon', 'a service_role key must never appear in eas.json');
  assert.equal(payload.ref, 'yzqjvdfgefveprobvvyw');
  // Nothing in any profile may look like a service-role or provider secret.
  assert.doesNotMatch(RAW, /service_role/);
  assert.doesNotMatch(RAW, /RAPIDAPI_KEY"\s*:\s*"[^"]+"/);
});

test('the production profile is untouched by the staging de-duplication', () => {
  assert.ok(eas.build.production, 'production profile must still exist');
  assert.notEqual(
    eas.build.production.env?.EXPO_PUBLIC_SUPABASE_URL,
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'production and staging must not share a backend target',
  );
});

test('every build profile is a plain object with an env map', () => {
  for (const [name, profile] of Object.entries(eas.build)) {
    assert.equal(typeof profile, 'object', `${name} must be an object`);
    assert.ok(!Array.isArray(profile), `${name} must not be an array`);
  }
});

// ── Staging-certification artifact profile (Build 34 Android certification) ──
//
// The Build 34 staging certification requires a RELEASE-SHAPED AAB that is
// INTENTIONALLY connected to the staging backend. Neither original profile can
// produce it: `production` bakes the production Supabase project, and `staging`
// produces an internal-distribution APK. This profile is the one governed way
// to build that artifact. It must never define its own env: inheriting the
// staging env verbatim (via `extends`) is what guarantees it can never drift
// onto the production backend.

test('staging-certification produces a store-shaped bundle on the staging backend', () => {
  const cert = eas.build['staging-certification'];
  assert.ok(cert, 'staging-certification profile must exist');
  assert.equal(cert.extends, 'staging', 'must inherit the staging env verbatim');
  assert.equal(cert.distribution, 'store');
  assert.equal(cert.autoIncrement, true);
  assert.equal(cert.android.buildType, 'app-bundle');
  assert.equal(cert.ios.buildConfiguration, 'Release');
});

// ── Build 34 certification feature matrix (owner rulings, P2-EAS-FLAGS) ──────
//
// Per-feature verification found K+ Early Access and Watchlist NOT closed
// (K+: the deployed `kplus-activate` function on staging predates the
// SEC-KPLUS-008 fix in ancestry — a possible lost repair, owner action
// required; Watchlist: zero recorded or database evidence of the
// scan-to-Watch-to-refresh path ever running end-to-end on staging). VTO,
// Packing Intelligence, and Wardrobe Concierge were each proven fully closed
// (ancestry + staging runtime + probe/fail-closed evidence) and are enabled
// here. Voice Scan stays off in THIS profile.
//
// Two of the notes above have since been superseded for the iOS
// `testflight-staging` profile, and are left here because they remain the
// correct rulings for the ANDROID certification artifact:
//   - K+: the staging `kplus-activate` deployment was refreshed on
//     2026-09-01 and now carries the SEC-KPLUS-008 repair (verified against
//     the deployed source), so the "possible lost repair" is closed. The
//     Android matrix still excludes K+ because that certification's evidence
//     was gathered before the refresh.
//   - Voice Scan: VOICESCAN_ENABLED is no longer a hardcoded constant — it is
//     now env-resolved and fail-closed (constants/featureFlags.ts). It stays
//     absent from this profile's env, so it remains OFF here; the resolver's
//     default is off and __tests__/testflightStagingProfile.test.js asserts
//     that EVERY profile except `testflight-staging` resolves it off.
//
// `staging-certification` may now define its OWN `env`, but only as a
// narrow additive override on top of the inherited staging env (via
// `extends`) — it must never redeclare the backend identity (Supabase URL /
// anon key / EXPO_PUBLIC_ENVIRONMENT), and it must contain exactly the
// approved matrix keys, nothing else.

const { resolveEasBuildProfile } = require('../scripts/resolve-eas-build-profiles');

const CERT_MATRIX_ENABLED = Object.freeze([
  'EXPO_PUBLIC_VTO_UI_ENABLED',
  'EXPO_PUBLIC_PACKING_INTELLIGENCE_V1',
  'EXPO_PUBLIC_ELISE_CONCIERGE_V1',
]);

const CERT_MATRIX_EXCLUDED = Object.freeze([
  'EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED',
  'EXPO_PUBLIC_SMART_WATCHLIST_V1',
]);

const BACKEND_IDENTITY_KEYS = Object.freeze([
  'EXPO_PUBLIC_SUPABASE_URL',
  'EXPO_PUBLIC_SUPABASE_ANON_KEY',
  'EXPO_PUBLIC_ENVIRONMENT',
]);

test('staging-certification defines an env, but only the approved matrix override keys', () => {
  const cert = eas.build['staging-certification'];
  assert.ok(cert.env && typeof cert.env === 'object', 'staging-certification must define its matrix overrides');
  assert.deepEqual(
    Object.keys(cert.env).sort(),
    [...CERT_MATRIX_ENABLED].sort(),
    'staging-certification env must contain exactly the approved enabled-flag overrides, nothing else',
  );
  for (const key of BACKEND_IDENTITY_KEYS) {
    assert.ok(!(key in cert.env), `staging-certification must not redeclare backend identity key ${key}`);
  }
});

test('staging-certification cannot drift onto its own backend target', () => {
  const resolved = resolveEasBuildProfile(eas, 'staging-certification');
  assert.equal(
    resolved.env.EXPO_PUBLIC_SUPABASE_URL,
    staging.env.EXPO_PUBLIC_SUPABASE_URL,
    'staging-certification must inherit the staging backend verbatim, unchanged by its matrix overrides',
  );
  assert.equal(resolved.env.EXPO_PUBLIC_ENVIRONMENT, 'staging');
});

test('the effective (extends-resolved) staging-certification matrix equals the approved rulings exactly', () => {
  const resolved = resolveEasBuildProfile(eas, 'staging-certification');
  for (const key of CERT_MATRIX_ENABLED) {
    assert.equal(resolved.env[key], 'true', `${key} must be enabled in the effective staging-certification matrix`);
  }
  for (const key of CERT_MATRIX_EXCLUDED) {
    assert.notEqual(
      resolved.env[key],
      'true',
      `${key} must NOT be enabled in the effective staging-certification matrix (not closed server-side)`,
    );
  }
});

test('the ordinary staging profile is not broadened by the certification matrix', () => {
  for (const key of CERT_MATRIX_ENABLED) {
    assert.ok(!(key in staging.env), `${key} must not leak into the ordinary staging profile`);
  }
});

test('the production profile is not broadened by the certification matrix', () => {
  const production = eas.build.production;
  for (const key of CERT_MATRIX_ENABLED) {
    assert.ok(!(production.env && key in production.env), `${key} must not leak into the production profile`);
  }
});
