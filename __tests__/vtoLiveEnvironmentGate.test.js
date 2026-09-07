// The Live VTO environment gate: a Live-enabled build may resolve to STAGING
// and to nothing else.
//
// WHY THIS IS MECHANICAL AND NOT A REVIEW NOTE (mission section 37). "Do not
// enable Live against production" is the kind of rule that holds until the
// day somebody adds one line to a profile that inherits from another profile
// that inherits from a third. Human inspection cannot see through `extends`;
// this test can, because it resolves every profile the way EAS does and then
// asks the question of the RESOLVED environment.
//
// THE NEGATIVE CONTROL IS THE POINT. A gate that has only ever been run
// against a repository that already passes is not evidence that it can fail.
// `theGateRefusesALiveEnabledProductionCandidate` builds exactly the profile
// this rule exists to stop and asserts the same function refuses it.
//
// WHY LIVE IS ENABLED ON `staging-certification` AND NOT ON `staging`.
// __tests__/staging/easProfileParity.test.js enforces a deliberate control:
// the `staging` profile must expose EXACTLY production's client-feature flag
// set, because "staging must not enable behavior that production has not
// shipped". Live is behavior production has not shipped, so putting the flag
// on `staging` would have required either shipping it to production (which
// this lane is not authorized to do) or writing a false justification into
// that gate's environment-specific allowlist. `staging-certification` is the
// established home for exactly this case -- it already carries
// EXPO_PUBLIC_VOICESCAN_ENABLED, EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED and
// EXPO_PUBLIC_SMART_WATCHLIST_V1 on the same reasoning -- and it inherits the
// staging backend from `staging`, which is what makes the resolved answer
// correct rather than merely permitted.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

const LIVE_FLAG = 'EXPO_PUBLIC_LIVE_VTO_ENABLED';
const URL_KEY = 'EXPO_PUBLIC_SUPABASE_URL';

function readEas() {
  return JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
}

/**
 * Resolves a profile's effective env the way EAS does -- parent first, child
 * overriding. Cycle-guarded rather than trusted: a malformed `extends` chain
 * must fail loudly here, not hang a release gate.
 */
function resolveEnv(build, profileName, seen = new Set()) {
  assert.ok(build[profileName], `eas.json has no "${profileName}" build profile`);
  assert.ok(!seen.has(profileName), `eas.json has a circular extends chain at "${profileName}"`);
  seen.add(profileName);
  const profile = build[profileName];
  const parent = profile.extends ? resolveEnv(build, profile.extends, seen) : {};
  return { ...parent, ...(profile.env || {}) };
}

/** The rule itself, as a function, so the negative control can run the SAME
 *  code against a candidate the repository does not contain. */
function classifyLiveTarget(env) {
  const liveEnabled = env[LIVE_FLAG] === 'true';
  const url = env[URL_KEY] ?? '';
  const targetsProduction = url.includes(PRODUCTION_PROJECT_REF);
  const targetsStaging = url.includes(STAGING_PROJECT_REF);
  if (!liveEnabled) return { verdict: 'live_disabled' };
  if (targetsProduction) return { verdict: 'refused', reason: 'live_enabled_against_production' };
  if (!targetsStaging) return { verdict: 'refused', reason: 'live_enabled_against_unrecognised_backend' };
  return { verdict: 'allowed' };
}

test('every EAS profile that enables Live resolves to the STAGING project', () => {
  const build = readEas().build;
  const offenders = [];
  let liveEnabledProfiles = 0;
  for (const name of Object.keys(build)) {
    const env = resolveEnv(build, name);
    const result = classifyLiveTarget(env);
    if (result.verdict === 'refused') offenders.push(`${name}: ${result.reason}`);
    if (result.verdict === 'allowed') liveEnabledProfiles += 1;
  }
  assert.deepEqual(offenders, [], `Live VTO is enabled against a non-staging backend: ${offenders.join('; ')}`);
  // A gate that passes because nothing enables Live anywhere proves nothing
  // about this lane's actual activation, so the activation itself is pinned.
  assert.ok(
    liveEnabledProfiles >= 1,
    'no EAS profile enables Live VTO -- the staging pilot candidate has no activation at all',
  );
});

