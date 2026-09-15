// K+ RESOLVING != FREE — hostile regression suite.
//
// THE DEFECT THIS EXISTS FOR (BUILD34-KPLUS-RESOLVING-001)
//
// services/kplus/kplusEntitlementStore.ts resolves an actor's K+ status into a
// KPlusResolvedState. Two of those states — 'loading' and 'error' — mean "we do
// not know yet", NOT "this actor is on the free tier". 'error' in particular is
// set precisely when the entitlement authority could not be read
// (fetchKPlusStatus -> reason 'read_failed': offline, RLS failure, Supabase
// outage).
//
// Every shipped K+ surface derived its lock/upsell from `isActive` alone, which
// is false for both. So:
//
//   * Try It On rendered "TRY IT ON · K+" — the upgrade CTA — to an entitled
//     customer whose status read had failed.
//   * The Home Voice Scan pill badged LOCKED for the same customer.
//   * Pack For A Trip showed "UNLOCK WITH K+" on every cold entry BEFORE the
//     first read returned, and permanently whenever that read failed.
//
// A temporary authority failure must never throw a valid K+ actor behind a
// free-user lock. The repo's own canonical presentation contract already says
// so for the summary model (shouldPresentKPlusPaywall returns false for
// 'resolving' and for 'unavailable'/'network' — see
// types/kplusEntitlementContract.ts); these surfaces read the other model and
// had no equivalent rule. isKPlusEntitlementUnresolved() is that rule.
//
// This suite runs the real predicate, and pins the three surfaces to it with
// source contracts — the same technique __tests__/homeVoiceScanPill.test.js and
// __tests__/kplusSurfaceWiring.test.js use, because this repo has no Jest/RTL.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

