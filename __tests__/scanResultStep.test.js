'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * Once the selected garment's result is showing, the result sheet is no longer on
 * the "choose a garment" step (Production Scanner debugger, P-FOOT-1).
 *
 * Found on the emulator with multi-image ON and a single-garment photo: detection
 * returns ONE candidate, the user taps Find Matches, the garment's analysis and its
 * shelf appear... and the sheet still behaves as the confirmation step. The sticky
 * footer keeps saying "Find Matches" (a button that re-runs the same analysis and
 * spends another scan), and Save / View Closet, Ask Elise and Add to Dressing Room
 * are withheld because they are "scan-scoped actions that would act on the wrong
 * garment" while several are on offer. With one garment on screen they are exactly
 * right. The cause is that the selected result deliberately keeps the detection's
 * candidate list for display, and the sheet derived "confirmation step" from the
 * list alone.
 */

const ROOT = path.resolve(__dirname, '..');
const V2_SOURCE = fs.readFileSync(path.join(ROOT, 'components/scan-results/ScanResultV2.tsx'), 'utf8');

function loadHelper() {
  const filename = path.join(ROOT, 'services/scanResultStep.ts');
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  vm.runInNewContext(output, { exports: mod.exports, module: mod }, { filename });
  return mod.exports;
}

const { isCandidateConfirmationStep } = loadHelper();

test('a detection result with candidates is the confirmation step', () => {
  assert.equal(isCandidateConfirmationStep({ candidateCount: 1 }), true);
  assert.equal(isCandidateConfirmationStep({ candidateCount: 3, selectedItemResult: false }), true);
});

test('the selected garment\'s result is NOT the confirmation step, though it keeps the candidates', () => {
  assert.equal(isCandidateConfirmationStep({ candidateCount: 1, selectedItemResult: true }), false);
});

test('no candidates is never the confirmation step', () => {
  assert.equal(isCandidateConfirmationStep({ candidateCount: 0 }), false);
  assert.equal(isCandidateConfirmationStep({ candidateCount: 0, selectedItemResult: true }), false);
});

test('only an explicit selectedItemResult:true ends the step (truthy look-alikes do not)', () => {
  for (const value of [undefined, null, false, 0, '', 'true', 1]) {
    assert.equal(
      isCandidateConfirmationStep({ candidateCount: 1, selectedItemResult: value }),
      true,
      `selectedItemResult=${JSON.stringify(value)}`,
    );
  }
});

// ── ScanResultV2 follows the helper ────────────────────────────────────────────

test('ScanResultV2 derives isConfirmationStep from the helper, with the selected-result marker', () => {
  assert.match(V2_SOURCE, /import \{ isCandidateConfirmationStep \} from '\.\.\/\.\.\/services\/scanResultStep';/);
  assert.match(
    V2_SOURCE,
    /const isConfirmationStep = isCandidateConfirmationStep\(\{\s*candidateCount: confirmationCandidates\.length,\s*selectedItemResult: analysis\?\.selectedItemResult === true,\s*\}\);/,
  );
});

test('the footer\'s primary action follows isConfirmationStep, not the raw candidate list', () => {
  const rowStart = V2_SOURCE.indexOf('<ScanResultActionRow');
  assert.ok(rowStart > 0, 'ScanResultActionRow is missing');
  const row = V2_SOURCE.slice(rowStart, V2_SOURCE.indexOf('/>', rowStart));
  assert.match(row, /onFindSimilar=\{\s*isConfirmationStep\s*\?/);
  assert.match(row, /findSimilarLabel=\{isConfirmationStep \? 'Find Matches' : 'Find Similar'\}/);
  assert.doesNotMatch(row, /confirmationCandidates\.length > 0/,
    'the footer must not key off the candidate list: the selected result keeps it');

  const sticky = V2_SOURCE.slice(
    V2_SOURCE.indexOf('const hasStickyActions ='),
    V2_SOURCE.indexOf('const handleBack'),
  );
  assert.match(sticky, /isConfirmationStep\s*\?\s*typeof onAnalyzeSelectedCandidate === 'function'/);
  assert.doesNotMatch(sticky, /confirmationCandidates\.length > 0/);
});

test('the scan-scoped actions stay withheld on the real confirmation step (Item A invariant)', () => {
  const rowStart = V2_SOURCE.indexOf('<ScanResultActionRow');
  const row = V2_SOURCE.slice(rowStart, V2_SOURCE.indexOf('/>', rowStart));
  assert.ok(row.includes('onSave={isConfirmationStep ? undefined : onSaveToLibrary}'));
  assert.ok(row.includes('onAskStyleChat={isConfirmationStep ? undefined : onAskStyleChat}'));
  assert.ok(row.includes('onAddToDressingRoom={isConfirmationStep ? undefined : onAddToDressingRoom}'));
});
