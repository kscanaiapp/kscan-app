// Checkpoint 5A — development-surface containment and action safety.
//
// TWO PROPERTIES DEFENDED HERE
//
//   1. CONTAINMENT. Internal similarity scoring — scores, evidence classes,
//      vetoes, stage timings — is engineering diagnostics. A user reading
//      "score 0.82, evidence: shared_silhouette" would take a machine's
//      internal state as a claim about their own wardrobe. So it may appear
//      only behind the development gate, never on a production result path.
//
//   2. ACTION SAFETY. Similarity is advisory: it may propose, never resolve.
//      Nothing may merge, delete, reject, or substitute a record on the user's
//      behalf, and the one action that can destroy an existing record must be
//      unreachable without an explicit separate confirmation.
//
// No live user data is touched anywhere in this file — every check is either
// static (reading source text) or runs against isolated in-memory state.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/**
 * Source with comments removed.
 *
 * These checks are about what the code DOES and what the user SEES, so they
 * must read executable source rather than prose. Without this, a file is
 * penalised for documenting the very rule it follows — `PotentialSimilarItem-
 * Notice.tsx` explains in a comment that it never says "same item", and
 * `scannerSimilarityBinding.ts` names `deleteScan` only to describe a platform
 * divergence. Both are correct code and neither should fail a ban list.
 */
function codeOnly(relative) {
  return read(relative)
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

function exists(relative) {
  return fs.existsSync(path.join(ROOT, relative));
}

function loadTsModule(relative, requireMap = {}) {
  const filename = path.join(ROOT, relative);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    console, exports: mod.exports, module: mod, JSON, Math, Date,
    Object, Array, Set, Map, String, Number, Boolean, Error, RegExp, Promise,
    process: { env: {} },
    __DEV__: false,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      throw new Error(`unexpected import '${id}'`);
    },
  };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(output, sandbox, { filename });
  return mod.exports;
}

const actions = loadTsModule('services/similarItemActions.ts');

const DEV_ROUTE = 'app/dev/similarity-inspector.tsx';

/** Every file that can render a production scan result. */
const PRODUCTION_RESULT_PATHS = [
  'components/scan-results/PotentialSimilarItemNotice.tsx',
  'components/scan-results/ScanResultV2.tsx',
];

/**
 * Tokens that only ever describe INTERNAL scoring. `reasons` is deliberately
 * absent — the neutral reason list is user-facing copy by design.
 */
const INTERNAL_ONLY_TOKENS = [
  'debugSimilarity',
  'prioritizationVersion',
  'recordsRejected',
  'recordsConsidered',
  'prioritizeMs',
  'dedupeMs',
];

// ── I. Development-surface containment ──────────────────────────────────────

test('CONTAINMENT — the inspector exists and is gated by the development-only flag', () => {
  assert.ok(exists(DEV_ROUTE), 'the development inspector route must exist');
  const source = read(DEV_ROUTE);
  assert.ok(
    source.includes('QA_TOOLS_ENABLED'),
    'the inspector must read the development gate',
  );
  assert.ok(
    /if\s*\(!QA_TOOLS_ENABLED\)/.test(source),
    'the inspector must return early when the gate is off',
  );
});

test('CONTAINMENT — QA_TOOLS_ENABLED is a pure __DEV__ gate, not an env opt-in', () => {
  const source = read('constants/build.js');
  const line = source
    .split(/\r?\n/)
    .join('\n')
    .match(/export const QA_TOOLS_ENABLED[\s\S]*?;/);
  assert.ok(line, 'QA_TOOLS_ENABLED must be defined');
  assert.ok(line[0].includes('__DEV__'), 'the gate must be __DEV__ based');
  assert.equal(
    line[0].includes('process.env'), false,
    'the gate must NOT be flippable by an environment variable in a release build',
  );
});

test('CONTAINMENT — production result paths never render internal scoring details', () => {
  for (const file of PRODUCTION_RESULT_PATHS) {
    if (!exists(file)) continue;
    const source = codeOnly(file);
    for (const token of INTERNAL_ONLY_TOKENS) {
      assert.equal(
        source.includes(token), false,
        `${file} must not reference internal scoring token '${token}'`,
      );
    }
  }
});

