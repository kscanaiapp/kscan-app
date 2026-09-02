/**
 * Build 34 / K+ Wardrobe Concierge -- UX maturity (2026-09-02).
 *
 * Two surfaces, one rule between them: the interface may say what is being
 * DONE and what the server PROVED, and nothing else.
 *
 *   the staged wait    describes work requested, never a result obtained
 *   the provenance     comes from the server's relationship, never from prose
 *
 * A progress stage that narrates a Closet read on a turn that never touches
 * the Closet, or a chip that says "In your Closet" because the model used the
 * words, would each undo exactly the trust the wardrobe-truth work buys.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');

const {
  CONCIERGE_PROGRESS_STAGES,
  conciergeProgressStageAt,
  messageReadsAsWardrobeRequest,
  shouldShowConciergeProgress,
} = require('../services/concierge/conciergeProgress.ts');
const {
  conciergeCardAccessibilityLabel,
  conciergeCardLabel,
  conciergeGapCopy,
} = require('../services/concierge/conciergeLabels.ts');

// ── the staged wait ──────────────────────────────────────────────────────────

test('UX-1: the stages advance with elapsed time and never run backwards', () => {
  const seen = [];
  for (let ms = 0; ms <= 20_000; ms += 100) {
    const stage = conciergeProgressStageAt(ms);
    if (seen[seen.length - 1] !== stage.id) seen.push(stage.id);
  }
  assert.deepEqual(seen, CONCIERGE_PROGRESS_STAGES.map((stage) => stage.id));
});

test('UX-1: a slow turn parks on the final stage rather than looping or blanking', () => {
  const last = CONCIERGE_PROGRESS_STAGES[CONCIERGE_PROGRESS_STAGES.length - 1];
  for (const ms of [10_000, 30_000, 120_000, Number.MAX_SAFE_INTEGER]) {
    assert.equal(conciergeProgressStageAt(ms).id, last.id);
  }
});

test('UX-1: nonsense elapsed values resolve to the first stage, never to nothing', () => {
  for (const ms of [-1, NaN, Infinity * -1, undefined]) {
    const stage = conciergeProgressStageAt(ms);
    assert.ok(stage && typeof stage.title === 'string' && stage.title.length > 0);
  }
});

test('UX-1: no stage claims a result, a count, or completion', () => {
  // The invariant that makes the staged copy safe: it describes work requested.
  // "Found 12 pieces" or "Done" would be a claim about the customer's Closet
  // that the client has no evidence for and the server has not yet returned.
  const forbidden =
    /\b(?:done|complete|completed|finished|ready|found|success|no items|nothing|\d+\s+(?:item|piece))/i;
  for (const stage of CONCIERGE_PROGRESS_STAGES) {
    for (const line of [stage.title, stage.subtitle]) {
      assert.ok(!forbidden.test(line), `stage "${stage.id}" claims an outcome: ${line}`);
    }
  }
});

test('UX-1: the wardrobe-request hint is narrow, and errs towards the plain spinner', () => {
  for (const yes of [
    'What can I wear to a smart-casual dinner?',
    'What do I already own that works for work?',
    'Style my black leather jacket for the weekend',
    'What is missing from my wardrobe?',
    'Put something together from my closet only',
    'Show me an outfit without buying anything',
  ]) {
    assert.equal(messageReadsAsWardrobeRequest(yes), true, yes);
  }

  // A false positive promises a Closet review on a turn that has nothing to do
  // with the Closet, so every ambiguous case must resolve the other way.
  for (const no of [
    'What is the weather in Paris?',
    'Is a peak lapel more formal than a notch lapel?',
    'Tell me about autumn colour trends',
    'hi',
    '',
    'Where can I buy a navy blazer?',
  ]) {
    assert.equal(messageReadsAsWardrobeRequest(no), false, no);
  }
});

test('UX-1: the staged copy requires capability AND entitlement AND intent', () => {
  const message = 'What can I wear from my closet tonight?';
  assert.equal(
    shouldShowConciergeProgress({ conciergeEnabled: true, kPlusActive: true, message }),
    true,
  );
  // Each condition alone is enough to withhold it.
  assert.equal(
    shouldShowConciergeProgress({ conciergeEnabled: false, kPlusActive: true, message }),
    false,
  );
  assert.equal(
    shouldShowConciergeProgress({ conciergeEnabled: true, kPlusActive: false, message }),
    false,
  );
  assert.equal(
    shouldShowConciergeProgress({
      conciergeEnabled: true,
      kPlusActive: true,
      message: 'What is the weather in Paris?',
    }),
    false,
  );
});

test('UX-1: the indicator is chosen from the SENT message, not the composer', () => {
  const screen = fs.readFileSync(
    path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'),
    'utf8',
  );
  // The composer keeps changing while the answer is in flight; choosing the
  // wait copy from it would let the customer's next draft rewrite the copy for
  // a question they already asked.
  const gate = screen.slice(
    screen.indexOf('const useConciergeWaitCopy ='),
    screen.indexOf('const ThinkingIndicator ='),
  );
  assert.ok(gate.includes('message: sentMessageText'));
  assert.ok(!gate.includes('composerText'));
  assert.ok(gate.includes('kPlusActive: kPlusEntitlement.isActive'));

  // And the in-flight message is per-conversation: a session or account change
  // clears it alongside the draft.
  const reset = screen.slice(
    screen.indexOf('setComposerTextState(getDraftComposerText(stableSessionId, actorKey));'),
    screen.indexOf('}, [stableSessionId, actorKey]);'),
  );
  assert.ok(reset.includes("setSentMessageText('')"));
});

test('UX-1: the staged copy is memoised and clears its own ticker', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'concierge', 'ConciergeProgressCopy.tsx'),
    'utf8',
  );
  assert.ok(source.includes('export const ConciergeProgressCopy = memo('));
  // An interval that outlives the wait keeps the chat list re-rendering after
  // the answer has already arrived.
  assert.ok(source.includes('return () => clearInterval(id);'));
  assert.ok(source.includes("accessibilityLiveRegion=\"polite\""));
});

// ── provenance ───────────────────────────────────────────────────────────────

test('UX-2: the chip never states a stronger relationship than the server sent', () => {
  assert.equal(conciergeCardLabel('owned', 'mixed'), 'In your Closet');
  assert.equal(conciergeCardLabel('saved', 'mixed'), 'Saved');
  assert.equal(conciergeCardLabel('scanned', 'mixed'), 'Scanned');
  assert.equal(conciergeCardLabel('shared', 'mixed'), 'Shared with you');
  assert.equal(conciergeCardLabel('discovered', 'mixed'), 'Shopping option');
  // Unknown provenance says nothing at all, in either direction.
  assert.equal(conciergeCardLabel('unverified', 'mixed'), null);
  assert.equal(conciergeCardLabel('unknown', 'mixed'), null);
  // Quiet case: the all-owned heading already carries it.
  assert.equal(conciergeCardLabel('owned', 'closet'), null);
});

test('UX-2: a card always SPEAKS its provenance, even when the chip is quiet', () => {
  // The gap this closes: under an all-owned heading the chip is suppressed, so
  // a screen reader previously got a card with no ownership signal on it.
  const owned = {
    title: 'Black leather jacket',
    category: 'jacket',
    brand: 'Acne Studios',
    relationship: 'owned',
  };
  assert.equal(
    conciergeCardAccessibilityLabel(owned, 'closet'),
    'Black leather jacket, Acne Studios, In your Closet',
  );
  assert.equal(
    conciergeCardAccessibilityLabel(owned, 'mixed'),
    'Black leather jacket, Acne Studios, In your Closet',
  );
});

test('UX-2: a non-owned card never speaks Closet wording', () => {
  for (const [relationship, expected] of [
    ['saved', 'Saved'],
    ['scanned', 'Scanned'],
    ['shared', 'Shared with you'],
    ['discovered', 'Shopping option'],
  ]) {
    const spoken = conciergeCardAccessibilityLabel(
      { title: 'Navy blazer', category: 'blazer', brand: null, relationship },
      'mixed',
    );
    assert.equal(spoken, `Navy blazer, ${expected}`);
    assert.ok(!/closet/i.test(spoken), relationship);
  }

  // And a card with no title and no category falls back to a neutral noun
  // rather than to the words used for the customer's own clothes.
  const spoken = conciergeCardAccessibilityLabel(
    { title: null, category: null, brand: null, relationship: 'shared' },
    'mixed',
  );
  assert.equal(spoken, 'Item, Shared with you');
});

test('UX-2: the chip treatment is driven by relationship, not by presentation', () => {
  const source = fs.readFileSync(
    path.join(ROOT, 'components', 'concierge', 'ConciergeClosetCard.tsx'),
    'utf8',
  );
  assert.ok(source.includes("const isOwned = card.relationship === 'owned';"));
  assert.ok(source.includes('isOwned && styles.labelChipOwned'));

  // And nothing about the card can be derived from the model's sentence,
  // because the card model has no field carrying one. This is the structural
  // half of "cards are built from validated structured data, never prose".
  const model = fs.readFileSync(
    path.join(ROOT, 'services', 'concierge', 'conciergeModel.ts'),
    'utf8',
  );
  const cardShape = model.slice(
    model.indexOf('export interface ConciergeCard {'),
    model.indexOf('export interface ConciergeLookGroup'),
  );
  for (const forbidden of ['message', 'content', 'text', 'body', 'assistant']) {
    assert.ok(
      !new RegExp('^\s*' + forbidden + '[?]?:', 'm').test(cardShape),
      'ConciergeCard must not carry a "' + forbidden + '" field',
    );
  }
});

test('UX-2: both cards and the evidence list are memoised for scroll cost', () => {
  const card = fs.readFileSync(
    path.join(ROOT, 'components', 'concierge', 'ConciergeClosetCard.tsx'),
    'utf8',
  );
  const evidence = fs.readFileSync(
    path.join(ROOT, 'components', 'concierge', 'ConciergeEvidence.tsx'),
    'utf8',
  );
  assert.ok(card.includes('export const ConciergeClosetCard = memo('));
  assert.ok(evidence.includes('export const ConciergeEvidence = memo('));
});

// ── scope of the claim ───────────────────────────────────────────────────────

test('UX-3: gap copy states a fact only on exhaustive evidence, and hedges otherwise', () => {
  assert.equal(
    conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: true }),
    "Your Closet doesn't have shoes yet.",
  );
  assert.equal(
    conciergeGapCopy({ gapCodes: ['missing_shoe'], evidenceIsExhaustive: false }),
    "From the pieces I reviewed, I didn't find shoes.",
  );
  // No gap, no claim, no note -- manufacturing doubt about a claim nobody made
  // is its own kind of dishonesty.
  assert.equal(conciergeGapCopy({ gapCodes: [], evidenceIsExhaustive: true }), null);
  assert.equal(conciergeGapCopy({ gapCodes: [], evidenceIsExhaustive: false }), null);
  // An unknown code renders nothing rather than an invented noun.
  assert.equal(
    conciergeGapCopy({ gapCodes: ['missing_monocle'], evidenceIsExhaustive: true }),
    null,
  );
});