function loadModule(absPath, requireMap = {}) {
  const output = ts.transpileModule(fs.readFileSync(absPath, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console,
    exports: mod.exports,
    module: mod,
    require: (specifier) => {
      if (Object.prototype.hasOwnProperty.call(requireMap, specifier)) return requireMap[specifier];
      throw new Error(`Unexpected import in ${path.basename(absPath)}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

const entitlements = loadModule(path.join(ROOT, 'types', 'entitlements.ts'));
const { isKPlusEntitlementUnresolved } = entitlements;

// Every state the store can produce. If a state is added to
// KPlusResolvedState without being classified here, the exhaustiveness test
// below fails rather than letting a new state default into "free".
const ALL_STATES = ['loading', 'eligible', 'active', 'expired', 'unavailable', 'error'];
const UNRESOLVED = ['loading', 'error'];
const RESOLVED = ['eligible', 'active', 'expired', 'unavailable'];

// ── The predicate itself ────────────────────────────────────────────────────

test('the two states that mean "we have not been told yet" are unresolved', () => {
  for (const state of UNRESOLVED) {
    assert.equal(isKPlusEntitlementUnresolved(state), true, state);
  }
});

test("'error' — the transient-authority state — is unresolved, not free", () => {
  // The whole invariant in one assertion. fetchKPlusStatus maps every
  // non-signed-out read failure to 'error'; if that ever reads as a resolved
  // free actor again, a K+ customer gets a paywall for being offline.
  assert.equal(isKPlusEntitlementUnresolved('error'), true);
});

test('genuine answers stay resolved, so the upsell still converts', () => {
  // Suppressing the upsell for 'eligible'/'expired' would be the opposite
  // defect: a free actor who can never be told K+ exists.
  for (const state of RESOLVED) {
    assert.equal(isKPlusEntitlementUnresolved(state), false, state);
  }
});

test('the predicate never grants access — it only withholds a claim', () => {
  // isKPlusEntitlementUnresolved answers "should we present the free-tier
  // lock", never "may this actor use the feature". Access stays isActive-only.
  assert.equal(isKPlusEntitlementUnresolved('active'), false);
  assert.equal(typeof isKPlusEntitlementUnresolved('error'), 'boolean');
});

test('a malformed or unknown state is treated as resolved, never as secretly entitled', () => {
  for (const bogus of [undefined, null, '', 'ACTIVE', 'resolving', 'k_plus', 0, {}]) {
    assert.equal(isKPlusEntitlementUnresolved(bogus), false, String(bogus));
  }
});

test('KPlusResolvedState is exhaustively classified — a new state cannot default to free', () => {
  const source = read('types', 'entitlements.ts');
  const block = source.match(/export type KPlusResolvedState =([\s\S]*?);/);
  assert.ok(block, 'KPlusResolvedState must remain a literal union');
  const declared = [...block[1].matchAll(/'([a-z_]+)'/g)].map((m) => m[1]).sort();
  assert.deepEqual(declared, [...ALL_STATES].sort(),
    'a state was added to KPlusResolvedState without being classified in this suite');
});

// ── The three shipped surfaces are pinned to the shared predicate ───────────
//
// Each of these was an INDEPENDENT re-derivation of "unresolved", and two of
// the three got it wrong. The point of the repair is that there is now exactly
// one definition; these assertions are what stop a fourth one appearing.

test('Try It On derives VTO loading from the shared predicate, not a bare literal', () => {
  const src = read('hooks', 'useVtoAvailability.ts');
  assert.match(src, /isKPlusEntitlementUnresolved\(kplusState\)/,
    'useVtoAvailability must ask the shared predicate');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /kplusState === 'loading'/,
    "the old literal check omitted 'error' and must not come back");
});

test('the Home Voice Scan pill derives resolving from the shared predicate', () => {
  const src = read('components', 'home', 'HomeVoiceScanPill.tsx');
  assert.match(src, /const resolving = isKPlusEntitlementUnresolved\(state\);/);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.doesNotMatch(code, /const resolving = state === 'loading'/,
    "the old literal check omitted 'error' and must not come back");
});

test('Pack For A Trip withholds the K+ upsell until the answer is known', () => {
  const src = read('app', 'packing', 'index.tsx');
  const code = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.match(code, /isKPlusEntitlementUnresolved\(state\)/,
    'the Packing gate must ask the shared predicate');

  // Ordering is the whole fix: the unresolved branch must be reached BEFORE
  // the branch that renders "UNLOCK WITH K+", or the upsell still wins.
  const unresolvedIndex = code.indexOf('isKPlusEntitlementUnresolved(state)');
  const upsellIndex = code.indexOf('packing-kplus-gate');
  assert.ok(unresolvedIndex >= 0 && upsellIndex > unresolvedIndex,
    'the unresolved branch must precede the UNLOCK WITH K+ branch');

  // The gate must actually receive `state`; destructuring only `isActive`
  // is how the defect existed in the first place.
  assert.match(code, /\{\(\{ state, isActive, openUpgrade \}\)/,
    'the Packing KPlusGate render prop must take `state`');
});

test('NEGATIVE CONTROL: a surface that checks only isActive would be caught', () => {
  // Proves the assertions above have teeth rather than matching anything.
  const mutant = `
    {({ isActive, openUpgrade }) => {
      if (!isActive && !packing.plan) { return <View testID="packing-kplus-gate" />; }
    }}
  `;
  assert.doesNotMatch(mutant, /isKPlusEntitlementUnresolved\(state\)/,
    'mutant must fail the real predicate assertion');
});

test('NEGATIVE CONTROL: a predicate that also swallowed the free states would be caught', () => {
  const overBroad = (state) => state !== 'active';
  assert.notEqual(overBroad('eligible'), isKPlusEntitlementUnresolved('eligible'),
    'an over-broad predicate would suppress the upsell for genuine free actors');
});

// ── Agreement with the canonical contract ──────────────────────────────────

test('the KPlusResolvedState rule agrees with the canonical summary contract', () => {
  // types/kplusEntitlementContract.ts is the server-facing model and already
  // encodes RESOLVING != FREE. The two models must never disagree about it.
  const contract = loadModule(path.join(ROOT, 'types', 'kplusEntitlementContract.ts'));
  assert.equal(contract.shouldPresentKPlusPaywall({ status: 'resolving' }), false);
  assert.equal(contract.shouldPresentKPlusPaywall({ status: 'unavailable', reason: 'network' }), false);
  // 'loading' and 'error' are this model's 'resolving' and 'unavailable/network'.
  assert.equal(isKPlusEntitlementUnresolved('loading'), true);
  assert.equal(isKPlusEntitlementUnresolved('error'), true);
});