test('CONTAINMENT — no production navigation links to the inspector route', () => {
  const roots = ['app', 'components', 'hooks', 'services'];
  const offenders = [];

  const walk = (dir) => {
    const full = path.join(ROOT, dir);
    if (!fs.existsSync(full)) return;
    for (const entry of fs.readdirSync(full, { withFileTypes: true })) {
      const rel = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules') continue;
        walk(rel);
        continue;
      }
      if (!/\.(t|j)sx?$/.test(entry.name)) continue;
      if (rel.replace(/\\/g, '/') === DEV_ROUTE) continue;
      const source = fs.readFileSync(path.join(ROOT, rel), 'utf8');
      if (source.includes('dev/similarity-inspector')) offenders.push(rel);
    }
  };
  roots.forEach(walk);

  assert.deepEqual(
    offenders, [],
    `the inspector route must not be linked from production navigation: ${offenders.join(', ')}`,
  );
});

test('CONTAINMENT — the inspector performs no mutation, scan, or network call', () => {
  const source = codeOnly(DEV_ROUTE);
  const FORBIDDEN = [
    'createClosetItem', 'deleteClosetItem', 'deleteScan', 'softDeleteCloudSavedScan',
    'runScannerIdentification', 'identifyScanImage', 'supabase', 'fetch(',
    'loadClosetTyped', 'loadLibrary',
  ];
  for (const token of FORBIDDEN) {
    assert.equal(
      source.includes(token), false,
      `the inspector must not reference '${token}'`,
    );
  }
});

// ── J. Action safety ────────────────────────────────────────────────────────

test('ACTIONS — only delete_existing_item may affect the existing record', () => {
  const touching = actions.ALL_SIMILAR_ITEM_ACTIONS
    .filter((action) => actions.ACTION_SCOPE[action].affectsExistingItem);
  assert.deepEqual(
    JSON.parse(JSON.stringify(touching)), ['delete_existing_item'],
    'exactly one action may touch the existing record',
  );
});

test('ACTIONS — reject_new_scan affects only the new scan', () => {
  const scope = actions.ACTION_SCOPE.reject_new_scan;
  assert.equal(scope.affectsNewScan, true);
  assert.equal(scope.affectsExistingItem, false);
});

test('ACTIONS — keep_both preserves both records independently', () => {
  const scope = actions.ACTION_SCOPE.keep_both;
  assert.equal(scope.affectsNewScan, false);
  assert.equal(scope.affectsExistingItem, false);
  assert.equal(scope.destructive, false);
});

test('ACTIONS — add_to_closet never overwrites the existing record', () => {
  const scope = actions.ACTION_SCOPE.add_to_closet;
  assert.equal(scope.affectsExistingItem, false);
  assert.equal(scope.destructive, false);
});

test('ACTIONS — keep_in_recent_scans creates no second record', () => {
  const scope = actions.ACTION_SCOPE.keep_in_recent_scans;
  assert.equal(scope.affectsExistingItem, false);
  assert.equal(scope.destructive, false);
});

test('ACTIONS — shop_identified_product resolves nothing on its own', () => {
  const scope = actions.ACTION_SCOPE.shop_identified_product;
  assert.equal(scope.affectsNewScan, false);
  assert.equal(scope.affectsExistingItem, false);
  assert.equal(scope.destructive, false);
});

test('ACTIONS — a destructive action without explicit confirmation throws', () => {
  for (const action of ['delete_existing_item', 'reject_new_scan']) {
    assert.throws(
      () => actions.assertConfirmedBeforeExecute(action, false),
      /requires explicit confirmation/,
      `${action} must refuse to execute unconfirmed`,
    );
    assert.doesNotThrow(() => actions.assertConfirmedBeforeExecute(action, true));
  }
});

test('ACTIONS — a non-destructive action needs no confirmation', () => {
  for (const action of ['keep_both', 'add_to_closet', 'keep_in_recent_scans', 'shop_identified_product']) {
    assert.doesNotThrow(() => actions.assertConfirmedBeforeExecute(action, false));
  }
});

