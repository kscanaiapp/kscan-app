'use strict';

/**
 * Build 34 Lane A -- the complimentary K+ activation presentation may only
 * advertise a capability a member can actually USE.
 *
 * THE DEFECT THIS PINS. The activation screen filtered its four capabilities
 * by BUILD flags only. The Build 34 certification binary compiles all four in,
 * so the screen promised Wardrobe Concierge and Packing Intelligence -- whose
 * server side was not enabled. A member who activated K+ for them got
 * an inert feature and a failing one. Its sub-headline ("scan, style, try on,
 * and plan") and the early-access sheet's benefit list (three hardcoded lines,
 * two of them vague enough to mean either) made the same promise.
 *
 * THE RULE. advertised = compiled in (build flag) AND served by the server:
 *   - 'confirmed'   -> advertised (a dated, hand-maintained answer);
 *   - 'unconfirmed' -> never advertised;
 *   - 'live'        -> advertised only on an explicit `true` from the live
 *                      signal (unknown, unreadable and off all fail closed).
 * Virtual Try-On is 'live' because its server switch is client-readable and every
 * try-on entry point already obeys it; Packing and Concierge have nothing the
 * client can read, so they are a dated snapshot that can only under-advertise.
 *
 * The rule is tested over EVERY combination, not as a snapshot, so an owner
 * flipping an entry later cannot accidentally over-advertise. One snapshot test
 * also pins the audited posture on purpose: flipping an entry then requires
 * editing it, which is the review point where the evidence gets asked for.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const read = (...segments) => fs.readFileSync(path.join(ROOT, ...segments), 'utf8');

/** Comments removed: assertions about what a surface SAYS must not be satisfied
 *  or tripped by prose that legitimately discusses what it used to say. */
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

function loadTs(relative, requireMap, mutate = (source) => source) {
  const absPath = path.join(ROOT, ...relative.split('/'));
  const output = ts.transpileModule(mutate(fs.readFileSync(absPath, 'utf8')), {
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
      throw new Error(`Unexpected import in ${relative}: ${specifier}`);
    },
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename: absPath }).runInContext(sandbox);
  return mod.exports;
}

function loadCatalog(mutate) {
  return loadTs(
    'services/kplus/kplusActivationCatalog.ts',
    {
      '../../constants/featureFlags': {
        VOICESCAN_ENABLED: false,
        VTO_UI_ENABLED: false,
        ELISE_CONCIERGE_V1: false,
        PACKING_INTELLIGENCE_V1: false,
      },
    },
    mutate,
  );
}

function loadSignalsService(getVtoRemoteConfig, mutate) {
  return loadTs(
    'services/kplus/kplusLiveCapabilitySignals.ts',
    { '../vto/vtoFeatureControl': { getVtoRemoteConfig } },
    mutate,
  );
}

/** vm-realm objects fail strict deepEqual on prototype identity alone. */
const plain = (value) => JSON.parse(JSON.stringify(value));

const IDS = ['voice_scan', 'virtual_try_on', 'wardrobe_concierge', 'packing_intelligence'];
const FLAG_KEY = {
  voice_scan: 'voiceScan',
  virtual_try_on: 'vto',
  wardrobe_concierge: 'concierge',
  packing_intelligence: 'packing',
};
const ALL_FLAGS_ON = { voiceScan: true, vto: true, concierge: true, packing: true };

/** Every assignment of one of `values` to each capability id. */
function everyAssignment(values) {
  const out = [{}];
  for (const id of IDS) {
    const next = [];
    for (const partial of out) for (const value of values) next.push({ ...partial, [id]: value });
    out.length = 0;
    out.push(...next);
  }
  return out;
}

/** The rule, stated independently of the implementation. */
function expectedAdvertised(flagsById, statusById, signalsById) {
  return IDS.filter(
    (id) =>
      flagsById[id] &&
      (statusById[id] === 'confirmed' || (statusById[id] === 'live' && signalsById[id] === true)),
  );
}

const catalog = loadCatalog();

/** The audited-posture check, as a function so a negative control can run it on mutated source. */
function advertisedInAuditedPosture(subject, liveSignals) {
  return plain(
    subject
      .resolveActivationCapabilities(ALL_FLAGS_ON, undefined, liveSignals)
      .map((capability) => capability.id),
  );
}

// ── The rule ────────────────────────────────────────────────────────────────

