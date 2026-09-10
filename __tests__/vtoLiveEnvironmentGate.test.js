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
// LIVE IS ENABLED ON `staging-certification`, BY OWNER RULING 2026-09-07,
// AND ON NOTHING ELSE.
//
// The history matters, because it is the reason this file can be trusted. The
// productization lane wrote the flag onto `staging-certification` -- the
// correct home: it already carries EXPO_PUBLIC_VOICESCAN_ENABLED,
// EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED and EXPO_PUBLIC_SMART_WATCHLIST_V1 on
// exactly the "staging exercises what production has not shipped" reasoning,
// and it INHERITS the staging backend rather than restating it. (`staging`
// itself was never an option: __tests__/staging/easProfileParity.test.js
// requires it to expose exactly production's flag set.)
//
// Two governed gates then refused it -- __tests__/easConfigIntegrity.test.js
// pins the certification matrix to the approved rulings exactly, and
// __tests__/vtoLiveFeatureGate.test.js asserted no profile set the flag at
// all. The lane REVERTED and escalated rather than editing the gates standing
// in its way, and the owner ruled. Both gates now permit precisely this state
// and nothing wider, each carrying the ruling and its limits in the diff.
//
// WHAT THE RULING DID NOT AUTHORIZE, and what this file therefore still has to
// hold: Production activation, store distribution, and external pilot use. The
// approval is source/configuration readiness only.
//
// THE NEGATIVE CONTROL IS PRESERVED DELIBERATELY. It was load-bearing when
// nothing enabled Live (an all-pass result would otherwise have been vacuous),
// and it is load-bearing now for the opposite reason: with a real Live-enabled
// profile in the tree, the rule is being exercised for real, and the control
// is what proves it would still REFUSE the Production candidate rather than
// having quietly become an always-allow.

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
  let profilesChecked = 0;
  for (const name of Object.keys(build)) {
    const env = resolveEnv(build, name);
    const result = classifyLiveTarget(env);
    if (result.verdict === 'refused') offenders.push(`${name}: ${result.reason}`);
    profilesChecked += 1;
  }
  assert.deepEqual(offenders, [], `Live VTO is enabled against a non-staging backend: ${offenders.join('; ')}`);
  // A rule applied to zero profiles would pass for the wrong reason. Every
  // profile is walked, and the negative control below proves the rule can
  // fail -- those two together are what make the empty result meaningful.
  assert.ok(profilesChecked >= 4, `expected the real profile set, walked ${profilesChecked}`);
});

test('the owner-ruled posture is EXACTLY one profile: staging-certification', () => {
  // An exact set, resolved through `extends`, not a list of profiles that must
  // not have it. A rule that only names what it forbids stops being a rule the
  // moment somebody adds a sixth profile -- and `extends` means a profile can
  // acquire the flag without the flag appearing in its own `env` at all, which
  // is precisely what a reviewer reading eas.json by eye would miss.
  const build = readEas().build;
  const enabled = Object.keys(build)
    .filter((name) => resolveEnv(build, name)[LIVE_FLAG] === 'true')
    .sort();
  assert.deepEqual(
    enabled,
    ['staging-certification'],
    `Live resolves enabled on [${enabled.join(', ')}]. The owner ruling of 2026-09-07 `
      + 'authorizes staging-certification and nothing else; widening this is a new ruling, '
      + 'and easConfigIntegrity.test.js has to change with it.',
  );
});

test('the dev harness flag ships on NO profile, and the ruling did not change that', () => {
  // A separate switch from the feature flag, and a more dangerous one: it
  // SIMULATES capability, and `vtoLiveCapability.ts` marks any answer it
  // produces `evidenceSource: 'harness'` so a simulated capability cannot be
  // laundered into native evidence. A build that shipped it would be a build
  // whose Live evidence was fabricated.
  const build = readEas().build;
  const withHarness = Object.keys(build)
    .filter((name) => resolveEnv(build, name).EXPO_PUBLIC_LIVE_VTO_HARNESS !== undefined)
    .sort();
  assert.deepEqual(withHarness, [], `the Live dev harness is set on ${withHarness.join(', ')}`);
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

test('the Live-enabled certification profile INHERITS the staging backend, never restates it', () => {
  // The activation and its target are two different facts, and this pins the
  // second one: the profile that now carries the Live flag reaches the staging
  // project by INHERITANCE from `staging`. A restated URL here would be a
  // second copy of the backend identity, and a second thing to drift -- which
  // is exactly how a Live-enabled build could one day resolve somewhere else
  // while every profile still "looked" right.
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
  // The flag is really there, and the rule really allows it -- run against the
  // RESOLVED environment, so this is the same judgement EAS's own resolution
  // would produce rather than a reading of one profile's literal `env`.
  assert.equal(resolved[LIVE_FLAG], 'true');
  assert.deepEqual(classifyLiveTarget(resolved), { verdict: 'allowed' });
});

test('the ruling authorized CONFIGURATION READINESS, not distribution', () => {
  // Recorded mechanically because "source-ready" and "shippable" are exactly
  // the two things a reader of a green pipeline is most likely to conflate.
  const eas = readEas();
  const cert = eas.build['staging-certification'];

  // The profile is a STORE-shaped build pointed at staging -- that is what
  // makes it the right vehicle for a production-style candidate -- but a
  // build is not a submission. No submit configuration may target production
  // from this lane, and none is added by it.
  assert.equal(cert.distribution, 'store');
  const resolved = resolveEnv(eas.build, 'staging-certification');
  assert.match(resolved[URL_KEY], new RegExp(STAGING_PROJECT_REF));
  assert.ok(
    !resolved[URL_KEY].includes(PRODUCTION_PROJECT_REF),
    'a Live-enabled certification build must never resolve to production',
  );

  // And the production profile is untouched by the ruling, checked here as
  // well as in its own test so the two claims cannot drift apart.
  const production = resolveEnv(eas.build, 'production');
  assert.equal(production[LIVE_FLAG], undefined, 'production must not carry the Live flag');
  assert.match(production[URL_KEY], new RegExp(PRODUCTION_PROJECT_REF));
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
