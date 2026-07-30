// Build 5 Phase 1 — eligibility + Build 4 confidence adapter.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function loadTsModule(relPath) {
  const full = path.join(ROOT, relPath);
  const moduleCache = new Map();

  function localRequire(request) {
    if (request.startsWith('.')) {
      const resolved = path.resolve(path.dirname(full), request);
      const candidates = [resolved, `${resolved}.ts`, `${resolved}.js`];
      for (const candidate of candidates) {
        if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) {
          if (moduleCache.has(candidate)) return moduleCache.get(candidate).exports;
          const child = { exports: {} };
          moduleCache.set(candidate, child);
          const childSource = ts.transpileModule(fs.readFileSync(candidate, 'utf8'), {
            compilerOptions: {
              module: ts.ModuleKind.CommonJS,
              target: ts.ScriptTarget.ES2020,
              esModuleInterop: true,
            },
          }).outputText;
          vm.runInNewContext(
            childSource,
            {
              module: child,
              exports: child.exports,
              require: localRequire,
              console,
              Object,
              Array,
              Map,
              Set,
              Number,
              String,
              JSON,
            },
            { filename: candidate },
          );
          return child.exports;
        }
      }
    }
    return require(request);
  }

  const mod = { exports: {} };
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
      require: localRequire,
      console,
      Object,
      Array,
      Map,
      Set,
      Number,
      String,
      JSON,
    },
    { filename: full },
  );
  return mod.exports;
}

const { adaptBuild4ConfidenceField } = loadTsModule(
  'services/todayWithElise/build4ConfidenceAdapter.ts',
);
const {
  evaluateTodayOwnedLookEligibility,
  TODAY_OWNED_LOOK_PROHIBITIONS,
} = loadTsModule('services/todayWithElise/eligibility.ts');

test('confidence absent uses safe current contract disposition', () => {
  assert.equal(adaptBuild4ConfidenceField(undefined).disposition, 'absent');
  assert.equal(adaptBuild4ConfidenceField(null).disposition, 'absent');
});

test('bare numeric confidence is malformed — no Build 5 threshold', () => {
  const result = adaptBuild4ConfidenceField(0.91);
  assert.equal(result.disposition, 'malformed');
  assert.equal(result.excluded, false);
});

test('unsupported schema fails closed for the field only', () => {
  const result = adaptBuild4ConfidenceField({ schemaVersion: 99, excludedByPolicy: true });
  assert.equal(result.disposition, 'unsupported_schema');
  assert.equal(result.excluded, false);
});

test('recognized Build 4 exclusion is honored', () => {
  const result = adaptBuild4ConfidenceField({
    schemaVersion: 1,
    excludedByPolicy: true,
    policyVersion: 'build4-policy-v1',
  });
  assert.equal(result.disposition, 'excluded_by_policy');
  assert.equal(result.excluded, true);
});

test('unknown ownership never counts as owned', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 'x1',
        slot: 'top',
        actorId: 'actor-a',
        ownership: 'unknown',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
    ],
  });
  assert.equal(outcome.status, 'ineligible');
});

test('recent scan only is prohibited as ownership', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 'scan-1',
        slot: 'top',
        actorId: 'actor-a',
        ownership: 'recent_scan_only',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
    ],
  });
  assert.equal(outcome.status, 'ineligible');
  assert.ok(TODAY_OWNED_LOOK_PROHIBITIONS.includes('recent_scans_as_ownership'));
});

test('cross-actor items are excluded', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 'b1',
        slot: 'top',
        actorId: 'actor-b',
        ownership: 'exact_owned',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
    ],
  });
  assert.equal(outcome.status, 'ineligible');
});

test('complete owned look requires core slots', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 't1',
        slot: 'top',
        actorId: 'actor-a',
        ownership: 'exact_owned',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
      {
        closetItemId: 'b1',
        slot: 'bottom',
        actorId: 'actor-a',
        ownership: 'probable_owned',
        category: 'bottoms',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
      {
        closetItemId: 's1',
        slot: 'footwear',
        actorId: 'actor-a',
        ownership: 'exact_owned',
        category: 'shoes',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
    ],
  });
  assert.equal(outcome.status, 'complete');
  assert.equal(outcome.itemRefs.length, 3);
});

test('partial owned look when footwear missing', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 't1',
        slot: 'top',
        actorId: 'actor-a',
        ownership: 'exact_owned',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
      {
        closetItemId: 'b1',
        slot: 'bottom',
        actorId: 'actor-a',
        ownership: 'exact_owned',
        category: 'bottoms',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: null,
      },
    ],
  });
  assert.equal(outcome.status, 'partial');
  assert.ok(outcome.missingSlots.includes('footwear'));
});

test('Build 4 policy exclusion removes item without inventing threshold', () => {
  const outcome = evaluateTodayOwnedLookEligibility({
    actorId: 'actor-a',
    loadedForActorId: 'actor-a',
    requireOuterwear: false,
    candidates: [
      {
        closetItemId: 't1',
        slot: 'top',
        actorId: 'actor-a',
        ownership: 'exact_owned',
        category: 'tops',
        clothingType: null,
        subtype: null,
        primaryColor: null,
        secondaryColor: null,
        material: null,
        build4Confidence: {
          schemaVersion: 1,
          excludedByPolicy: true,
          policyVersion: 'build4-policy-v1',
        },
      },
    ],
  });
  assert.equal(outcome.status, 'ineligible');
  assert.equal(outcome.excluded[0].reason, 'build4_policy_excluded');
});
