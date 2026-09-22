'use strict';

/**
 * Build 35 — Elise Conversation Quality V2.
 *
 * Three layers, all deterministic, none network-bound:
 *
 *   1. JOURNEYS 1-20 — the conversation matrix, run against the REAL
 *      `services/style-chat/eliseConversationFrame.ts`.
 *   2. BLOCK-ELISE-Q2-00..20 — the blocking controls.
 *   3. HOOK — the real `hooks/useStyleChat.ts`, executed through the shared
 *      hook runtime, so the gate, the local clarification and the notices are
 *      proven on the send path that ships rather than on a module in isolation.
 *
 * What these tests do NOT claim: that Elise's prose got better. Wording,
 * brevity and fashion specificity are the model's, governed by the server
 * prompt this lane may not change; see docs/elise-conversation-quality-v2.md
 * for the subjective before/after record, kept deliberately separate.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { execFileSync } = require('node:child_process');
const ts = require('typescript');

const { settle } = require('./helpers/hookRuntime');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
/** VM-realm objects fail deepStrictEqual on prototype; compare plain data. */
const plain = (value) => JSON.parse(JSON.stringify(value));

function loadTsModule(relativePath, requireMap = {}) {
  const filename = path.join(ROOT, relativePath);
  const output = ts.transpileModule(fs.readFileSync(filename, 'utf8'), {
    fileName: filename,
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
      jsx: ts.JsxEmit.ReactJSX,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console, Date, Error, Promise, Set, Map, Array, Object, JSON, Number, String,
    Boolean, RegExp, Math, isNaN, setTimeout, clearTimeout, setImmediate,
    AbortController,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
  };
  vm.runInNewContext(output, sandbox, { filename });
  return module.exports;
}

const FRAME_PATH = 'services/style-chat/eliseConversationFrame.ts';
const TELEMETRY_PATH = 'services/style-chat/eliseConversationTelemetry.ts';
// Loading with an EMPTY require map is itself an assertion: both modules are
// zero-import leaves, so they cannot reach the network, Supabase or a model.
const F = loadTsModule(FRAME_PATH);
const T = loadTsModule(TELEMETRY_PATH);

// ── Fixture helpers (sanitized, synthetic) ──────────────────────────────────

let seq = 0;
const u = (content) => ({ id: `u-${++seq}`, sender: 'user', content, uiBlocks: [] });
const a = (content, uiBlocks = []) => ({ id: `a-${++seq}`, sender: 'assistant', content, uiBlocks });
const shelfBlocks = (titles) => [
  { type: 'commerce_shopping_intent', state: { stateVersion: 1 } },
  { type: 'commerce_products', status: 'results', products: titles.map((title) => ({ title })) },
];
const turn = (history, message) => F.analyzeEliseTurn({ messages: history, message });
const decide = (t) => plain(F.decideEliseCommerceActivation(t));
const violations = (t, reply) => plain(F.validateEliseReply(t.frame, reply));
const negationTokens = (t) => plain(t.frame.negations).map((n) => `${n.axis}:${n.token}`);

// ═══════════════════════════════════════════════════════════════════════════
// 1. JOURNEYS
// ═══════════════════════════════════════════════════════════════════════════

test('Journey 1 — simple refinement: "More casual." keeps the task and moves formality', () => {
  const t = turn(
    [u('Style my black blazer with jeans.'), a('Try the black blazer over a white tee with straight jeans and loafers.')],
    'More casual.',
  );
  assert.equal(t.taskReset, false);
  assert.equal(t.relation, 'refinement');
  assert.equal(t.frame.taskKind, 'styling');
  assert.equal(t.frame.garmentFocus, 'outerwear', 'the blazer is still the anchor');
  assert.equal(t.frame.formality, 'less');
  assert.deepEqual(plain(t.frame.colors), [], '"my black blazer" describes an owned piece; it is not a colour request');
  assert.deepEqual(decide(t), { action: 'hold', code: 'shopping_held_not_requested' }, 'no unrelated new shopping');
});

test('Journey 2 — negation carryover: "Cheaper." keeps red, jacket and NOT leather', () => {
  const history = [
    u('Find me a red jacket, not leather.'),
    a('Let me find some options.', shelfBlocks(['Red Wool Jacket', 'Red Nylon Bomber'])),
  ];
  const t = turn(history, 'Cheaper.');
  assert.equal(t.taskReset, false);
  assert.deepEqual(plain(t.frame.colors), ['red']);
  assert.equal(t.frame.garmentFocus, 'outerwear');
  assert.deepEqual(negationTokens(t), ['material:leather']);
  assert.equal(t.memoryOp, 'cheaper');
  assert.deepEqual(decide(t), { action: 'allow', basis: 'memory_op' });
  assert.deepEqual(violations(t, 'A red leather jacket would work too.'), [{ kind: 'negation', token: 'leather' }]);
});

test('Journey 3 — owned only: an outfit "from what I own" never shops on its own', () => {
  const t = turn([], 'Make me an outfit from what I own.');
  assert.equal(t.frame.ownedOnly, true);
  assert.equal(t.frame.taskKind, 'owned_styling');
  assert.equal(t.shoppingCue, null);
  assert.deepEqual(decide(t), { action: 'hold', code: 'shopping_held_owned_only' });
});

test('Journey 4 — owned gap: a rain outfit "from my Closet" holds shopping until accepted', () => {
  const t = turn([], 'Build a rain outfit from my Closet.');
  assert.equal(t.frame.ownedOnly, true);
  assert.deepEqual(decide(t), { action: 'hold', code: 'shopping_held_owned_only' });

  // Gap LANGUAGE is the server's (census-backed certainty); what the client
  // guarantees is that no shelf appears until the customer accepts one.
  const accepted = turn(
    [u('Build a rain outfit from my Closet.'), a("I don't see a rain-ready layer in the Closet items I can verify.", [
      { type: 'commerce_shopping_intent', state: { stateVersion: 1 } },
      { type: F.ELISE_CONVERSATION_NOTICE_BLOCK_TYPE, code: 'shopping_held_owned_only' },
    ])],
    'Yes please',
  );
  assert.equal(accepted.relation, 'acceptance');
  assert.deepEqual(decide(accepted), { action: 'allow', basis: 'acceptance' });
});

test('Journey 5 — rejection: "I don\'t like those shoes" rejects the shown pair, not footwear', () => {
  const history = [u('What shoes with this dress?'), a('White sneakers keep it easy.')];
  const t = turn(history, "I don't like those shoes.");
  assert.equal(t.relation, 'rejection');
  assert.deepEqual(plain(t.frame.rejections), [
    { garmentClass: 'footwear', noun: 'sneakers', modifiers: ['white'], reason: null },
  ]);
  assert.deepEqual(plain(t.frame.negations), [], 'the category is NOT excluded');
  assert.deepEqual(violations(t, 'Swap the white sneakers for tan suede loafers.'), [], 'naming what is swapped OUT is fine');
  assert.deepEqual(violations(t, 'Try white sneakers with a thicker sole.'), [
    { kind: 'rejected_repeat', token: 'white sneakers' },
  ]);
  assert.deepEqual(violations(t, 'Try black leather sneakers instead.'), [], 'another sneaker is a new option');
});

test('Journey 6 — reasoned rejection: "That\'s too formal." lowers formality as a task constraint', () => {
  const t = turn([u('Dress me for dinner.'), a('A silk blouse, tailored trousers and a blazer.')], "That's too formal.");
  assert.equal(t.relation, 'rejection');
  assert.equal(t.frame.formality, 'less');
  assert.equal(t.frame.occasion, 'dinner', 'the customer does not need to repeat the request');
  assert.equal(t.frame.rejections.at(-1).reason, 'too_formal');
  // …and it persists into the next refinement of the same task.
  const next = turn(
    [u('Dress me for dinner.'), a('A silk blouse, tailored trousers and a blazer.'), u("That's too formal."), a('Try a knit top and trousers.')],
    'What about shoes?',
  );
  assert.equal(next.frame.formality, 'less');
});

test('Journey 7 — ordinal reference resolves against the three options shown', () => {
  const shown = a('Three directions:\n1. Linen shirt with chinos.\n2. Knit polo with tailored shorts.\n3. Slip dress with sandals.');
  const t = turn([u('Give me three brunch looks.'), shown], 'Tell me more about the second one.');
  assert.equal(t.relation, 'reference');
  assert.equal(t.reference.status, 'resolved');
  assert.equal(t.reference.ordinal, 2);
  assert.match(t.reference.label, /knit polo/);
  assert.equal(t.localClarification, null, 'a resolved reference asks nothing');
});

test('Journey 8 — ambiguous reference gets one concise clarification naming both jackets', () => {
  const t = turn(
    [u('What layer over this dress?'), a('Layer the denim jacket or the leather jacket over it.')],
    'Use that jacket.',
  );
  assert.equal(t.reference.status, 'ambiguous');
  assert.deepEqual(plain(t.reference.candidates), ['denim jacket', 'leather jacket']);
  assert.equal(t.localClarification, 'Do you mean the denim jacket or the leather jacket?');
});

test('Journey 9 — task reset: a Packing request does not inherit dinner or "no heels"', () => {
  const t = turn(
    [u('Style this dress for dinner.'), a('Pair it with strappy sandals.'), u('No heels.'), a('Flats, then.')],
    'What should I pack for Chicago?',
  );
  assert.equal(t.taskReset, true);
  assert.equal(t.frame.taskKind, 'packing');
  assert.equal(t.frame.occasion, null);
  assert.deepEqual(plain(t.frame.negations), []);
  assert.deepEqual(violations(t, 'Pack ankle boots with a block heel.'), [], 'an old exclusion cannot flag a new task');
});

test('Journey 10 — Signature Style override: "I want bright red" is a stated colour', () => {
  const t = turn([], 'I want bright red.');
  assert.deepEqual(plain(t.frame.colors), ['red']);
  assert.deepEqual(plain(t.frame.negations), []);
});

test('Journey 11 — budget persistence: "Different." keeps loafers and $150', () => {
  const t = turn(
    [u('Find loafers under $150.'), a('Let me look.', shelfBlocks(['Black Penny Loafer', 'Brown Suede Loafer']))],
    'Different.',
  );
  assert.deepEqual(plain(t.frame.budget), { amount: 150, currency: 'USD' });
  assert.equal(t.frame.garmentFocus, 'footwear');
  assert.equal(t.memoryOp, 'different');
  assert.deepEqual(decide(t), { action: 'allow', basis: 'memory_op' });
});

test('Journey 12 — "Show me another." is the Commerce V2 one-more operation, inside the task', () => {
  const t = turn(
    [u('Find loafers under $150.'), a('Let me look.', shelfBlocks(['Black Penny Loafer']))],
    'Show me another.',
  );
  assert.equal(t.memoryOp, 'another');
  assert.equal(t.taskReset, false);
  assert.equal(decide(t).action, 'allow');
  // The ONE-additional-option semantics are Commerce V2's, reused not re-built.
  assert.match(read('services/style-chat/commerceShelfMemory.ts'), /input\.op === 'another' \? 1/);
});

test('Journey 13 — correction is adopted, and "not loafers" is not an exclusion', () => {
  const t = turn([u('Style my loafers.'), a('Your loafers work with cropped trousers.')], 'Those are boots, not loafers.');
  assert.equal(t.relation, 'correction');
  assert.deepEqual(plain(t.frame.corrections), [{ from: 'loafers', to: 'boots' }]);
  assert.deepEqual(plain(t.frame.negations), []);
  assert.deepEqual(decide(t), { action: 'hold', code: 'shopping_held_not_requested' });
});

test('Journey 14 — occasion change evolves the same outfit task', () => {
  const t = turn([u('Dress me for dinner.'), a('Silk top, trousers, heels.')], 'Make it work appropriate.');
  assert.equal(t.taskReset, false);
  assert.equal(t.frame.occasion, 'work');
});

test('Journey 15 — weather refinement adds warmth without dropping the task', () => {
  const t = turn([u('Dress me for dinner.'), a('Silk top, trousers, heels.')], "It's colder than I thought.");
  assert.equal(t.taskReset, false);
  assert.equal(t.frame.warmth, 'warmer');
  assert.equal(t.frame.occasion, 'dinner');
});

test('Journey 16 — contradiction prevention: pumps after "No heels." are caught', () => {
  const history = [u('Dress me for dinner.'), a('A silk top.'), u('No heels.'), a('Flats it is.')];
  const t = turn(history, 'Something dressier.');
  assert.deepEqual(violations(t, 'Finish with pointed-toe pumps and a clutch.'), [{ kind: 'negation', token: 'heels' }]);
  assert.deepEqual(violations(t, 'Since you said no heels, go with pointed flats.'), []);
  assert.deepEqual(violations(t, 'Skip heels and choose a sleek loafer.'), []);
  // False-positive controls: a singular "heel" is a shoe PART or a figure of
  // speech unless it is a named heel type, and "kept heels out" is compliant.
  for (const clean of [
    'A pointed flat gives the lift of a heel without the height.',
    'The heel of your hand should rest on the bag strap.',
    'I kept heels out and went with a loafer.',
    'Go for flats over heels tonight.',
    'Instead of pumps, go with ballet flats.',
  ]) {
    assert.deepEqual(violations(t, clean), [], clean);
  }
  assert.deepEqual(violations(t, 'Ankle boots with a block heel.'), [{ kind: 'negation', token: 'heels' }]);
});

test('Journey 17 — "Which jacket I own works best?" is owned-only, not shopping', () => {
  const t = turn([], 'Which jacket I own works best?');
  assert.equal(t.frame.ownedOnly, true);
  assert.deepEqual(decide(t), { action: 'hold', code: 'shopping_held_owned_only' });
});

test('Journey 18 — explicit shopping carries its structured attributes', () => {
  const t = turn([], 'Find me a black blazer under $200.');
  assert.equal(t.frame.taskKind, 'shopping');
  assert.deepEqual(plain(t.frame.colors), ['black']);
  assert.deepEqual(plain(t.frame.budget), { amount: 200, currency: 'USD' });
  assert.equal(t.frame.garmentFocus, 'outerwear');
  assert.deepEqual(decide(t), { action: 'allow', basis: 'explicit' });
});

test('Journey 19 — "White sneakers or loafers?" is a comparison, not a shopping turn', () => {
  const t = turn([], 'White sneakers or loafers?');
  assert.equal(t.frame.taskKind, 'comparison');
  assert.equal(decide(t).action, 'hold');
});

test('Journey 20 — scope persistence: dinner + no blazer + warmer all live together', () => {
  const t = turn(
    [u('Dress me for dinner tonight.'), a('A wrap dress and a blazer.'), u('No blazer.'), a('A long cardigan then.')],
    'Make it warmer.',
  );
  assert.equal(t.frame.occasion, 'dinner');
  assert.deepEqual(negationTokens(t), ['garment:blazer']);
  assert.equal(t.frame.warmth, 'warmer');
  assert.deepEqual(violations(t, 'Add a cropped blazer over the dress.'), [{ kind: 'negation', token: 'blazer' }]);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. BLOCKING CONTROLS
// ═══════════════════════════════════════════════════════════════════════════

test('BLOCK-ELISE-Q2-00 — the current explicit request outranks Signature Style', () => {
  // The frame takes no Signature Style input at all, so it cannot be overridden by it.
  const src = read(FRAME_PATH);
  assert.equal(/signature/i.test(src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false);
  // The server's model instruction states the same ladder (read-only check).
  const index = read('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /A stated request outranks an inferred preference every time/);
  // And Commerce applies USER_EXPLICIT last, i.e. on top (existing precedence).
  const activation = read('services/style-chat/commerceActivation.ts');
  const order = activation.slice(activation.indexOf('buildShoppingContext(['), activation.indexOf(']);', activation.indexOf('buildShoppingContext([')));
  assert.ok(order.indexOf('selectSignatureStyleContext') < order.indexOf('explicit,'));
});

test('BLOCK-ELISE-Q2-01 — an owned-only request can never shop externally on its own', () => {
  for (const message of [
    'Make me an outfit from what I own.',
    'Which jacket I own works best?',
    'Use only what I have, no shopping.',
    "Don't make me buy anything, style the navy dress.",
    'Can I do this with what I already have?',
    'Shop my closet for a dinner look.',
    'Do I have any black loafers?',
  ]) {
    assert.deepEqual(decide(turn([], message)), { action: 'hold', code: 'shopping_held_owned_only' }, message);
  }
  // Owned-only is sticky inside the task: a later garment word does not shop…
  const later = turn([u('Style me from my closet.'), a('Start with the grey knit.')], 'What about boots?');
  assert.deepEqual(decide(later), { action: 'hold', code: 'shopping_held_owned_only' });
  // …until the customer explicitly opens shopping.
  const reopened = turn([u('Style me from my closet.'), a('Start with the grey knit.')], "I'm happy to buy, show me options to buy.");
  assert.equal(decide(reopened).action, 'allow');
});

test('BLOCK-ELISE-Q2-02 — Saved / Watched / Scanned / Tried-On cannot become Owned', () => {
  for (const message of [
    'I saved this jacket, style it.',
    'Style the boots I scanned yesterday.',
    'I tried on this dress in the VTO, what goes with it?',
    'Style the coat on my watchlist.',
    'Use the look from my dressing room.',
  ]) {
    const t = turn([], message);
    assert.equal(t.frame.ownedOnly, false, message);
  }
  // The frame has no ownership field at all — only the owned-only CONSTRAINT.
  const keys = Object.keys(plain(turn([], 'hi').frame));
  assert.equal(keys.some((k) => /owned(?!Only)|ownership/i.test(k)), false, keys.join(','));
  // The only owned-item read on the send path is the RLS-bound Closet read.
  const hook = read('hooks/useStyleChat.ts');
  assert.match(hook, /const owned = await listOwnedClosetItems\(\);/);
});

test('BLOCK-ELISE-Q2-03 — hard negations survive refinements, even past the server window', () => {
  // The server sends the model only the newest 6 messages. "No heels" here is
  // 8 messages back — gone from the model's context, still live in the frame.
  const history = [
    u('Dress me for dinner.'), a('A silk top and trousers.'),
    u('No heels.'), a('Flats it is.'),
    u('More colour?'), a('Try a jewel-tone top.'),
    u('Warmer, please.'), a('Add a long cardigan.'),
  ];
  const t = turn(history, 'Something dressier.');
  assert.deepEqual(negationTokens(t), ['garment:heels']);
  assert.deepEqual(violations(t, 'Switch to strappy stilettos.'), [{ kind: 'negation', token: 'heels' }]);
  // Explicit removal lifts it.
  const lifted = turn([...history, u('Something dressier.'), a('Velvet top.')], 'Actually heels are fine.');
  assert.deepEqual(negationTokens(lifted), []);
});

test('BLOCK-ELISE-Q2-04 — budget survives same-task refinements', () => {
  const history = [u('Find black loafers under $150.'), a('Looking.', shelfBlocks(['Loafer A']))];
  for (const follow of ['Different.', 'Not those.', 'Show me another.', 'In suede?']) {
    const t = turn(history, follow);
    assert.deepEqual(plain(t.frame.budget), { amount: 150, currency: 'USD' }, follow);
  }
  // A new category is a new shopping intent (mirrors the server reducer).
  assert.equal(turn(history, 'Find me a trench coat instead.').frame.budget, null);
});

test('BLOCK-ELISE-Q2-05 — a rejected exact option cannot return as a fresh recommendation', () => {
  const t = turn([u('Shoes?'), a('Try the white leather sneakers.')], "I don't like those shoes.");
  assert.deepEqual(violations(t, 'The white leather sneakers still work best.'), [
    { kind: 'rejected_repeat', token: 'white leather sneakers' },
  ]);
  // Identity unknown (no vocabulary modifier shown) -> nothing is claimed.
  const unknown = turn([u('Shoes?'), a('Try the sneakers.')], "I don't like those shoes.");
  assert.deepEqual(violations(unknown, 'Sneakers still work.'), []);
});

test('BLOCK-ELISE-Q2-06 — a task reset removes irrelevant old constraints', () => {
  const history = [u('Find a red jacket under $100, not leather.'), a('Looking.', shelfBlocks(['Red Jacket']))];
  const t = turn(history, 'Help me style my navy dress for a wedding.');
  assert.equal(t.taskReset, true);
  assert.equal(t.frame.budget, null);
  assert.deepEqual(plain(t.frame.colors), []);
  assert.deepEqual(plain(t.frame.negations), []);
  assert.equal(t.frame.shoppingActive, false);
  for (const restart of ['New question: what goes with olive?', 'Never mind, start over.']) {
    assert.equal(turn(history, restart).taskReset, true, restart);
  }
});

test('BLOCK-ELISE-Q2-07 — an ambiguous reference is never resolved as certain', () => {
  const t = turn([u('Layer?'), a('The black blazer or the navy blazer both work.')], 'I like that blazer.');
  assert.equal(t.reference.status, 'ambiguous');
  // Indistinguishable candidates are not guessed at AND not asked about.
  const vague = turn([u('Layer?'), a('A blazer works, or another blazer.')], 'Use that blazer.');
  assert.equal(vague.reference.status, 'none');
  assert.equal(vague.localClarification, null);
  // "the other dress" already points at one of two; the customer is not stopped.
  const other = turn([u('Dress?'), a('A black dress or a red dress.')], 'I will take the other dress.');
  assert.equal(other.localClarification, null);
  // A single candidate resolves.
  const single = turn([u('Layer?'), a('The camel coat is the move.')], 'Use that coat.');
  assert.equal(single.reference.status, 'resolved');
  assert.equal(single.reference.label, 'camel coat');
});

test('BLOCK-ELISE-Q2-08 — ordinals resolve against the options actually shown', () => {
  const shelf = a('Let me look.', shelfBlocks(['Black Penny Loafer', 'Brown Suede Loafer', 'Tan Tassel Loafer']));
  const t = turn([u('Find loafers.'), shelf], 'Tell me about the third one.');
  assert.equal(t.reference.status, 'resolved');
  assert.equal(t.reference.source, 'structured');
  assert.equal(t.reference.label, 'Tan Tassel Loafer');
  // Out of range on a COMMERCE shelf belongs to Commerce V2's own reference
  // path (reference_out_of_range); the frame does not answer it locally.
  const far = turn([u('Find loafers.'), shelf], 'Show me the sixth one.');
  assert.equal(far.reference.status, 'out_of_range');
  assert.equal(far.localClarification, null);
  // Out of range on prose options is clarified without a model call.
  const prose = turn([u('Ideas?'), a('1. Linen shirt.\n2. Knit polo.')], 'The fourth option please.');
  assert.equal(prose.localClarification, 'I only suggested two options there — which one did you mean?');
});

test('BLOCK-ELISE-Q2-09 — Commerce cannot activate on a category mention alone', () => {
  for (const message of [
    'What shoes work with this?',
    'Do jackets go with this dress?',
    'I love loafers.',
    'White sneakers or loafers?',
    'What style of jacket is this?',
    'Why do loafers work here?',
    "I can't find anything to wear for dinner.",
    'Can you recommend how to style my boots?',
  ]) {
    assert.deepEqual(decide(turn([], message)), { action: 'hold', code: 'shopping_held_not_requested' }, message);
  }
  // Inside a styling task, "black boots please" is a styling refinement.
  const styling = turn([u('Dress me for dinner.'), a('Wrap dress, block heels.')], 'Black boots please.');
  assert.equal(decide(styling).action, 'hold');
});

test('BLOCK-ELISE-Q2-10 — an explicit shopping request still reaches the existing Commerce path', () => {
  for (const message of [
    'Find me a black blazer under $200.',
    'Where can I buy a rain jacket?',
    'Show me some white sneakers.',
    'I need a new rain jacket.',
    'Only black boots please.',
    'Black loafers under $150.',
    'Recommend some black boots.',
    'Any good rain jackets?',
    'I want new boots.',
    'Any black loafers?',
    'Show me black boots.',
  ]) {
    assert.equal(decide(turn([], message)).action, 'allow', message);
  }
});

test('BLOCK-ELISE-Q2-11 — Signature Style cannot override a direct colour/material/occasion', () => {
  const t = turn([], 'Find a bright red satin dress for a wedding.');
  assert.deepEqual(plain(t.frame.colors), ['red']);
  assert.equal(t.frame.occasion, 'wedding');
  // The frame is built from the customer's words only; its entire input is the
  // conversation and the message, so there is no channel a profile could use.
  const src = read(FRAME_PATH);
  const signature = src.slice(src.indexOf('export function analyzeEliseTurn(input: {'), src.indexOf('}): EliseTurnAnalysis {'));
  const fields = [...signature.matchAll(/^\s+(\w+)\??:/gm)].map((m) => m[1]);
  assert.deepEqual(fields, ['messages', 'message']);
});

test('BLOCK-ELISE-Q2-12 — a user correction controls the current interpretation', () => {
  const t = turn([u('Style my loafers.'), a('Loafers and cropped trousers.')], "They're boots, not loafers.");
  assert.deepEqual(plain(t.frame.corrections), [{ from: 'loafers', to: 'boots' }]);
  const reverse = turn([u('Style my boots.'), a('Boots and a midi.')], "Those aren't boots, they're loafers.");
  assert.deepEqual(plain(reverse.frame.corrections), [{ from: 'boots', to: 'loafers' }]);
  // A correction is not a product-truth write: the module has no write path.
  assert.equal(/supabase|fetch\(|saveStyleChatMessage|functions\.invoke/.test(read(FRAME_PATH)), false);
});

test('BLOCK-ELISE-Q2-14 — no additional model or classification call is introduced', () => {
  for (const rel of [FRAME_PATH, TELEMETRY_PATH, 'components/style-chat/EliseConversationNotice.tsx']) {
    const src = read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
    assert.equal(/fetch\(|gemini|generateContent|functions\.invoke|openai|anthropic|XMLHttpRequest/i.test(src), false, rel);
  }
  const frameImports = read(FRAME_PATH).match(/^import .*$/gm) ?? [];
  const telemetryImports = read(TELEMETRY_PATH).match(/^import .*$/gm) ?? [];
  assert.deepEqual([...frameImports, ...telemetryImports], [], 'both new service modules are zero-import leaves');
  // Still exactly one generateReply call site in the hook.
  const hook = read('hooks/useStyleChat.ts');
  assert.equal((hook.match(/provider\.generateReply\(/g) ?? []).length, 1);
});

test('BLOCK-ELISE-Q2-15 — Elise conversation text cannot enter analytics', () => {
  const seen = [];
  T.setEliseConversationTelemetrySink((event, payload) => seen.push({ event, payload }));
  try {
    T.recordEliseConversationTurn({
      relation: 'refinement',
      taskKind: 'styling',
      commerce: 'allow',
      validation: 'clean',
      reference: 'none',
      outcome: 'model_reply',
      taskReset: false,
      ownedOnly: false,
      constraintBucket: '1',
      frameMsBucket: 'lt_1',
      // Everything below must be dropped.
      message: 'Find me a red jacket, not leather.',
      reply: 'Try the red wool jacket.',
      product: 'Red Wool Jacket',
      closetItem: 'navy wool overcoat',
      styleProfile: 'warm neutrals',
      relationTypo: 'refinement',
    });
    T.recordEliseConversationTurn({ relation: 'Find me a red jacket', taskKind: 'styling ' });
  } finally {
    T.setEliseConversationTelemetrySink(null);
  }
  assert.equal(seen.length, 2);
  const first = plain(seen[0].payload);
  assert.deepEqual(Object.keys(first).sort(), [
    'commerce', 'constraintBucket', 'frameMsBucket', 'outcome', 'ownedOnly', 'reference', 'relation', 'taskKind', 'taskReset', 'validation',
  ]);
  assert.deepEqual(plain(seen[1].payload), {}, 'free text in an allowlisted key is dropped, not truncated');
  // NOT bridged to the vendor: the governed registry does not list it.
  assert.equal(read('services/analytics/analyticsEventRegistry.ts').includes('elise_conversation'), false);
  assert.equal(read('services/analytics/posthogClient.core.ts').includes('EliseConversationTelemetry'), false);
});

function gitChangedPaths() {
  try {
    const base = execFileSync('git', ['merge-base', 'HEAD', 'origin/fix/notifications-final-convergence-v1'], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    if (!base) return null;
    return execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
      cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'],
    }).split('\n').map((l) => l.trim()).filter(Boolean);
  } catch {
    return null;
  }
}

test('BLOCK-ELISE-Q2-16 — no Supabase schema, migration, function or deploy change', (t) => {
  const changed = gitChangedPaths();
  if (changed === null) {
    t.skip('base ref unavailable in this checkout; the static half below still runs');
  } else {
    const backend = changed.filter((p) => /^supabase\/|^\.github\/workflows\/|^eas\.json$|^config\/test-failure-baseline\.json$/.test(p));
    assert.deepEqual(backend, [], backend.join(', '));
  }
  for (const rel of [FRAME_PATH, TELEMETRY_PATH]) {
    assert.equal(/supabase|migration|createClient/i.test(read(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false, rel);
  }
});

test('BLOCK-ELISE-Q2-17 — the avatar cannot gate speech or Elise response generation', () => {
  const hook = read('hooks/useStyleChat.ts');
  assert.equal(/from ['"][^'"]*avatars?\//.test(hook), false, 'the hook imports nothing from the Avatar Engine');
  assert.equal(/deriveAvatarPresentation|avatarPresentation|avatarEngine/i.test(hook), false);
  const send = hook.slice(hook.indexOf('const sendMessage = useCallback('), hook.indexOf('const retryLastMessage'));
  const beforeProvider = send.slice(0, send.indexOf('provider.generateReply('));
  assert.equal(/await\s+[^;]*avatar/i.test(beforeProvider.replace(/stopAvatarSpeechPlayback/g, '')), false,
    'nothing avatar-related is awaited before generation');
  assert.equal(/avatar/i.test(read(FRAME_PATH).replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')), false);
});

test('BLOCK-ELISE-Q2-18 — no other Build 35 lane\'s contract is silently redefined', (t) => {
  const protectedPaths = [
    'services/style-chat/commerceActivation.ts',
    'services/style-chat/commerceShelfMemory.ts',
    'components/ProductShelf.tsx',
    'components/style-chat/StyleChatReasonChips.tsx',
    'components/style-chat/CommerceProductsBlock.tsx',
    'services/latestIntentMutationQueue.ts',
    'services/analytics/analyticsEventRegistry.ts',
    'services/analytics/posthogClient.core.ts',
    'constants/featureFlags.ts',
  ];
  const changed = gitChangedPaths();
  if (changed === null) {
    t.skip('base ref unavailable in this checkout');
  } else {
    const touched = changed.filter((p) => protectedPaths.includes(p) || p.startsWith('supabase/functions/'));
    assert.deepEqual(touched, [], touched.join(', '));
  }
  // The Commerce call site keeps every dependency it supplied before.
  const hook = read('hooks/useStyleChat.ts');
  for (const dep of ['fetchCommerce: (evidence) => fetchDeferredCommerce(evidence)', 'loadClosetItems: async () => {', 'loadSignatureStyleTokens: async () =>']) {
    assert.ok(hook.includes(dep), dep);
  }
});

test('BLOCK-ELISE-Q2-19 — structured UI/action blocks remain compatible', () => {
  const notices = plain(F.buildEliseConversationNotices({
    violations: [{ kind: 'negation', token: 'heels' }, { kind: 'rejected_repeat', token: 'white sneakers' }],
    commerceHold: { action: 'hold', code: 'shopping_held_owned_only' },
  }));
  assert.deepEqual(notices, [
    { type: 'elise_conversation_notice', code: 'constraint_conflict', tokens: ['heels'] },
    { type: 'elise_conversation_notice', code: 'rejected_repeat', tokens: ['white sneakers'] },
    { type: 'elise_conversation_notice', code: 'shopping_held_owned_only' },
  ]);
  for (const block of notices) assert.deepEqual(plain(F.parseEliseConversationNotice(block)), block);
  // A forged or legacy block renders nothing rather than something invented.
  assert.equal(F.parseEliseConversationNotice({ type: 'elise_conversation_notice', code: 'free_text', body: 'hi' }), null);
  assert.equal(F.parseEliseConversationNotice({ type: 'elise_conversation_notice', code: 'constraint_conflict', tokens: ['<script>'] }), null);
  // The bubble renders the notice through its own component and still handles
  // every pre-existing block type the same way.
  const bubble = read('components/style-chat/StyleChatBubble.tsx');
  assert.match(bubble, /block\?\.type === ELISE_CONVERSATION_NOTICE_BLOCK_TYPE/);
  for (const type of ['greeting', 'concierge_outfit_state', 'commerce_shopping_intent', 'commerce_products', 'stylechat_actions', 'concierge_evidence']) {
    assert.ok(bubble.includes(`block?.type === '${type}'`), type);
  }
  // The hook still writes the pre-existing blocks exactly as before.
  const hook = read('hooks/useStyleChat.ts');
  for (const literal of ["type: 'why_this_works'", "type: 'stylechat_actions'", "type: 'concierge_evidence'", "type: 'concierge_outfit_state'"]) {
    assert.ok(hook.includes(literal), literal);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. HOOK — the real send path
// ═══════════════════════════════════════════════════════════════════════════

const ACTOR = '11111111-1111-1111-1111-111111111111';
const SESSION = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';

function shoppingWire(category) {
  return {
    blockType: 'commerce_shopping_intent',
    state: {
      stateVersion: 1, category, color: null, budget: null, exclusions: [],
      functionalRequirements: [], turns: 0,
    },
    needsBudgetReference: false,
    needsFormalityReference: false,
  };
}

function persisted(message, index) {
  return {
    id: `${message.sender}-hist-${index}`,
    sessionId: SESSION,
    sender: message.sender,
    content: message.content,
    referencedScanIds: [],
    referencedSavedItemIds: [],
    referencedDressingRoomIds: [],
    referencedCatalogItems: [],
    uiBlocks: message.uiBlocks ?? [],
    provider: message.sender === 'user' ? 'client' : 'gemini',
    tokenEstimate: 0,
    createdAt: new Date(Date.UTC(2026, 8, 22, 0, index)).toISOString(),
  };
}

function createHookHarness({ history = [], reply = 'Loafers keep it polished.', wire = null, gate = false } = {}) {
  const actorContext = require('../services/actorContext.js');
  actorContext.__resetActorContextForTests();
  const actorScope = loadTsModule('services/actorScope.ts', { './actorContext': actorContext });
  actorContext.advanceActorEpoch(ACTOR);

  const observed = { providerCalls: [], saved: [], activations: [], spoken: [], telemetry: [] };
  let release;
  const providerGate = new Promise((resolve) => { release = resolve; });

  const realActivation = require(path.join(ROOT, 'services/style-chat/commerceActivation.ts'));
  const frameModule = loadTsModule(FRAME_PATH);
  const telemetryModule = loadTsModule(TELEMETRY_PATH);
  telemetryModule.setEliseConversationTelemetrySink((event, payload) => observed.telemetry.push({ event, payload }));

  const requireMap = {
    react: null,
    '../services/style-chat/providers/edgeStyleChatProvider': {
      EdgeStyleChatProvider: class {
        async generateReply(request) {
          observed.providerCalls.push(request);
          if (gate) await providerGate;
          return {
            status: 'success',
            message: { sender: 'assistant', content: reply, model: 'gemini-2.5-flash', tokenEstimate: 20 },
            usage: { messagesUsed: 1, messagesLimit: 25 },
            ...(wire ? { shoppingIntent: wire } : {}),
          };
        }
      },
    },
    '../constants/featureFlags': { ELISE_CONCIERGE_V1: false },
    '../services/concierge/conciergeModel': { buildConciergeResult: () => ({ presentation: 'none' }) },
    '../services/style-chat/styleChatRepository': {
      getStyleChatSession: async (id) => ({ id, title: 'Styling', mode: 'general', createdAt: '', updatedAt: '' }),
      listStyleChatMessages: async () => history.map(persisted),
      saveStyleChatMessage: async (input) => {
        observed.saved.push(input);
        return {
          id: `saved-${observed.saved.length}-0000-4000-8000-000000000000`,
          sessionId: input.sessionId,
          sender: input.sender,
          content: input.content,
          referencedScanIds: [], referencedSavedItemIds: [], referencedDressingRoomIds: [], referencedCatalogItems: [],
          uiBlocks: input.uiBlocks ?? [],
          provider: input.provider ?? 'mock',
          tokenEstimate: input.tokenEstimate ?? 0,
          createdAt: new Date().toISOString(),
        };
      },
      readStyleChatDailyUsage: async () => ({ messagesUsed: 0, messagesLimit: 25 }),
    },
    '../services/style-chat/styleChatErrors': { getFriendlyStyleChatError: (e) => String(e && e.message ? e.message : e) },
    '../services/weather/todayWeatherStore': { saveTodayWeather: async () => {} },
    '../constants/styleChat': {
      STYLE_CHAT_COPY: { errorGeneric: 'Something went wrong.', systemLimitNotice: 'Limit.', burstLimitNotice: 'Too fast.' },
      STYLE_CHAT_DAILY_MESSAGE_LIMIT: 25,
    },
    '../types/styleChatAttachments': { buildAttachmentUiBlock: () => ({ type: 'attachments' }) },
    '../services/style-chat/styleChatRetryState': loadTsModule('services/style-chat/styleChatRetryState.ts'),
    '../services/style-chat/styleChatOutcome': { classifyStyleChatOperationalFailure: () => null },
    '../contexts/AuthSessionContext': { useAuthSession: () => ({ user: { id: ACTOR } }) },
    '../services/actorScope': actorScope,
    '../services/style-chat/commerceActivation': {
      ...realActivation,
      runCommerceActivation: async (input) => {
        observed.activations.push(input.wire);
        return { blocks: [{ type: 'commerce_products', status: 'no_matches', products: [] }], status: 'no_matches', commerceCalls: 0 };
      },
    },
    '../services/style-chat/eliseConversationFrame': frameModule,
    '../services/style-chat/eliseConversationTelemetry': telemetryModule,
    '../services/commerceHydration': {
      fetchDeferredCommerce: async () => { throw new Error('Commerce transport must not be reached directly'); },
    },
    '../services/ownedClosetItems': { listOwnedClosetItems: async () => [] },
    './useStylistIdentity': {
      useStylistIdentity: () => ({ identity: { avatarId: 'elise_default', displayName: 'Elise' }, isLoading: false }),
    },
    './useScreenReaderEnabled': { useScreenReaderEnabled: () => false, useScreenReaderReady: () => true },
    '../constants/stylistIdentity': { getStylistVoiceProfile: () => 'feminine' },
    '../services/avatarSpeech': {
      speakAvatarMessage: async (payload) => { observed.spoken.push(payload); },
      stopAvatarSpeechPlayback: async () => {},
    },
    './useVoiceResponsesPreference': { useVoiceResponsesPreference: () => ({ enabled: true, loading: false }) },
    '../services/style-chat/styleChatGreeting': {
      ensureSessionGreeting: async () => ({ inserted: false, message: null }),
      waitForSessionGreeting: async (p) => p,
      markSessionGreeted: () => {},
      isSessionGreeted: () => true,
      getGreetingTextForUser: () => 'Hi, I am Elise.',
      getPendingGreetingSpeechMessageId: () => null,
      claimGreetingSpeechAttempt: () => null,
      noteInsertedGreetingForSpeech: () => {},
    },
  };

  return {
    observed,
    release: () => release(),
    async mount() {
      const { createHookRuntime } = require('./helpers/hookRuntime');
      const runtime = createHookRuntime();
      requireMap.react = runtime.react;
      const { useStyleChat } = loadTsModule('hooks/useStyleChat.ts', requireMap);
      let api;
      const render = () => {
        runtime.beginRender();
        api = useStyleChat(SESSION, {});
        runtime.flushEffects();
      };
      render();
      for (let i = 0; i < 20; i += 1) {
        await settle(2);
        if (!runtime.dirty) break;
        runtime.clearDirty();
        render();
      }
      return { api: () => api, rerender: async () => {
        for (let i = 0; i < 20; i += 1) {
          await settle(2);
          if (!runtime.dirty) break;
          runtime.clearDirty();
          render();
        }
      } };
    },
  };
}

const assistantWrites = (h) => h.observed.saved.filter((m) => m.sender === 'assistant');
const noticeCodes = (h) => assistantWrites(h)
  .flatMap((m) => m.uiBlocks ?? [])
  .filter((b) => b.type === 'elise_conversation_notice')
  .map((b) => b.code);

test('HOOK BLOCK-ELISE-Q2-01 — an owned-only turn with a model shopping proposal never reaches Commerce', async () => {
  const h = createHookHarness({ wire: shoppingWire('outerwear'), reply: 'Your camel coat is the strongest option you own.' });
  const hook = await h.mount();
  const sent = await hook.api().sendMessage('Which jacket I own works best?');
  assert.equal(sent, true);
  assert.equal(h.observed.activations.length, 0, 'runCommerceActivation was never called');
  assert.deepEqual(noticeCodes(h), ['shopping_held_owned_only']);
  // The intent block is kept so an explicit "yes, show me" can resume it.
  assert.ok(assistantWrites(h)[0].uiBlocks.some((b) => b.type === 'commerce_shopping_intent'));
  assert.equal(h.observed.providerCalls.length, 1, 'exactly one model turn');
});

test('HOOK BLOCK-ELISE-Q2-09/10 — a category mention holds; an explicit request activates', async () => {
  const held = createHookHarness({ wire: shoppingWire('footwear'), reply: 'Loafers or a sleek ankle boot would both work.' });
  const heldHook = await held.mount();
  await heldHook.api().sendMessage('What shoes work with this?');
  assert.equal(held.observed.activations.length, 0);
  assert.deepEqual(noticeCodes(held), ['shopping_held_not_requested']);

  const explicit = createHookHarness({ wire: shoppingWire('outerwear'), reply: "Let me find options under $200 that prioritise black." });
  const explicitHook = await explicit.mount();
  await explicitHook.api().sendMessage('Find me a black blazer under $200.');
  assert.equal(explicit.observed.activations.length, 1, 'the existing Commerce path ran once');
  assert.deepEqual(noticeCodes(explicit), []);
});

test('HOOK Journey 8 — an ambiguous reference is clarified locally with ZERO model calls', async () => {
  const h = createHookHarness({
    history: [
      { sender: 'user', content: 'What layer over this dress?' },
      { sender: 'assistant', content: 'Layer the denim jacket or the leather jacket over it.' },
    ],
  });
  const hook = await h.mount();
  const sent = await hook.api().sendMessage('Use that jacket.');
  assert.equal(sent, true);
  assert.equal(h.observed.providerCalls.length, 0, 'no model call, no quota spent');
  const writes = h.observed.saved.map((m) => [m.sender, m.content, m.provider ?? null]);
  assert.deepEqual(writes, [
    ['user', 'Use that jacket.', null],
    ['assistant', 'Do you mean the denim jacket or the leather jacket?', 'elise_clarification'],
  ]);
  assert.equal(h.observed.spoken.length, 1, 'spoken like any other reply when voice is on');
  assert.equal(h.observed.telemetry.at(-1).payload.outcome, 'local_clarification');
});

test('HOOK Journey 16 — a reply that brings back a ruled-out item carries a notice, not silence', async () => {
  const h = createHookHarness({
    history: [
      { sender: 'user', content: 'Dress me for dinner.' },
      { sender: 'assistant', content: 'A silk top and wide trousers.' },
      { sender: 'user', content: 'No heels.' },
      { sender: 'assistant', content: 'Flats it is.' },
    ],
    reply: 'For something dressier, finish with pointed-toe pumps.',
  });
  const hook = await h.mount();
  await hook.api().sendMessage('Something dressier.');
  const blocks = assistantWrites(h)[0].uiBlocks.filter((b) => b.type === 'elise_conversation_notice');
  assert.deepEqual(plain(blocks), [{ type: 'elise_conversation_notice', code: 'constraint_conflict', tokens: ['heels'] }]);
  assert.equal(assistantWrites(h)[0].content, 'For something dressier, finish with pointed-toe pumps.', 'the reply text is never rewritten');
});

test('HOOK BLOCK-ELISE-Q2-13 — a second send while one is generating cannot race it', async () => {
  const h = createHookHarness({ gate: true });
  const hook = await h.mount();
  const first = hook.api().sendMessage('What goes with a camel coat?');
  await settle(3);
  const second = await hook.api().sendMessage('Actually, what about a trench?');
  assert.equal(second, false, 'the in-flight guard refuses the overlapping send');
  h.release();
  assert.equal(await first, true);
  assert.equal(h.observed.providerCalls.length, 1);
  // Actor/session staleness for a LATE completion is proven by the existing
  // ELISE-NC-00x suite in eliseStaleCompletionIsolation.test.js, which now
  // loads the same frame module on the same send path.
  assert.match(read('__tests__/eliseStaleCompletionIsolation.test.js'), /eliseConversationFrame/);
});

test('HOOK BLOCK-ELISE-Q2-20 — zero-context basic chat does not regress', async () => {
  const h = createHookHarness({ reply: 'A crisp white shirt and dark jeans are an easy start.' });
  const hook = await h.mount();
  const sent = await hook.api().sendMessage('What should I wear to a gallery opening?');
  assert.equal(sent, true);
  assert.equal(h.observed.providerCalls.length, 1);
  // The request carries exactly the fields it always did — the frame adds none.
  assert.deepEqual(Object.keys(h.observed.providerCalls[0]).sort(), [
    'activeContext', 'genderStylingContext', 'message', 'sessionId', 'sourceMessageId', 'styleDnaContext', 'weatherLocation',
  ]);
  const [reply] = assistantWrites(h);
  assert.equal(reply.content, 'A crisp white shirt and dark jeans are an easy start.');
  assert.deepEqual(plain(reply.uiBlocks), [], 'a clean reply gains no blocks');
  // Telemetry carries codes only.
  const payload = h.observed.telemetry.at(-1).payload;
  for (const value of Object.values(payload)) {
    assert.ok(typeof value === 'boolean' || /^[a-z0-9_]+$/.test(value), String(value));
  }
  assert.equal(JSON.stringify(payload).includes('gallery'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// Performance — the frame is local and bounded
// ═══════════════════════════════════════════════════════════════════════════

test('PERF — deriving the frame over a full 16-message window stays well under a frame budget', () => {
  const history = [];
  for (let i = 0; i < 8; i += 1) {
    history.push(u(`Find black loafers under $150, not suede, for dinner ${i}.`));
    history.push(a('1. Black penny loafer.\n2. Black horsebit loafer.\n3. Black tassel loafer.', shelfBlocks(['Loafer A', 'Loafer B'])));
  }
  const runs = 300;
  const started = process.hrtime.bigint();
  for (let i = 0; i < runs; i += 1) turn(history, 'Tell me about the second one.');
  const meanMs = Number(process.hrtime.bigint() - started) / 1e6 / runs;
  assert.ok(meanMs < 5, `mean ${meanMs.toFixed(3)}ms per turn`);
});

// ═══════════════════════════════════════════════════════════════════════════
// Quality harness + notice copy, inside the governed root gate
// ═══════════════════════════════════════════════════════════════════════════

test('HARNESS — the Elise eval harness conversation sequences pass deterministically', async () => {
  const { evaluateConversationSequences } = require('../tools/elise-concierge-eval/conversation/conversationEvaluator');
  const report = await evaluateConversationSequences();
  assert.equal(report.deterministicFail, 0, JSON.stringify(report.results.filter((r) => !r.deterministic.pass)));
  assert.ok(report.sequenceCount >= 20);
});

test('NOTICE COPY — every code renders one concise line, tokens only from the closed vocabulary', () => {
  const component = loadTsModule('components/style-chat/EliseConversationNotice.tsx', {
    'react/jsx-runtime': { jsx: () => null, jsxs: () => null, Fragment: 'Fragment' },
    'react-native': { View: 'View', Text: 'Text', StyleSheet: { create: (s) => s } },
    '../../constants/theme': { LUXURY: { colors: { graphite: '#555' } }, SPACING: { xs: 4 } },
    '../../services/style-chat/eliseConversationFrame': F,
  });
  const copy = (block) => component.eliseConversationNoticeCopy(F.parseEliseConversationNotice(block));
  assert.equal(
    copy({ type: 'elise_conversation_notice', code: 'constraint_conflict', tokens: ['heels'] }),
    "That mentions heels, which you asked me to leave out. Ask me for a swap and I'll keep it out.",
  );
  assert.equal(
    copy({ type: 'elise_conversation_notice', code: 'rejected_repeat', tokens: ['white sneakers'] }),
    "That brings back the white sneakers you passed on. Ask me for a swap and I'll suggest something else.",
  );
  assert.match(copy({ type: 'elise_conversation_notice', code: 'shopping_held_owned_only' }), /stick to what you own/);
  assert.match(copy({ type: 'elise_conversation_notice', code: 'shopping_held_not_requested' }), /haven't pulled up anything to buy/);
  for (const code of ['constraint_conflict', 'rejected_repeat', 'shopping_held_owned_only', 'shopping_held_not_requested']) {
    const line = copy({ type: 'elise_conversation_notice', code, tokens: ['heels'] });
    assert.ok(line.split(/\s+/).length <= 30, `${code} stays short`);
    assert.equal(/sorry|apolog|absolutely|great choice/i.test(line), false, `${code} has no filler`);
  }
});
