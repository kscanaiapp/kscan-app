// Regression cover for the P1 live Elise photo-upload rejection.
//
// The defect: an ordinary worn-garment photo — one dominant garment plus an
// incidental sliver of another — came back as a multi-candidate detection, and
// Elise's item path treats any multi-candidate detection as terminal. These
// tests pin the two halves of the repair that must never drift apart: a photo
// with a clear subject resolves, and a photo without one still asks.

import assert from 'node:assert/strict';
import {
  ELISE_GARMENT_DOMINANCE_RATIO,
  ELISE_ITEM_ENTRY_PATHS,
  isEliseItemEntryPath,
  resolveEliseDominantGarment,
} from './eliseDominantGarment.ts';
import { sanitizeDetectedGarments } from './multiItemGarments.ts';
import type { SanitizedDetectedGarment } from './multiItemGarments.ts';

type Box = { x: number; y: number; width: number; height: number };

function garment(
  candidateId: string,
  category: string,
  bounds: Box | undefined,
  order = 0,
  confidenceScore?: number,
): SanitizedDetectedGarment {
  return {
    candidateId,
    order,
    label: `${category} label`,
    category,
    subtype: category,
    ...(bounds ? { bounds } : {}),
    ...(confidenceScore !== undefined ? { confidenceScore } : {}),
    attributes: { category, itemType: category },
    identification: { item_type: category, subtype: category },
  };
}

// The reported image class: a close-up dominated by a white long-sleeve top
// with a small band of grey lower-body clothing along the bottom edge.
// Structural stand-in only — no user photograph is stored in this repository.
const WHITE_TOP: Box = { x: 0.08, y: 0.04, width: 0.84, height: 0.74 };
const INCIDENTAL_GREY_BOTTOM: Box = { x: 0.1, y: 0.86, width: 0.8, height: 0.12 };

// ── Entry-path scope ─────────────────────────────────────────────────────────

Deno.test('only the two Elise item entry paths opt in', () => {
  assert.deepEqual([...ELISE_ITEM_ENTRY_PATHS], ['elise_camera', 'elise_gallery']);
  assert.equal(isEliseItemEntryPath('elise_camera'), true);
  assert.equal(isEliseItemEntryPath('elise_gallery'), true);

  // Scanner keeps its multi-item candidate set; Closet stages every garment;
  // the header gallery is outfit-oriented. None of them may be narrowed.
  for (
    const other of [
      'scanner_camera',
      'scanner_gallery',
      'scanner_handoff',
      'closet_camera',
      'closet_gallery',
      'closet_mirror',
      'elise_header_gallery',
    ]
  ) {
    assert.equal(isEliseItemEntryPath(other), false, `${other} must not be narrowed`);
  }
  assert.equal(isEliseItemEntryPath(null), false);
  assert.equal(isEliseItemEntryPath(undefined), false);
  assert.equal(isEliseItemEntryPath(''), false);
});

// ── The reported defect ──────────────────────────────────────────────────────

Deno.test('dominant top plus an incidental second garment resolves to the top', () => {
  const result = resolveEliseDominantGarment([
    garment('garment-1-top-henley', 'top', WHITE_TOP, 0),
    garment('garment-2-bottoms-trousers', 'bottoms', INCIDENTAL_GREY_BOTTOM, 1),
  ]);

  assert.equal(result.kind, 'dominant');
  if (result.kind !== 'dominant') return;
  assert.equal(result.garment.candidateId, 'garment-1-top-henley');
  assert.equal(result.reason, 'area_dominance');
});

Deno.test('detection order never decides the winner — area does', () => {
  // Same photo, provider emitted the incidental garment first.
  const result = resolveEliseDominantGarment([
    garment('garment-1-bottoms-trousers', 'bottoms', INCIDENTAL_GREY_BOTTOM, 0),
    garment('garment-2-top-henley', 'top', WHITE_TOP, 1),
  ]);

  assert.equal(result.kind, 'dominant');
  if (result.kind !== 'dominant') return;
  assert.equal(result.garment.candidateId, 'garment-2-top-henley');
});

Deno.test('the real sanitizer produces boxes this rule resolves', () => {
  // Proves the repair works on the shape detection actually emits, including
  // Gemini's [yMin, xMin, yMax, xMax] 0..1000 boxes, not just on hand-built
  // fractions. 40..820 down the frame is the top; 880..980 is the hem below it.
  const garments = sanitizeDetectedGarments([
    {
      category: 'top',
      subtype: 'henley',
      bounds: [40, 80, 820, 920],
      identification: { item_type: 'top', subtype: 'henley', primary_color: 'white' },
    },
    {
      category: 'bottoms',
      subtype: 'trousers',
      bounds: [880, 100, 980, 900],
      identification: { item_type: 'bottoms', subtype: 'trousers', primary_color: 'grey' },
    },
  ]);
  assert.equal(garments.length, 2);

  const result = resolveEliseDominantGarment(garments);
  assert.equal(result.kind, 'dominant');
  if (result.kind !== 'dominant') return;
  assert.equal(result.garment.category, 'top');
});