test('RULE: advertised iff compiled in AND (confirmed, or live with an explicit yes) -- every combination', () => {
  let combinations = 0;
  const flagSets = everyAssignment([true, false]);
  const statusSets = everyAssignment(['confirmed', 'unconfirmed', 'live']);
  const signalSets = everyAssignment([true, false, undefined]);
  for (const flags of flagSets) {
    const flagArg = Object.fromEntries(IDS.map((id) => [FLAG_KEY[id], flags[id]]));
    for (const status of statusSets) {
      const enablement = Object.fromEntries(
        IDS.map((id) => [id, { status: status[id], basis: 'test fixture' }]),
      );
      for (const signals of signalSets) {
        const resolved = catalog.resolveActivationCapabilities(flagArg, enablement, signals);
        const actual = resolved.map((capability) => capability.id);
        const expected = expectedAdvertised(flags, status, signals);
        if (actual.length !== expected.length || actual.some((id, index) => id !== expected[index])) {
          assert.fail(
            `flags ${JSON.stringify(flags)} / status ${JSON.stringify(status)} / signals ${JSON.stringify(signals)}: ` +
              `got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)}`,
          );
        }
        combinations += 1;
      }
    }
  }
  assert.equal(combinations, 16 * 81 * 81);
});

test('RULE: an unconfirmed capability is never advertised, whatever the flags or signals say', () => {
  const allDark = Object.fromEntries(IDS.map((id) => [id, { status: 'unconfirmed', basis: 'test fixture' }]));
  const everySignalTrue = Object.fromEntries(IDS.map((id) => [id, true]));
  const resolved = catalog.resolveActivationCapabilities(ALL_FLAGS_ON, allDark, everySignalTrue);
  assert.deepEqual(plain(resolved), []);
  assert.equal(catalog.activationOfferSubhead(resolved), '', 'nothing advertised -> no sub-headline');
});

test('RULE: a missing enablement entry fails closed (an unknown capability is not advertised)', () => {
  const partial = { voice_scan: { status: 'confirmed', basis: 'test fixture' } };
  const resolved = catalog.resolveActivationCapabilities(ALL_FLAGS_ON, partial, { virtual_try_on: true });
  assert.deepEqual(plain(resolved.map((capability) => capability.id)), ['voice_scan']);
});

test('RULE: a live capability follows its signal and fails closed while the signal is unknown', () => {
  const ids = (signals) => advertisedInAuditedPosture(catalog, signals);
  assert.deepEqual(ids(undefined), ['voice_scan'], 'no signal object at all');
  assert.deepEqual(ids({}), ['voice_scan'], 'not read yet');
  assert.deepEqual(ids({ virtual_try_on: null }), ['voice_scan'], 'explicitly unknown');
  assert.deepEqual(ids({ virtual_try_on: false }), ['voice_scan'], 'the switch reads off');
  assert.deepEqual(ids({ virtual_try_on: true }), ['voice_scan', 'virtual_try_on'], 'the switch reads on');
  // A signal for a capability that is not 'live' is ignored, not believed.
  assert.deepEqual(ids({ virtual_try_on: true, packing_intelligence: true, wardrobe_concierge: true }), [
    'voice_scan',
    'virtual_try_on',
  ]);
});

// ── The record ──────────────────────────────────────────────────────────────

test('RECORD: covers exactly the four approved capabilities, each with a status and a dated basis', () => {
  const record = catalog.KPLUS_CAPABILITY_SERVER_ENABLEMENT;
  assert.deepEqual(Object.keys(record).sort(), [...IDS].sort());
  for (const id of IDS) {
    assert.ok(['confirmed', 'unconfirmed', 'live'].includes(record[id].status), `${id} status`);
    assert.ok(record[id].basis.length > 20, `${id} must say what its status rests on`);
    assert.match(record[id].basis, /\b20\d{2}-\d{2}-\d{2}\b/, `${id} basis must carry the date it was observed`);
  }
});

test('RECORD: every live capability has a signal the service can supply', async () => {
  const record = catalog.KPLUS_CAPABILITY_SERVER_ENABLEMENT;
  const liveIds = IDS.filter((id) => record[id].status === 'live');
  assert.deepEqual(liveIds, ['virtual_try_on'], 'today only the try-on switch is client-readable');
  const service = loadSignalsService(async () => ({ enabled: true }));
  const signals = plain(await service.readKPlusLiveCapabilitySignals());
  for (const id of liveIds) assert.equal(typeof signals[id], 'boolean', `${id} needs a boolean live signal`);
});