test('THE NEGATIVE CONTROL: the gate refuses a Live-enabled production candidate', () => {
  const forged = {
    [LIVE_FLAG]: 'true',
    [URL_KEY]: `https://${PRODUCTION_PROJECT_REF}.supabase.co`,
  };
  assert.deepEqual(classifyLiveTarget(forged), {
    verdict: 'refused',
    reason: 'live_enabled_against_production',
  });

  // And an unrecognised backend is refused too -- "not production" is not the
  // same claim as "staging", and a typo in a project ref must not pass.
  assert.deepEqual(
    classifyLiveTarget({ [LIVE_FLAG]: 'true', [URL_KEY]: 'https://example.supabase.co' }),
    { verdict: 'refused', reason: 'live_enabled_against_unrecognised_backend' },
  );

  // The real staging candidate passes the same function, so the control is
  // discriminating rather than simply always-refusing.
  assert.deepEqual(
    classifyLiveTarget({ [LIVE_FLAG]: 'true', [URL_KEY]: `https://${STAGING_PROJECT_REF}.supabase.co` }),
    { verdict: 'allowed' },
  );
});

test('the production, preview and development profiles do NOT enable Live', () => {
  const build = readEas().build;
  for (const name of ['production', 'preview', 'development']) {
    const env = resolveEnv(build, name);
    assert.notEqual(
      env[LIVE_FLAG],
      'true',
      `${name} must not enable Live VTO -- production activation is not authorized`,
    );
  }
});

test('the Live-enabled certification profile inherits the STAGING backend, it does not restate it', () => {
  const eas = readEas();
  const profile = eas.build['staging-certification'];
  assert.equal(profile.extends, 'staging', 'the certification profile must inherit from staging');
  assert.equal(
    profile.env?.[URL_KEY],
    undefined,
    'the certification profile must NOT declare its own backend URL -- a second copy is a second thing to drift',
  );
  const resolved = resolveEnv(eas.build, 'staging-certification');
  assert.match(
    resolved[URL_KEY],
    new RegExp(`^https://${STAGING_PROJECT_REF}\\.supabase\\.co/?$`),
  );
  assert.equal(resolved[LIVE_FLAG], 'true');
});

test('the client flag is read from that exact env var and defaults OFF', () => {
  const flags = fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8');
  assert.ok(
    flags.includes(`process.env.${LIVE_FLAG}`),
    `constants/featureFlags.ts must read ${LIVE_FLAG} -- the EAS profile above is only meaningful if it is`,
  );
  // A build with the variable absent must be a build with Live off, or the
  // production profiles' silence above would not be a refusal.
  const resolver = flags.slice(flags.indexOf('function resolveLiveVtoEnabled'));
  assert.ok(
    /=== 'true'/.test(resolver),
    'the Live gate must require the literal string "true", so any other value is off',
  );
});

test('the server-side operator switch is a SECOND gate, not a restatement of this one', () => {
  // Section 36: the build flag and the operator kill switch are independent.
  // A build-time flag alone must not be able to turn Live on for customers.
  const router = fs.readFileSync(path.join(ROOT, 'services/vto/vtoLiveCapability.ts'), 'utf8');
  assert.ok(router.includes('input.liveFeatureEnabled !== true'), 'the build flag must be a gate');
  assert.ok(router.includes('input.liveRemoteEnabled !== true'), 'the operator switch must be a separate gate');
  const control = fs.readFileSync(path.join(ROOT, 'services/vto/vtoFeatureControl.ts'), 'utf8');
  assert.ok(
    control.includes('liveEnabled: live?.enabled === true'),
    'the remote Live switch must read as false for every row that predates it',
  );
});
