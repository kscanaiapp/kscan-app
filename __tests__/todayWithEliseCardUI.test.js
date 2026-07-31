// Build 5 Phase 2 — Today card UI contract.
//
// The card is presentation only, so what is provable without a renderer is what
// it renders FROM and what it structurally cannot render. Each assertion below
// targets a rule the addendum states: no dead control, a truthful partial Look,
// a safe image fallback, no commerce, no raw state, and accessibility that does
// not depend on colour or motion.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const Module = require('node:module');

const ROOT = path.resolve(__dirname, '..');

if (!Module._extensions['.ts']) {
  Module._extensions['.ts'] = function compileTs(module, filename) {
    const out = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
      fileName: filename,
    }).outputText;
    module._compile(out, filename);
  };
}

const presentation = require(path.join(ROOT, 'services/todayWithElise/presentation.ts'));
const { TODAY_WITH_ELISE_STATE_IDS } = require(path.join(ROOT, 'types/todayWithElise.ts'));

const card = fs.readFileSync(path.join(ROOT, 'components/home/TodayWithEliseCard.tsx'), 'utf8');
const section = fs.readFileSync(
  path.join(ROOT, 'components/home/TodayWithEliseSection.tsx'),
  'utf8',
);

const NOW = Date.parse('2026-07-30T09:00:00Z');

/**
 * Prohibition checks run against CODE, not prose. The card's own comments
 * explain what it refuses to do ("no retailer image is substituted"), and a
 * naive substring scan would read that explanation as the violation.
 */
function codeOnly(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
}

const cardCode = codeOnly(card);

function baseCard(overrides = {}) {
  return {
    stateId: 'today_owned_look',
    actorId: 'actor-a',
    actorEpoch: 1,
    generationToken: 'today_1_1',
    headlineKey: 'headline.today_owned_look',
    explanationKey: 'explanation.today_owned_look',
    primaryAction: {
      action: 'tap_to_get_ready',
      labelKey: 'action.tap_to_get_ready',
      target: 'private_dressing_room',
      runnable: true,
    },
    secondaryAction: {
      action: 'change_something',
      labelKey: 'action.change_something',
      target: 'elise_modification',
      runnable: true,
    },
    itemRefs: [
      { closetItemId: 'item-top', slot: 'top' },
      { closetItemId: 'item-shoes', slot: 'footwear' },
    ],
    completeness: 'complete',
    source: 'owned_closet_composition',
    weatherDependent: false,
    dressingRoomDependent: true,
    analyticsClass: 'eligible',
    safeFallbackStateId: 'fallback',
    priority: 'today_owned_look',
    ...overrides,
  };
}

const PROJECTIONS = [
  { id: 'item-top', title: 'Silk blouse', imageUri: 'file://top.jpg', thumbnailUri: null },
  { id: 'item-shoes', title: '', imageUri: null, thumbnailUri: null },
];

function project(cardState, missingSlots = []) {
  return presentation.projectTodayCard({
    card: cardState,
    projections: PROJECTIONS,
    missingSlots,
    nowMs: NOW,
  });
}

// ── Every approved state produces a renderable projection ────────────────────

test('every contract state produces copy without throwing', () => {
  for (const stateId of TODAY_WITH_ELISE_STATE_IDS) {
    if (stateId === 'loading') continue;
    const view = project(baseCard({ stateId }));
    assert.ok(view.headline.length > 0, `${stateId} produced no headline`);
    assert.ok(view.explanation.length > 0, `${stateId} produced no explanation`);
  }
});

test('a state with no runnable action renders no button', () => {
  const view = project(
    baseCard({
      stateId: 'fallback',
      primaryAction: { action: 'none', labelKey: 'action.none', target: 'none', runnable: false },
      secondaryAction: null,
      itemRefs: [],
    }),
  );
  assert.equal(view.primaryLabel, null);
  assert.equal(view.secondaryLabel, null);
  assert.equal(view.actionless, true);
});

test('an action marked not runnable never produces a label', () => {
  const view = project(
    baseCard({
      primaryAction: {
        action: 'tap_to_get_ready',
        labelKey: 'action.tap_to_get_ready',
        target: 'private_dressing_room',
        runnable: false,
      },
      secondaryAction: {
        action: 'change_something',
        labelKey: 'action.change_something',
        target: 'elise_modification',
        runnable: false,
      },
    }),
  );
  assert.equal(view.primaryLabel, null);
  assert.equal(view.secondaryLabel, null);
});

// ── Complete Look ────────────────────────────────────────────────────────────

test('a complete Look renders only approved actor-owned items', () => {
  const view = project(baseCard());
  assert.deepEqual(
    view.items.map((item) => item.closetItemId),
    ['item-top', 'item-shoes'],
  );
  assert.equal(view.missingSlotLabels.length, 0);
  assert.equal(view.primaryLabel, 'Tap to Get Ready');
  assert.equal(view.secondaryLabel, 'Change Something');
});

test('an item with no title falls back to its slot label, never a blank', () => {
  const view = project(baseCard());
  const shoes = view.items.find((item) => item.closetItemId === 'item-shoes');
  assert.equal(shoes.title, 'Shoes');
});

test('an item with no image resolves to no image rather than a broken one', () => {
  const view = project(baseCard());
  const shoes = view.items.find((item) => item.closetItemId === 'item-shoes');
  assert.equal(shoes.imageUri, null);
});

// ── Partial Look ─────────────────────────────────────────────────────────────