// ── Ambiguity must still ask ─────────────────────────────────────────────────

Deno.test('a full outfit at comparable prominence stays ambiguous', () => {
  // Shirt over trousers, both squarely in frame. Guessing here is the failure
  // mode this rule exists to prevent.
  const result = resolveEliseDominantGarment([
    garment('garment-1-top-shirt', 'top', { x: 0.2, y: 0.05, width: 0.6, height: 0.42 }, 0),
    garment('garment-2-bottoms-trousers', 'bottoms', {
      x: 0.22,
      y: 0.48,
      width: 0.56,
      height: 0.47,
    }, 1),
  ]);

  assert.equal(result.kind, 'ambiguous');
  if (result.kind !== 'ambiguous') return;
  assert.equal(result.reason, 'comparable_area');
});

Deno.test('two garments side by side stay ambiguous', () => {
  const result = resolveEliseDominantGarment([
    garment('garment-1-dresses-slip', 'dresses', { x: 0.04, y: 0.1, width: 0.42, height: 0.8 }, 0),
    garment('garment-2-dresses-shift', 'dresses', { x: 0.54, y: 0.1, width: 0.42, height: 0.8 }, 1),
  ]);

  assert.equal(result.kind, 'ambiguous');
  if (result.kind !== 'ambiguous') return;
  assert.equal(result.reason, 'comparable_area');
});

Deno.test('the dominance boundary is exactly the shared ratio, inclusive', () => {
  // Runner-up area is fixed at 0.1; the top is sized to land precisely on and
  // just under the threshold, so a silent change to the ratio fails here.
  const runnerUp = garment('garment-2-bottoms-trousers', 'bottoms', {
    x: 0,
    y: 0.8,
    width: 0.5,
    height: 0.2,
  }, 1);

  const atThreshold = resolveEliseDominantGarment([
    garment('garment-1-top-knit', 'top', {
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.2 * ELISE_GARMENT_DOMINANCE_RATIO,
    }, 0),
    runnerUp,
  ]);
  assert.equal(atThreshold.kind, 'dominant');

  const justUnder = resolveEliseDominantGarment([
    garment('garment-1-top-knit', 'top', {
      x: 0,
      y: 0,
      width: 0.5,
      height: 0.2 * ELISE_GARMENT_DOMINANCE_RATIO - 0.001,
    }, 0),
    runnerUp,
  ]);
  assert.equal(justUnder.kind, 'ambiguous');
});

Deno.test('an unboxed candidate makes the whole set ambiguous', () => {
  // The unboxed garment could be anything, including the subject. Ranking only
  // the measurable ones would rank an incomplete field.
  const result = resolveEliseDominantGarment([
    garment('garment-1-top-henley', 'top', WHITE_TOP, 0),
    garment('garment-2-bags-tote', 'bags', undefined, 1),
  ]);

  assert.equal(result.kind, 'ambiguous');
  if (result.kind !== 'ambiguous') return;
  assert.equal(result.reason, 'missing_bounds');
});

Deno.test('a high-confidence incidental garment cannot buy dominance', () => {
  // Confidence is "did I classify this right", not "is this the subject".
  // A crisply read waistband must not beat a partly out-of-frame coat.
  const result = resolveEliseDominantGarment([
    garment('garment-1-outerwear-coat', 'outerwear', {
      x: 0.05,
      y: 0.05,
      width: 0.55,
      height: 0.6,
    }, 0, 0.41),
    garment('garment-2-bottoms-trousers', 'bottoms', {
      x: 0.1,
      y: 0.5,
      width: 0.7,
      height: 0.45,
    }, 1, 0.99),
  ]);

  // 0.33 vs 0.315 — comparable, so it asks rather than handing it to either.
  assert.equal(result.kind, 'ambiguous');
});

// ── Degenerate input ─────────────────────────────────────────────────────────

Deno.test('one garment resolves without consulting the ratio', () => {
  const result = resolveEliseDominantGarment([garment('garment-1-top-tee', 'top', undefined, 0)]);
  assert.equal(result.kind, 'dominant');
  if (result.kind !== 'dominant') return;
  assert.equal(result.reason, 'single');
  // Deliberately unboxed: a lone candidate needs no comparison, and this is
  // already the client's auto-continue case today.
  assert.equal(result.garment.candidateId, 'garment-1-top-tee');
});

