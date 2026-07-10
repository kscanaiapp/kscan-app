#!/usr/bin/env node
/**
 * Offline identification-accuracy matrix (sprint v1).
 *
 * Runs the 10 baseline scan phrases (plus item_type proxies) through the
 * deterministic accuracy path — normalizeCategory + deriveConfidenceLabel — and
 * prints a before/after table. "Before" is the committed (HEAD) version of
 * scanHelpers.ts; "after" is the current working tree. This needs no JWT, no
 * network, and no image, so it can measure the change deterministically. It is
 * a TEXT proxy: real visual accuracy must still be confirmed with image scans.
 *
 * Usage:
 *   node scripts/accuracy-matrix.js            # before(HEAD) vs after(working tree)
 *   node scripts/accuracy-matrix.js --after    # working tree only
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const HELPERS_REL = 'supabase/functions/_shared/scanHelpers.ts';

function loadFromSource(source) {
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = {
    __DEV__: false, console, exports: mod.exports, module: mod,
    Date, Math, Number, Object, Array, JSON, crypto: require('crypto'),
    require: (id) => { if (id.startsWith('node:')) return require(id); throw new Error('Unexpected require: ' + id); },
  };
  vm.runInNewContext(output, sandbox);
  return mod.exports;
}

function loadWorkingTree() {
  return loadFromSource(fs.readFileSync(path.join(ROOT, HELPERS_REL), 'utf8'));
}

function loadHead() {
  try {
    const src = execFileSync('git', ['show', `HEAD:${HELPERS_REL}`], { cwd: ROOT, encoding: 'utf8' });
    return loadFromSource(src);
  } catch (err) {
    console.log('[matrix] could not load HEAD version (git unavailable?):', err.message);
    return null;
  }
}

// The 10 baseline phrases + the item_type the model would emit for each.
const CASES = [
  { phrase: 'black puffer jacket', itemType: 'puffer jacket', expected: 'outerwear' },
  { phrase: 'cream wool coat', itemType: 'wool coat', expected: 'outerwear' },
  { phrase: 'navy blazer', itemType: 'blazer', expected: 'blazer' },
  { phrase: 'white sneakers', itemType: 'sneakers', expected: 'footwear' },
  { phrase: 'brown leather handbag', itemType: 'handbag', expected: 'bag' },
  { phrase: 'floral midi dress', itemType: 'midi dress', expected: 'dress' },
  { phrase: 'black tote bag next to jacket', itemType: 'jacket', expected: 'outerwear' },
  { phrase: 'lamp on table', itemType: 'NON_FASHION', expected: 'NON_FASHION' },
  { phrase: 'dark blurry clothing', itemType: 'unknown', expected: 'unknown/empty' },
  { phrase: 'person wearing jacket and carrying bag', itemType: 'jacket', expected: 'outerwear' },
];

const CATALOG = new Set(['outerwear', 'blazer', 'dress', 'footwear', 'bag', 'accessory']);

function pad(s, n) { s = String(s); return s + ' '.repeat(Math.max(0, n - s.length)); }

function run() {
  const afterOnly = process.argv.includes('--after');
  const after = loadWorkingTree();
  const before = afterOnly ? null : loadHead();

  console.log('# Identification accuracy matrix (text proxy)\n');
  console.log(pad('item_type', 22), pad('expected', 16), pad('before', 14), pad('after', 14), 'result');
  console.log('-'.repeat(82));

  let improved = 0, regressed = 0, correctAfter = 0;
  for (const c of CASES) {
    const a = after.normalizeCategory(c.itemType);
    const b = before ? before.normalizeCategory(c.itemType) : '(n/a)';
    const aOk = c.expected === 'unknown/empty' ? !CATALOG.has(a) : a === c.expected;
    const bOk = before ? (c.expected === 'unknown/empty' ? !CATALOG.has(b) : b === c.expected) : null;
    let result = 'unchanged';
    if (before) {
      if (!bOk && aOk) { result = 'IMPROVED'; improved++; }
      else if (bOk && !aOk) { result = 'REGRESSED'; regressed++; }
    }
    if (aOk) correctAfter++;
    console.log(pad(c.itemType, 22), pad(c.expected, 16), pad(b, 14), pad(a, 14), result);
  }

  console.log('\nConfidence label calibration (after):');
  for (const score of [0.95, 0.80, 0.79, 0.65, 0.6, 0.59, 0.3]) {
    console.log('  score', pad(score, 6), '->', after.deriveConfidenceLabel(score));
  }
  console.log('  score 0.90 + scan_quality_note ->', after.deriveConfidenceLabel(0.90, { hasQualityNote: true }));
  console.log('  score 0.92 + item_type=unknown ->', after.deriveConfidenceLabel(0.92, { itemType: 'unknown' }));

  console.log('\nSummary:');
  console.log('  cases:', CASES.length, '| correct after:', correctAfter,
    before ? `| improved: ${improved} | regressed: ${regressed}` : '| (no HEAD baseline)');
  if (regressed > 0) { process.exitCode = 2; }
}

run();
