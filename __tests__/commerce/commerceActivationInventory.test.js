/**
 * Activation inventory and scope decisions (continuation brief §3, §19, §30).
 *
 * The defect this lane exists to close is:
 *
 *   flag ON + approved integration exists + customer still cannot reach it.
 *
 * So every seam in scope is classified here, and each one is either CONNECTED
 * or carries a recorded reason. A surface that is implemented, tested and
 * unreachable is the thing being forbidden, and "we'll wire it later" is
 * exactly how #410's two holes survived a green suite.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));

/**
 * Every approved activation seam, and where a customer reaches it.
 *
 * `CONNECTED` means a production call site supplies it — not that a module
 * exports it.
 */
const INVENTORY = [
  {
    seam: 'Elise -> structured shopping intent',
    status: 'CONNECTED',
    callSite: 'supabase/functions/stylechat-generate/index.ts',
    evidence: /const commerceAction = config\.flags\.commerceActivationV1/,
  },
  {
    seam: 'shopping intent -> Commerce request',
    status: 'CONNECTED',
    callSite: 'hooks/useStyleChat.ts',
    evidence: /runCommerceActivation\(\{/,
  },
  {
    seam: 'Closet -> Commerce context',
    status: 'CONNECTED',
    callSite: 'hooks/useStyleChat.ts',
    evidence: /loadClosetItems: async \(\) => \{/,
  },
  {
    seam: 'Signature Style -> Commerce context',
    status: 'CONNECTED',
    callSite: 'hooks/useStyleChat.ts',
    evidence: /loadSignatureStyleTokens: async \(\) =>/,
  },
  {
    seam: 'confirmed Packing gap -> Commerce',
    status: 'CONNECTED',
    callSite: 'app/packing/index.tsx',
    evidence: /buildPackingCommerceHandoff\(\{/,
  },
  {
    seam: 'Commerce result -> product shelf',
    status: 'CONNECTED',
    callSite: 'components/style-chat/StyleChatBubble.tsx',
    evidence: /<CommerceProductsBlock/,
  },
  {
    seam: 'explicit attribute strength -> ranking',
    status: 'CONNECTED',
    callSite: 'supabase/functions/scan-identify/commerceContextualRanking.ts',
    evidence: /CTX_STRONG_EXPLICIT_ATTRIBUTE_MATCH/,
  },
];

test('every approved seam has a production call site, not just a module', () => {
  for (const entry of INVENTORY) {
    assert.equal(entry.status, 'CONNECTED', `${entry.seam} is not connected`);
    assert.match(src(entry.callSite), entry.evidence, `${entry.seam}: ${entry.callSite}`);
  }
});

test('APPROVED_INACTIVE_SURFACES = 0: nothing is exported for Commerce and left unreachable', () => {
  // The two specific holes this lane closed, pinned so they cannot reopen.
  const hook = src('hooks/useStyleChat.ts');
  const activation = src('services/style-chat/commerceActivation.ts');

  // Every optional dependency the activation module declares must be supplied
  // by the production call site. This is the assertion that would have caught
  // the Signature Style hole in #410.
  const depBlock = activation.slice(
    activation.indexOf('export interface CommerceActivationDeps'),
    activation.indexOf('}', activation.indexOf('export interface CommerceActivationDeps')),
  );
  const declared = [...depBlock.matchAll(/^\s*(\w+)\??:/gm)].map((m) => m[1]);
  assert.ok(declared.length >= 3, 'the dependency surface must actually be read');
  for (const dep of declared) {
    assert.ok(hook.includes(dep), `CommerceActivationDeps.${dep} is declared but never supplied`);
  }
});

test('the Packing adapter is no longer test-only', () => {
  const screen = src('app/packing/index.tsx');
  assert.match(screen, /from '\.\.\/\.\.\/services\/packing\/packingCommerceHandoff'/);
  assert.match(screen, /setStyleChatHandoffContext/);
});

// ── Scope decisions, recorded rather than silently skipped ─────────────────

test('UNCONFIRMED_GAP_COMMERCE_ACTION = OUT_OF_SCOPE_BY_PRODUCT_DECISION', () => {
  // Not an inactive surface: no adapter, no control and no future hook exists
  // for it. An unconfirmed gap stays informational, and nothing was built
  // speculatively so that it could be left switched off.
  const view = src('components/packing/PackingPlanView.tsx');
  assert.match(view, /gap\.certainty === 'confirmed'/);
  const handoff = src('services/packing/packingCommerceHandoff.ts');
  assert.equal(
    /unconfirmed/i.test(handoff.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')),
    false,
    'no unconfirmed-gap code path exists at all',
  );
});

test('DIFFERENT_BEHAVIOR_FOLLOWUP_REQUIRED: recorded, and deliberately not changed', () => {
  // Current behaviour, measured: "different" carries NO intent signal. The word
  // is not in any vocabulary, sets no field, and a "show me different shoes"
  // turn produces the same intent as "show me shoes".
  const { reduceShoppingIntent } = chat('eliseCommerceIntent.ts');
  const withDifferent = reduceShoppingIntent({
    previous: null,
    message: 'Show me different shoes.',
    payload: { category: 'shoes' },
  });
  const plain = reduceShoppingIntent({
    previous: null,
    message: 'Show me shoes.',
    payload: { category: 'shoes' },
  });
  assert.deepEqual(withDifferent.state, plain.state, '"different" is not modelled today');

  // Section 19 permits improving this ONLY if it needs no new persisted state.
  // It does: showing something different from what was just shown requires
  // remembering which products were shown, and the persisted intent carries
  // prices (for "cheaper") and no product identity. So it is recorded and left
  // alone rather than turned into a diversity side quest.
  const activation = src('services/style-chat/commerceActivation.ts');
  assert.match(activation, /lastShownPrices/, 'prices are remembered');
  assert.equal(
    /lastShownProductIds|shownProductIds|seenProductIds/.test(activation),
    false,
    'product identity is NOT remembered, and this lane does not add it',
  );
});

test('no new telemetry was added in this lane', () => {
  // Section 34: existing bounded telemetry only.
  for (const rel of [
    'services/style-chat/commerceActivation.ts',
    'components/style-chat/CommerceProductsBlock.tsx',
    'services/packing/packingCommerceHandoff.ts',
    'supabase/functions/scan-identify/commerceContextualRanking.ts',
  ]) {
    assert.equal(
      /posthog|captureEvent|trackEvent|analytics\./i.test(src(rel)),
      false,
      `${rel} must not emit analytics`,
    );
  }
});

test('no new provider, model or migration was introduced', () => {
  const migrations = fs.readdirSync(path.join(ROOT, 'supabase/migrations'));
  const commerceActivationMigrations = migrations.filter((f) => /commerce_activation|shopping_intent/i.test(f));
  assert.deepEqual(commerceActivationMigrations, [], 'this lane adds no migration');

  const activation = src('services/style-chat/commerceActivation.ts');
  assert.match(activation, /fetchCommerce/, 'it calls the existing Commerce seam');
  assert.equal(
    /fetch\(|axios|XMLHttpRequest/.test(activation),
    false,
    'and opens no network connection of its own',
  );
});
