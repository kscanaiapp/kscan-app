// BUILD 29 CLOSET V2 — OWNER GUARDRAILS
//
// Two owner-mandated constraints on the Closet V2 workstream, enforced as
// tests rather than as review discipline:
//
//   1. MIRROR SELFIE stays exactly as prominent and reachable as it was at
//      BUILD29_BASE_HEAD 07193c39dea71facc551d54a38f71b7d6a6cef85.
//   2. COST PER WEAR stays dormant. Activating any Closet V2 surface must not
//      be able to switch it on.
//
// These are source-level assertions on purpose. The failure they guard against
// is a refactor quietly relocating a control or widening a flag composition —
// something a behavioural test with all flags forced on would not notice.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

// ── 1. Mirror Selfie prominence + reachability ───────────────────────────────

test('Mirror Selfie: the Library entry point still exists with its baseline identity', () => {
  const library = read('app/library.tsx');

  assert.match(library, /testID="closet-mirror-selfie-button"/, 'the entry-point testID must not change');
  assert.match(library, /title="Mirror Selfie"/, 'the control must keep its product copy');
  assert.match(
    library,
    /accessibilityLabel="Add several items from one mirror selfie"/,
    'the accessibility label is part of the recorded baseline and must not drift',
  );
  assert.match(
    library,
    /setMirrorSelfieVisible\(true\)/,
    'pressing the control must still open the extraction sheet',
  );
  assert.match(
    library,
    /<MirrorSelfieExtractionModal/,
    'the extraction modal must stay mounted on this screen',
  );
});

