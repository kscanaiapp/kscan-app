/**
 * Build 34 Scanner audit — the Item A invariant, at the action boundary.
 *
 * Sections 9 / 49 of the audit: "Save Item A" must save Item A. On the
 * multi-item confirmation step there are up to five detected garments and one
 * selection, and the whole-result actions (Save to Library, Add to Dressing
 * Room, Ask StyleChat) are bound to the SCAN, not to the selected candidate.
 * Offering them there would silently act on the primary garment while the user
 * is looking at garment three.
 *
 * ScanResultV2 already withholds them — and app.js's single-item save effect
 * correspondingly refuses to run while `confirmationCandidates` exist — but
 * the negative control (re-enable Save on the confirmation step) passed every
 * existing suite. This is that missing guard.
 *
 * Source-contract test, matching the convention multiItemCommerceZeroLatency
 * already uses for wiring that cannot be exercised without mounting the whole
 * modal tree.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const V2 = fs.readFileSync(path.join(ROOT, 'components/scan-results/ScanResultV2.tsx'), 'utf8');
const APP = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

/** The sticky action row's props block. */
function actionRow() {
  const start = V2.indexOf('<ScanResultActionRow');
  assert.ok(start > 0, 'ScanResultActionRow is missing from ScanResultV2');
  const end = V2.indexOf('/>', start);
  assert.ok(end > start, 'could not bound the ScanResultActionRow props');
  return V2.slice(start, end);
}

const SCAN_SCOPED_ACTIONS = [
  ['onSave', 'onSaveToLibrary'],
  ['onAskStyleChat', 'onAskStyleChat'],
  ['onAddToDressingRoom', 'onAddToDressingRoom'],
];

for (const [prop, handler] of SCAN_SCOPED_ACTIONS) {
  test(`${prop} is withheld on the multi-item confirmation step`, () => {
    const row = actionRow();
    const expected = `${prop}={isConfirmationStep ? undefined : ${handler}}`;
    assert.ok(
      row.includes(expected),
      `${prop} must be gated on isConfirmationStep. It acts on the SCAN, not on the selected ` +
        'garment, so offering it while several garments are shown means the user asks for one ' +
        'item and gets another.',
    );
  });
}

test('the only action offered on the confirmation step is bound to the selected candidate', () => {
  const row = actionRow();
  assert.ok(
    row.includes('handleFindCandidateMatches'),
    'the confirmation step must route its one action through the candidate-bound handler',
  );

  const start = V2.indexOf('const handleFindCandidateMatches');
  assert.ok(start > 0, 'handleFindCandidateMatches is missing');
  const body = V2.slice(start, start + 400);
  assert.ok(body.includes('if (!activeCandidateId) return;'),
    'the handler must refuse to act when no candidate is selected, rather than defaulting to one');
  assert.ok(body.includes('onAnalyzeSelectedCandidate?.(activeCandidateId)'),
    'the handler must pass the ACTIVE candidate id, never an index or the primary garment');
});

test('activeCandidateId is the explicit selection, falling back only to the first garment', () => {
  assert.ok(
    V2.includes('const activeCandidateId = selectedCandidateId ?? confirmationCandidates[0]?.id ?? null;'),
    'the active candidate must come from the explicit selection first',
  );
});

test('app.js does not write a single-item scan record while several garments are shown', () => {
  const start = APP.indexOf('// Save each successful scan once to the local Style Library.');
  assert.ok(start > 0, 'the single-item save effect is missing');
  const effect = APP.slice(start, start + 900);
  assert.ok(
    effect.includes('analysis.confirmationCandidates?.length ||'),
    'the single-item save must bail out while confirmation candidates exist, or a multi-item ' +
      'scan is persisted as though it were the primary garment alone',
  );
});

test('the multi-item save persists the candidates it was shown, not a single item', () => {
  const start = APP.indexOf('saveMultiItemScan({');
  assert.ok(start > 0, 'saveMultiItemScan call is missing');
  const call = APP.slice(start, APP.indexOf('})', start));
  assert.ok(call.includes('candidates: analysis.confirmationCandidates,'),
    'the persisted candidate list must be the one rendered, not a re-derived or sliced copy');
  assert.ok(call.includes('actorRequest'),
    'the write must carry the actor captured before the async hop');
});
