// SCAN RESULTS ACTION SURFACE (Build 25 Phase 2, BUG-09 + BUG-12).
//
// BUG-09: the pinned bottom action bar was rgba(255, 253, 249, 0.96). Four
// percent of whatever scrolled underneath came through it, and over a dark
// garment photo that is enough to put moving content behind the button labels.
// Both pinned bars on this screen had the same value.
//
// BUG-09 also covers the content inset: the measured row height ALREADY
// contains the row's own safe-area padding, so adding the inset again
// double-counts it, and the pre-measurement floor was below a two-line row —
// one frame with the last item behind the bar.
//
// BUG-12: the "What would you like to do with this look?" prompt rendered
// unconditionally, including when every action handler resolved to undefined
// and the row below it rendered null.
//
// These are source-level guards. The styles are static StyleSheet objects and
// the repo has no react-test-renderer, so what is provable here is the declared
// contract — which is exactly what regressed.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const stripComments = (source) =>
  source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');

const ACTION_ROW = 'components/scan-results/ScanResultActionRow.tsx';
const RESULT_V2 = 'components/scan-results/ScanResultV2.tsx';

/** Any colour that is not fully opaque. */
const TRANSLUCENT = /rgba\s*\([^)]*,\s*0?\.\d+\s*\)|hsla\s*\([^)]*,\s*0?\.\d+\s*\)/;

function styleBlock(source, name) {
  const start = source.indexOf(`${name}: {`);
  assert.notEqual(start, -1, `expected a ${name} style block`);
  let depth = 0;
  for (let i = source.indexOf('{', start); i < source.length; i += 1) {
    if (source[i] === '{') depth += 1;
    if (source[i] === '}') {
      depth -= 1;
      if (depth === 0) return source.slice(start, i + 1);
    }
  }
  throw new Error(`unterminated ${name} style block`);
}

// ── BUG-09: the bars are opaque ──────────────────────────────────────────────

test('the pinned action row background is opaque', () => {
  const container = styleBlock(stripComments(read(ACTION_ROW)), 'container');
  assert.match(container, /backgroundColor:/);
  assert.equal(
    TRANSLUCENT.test(container),
    false,
    'content bleeding through the action bar is BUG-09 itself',
  );
  assert.equal(/opacity:/.test(container), false, 'an opacity would reintroduce the bleed');
});

test('the pinned review CTA background is opaque too', () => {
  // The second bar on the same screen. Fixing only one leaves the defect.
  const wrap = styleBlock(stripComments(read(RESULT_V2)), 'reviewCtaWrap');
  assert.match(wrap, /backgroundColor:/);
  assert.equal(TRANSLUCENT.test(wrap), false);
  assert.equal(/opacity:/.test(wrap), false);
});

test('neither pinned bar is a blur surface', () => {
  // A BlurView is translucent by definition and would restore the defect while
  // passing a naive colour check.
  for (const rel of [ACTION_ROW, RESULT_V2]) {
    assert.equal(/BlurView/.test(read(rel)), false, `${rel} must not blur the pinned bar`);
  }
});

test('the action row stays above scrolling content and respects the bottom inset', () => {
  const source = read(ACTION_ROW);
  const container = styleBlock(stripComments(source), 'container');
  assert.match(container, /position: 'absolute'/);
  assert.match(container, /zIndex: \d+/);
  assert.match(container, /elevation: \d+/, 'Android orders by elevation, not zIndex');

  // The inset is applied at the call site, not baked into the static style.
  assert.match(source, /useSafeAreaInsets\(\)/);
  assert.match(source, /paddingBottom: Math\.max\(SPACING\.md, insets\.bottom\)/);
});

// ── BUG-09: the last item is not occluded ────────────────────────────────────