test('ACTIONS — an archived existing record cannot be deleted', () => {
  const availability = actions.evaluateSimilarItemActions({
    existingItemExists: true,
    existingItemSource: 'closet',
    newItemSavedToCloset: false,
    newItemInRecentScans: true,
    hasCommerceCandidates: false,
    existingItemArchived: true,
  });
  const del = availability.find((entry) => entry.action === 'delete_existing_item');
  assert.ok(del, 'delete_existing_item must be represented');
  assert.equal(del.eligible, false, 'an archived record must not be deletable');
});

test('ACTIONS — a missing existing record cannot be deleted', () => {
  const availability = actions.evaluateSimilarItemActions({
    existingItemExists: false,
    existingItemSource: 'closet',
    newItemSavedToCloset: false,
    newItemInRecentScans: true,
    hasCommerceCandidates: false,
  });
  const del = availability.find((entry) => entry.action === 'delete_existing_item');
  assert.equal(del.eligible, false, 'a stale/absent record must not be deletable');
});

test('ACTIONS — an ineligible action carries a reason and never substitutes another', () => {
  const availability = actions.evaluateSimilarItemActions({
    existingItemExists: true,
    existingItemSource: 'closet',
    newItemSavedToCloset: true,
    newItemInRecentScans: false,
    hasCommerceCandidates: false,
  });
  for (const entry of availability) {
    if (entry.eligible) continue;
    assert.ok(entry.reason, `${entry.action} must explain why it is unavailable`);
    // The availability record must never name a different action to run
    // instead — that would be the client resolving the comparison for the user.
    assert.equal(
      Object.prototype.hasOwnProperty.call(entry, 'fallbackAction'), false,
      'an unavailable action must not nominate a substitute',
    );
  }
});

test('ACTIONS — the notice component performs no mutation itself', () => {
  const source = codeOnly('components/scan-results/PotentialSimilarItemNotice.tsx');
  for (const token of [
    'createClosetItem', 'deleteClosetItem', 'deleteScan',
    'softDeleteCloudSavedScan', 'supabase',
  ]) {
    assert.equal(
      source.includes(token), false,
      `the notice must not call '${token}' — it renders and delegates only`,
    );
  }
});

test('ACTIONS — no automatic mutation is wired to candidate attachment', () => {
  for (const file of [
    'services/scannerSimilarityAttachment.ts',
    'services/scannerSimilarityBinding.ts',
    'services/similarItemCandidateProvider.ts',
  ]) {
    const source = codeOnly(file);
    for (const token of [
      'createClosetItem', 'deleteClosetItem', 'deleteScan',
      'softDeleteCloudSavedScan', 'promoteToCloset',
    ]) {
      assert.equal(
        source.includes(token), false,
        `${file} must not reference the mutation primitive '${token}'`,
      );
    }
  }
});

// ── Advisory language ───────────────────────────────────────────────────────

test('LANGUAGE — no definitive duplicate claim appears in the similarity surface', () => {
  const FORBIDDEN = [
    /\bisDuplicate\b/,
    /duplicate item/i,
    /same item/i,
    /you already own this/i,
    /confirmed duplicate/i,
  ];
  for (const file of [
    'services/similarItemActions.ts',
    'components/scan-results/PotentialSimilarItemNotice.tsx',
    'services/scannerSimilarityAttachment.ts',
    'services/scannerSimilarityBinding.ts',
    DEV_ROUTE,
  ]) {
    if (!exists(file)) continue;
    const source = codeOnly(file);
    for (const pattern of FORBIDDEN) {
      assert.equal(
        pattern.test(source), false,
        `${file} must not use definitive duplicate language (${pattern})`,
      );
    }
  }
});

test('LANGUAGE — the advisory term is the one used throughout', () => {
  const source = read('services/scannerSimilarityAttachment.ts');
  assert.ok(
    source.includes('similarity') || source.includes('Similarity'),
    'the attachment module should describe itself as similarity',
  );
  assert.equal(source.includes('isDuplicate'), false);
});