test('RECORD: cannot be mutated by a consumer', () => {
  assert.throws(() => {
    catalog.KPLUS_CAPABILITY_SERVER_ENABLEMENT.packing_intelligence.status = 'confirmed';
  });
  assert.throws(() => {
    catalog.KPLUS_CAPABILITY_SERVER_ENABLEMENT.extra = { status: 'confirmed', basis: 'x' };
  });
});

test('RECORD: names no server switch -- this file ships in the app bundle', () => {
  const record = catalog.KPLUS_CAPABILITY_SERVER_ENABLEMENT;
  // Any UPPER_SNAKE token of two or more segments: a switch's name, whatever its length.
  const snakeCaseSwitch = /\b[A-Z][A-Z0-9]+(?:_[A-Z0-9]+){1,}\b/;
  for (const id of IDS) {
    assert.doesNotMatch(record[id].basis, snakeCaseSwitch, `${id} basis must not name an environment switch`);
  }
  // Identifiers like KPLUS_ACTIVATION_CAPABILITIES are code, not data. What ships
  // as data -- and so could disclose a server switch's name -- is a string literal.
  for (const file of [
    ['services', 'kplus', 'kplusActivationCatalog.ts'],
    ['services', 'kplus', 'kplusLiveCapabilitySignals.ts'],
  ]) {
    const literals = [
      ...stripComments(read(...file)).matchAll(/(['"`])((?:\\.|(?!\1)[^\\])*)\1/g),
    ].map((match) => match[2]);
    assert.ok(literals.length > 0, `the scan must actually see ${file.join('/')}'s string literals`);
    for (const literal of literals) {
      assert.doesNotMatch(literal, snakeCaseSwitch, `string literal names an environment switch: ${literal}`);
    }
  }
});

test('SNAPSHOT (update deliberately, with evidence): the advertised set at the 2026-09-24 audit', () => {
  // The certification binary compiles all four capabilities in. At the
  // 2026-09-24 read-only audit the server served two of them: Voice Scan
  // (on-device, over the live text-search backend) and Virtual Try-On (service
  // deployed, remote feature switch on). Wardrobe Concierge and Packing
  // Intelligence were not enabled on the server.
  //
  // If you are changing this list, you are changing what K+ promises a member.
  // Flip a record entry to 'confirmed' only after the capability is enabled on
  // the server AND proven to work for an activated member, cite that evidence
  // in the entry's basis, and update this snapshot in the same change.
  assert.deepEqual(advertisedInAuditedPosture(catalog, { virtual_try_on: true }), ['voice_scan', 'virtual_try_on']);
  assert.deepEqual(advertisedInAuditedPosture(catalog, { virtual_try_on: false }), ['voice_scan']);
});

// ── The live signal service ────────────────────────────────────────────────

test('SERVICE: the live signal is true only for a read that says enabled === true', async () => {
  const signalFor = async (reader) => plain(await loadSignalsService(reader).readKPlusLiveCapabilitySignals());
  assert.deepEqual(await signalFor(async () => ({ enabled: true })), { virtual_try_on: true });
  assert.deepEqual(await signalFor(async () => ({ enabled: false })), { virtual_try_on: false });
  for (const notYes of ['true', 1, 'yes', {}, [], undefined, null]) {
    assert.deepEqual(await signalFor(async () => ({ enabled: notYes })), { virtual_try_on: false }, `enabled: ${String(notYes)}`);
  }
  assert.deepEqual(await signalFor(async () => null), { virtual_try_on: false });
  assert.deepEqual(await signalFor(async () => undefined), { virtual_try_on: false });
});

test('SERVICE: a failing read is false, never a throw, never true', async () => {
  const failing = loadSignalsService(async () => {
    throw new Error('boom');
  });
  assert.deepEqual(plain(await failing.readKPlusLiveCapabilitySignals()), { virtual_try_on: false });
  assert.deepEqual(
    plain(await failing.readKPlusLiveCapabilitySignals({ readVtoConfig: () => Promise.reject(new Error('down')) })),
    { virtual_try_on: false },
  );
  assert.deepEqual(
    plain(
      await loadSignalsService(async () => ({ enabled: false })).readKPlusLiveCapabilitySignals({
        readVtoConfig: async () => ({ enabled: true }),
      }),
    ),
    { virtual_try_on: true },
    'an injected reader wins over the default one',
  );
});

test('SERVICE: asks the existing try-on reader and nothing else', () => {
  const source = stripComments(read('services', 'kplus', 'kplusLiveCapabilitySignals.ts'));
  const imports = [...source.matchAll(/from\s+'([^']+)'/g)].map((match) => match[1]).sort();
  assert.deepEqual(imports, ['../vto/vtoFeatureControl', './kplusActivationCatalog']);
});

// ── The sub-headline ────────────────────────────────────────────────────────

test('SUBHEAD: names only what is advertised, in the approved order', () => {
  const advertise = (...ids) => ids.map((id) => ({ id }));
  assert.equal(catalog.describeActivationWays([]), '');
  assert.equal(catalog.describeActivationWays(advertise('voice_scan')), 'scan');
  assert.equal(catalog.describeActivationWays(advertise('virtual_try_on', 'voice_scan')), 'scan and try on');
  assert.equal(
    catalog.describeActivationWays(advertise('virtual_try_on', 'wardrobe_concierge', 'voice_scan')),
    'scan, style, and try on',
  );
  assert.equal(
    catalog.describeActivationWays(advertise(...IDS)),
    'scan, style, try on, and plan',
  );
});

test('SUBHEAD: the audited posture never mentions styling or planning', () => {
  const subhead = catalog.activationOfferSubhead(
    catalog.resolveActivationCapabilities(ALL_FLAGS_ON, undefined, { virtual_try_on: true }),
  );
  assert.equal(subhead, 'Unlock more ways to scan and try on with K Scan AI.');
  assert.doesNotMatch(subhead, /style|plan/i);
});

test('SUBHEAD: is byte-for-byte the approved sentence when all four are advertised', () => {
  const allConfirmed = Object.fromEntries(IDS.map((id) => [id, { status: 'confirmed', basis: 'test fixture' }]));
  assert.equal(
    catalog.activationOfferSubhead(catalog.resolveActivationCapabilities(ALL_FLAGS_ON, allConfirmed)),
    'Unlock more ways to scan, style, try on, and plan with K Scan AI.',
  );
});

// ── Both presentations derive from the catalog and its live signal ─────────

test('SURFACES: the onboarding offer takes its sub-headline and cards from the catalog and the live signal', () => {
  const screen = stripComments(read('components', 'kplus', 'KPlusActivationStep.tsx'));
  assert.match(screen, /activationOfferSubhead\(capabilities\)/);
  assert.match(screen, /useKPlusLiveCapabilitySignals\(\)/);
  assert.match(screen, /resolveActivationCapabilities\(\{\}, undefined, liveSignals\)/);
  assert.doesNotMatch(screen, /scan, style, try on, and plan/i, 'the fixed sentence must not come back');
});

test('SURFACES: an unsettled live answer is not "nothing to offer" (the step must not skip early)', () => {
  const screen = stripComments(read('components', 'kplus', 'KPlusActivationStep.tsx'));
  assert.match(
    screen,
    /const nothingToOffer = isActive \|\| state === 'unavailable' \|\|\s*\(liveSignalsSettled && capabilities\.length === 0\);/,
  );
});

test('SURFACES: the early-access sheet derives its benefit list from the same catalog and signal', () => {
  const sheet = stripComments(read('components', 'kplus', 'KPlusEarlyAccessSheet.tsx'));
  assert.match(sheet, /useKPlusLiveCapabilitySignals\(visible\)/);
  assert.match(sheet, /resolveActivationCapabilities\(\{\}, undefined, liveSignals\)/);
  assert.match(sheet, /advertisedCapabilities\.map\(/);
  for (const stale of ['Advanced style intelligence', 'Smarter wardrobe tools']) {
    assert.ok(!sheet.includes(stale), `the vague hardcoded line "${stale}" must not come back`);
  }
  assert.ok(!/•\s*Voice Scan/.test(sheet), 'Voice Scan is listed from the catalog, not hardcoded');
  assert.match(sheet, /More ways to use K Scan AI\./, 'the sheet says "K Scan AI", never bare "K Scan"');
  assert.ok(!/More ways to use K Scan\./.test(sheet));
});

test('HOOK: reads the signal only when something depends on it, and ignores a late answer', () => {
  const hook = stripComments(read('hooks', 'useKPlusLiveCapabilitySignals.ts'));
  assert.match(hook, /const needed = active && VTO_UI_ENABLED;/);
  assert.match(hook, /readKPlusLiveCapabilitySignals\(\)/);
  assert.match(hook, /if \(alive\) setResult\(\{ signals, settled: true \}\);/);
  assert.match(hook, /alive = false;/);
  assert.match(hook, /return needed \? result : NOTHING_TO_ASK;/);
  assert.match(hook, /settled: true,\s*\}\);/, 'the nothing-to-ask result is already settled');
});

// ── Negative controls: the rule must be able to fail ───────────────────────

/** Loads the catalog with `pattern` replaced, and proves the mutation really changed it. */
function mutatedCatalog(pattern, replacement) {
  const mutant = loadCatalog((source) => {
    assert.ok(pattern.test(source), `the mutation target must exist in the source: ${pattern}`);
    return source.replace(pattern, replacement);
  });
  assert.notEqual(
    mutant.resolveActivationCapabilities.toString(),
    catalog.resolveActivationCapabilities.toString(),
    'the mutation must actually apply',
  );
  return mutant;
}

test('negative control: dropping the server check re-advertises the dark capabilities', () => {
  const mutant = mutatedCatalog(
    /\.filter\(\(capability\) => compiledIn\[capability\.id\] && servedByServer\(capability\.id\)\)/,
    '.filter((capability) => compiledIn[capability.id])',
  );
  assert.deepEqual(
    advertisedInAuditedPosture(mutant, { virtual_try_on: true }),
    ['voice_scan', 'virtual_try_on', 'wardrobe_concierge', 'packing_intelligence'],
    'the mutant over-advertises',
  );
  assert.notDeepEqual(
    advertisedInAuditedPosture(mutant, { virtual_try_on: true }),
    advertisedInAuditedPosture(catalog, { virtual_try_on: true }),
    'so the audited-posture check above is able to catch it',
  );
});

test('negative control: treating a live capability as confirmed advertises it while the signal is unknown', () => {
  const mutant = mutatedCatalog(
    /if \(status === 'live'\) return liveSignals\[id\] === true;/,
    "if (status === 'live') return true;",
  );
  assert.deepEqual(advertisedInAuditedPosture(mutant, {}), ['voice_scan', 'virtual_try_on'], 'the mutant fails open');
  assert.notDeepEqual(
    advertisedInAuditedPosture(mutant, {}),
    advertisedInAuditedPosture(catalog, {}),
    'so the fail-closed check above is able to catch it',
  );
});

test('negative control: a signal service that fails open answers true for a failing read', async () => {
  const mutant = loadSignalsService(
    async () => {
      throw new Error('boom');
    },
    (source) => {
      assert.ok(/return \{ virtual_try_on: false \};/.test(source), 'the catch branch must exist');
      return source.replace(/return \{ virtual_try_on: false \};/, 'return { virtual_try_on: true };');
    },
  );
  assert.deepEqual(plain(await mutant.readKPlusLiveCapabilitySignals()), { virtual_try_on: true }, 'the mutant fails open');
  const genuine = loadSignalsService(async () => {
    throw new Error('boom');
  });
  assert.notDeepEqual(
    plain(await mutant.readKPlusLiveCapabilitySignals()),
    plain(await genuine.readKPlusLiveCapabilitySignals()),
    'so the fail-closed service check is able to catch it',
  );
});

test('negative control: the old fixed sub-headline fails the derivation checks', () => {
  const fixedSentence = loadCatalog((source) =>
    source.replace(
      /return ways \? `Unlock more ways to \$\{ways\} with K Scan AI\.` : '';/,
      "return 'Unlock more ways to scan, style, try on, and plan with K Scan AI.';",
    ),
  );
  assert.notEqual(
    fixedSentence.activationOfferSubhead.toString(),
    catalog.activationOfferSubhead.toString(),
    'the mutation must actually apply',
  );
  const subhead = fixedSentence.activationOfferSubhead(
    fixedSentence.resolveActivationCapabilities(ALL_FLAGS_ON, undefined, { virtual_try_on: true }),
  );
  assert.match(subhead, /style/, 'the mutant names a capability that is not advertised');
  assert.notEqual(subhead, 'Unlock more ways to scan and try on with K Scan AI.');
});