test('scroll padding does not double-count the safe-area inset', () => {
  const source = stripComments(read(RESULT_V2));
  // Anchor on the measured-row block specifically — the review path below uses
  // its own fixed reservation and is not what regressed.
  const start = source.indexOf('actionRowHeight');
  assert.notEqual(start, -1, 'the analyzed-result path must measure the row');
  const region = source.slice(start, source.indexOf('actionRowHeight', start + 1) + 400);

  // The measured height already contains the row's own bottom inset padding.
  assert.match(
    region,
    /actionRowHeight > 0\s*\?\s*actionRowHeight/,
    'a measured row height must be used as-is',
  );
  assert.equal(
    /Math\.max\(actionRowHeight, \d+\)\s*\+\s*Math\.max\(insets\.bottom/.test(region),
    false,
    'adding the inset to a measured height counts it twice',
  );
});

test('the pre-measurement estimate covers a two-line action row', () => {
  const source = read(RESULT_V2);
  const declared = source.match(/const ESTIMATED_ACTION_ROW_HEIGHT = ([^;]+);/);
  assert.ok(declared, 'the first-frame reservation must be a named constant');

  // Four actions wrap to two 48pt lines on a narrow screen. The old floor of
  // 100 was under even one line plus its inset.
  const value = Function('SPACING', `return ${declared[1]}`)({ sm: 8, md: 12, xl: 24 });
  assert.ok(
    value >= 116,
    `an estimate of ${value} leaves the last item behind the bar on the first frame`,
  );
});

// ── BUG-12: no heading without actions ───────────────────────────────────────

test('the next-step prompt renders only when an action exists', () => {
  const source = stripComments(read(RESULT_V2));
  const promptIndex = source.indexOf('What would you like to do with this look?');
  assert.notEqual(promptIndex, -1, 'the prompt should still exist for the normal case');

  const preceding = source.slice(Math.max(0, promptIndex - 300), promptIndex);
  assert.match(
    preceding,
    /hasStickyActions \?/,
    'an unconditional prompt asks a question the screen cannot answer',
  );
});

test('the prompt gate mirrors the action row own filter', () => {
  const source = read(RESULT_V2);
  const gate = source.match(/const hasStickyActions =([\s\S]*?);/);
  assert.ok(gate, 'the gate must be derived, not hardcoded');

  // Every handler the row filters on has to appear in the gate, or the two can
  // disagree and the orphan heading comes back for one of them.
  for (const handler of ['onSaveToLibrary', 'onAskStyleChat', 'onAddToDressingRoom']) {
    assert.ok(gate[1].includes(handler), `${handler} is missing from the prompt gate`);
  }
  assert.ok(
    gate[1].includes('similarFindsTargetReady'),
    'Find Similar is conditional on having enough renderable finds',
  );
});

test('an action row with no actions still renders nothing', () => {
  // The row own guard, which the prompt gate mirrors. If this is removed the
  // gate above becomes a lie.
  assert.match(read(ACTION_ROW), /if \(actions\.length === 0\) return null;/);
});

// ── Preserved behaviour ──────────────────────────────────────────────────────

test('button contrast and the primary/secondary split are unchanged', () => {
  const source = stripComments(read(ACTION_ROW));
  const primary = styleBlock(source, 'primaryButton');
  const secondary = styleBlock(source, 'secondaryButton');
  assert.match(primary, /backgroundColor: LUXURY\.colors\.plum/);
  assert.match(secondary, /borderColor: LUXURY\.colors\.gold/);
  assert.match(source, /const isPrimary = index === 0/);
});

test('the row keeps 44pt-plus touch targets', () => {
  const button = styleBlock(stripComments(read(ACTION_ROW)), 'button');
  const minHeight = button.match(/minHeight: (\d+)/);
  assert.ok(minHeight && Number(minHeight[1]) >= 44, 'touch targets must stay accessible');
});

// ── Negative controls ────────────────────────────────────────────────────────

test('NEGATIVE CONTROL: the pre-repair translucent value fails the opacity gate', () => {
  const preRepair = "container: { backgroundColor: 'rgba(255, 253, 249, 0.96)', zIndex: 50 }";
  assert.equal(
    TRANSLUCENT.test(preRepair),
    true,
    'the exact value Phase 1 shipped must be detected as translucent',
  );

  // And the gate is not so loose that it accepts any alpha at all.
  for (const value of ['rgba(255, 253, 249, 0.99)', 'rgba(0, 0, 0, 0.5)', 'hsla(40, 10%, 98%, 0.9)']) {
    assert.equal(TRANSLUCENT.test(value), true, `${value} must not pass as opaque`);
  }
  for (const value of ['#FFFDF9', 'rgb(255, 253, 249)', 'LUXURY.colors.cream', 'rgba(255,253,249,1)']) {
    assert.equal(TRANSLUCENT.test(value), false, `${value} is opaque and must pass`);
  }
});

test('NEGATIVE CONTROL: the pre-repair padding floor did not clear a two-line row', () => {
  const PRE_REPAIR_FLOOR = 100;
  const TWO_LINE_ROW = 48 * 2 + 8 + 12; // 116, before any safe-area inset
  assert.ok(
    PRE_REPAIR_FLOOR < TWO_LINE_ROW,
    'the old floor must be provably short of a wrapped row',
  );
});