test('Mirror Selfie: the control stays in its Closet-header position', () => {
  const library = read('app/library.tsx');

  // The baseline places the action under the Closet section header via
  // styles.mirrorAction. Relocating it elsewhere on the screen is a demotion
  // and needs owner approval, so the style anchor is pinned here.
  assert.match(library, /styles\.mirrorAction/, 'the mirrorAction placement anchor must survive');
  assert.match(
    library,
    /mirrorAction:\s*\{/,
    'the mirrorAction style must still be defined',
  );
});

test('Mirror Selfie: the flag composition gains no new parent', () => {
  const flags = read('constants/featureFlags.ts');

  // The cheapest accidental demotion is not deleting the button — it is adding
  // a fourth condition to this AND chain, after which the control silently
  // renders nothing. Pin the exact composition.
  const match = flags.match(
    /export const MIRROR_SELFIE_V1_ACTIVE\s*=\s*([\s\S]*?);/,
  );
  assert.ok(match, 'MIRROR_SELFIE_V1_ACTIVE must still be declared');

  const parents = match[1]
    .split('&&')
    .map((part) => part.trim())
    .filter(Boolean);

  assert.deepEqual(
    parents.sort(),
    ['CLOSET_BATCH_REVIEW_V2_ACTIVE', 'CLOSET_CANDIDATE_STAGING_ACTIVE', 'MIRROR_SELFIE_V1'],
    'Mirror Selfie must keep exactly its three baseline parent flags',
  );
});

test('Mirror Selfie: every build profile still enables it', () => {
  const eas = JSON.parse(read('eas.json'));
  const profiles = eas.build || {};

  const REQUIRED = [
    'EXPO_PUBLIC_MIRROR_SELFIE_V1',
    'EXPO_PUBLIC_CLOSET_CANDIDATE_STAGING_V1',
    'EXPO_PUBLIC_CLOSET_BATCH_REVIEW_V2',
  ];

  // Mirror Selfie is live in every shipping profile at baseline. Silently
  // dropping it from one is a prominence regression that no source assertion
  // above would catch.
  for (const name of ['preview', 'development', 'production', 'staging']) {
    const env = (profiles[name] && profiles[name].env) || {};
    for (const key of REQUIRED) {
      assert.equal(env[key], 'true', `${name} profile must keep ${key}="true"`);
    }
  }
});

test('Mirror Selfie: mirror_extract remains an accepted Closet intake source', () => {
  const candidate = read('types/closetCandidate.ts');

  const active = candidate.match(
    /CLOSET_CANDIDATE_ACTIVE_SOURCES[^=]*=\s*\[([\s\S]*?)\]/,
  );
  assert.ok(active, 'the active-source list must still be declared');
  assert.match(
    active[1],
    /'mirror_extract'/,
    'narrowing intake sources must not break Mirror Selfie staging',
  );
});

// ── 2. Cost Per Wear stays dormant ───────────────────────────────────────────

test('Cost Per Wear: has its own dedicated flag and is not implied by any other', () => {
  const flags = read('constants/freeTierUtilityFlags.ts');

  assert.match(
    flags,
    /FREE_TIER_COST_PER_WEAR_ENABLED\s*=\s*isTrue\(\s*process\.env\.EXPO_PUBLIC_FREE_TIER_COST_PER_WEAR_ENABLED\s*\)/,
    'CPW must remain gated by its own env flag only',
  );

  // No other free-tier flag may appear in the CPW declaration. If CPW ever
  // reads a sibling flag, activating that sibling activates CPW.
  const decl = flags.match(
    /export const FREE_TIER_COST_PER_WEAR_ENABLED[\s\S]*?;/,
  );
  assert.ok(decl);
  const siblings = decl[0].match(/FREE_TIER_(?!COST_PER_WEAR)[A-Z_]+/g) || [];
  assert.deepEqual(siblings, [], 'CPW must not derive from any sibling free-tier flag');
});

test('Cost Per Wear: stays off in every profile it was off in at baseline', () => {
  const eas = JSON.parse(read('eas.json'));
  const profiles = eas.build || {};

  // BASELINE STATE at 07193c3, measured not assumed:
  //   preview      CPW=true   (free-tier utility master also true)
  //   development  unset
  //   production   unset
  //   staging      unset
  //
  // The `preview` profile enabling CPW PREDATES Closet V2 and is a standing
  // product state, not something this workstream introduced. Turning it off
  // would change a shipping profile, which is an owner decision — so it is
  // recorded here as a known exception rather than silently "corrected".
  //
  // What this test actually guards: CPW must not SPREAD. Production, staging
  // and development must stay off, which is what "BUILD29 = OFF" requires.
  const MUST_STAY_OFF = ['development', 'production', 'staging'];

  for (const name of MUST_STAY_OFF) {
    const env = (profiles[name] && profiles[name].env) || {};
    assert.notEqual(
      env.EXPO_PUBLIC_FREE_TIER_COST_PER_WEAR_ENABLED,
      'true',
      `CPW is reserved for K+ and must stay off in the ${name} profile`,
    );
  }

  // Pin the known exception too. If preview ever flips off, that is a
  // deliberate owner change and this reminder should be removed with it.
  const preview = (profiles.preview && profiles.preview.env) || {};
  assert.equal(
    preview.EXPO_PUBLIC_FREE_TIER_COST_PER_WEAR_ENABLED,
    'true',
    'preview CPW state changed — update the recorded baseline exception above',
  );
});

test('Cost Per Wear: activating Closet intelligence cannot activate it', () => {
  // The five Closet intelligence flags are backend (Edge Function) flags; CPW
  // is a client Expo flag. They live in different files and different runtimes,
  // and nothing may bridge them. Assert the separation explicitly so a future
  // convenience wiring is caught here.
  const eliseConfig = read('supabase/functions/stylechat-generate/eliseConfig.ts');
  assert.doesNotMatch(
    eliseConfig,
    /COST_PER_WEAR|costPerWear/i,
    'the Elise backend config must never reference cost per wear',
  );

  const cpw = read('services/free-tier/costPerWear.ts');
  assert.doesNotMatch(
    cpw,
    /CLOSET_RETRIEVAL|COMPATIBILITY_SCORING|WARDROBE_GAP|PURCHASE_ADVICE|MULTI_LOOK/i,
    'cost per wear must not read any Closet intelligence flag',
  );
});

test('Cost Per Wear: the implementation is preserved, not removed', () => {
  // The owner decision is IMPLEMENTED_DORMANT — dormant, not deleted. A
  // Closet V2 change that "cleans up" the unused module would destroy work
  // that K+ is going to consume.
  assert.ok(
    fs.existsSync(path.join(ROOT, 'services/free-tier/costPerWear.ts')),
    'the CPW service must remain in the tree',
  );
  assert.ok(
    fs.existsSync(path.join(ROOT, 'components/free-tier/CostPerWearCard.tsx')),
    'the CPW card must remain in the tree',
  );
});