test('a partial Look shows present items and a missing-slot treatment', () => {
  const partial = presentation.projectPartialLookActions(
    baseCard({
      stateId: 'partial_look',
      completeness: 'partial',
      itemRefs: [{ closetItemId: 'item-top', slot: 'top' }],
    }),
  );
  const view = project(partial, ['bottom', 'footwear']);
  assert.deepEqual(view.items.map((i) => i.slotLabel), ['Top']);
  assert.deepEqual(view.missingSlotLabels, ['Bottom', 'Shoes']);
  assert.match(view.missingSummary, /Add a bottom and shoes to complete this Look\./);
});

test('a partial Look never offers Tap to Get Ready or Change Something', () => {
  const partial = presentation.projectPartialLookActions(
    baseCard({ stateId: 'partial_look', completeness: 'partial' }),
  );
  const view = project(partial, ['footwear']);
  assert.equal(view.primaryLabel, 'Add More Items');
  assert.equal(view.secondaryLabel, null);
  assert.notEqual(view.primaryLabel, 'Tap to Get Ready');
});

test('a missing slot is never rendered as an owned item', () => {
  const partial = presentation.projectPartialLookActions(
    baseCard({
      stateId: 'partial_look',
      completeness: 'partial',
      itemRefs: [{ closetItemId: 'item-top', slot: 'top' }],
    }),
  );
  const view = project(partial, ['footwear']);
  assert.equal(view.items.length, 1);
  assert.ok(!view.items.some((item) => item.slotLabel === 'Shoes'));
});

test('a partial Look is never described as complete', () => {
  const partial = presentation.projectPartialLookActions(
    baseCard({ stateId: 'partial_look', completeness: 'partial' }),
  );
  const view = project(partial, ['footwear']);
  assert.doesNotMatch(view.explanation, /complete Look\b(?! \()/i);
  assert.match(view.explanation, /partial Look/i);
});

// ── Truthfulness and privacy ─────────────────────────────────────────────────

test('no retailer, price or purchase language appears in any state copy', () => {
  for (const stateId of TODAY_WITH_ELISE_STATE_IDS) {
    if (stateId === 'loading') continue;
    const view = project(baseCard({ stateId }));
    const text = `${view.headline} ${view.explanation}`;
    assert.doesNotMatch(text, /\$|buy|shop now|checkout|price|retailer|discount|sale/i, stateId);
  }
});

test('no raw id, image path or private state appears in rendered strings', () => {
  const view = project(baseCard());
  const rendered = `${view.headline} ${view.explanation} ${view.accessibilityLabel}`;
  for (const forbidden of ['item-top', 'file://', 'actor-a', 'today_1_1']) {
    assert.ok(!rendered.includes(forbidden), `leaked ${forbidden}`);
  }
});

test('no state exposes a technical error to the user', () => {
  for (const stateId of ['fallback', 'incompatible', 'unavailable', 'stale', 'unauthorized']) {
    const view = project(baseCard({ stateId }));
    assert.doesNotMatch(
      `${view.headline} ${view.explanation}`,
      /undefined|null|NaN|Error|exception|stack|ENOENT/i,
      stateId,
    );
  }
});

// ── Card source contract ─────────────────────────────────────────────────────

test('the card renders no commerce affordance of any kind', () => {
  assert.doesNotMatch(cardCode, /purchaseOption|Linking\.openURL|buy|checkout|retailer/i);
});

test('the card introduces no animation architecture and no new avatar asset', () => {
  assert.doesNotMatch(
    cardCode,
    /Animated\.|useSharedValue|withTiming|LottieView|require\('\.\.\/\.\.\/assets/,
  );
});

test('a failed image decodes to the slot placeholder, not a broken box', () => {
  assert.match(card, /onError=\{onError\}/);
  assert.match(card, /const showImage = !!item\.imageUri && !failed;/);
  assert.match(card, /tilePlaceholder/);
});

test('the garment row is one accessible element with a spoken summary', () => {
  assert.match(card, /accessibilityLabel=\{presentation\.accessibilityLabel\}/);
  assert.match(card, /accessibilityElementsHidden/);
});

test('a missing slot is announced in words, never by border style alone', () => {
  const view = project(
    presentation.projectPartialLookActions(
      baseCard({ stateId: 'partial_look', completeness: 'partial' }),
    ),
    ['footwear'],
  );
  assert.match(view.accessibilityLabel, /Missing Shoes/);
  assert.match(card, /Missing<\/Text>|>\s*Missing\s*</);
});

test('the heading is a header and the stable focus target', () => {
  assert.match(card, /accessibilityRole="header"/);
  assert.match(card, /ref=\{headingRef\}/);
  assert.match(section, /headingRef/);
});

test('loading is a bounded card-level treatment, never a full-screen spinner', () => {
  assert.match(card, /accessibilityRole="progressbar"/);
  assert.match(card, /accessibilityLiveRegion="polite"/);
  assert.doesNotMatch(card, /Modal|position: 'absolute'|StyleSheet\.absoluteFill/);
});

test('explanatory copy is not truncated, so large text stays readable', () => {
  const explanationBlock = card.slice(card.indexOf('styles.explanation'), card.indexOf('tileRow'));
  assert.ok(!/numberOfLines/.test(explanationBlock.split('\n')[0]));
  assert.doesNotMatch(card, /<Text style=\{styles\.explanation\} numberOfLines/);
});

test('controls keep a 44dp minimum target', () => {
  assert.match(card, /minHeight: 48/);
  assert.match(card, /minHeight: 44/);
});