Deno.test('no garments is ambiguous, never a resolution', () => {
  const result = resolveEliseDominantGarment([]);
  assert.equal(result.kind, 'ambiguous');
  if (result.kind !== 'ambiguous') return;
  assert.equal(result.reason, 'no_candidates');
});

Deno.test('a zero-area box cannot dominate', () => {
  const result = resolveEliseDominantGarment([
    garment('garment-1-top-tee', 'top', { x: 0.1, y: 0.1, width: 0, height: 0 }, 0),
    garment('garment-2-bottoms-jeans', 'bottoms', { x: 0.1, y: 0.5, width: 0, height: 0.4 }, 1),
  ]);
  assert.equal(result.kind, 'ambiguous');
});

Deno.test('resolution never mutates or reorders the caller list', () => {
  const input = [
    garment('garment-1-bottoms-trousers', 'bottoms', INCIDENTAL_GREY_BOTTOM, 0),
    garment('garment-2-top-henley', 'top', WHITE_TOP, 1),
  ];
  const snapshot = JSON.parse(JSON.stringify(input));

  resolveEliseDominantGarment(input);

  assert.deepEqual(JSON.parse(JSON.stringify(input)), snapshot);
  assert.equal(input[0].candidateId, 'garment-1-bottoms-trousers');
});

// ── Wiring: the rule is applied where it belongs, and nowhere else ───────────
//
// `index.ts` is a Deno server module with request-scoped state, so the
// projection cannot be imported and called in isolation. These read the source
// to pin the wiring the behaviour above depends on.

const INDEX_SOURCE = Deno.readTextFileSync(new URL('./index.ts', import.meta.url));

Deno.test('WIRING: the candidate projection is gated on the Elise item entry path', () => {
  const start = INDEX_SOURCE.indexOf('const eliseDominant =');
  assert.ok(start > 0, 'index.ts no longer resolves an Elise dominant garment');
  const block = INDEX_SOURCE.slice(start, INDEX_SOURCE.indexOf('const v2DetectionCandidates', start));

  assert.match(block, /isEliseItemEntryPath\(internalRequest\.entryPath\)/);
  assert.match(block, /resolveEliseDominantGarment\(detectedGarments\)/);
  // Only a genuine multi-candidate detection is narrowed. A single-garment
  // detection must reach the projection on exactly the path it does today.
  assert.match(block, /detectedGarments\.length > 1/);
});

Deno.test('WIRING: narrowing applies only when a garment actually dominates', () => {
  assert.match(
    INDEX_SOURCE,
    /const v2CandidateGarments = eliseDominant\?\.kind === 'dominant'\s*\n\s*\? \[eliseDominant\.garment\]\s*\n\s*: detectedGarments;/,
    'an ambiguous or absent resolution must pass every detected garment through',
  );
});

Deno.test('WIRING: nothing else in the function consults the dominance rule', () => {
  // Scanner, Closet and the header gallery share this handler. Exactly one
  // call site keeps "which paths are narrowed" answerable by reading one place.
  const calls = INDEX_SOURCE.match(/resolveEliseDominantGarment\(/g) ?? [];
  assert.equal(calls.length, 1, 'the dominance rule must have exactly one call site');
  const gates = INDEX_SOURCE.match(/isEliseItemEntryPath\(/g) ?? [];
  assert.equal(gates.length, 1, 'the entry-path gate must have exactly one call site');
});

Deno.test('WIRING: the resolution log carries no image or garment content', () => {
  const start = INDEX_SOURCE.indexOf('elise_item_candidate_resolution');
  assert.ok(start > 0, 'the resolution telemetry line is gone');
  const line = INDEX_SOURCE.slice(start - 200, start + 500);

  // Bounded enum values and a count only. A label, category or any provider
  // string here would put garment content into a log line.
  for (
    const forbidden of ['garment.label', 'garment.category', 'identification', 'imageBase64']
  ) {
    assert.equal(line.includes(forbidden), false, `resolution log must not carry ${forbidden}`);
  }
  assert.match(line, /requestHash=%s/);
  assert.match(line, /sha256Hex\(internalRequest\.requestId \?\? scanId\)/);
});

Deno.test('identical boxes resolve deterministically rather than by input order', () => {
  const box: Box = { x: 0.2, y: 0.2, width: 0.5, height: 0.5 };
  const forwards = resolveEliseDominantGarment([
    garment('garment-1-top-tee', 'top', box, 0),
    garment('garment-2-bottoms-jeans', 'bottoms', box, 1),
  ]);
  const backwards = resolveEliseDominantGarment([
    garment('garment-2-bottoms-jeans', 'bottoms', box, 1),
    garment('garment-1-top-tee', 'top', box, 0),
  ]);

  // Equal areas are never dominant, so both orderings ask — and they agree.
  assert.equal(forwards.kind, 'ambiguous');
  assert.equal(backwards.kind, 'ambiguous');
});
