// Keeps the client's mirror of the scan-journey contract honest.
//
// `services/scanJourneyTypes.ts` duplicates the state union from
// `supabase/functions/_shared/scanJourneyState.ts` rather than importing it:
// the Edge module is Deno TypeScript with `.ts` import specifiers and Deno
// globals, and pulling it into the Metro bundle would drag a server runtime
// into the app.
//
// Duplication is fine. Duplication that silently diverges is not — a client
// that does not recognise a state the backend now sends will fall back to
// legacy handling and quietly stop rendering the new flow. These tests fail the
// moment the two lists disagree.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function read(relative) {
  return fs.readFileSync(path.join(ROOT, relative), 'utf8');
}

/** Pulls the members out of a `readonly`/plain string-array literal. */
function arrayMembers(source, name) {
  const match = new RegExp(`${name}[^=]*=\\s*\\[([\\s\\S]*?)\\]`).exec(source);
  assert.ok(match, `could not find the ${name} literal`);
  return [...match[1].matchAll(/'([A-Z_]+)'/g)].map((m) => m[1]).sort();
}

test('client and backend agree on the scan-journey states', () => {
  const backend = arrayMembers(
    read('supabase/functions/_shared/scanJourneyState.ts'),
    'SCAN_JOURNEY_STATES',
  );
  const client = arrayMembers(read('services/scanJourneyTypes.ts'), 'SCAN_JOURNEY_STATES');
  assert.deepEqual(client, backend);
  assert.equal(backend.length, 6);
});

test('client and backend agree on the similar-item actions', () => {
  const backend = [
    ...read('supabase/functions/product-match/contracts.ts')
      .match(/SIMILAR_ITEM_ACTIONS[^=]*=\s*\[([\s\S]*?)\]/)[1]
      .matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]).sort();

  const client = [
    ...read('services/similarItemActions.ts')
      .match(/ALL_SIMILAR_ITEM_ACTIONS[^=]*=\s*\[([\s\S]*?)\]/)[1]
      .matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]).sort();

  assert.deepEqual(client, backend);
  assert.equal(backend.length, 6);
});

test('every action the client can offer has a label', () => {
  const source = read('services/similarItemActions.ts');
  const actions = [
    ...source.match(/ALL_SIMILAR_ITEM_ACTIONS[^=]*=\s*\[([\s\S]*?)\]/)[1].matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]);
  const labels = source.match(/SIMILAR_ITEM_ACTION_LABELS[^=]*=\s*\{([\s\S]*?)\n\};/)[1];
  for (const action of actions) {
    assert.ok(labels.includes(`${action}:`), `${action} has no user-facing label`);
  }
});

test('client and backend agree on the similarity reasons', () => {
  const backend = [
    ...read('supabase/functions/product-match/contracts.ts')
      .match(/export type SimilarityReason =([\s\S]*?);/)[1]
      .matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]).sort();

  const client = [
    ...read('services/scanJourney.ts')
      .match(/export type SimilarityReason =([\s\S]*?);/)[1]
      .matchAll(/'([a-z_]+)'/g),
  ].map((m) => m[1]).sort();

  assert.deepEqual(client, backend);

  // And every reason must be renderable, or the notice shows a blank chip.
  const labels = read('services/similarItemActions.ts');
  for (const reason of backend) {
    assert.ok(labels.includes(`${reason}:`), `${reason} has no plain-language label`);
  }
});

test('the client never declares a duplicate verdict field', () => {
  const stripComments = (source) =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const relative of [
    'services/scanJourney.ts',
    'services/similarItemActions.ts',
    'services/scanSelectionSession.ts',
    'components/scan-results/PotentialSimilarItemNotice.tsx',
  ]) {
    assert.ok(
      !/isDuplicate/.test(stripComments(read(relative))),
      `${relative} must not declare an isDuplicate field`,
    );
  }
});

test('the notice component renders both panes and never auto-resolves', () => {
  const source = read('components/scan-results/PotentialSimilarItemNotice.tsx');
  // Both sides of the comparison.
  assert.match(source, /heading="Just scanned"/);
  assert.match(source, /SIMILAR_ITEM_SOURCE_LABELS\[item\.existingItemSource\]/);
  // Actions come from state-aware eligibility, not straight from the payload.
  assert.match(source, /eligibleSimilarItemActions\(recordState\)/);
  // No component-owned resolution: every action goes back to the caller.
  assert.ok(!/useState|useEffect|onDismiss|autoResolve/.test(source),
    'the notice must hold no state and resolve nothing on its own');
});
