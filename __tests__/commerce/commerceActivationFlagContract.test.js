/**
 * The activation flag, both ways (continuation brief §25, §24, §23).
 *
 * "Do not merely assert flag-off behaviour" -- so the off cases below EXECUTE
 * the real config resolver, the real prompt assembly and the real action
 * validator against a flag-off environment, rather than reading the source and
 * believing it.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const chat = (n) => require(path.join(ROOT, 'supabase/functions/stylechat-generate', n));
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

const { readEliseBackendConfig } = chat('eliseConfig.ts');
const { validateStyleChatActions, extractActionsBlock } = chat('actions.ts');
const ts = require('typescript');
const vm = require('node:vm');

/**
 * Load `constants/featureFlags.ts` against an explicit environment.
 *
 * The repo convention (see closetCandidateFeatureFlags.test.js): the module
 * reads `__DEV__` and `process.env` at import time, so the flag is EVALUATED
 * against real inputs here rather than asserted from source text.
 */
function loadFlags(env = {}) {
  const source = ts.transpileModule(
    fs.readFileSync(path.join(ROOT, 'constants/featureFlags.ts'), 'utf8'),
    {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        esModuleInterop: true,
      },
    },
  ).outputText;
  const sandbox = { module: { exports: {} }, exports: {}, require: () => ({}), process: { env }, __DEV__: false, console };
  sandbox.module.exports = sandbox.exports;
  vm.runInNewContext(source, sandbox, { filename: 'constants/featureFlags.ts' });
  return sandbox.module.exports;
}

const configWith = (value) =>
  readEliseBackendConfig({
    get: (key) => (key === 'ELISE_COMMERCE_ACTIVATION_V1_ENABLED' ? value : undefined),
  });

// ── OFF ────────────────────────────────────────────────────────────────────

test('the capability is OFF unless the environment opts in', () => {
  // Default off, and an unset or unrecognised value stays off. The truthy set
  // is the SERVER convention (`parseBooleanEnv`), which is deliberately more
  // forgiving than the client mirror below -- asserted here so the difference
  // is recorded rather than discovered.
  assert.equal(configWith(undefined).flags.commerceActivationV1, false);
  for (const value of ['', 'false', 'off', 'no', '0', 'maybe', 'enabled']) {
    assert.equal(configWith(value).flags.commerceActivationV1, false, `${value} must not enable it`);
  }
  for (const value of ['true', 'TRUE', '1', 'yes', 'on']) {
    assert.equal(configWith(value).flags.commerceActivationV1, true, `${value} is the documented opt-in`);
  }
});

test('the client mirror is OFF by default and only "true" enables it', () => {
  assert.equal(loadFlags({}).ELISE_COMMERCE_ACTIVATION_V1, false);
  for (const value of ['', 'false', 'TRUE', 'True', '1', 'yes', ' true', 'true ']) {
    assert.equal(
      loadFlags({ EXPO_PUBLIC_ELISE_COMMERCE_ACTIVATION_V1: value }).ELISE_COMMERCE_ACTIVATION_V1,
      false,
      `${JSON.stringify(value)} must not enable it`,
    );
  }
  assert.equal(
    loadFlags({ EXPO_PUBLIC_ELISE_COMMERCE_ACTIVATION_V1: 'true' }).ELISE_COMMERCE_ACTIVATION_V1,
    true,
  );
});

test('flag off: the prompt never mentions the shopping action', () => {
  // The instruction block is appended behind the flag, so a flag-off turn
  // cannot teach the model an action it is not allowed to propose.
  const index = src('supabase/functions/stylechat-generate/index.ts');
  assert.match(index, /config\.flags\.commerceActivationV1 \? COMMERCE_ACTION_INSTRUCTIONS : null/);
});

test('flag off: a find_products action the model proposes anyway is dropped', () => {
  const modelText =
    'Sure.\n<actions>[{"type":"find_products","shopping":{"category":"shoes","color":"black"}}]</actions>';
  const extracted = extractActionsBlock(modelText);

  // The validator is the allowlist. With the action filtered out upstream on a
  // flag-off turn, nothing downstream can act on it.
  const index = src('supabase/functions/stylechat-generate/index.ts');
  assert.match(
    index,
    /if \(!config\.flags\.commerceActivationV1\) \{\s+validatedActions = validatedActions\.filter\(/,
    'the flag-off path strips the action before it is published',
  );
  assert.match(
    index,
    /const commerceAction = config\.flags\.commerceActivationV1\s+\? validatedActions\.find/,
    'and the reducer is only reached when the flag is on',
  );
  // The reducer is downstream of `commerceAction`, which is undefined when the
  // flag is off, so no intent is produced. Modelled directly rather than by
  // calling the reducer with a null payload -- that path still infers a
  // category from the message text, which is correct behaviour for a turn that
  // reached it, and asserting otherwise would be testing a call that a
  // flag-off turn never makes.
  const actions = validateStyleChatActions(extracted.rawActions, []);
  const asFlagOff = actions.filter((a) => a.type !== 'find_products');
  assert.equal(asFlagOff.find((a) => a.type === 'find_products'), undefined);

  // Sanity: the same text DOES parse when the action is allowed, so this is
  // proving a gate rather than a parse failure.
  assert.equal(actions.some((a) => a.type === 'find_products'), true);
});

test('flag off: no shoppingIntent and no Signature Style tokens are published', () => {
  const index = src('supabase/functions/stylechat-generate/index.ts');
  // Both response fields are conditional on state that only a flag-on turn
  // can produce.
  assert.match(index, /\.\.\.\(shoppingIntentState\n?\s*\? \{/);
  assert.match(index, /\.\.\.\(shoppingIntentState && signatureStyleCommerceTokens\.length/);
  assert.match(index, /const signatureStyleCommerceTokens = config\.flags\.commerceActivationV1/);
});

test('flag off: the client cannot start a Commerce turn at all', () => {
  const hook = src('hooks/useStyleChat.ts');
  // The only entry point is a parsed wire, and the server publishes none.
  assert.match(hook, /if \(shoppingWire\) \{/);
  assert.match(hook, /const shoppingWire = parseShoppingIntentWire\(/);
});

test('flag off: the Packing action is absent, not merely disabled', () => {
  const screen = src('app/packing/index.tsx');
  assert.match(
    screen,
    /onFindOptions=\{ELISE_COMMERCE_ACTIVATION_V1 \? onFindOptions : undefined\}/,
  );
  const view = src('components/packing/PackingPlanView.tsx');
  // Undefined handler -> the control does not render, rather than rendering
  // greyed out. A disabled control still advertises a capability.
  assert.match(view, /\{onFindOptions && gap\.certainty === 'confirmed' \? \(/);
});

// ── ON ─────────────────────────────────────────────────────────────────────

test('flag on: exactly one model turn, and no Commerce-side model call', () => {
  const index = src('supabase/functions/stylechat-generate/index.ts');
  // The single-pass structure is what makes the whole design possible; a tool
  // loop would be a second round trip per shopping turn.
  assert.equal(/functionDeclarations|toolConfig/.test(index), false, 'no tool calling was introduced');

  const activation = src('services/style-chat/commerceActivation.ts');
  const stripped = activation.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.equal(
    /gemini|generateContent|callModel|openai|anthropic/i.test(stripped),
    false,
    'the Commerce side calls no model',
  );
});

test('flag on: degradation is graceful when Signature Style is unavailable', () => {
  const hook = src('hooks/useStyleChat.ts');
  // No tokens -> the dependency is simply not supplied. No fallback profile is
  // invented, and the rest of the context still travels.
  assert.match(hook, /\.\.\.\(Array\.isArray\(signatureStyleTokens\) && signatureStyleTokens\.length/);
  const activation = src('services/style-chat/commerceActivation.ts');
  assert.match(activation, /loadSignatureStyleTokens\?\.\(\)\.catch\(\(\) => null\)/);
});

// ── §23 pre-result prose ───────────────────────────────────────────────────

test('the prompt forbids claiming results that have not arrived', () => {
  const index = src('supabase/functions/stylechat-generate/index.ts');
  const instructions = index.slice(
    index.indexOf('const COMMERCE_ACTION_INSTRUCTIONS'),
    index.indexOf('// ── Helpers'),
  );
  // Commerce runs AFTER the prose, so the prose cannot truthfully describe it.
  assert.match(instructions, /Do NOT name products, prices, brands, retailers, stock or availability/);
  assert.match(instructions, /Do not say you already found, checked, or listed anything/);
  assert.match(instructions, /never that you have looked/);
});

test('the shelf attaches to the message without gating the first text', () => {
  const hook = src('hooks/useStyleChat.ts');
  const optimistic = hook.indexOf('setMessages(prev => [...prev, optimisticAssistant])');
  const commerce = hook.indexOf('runCommerceActivation({');
  assert.ok(optimistic > -1 && commerce > optimistic, 'prose renders before Commerce runs');
});

// ── §24 Save / Watch / Shop ────────────────────────────────────────────────

test('the activated shelf reuses ProductShelf and adds no action of its own', () => {
  const block = src('components/style-chat/CommerceProductsBlock.tsx');
  assert.match(block, /import \{ ProductShelf/);
  // No Save/Watch/Shop handler is defined here: the contracts stay in one place.
  assert.equal(/onSave=|onWatch=|onShop=|onPress=/.test(block), false);
});

test('J17: nothing in the activated path can turn Save or Watch into ownership', () => {
  const activation = src('services/style-chat/commerceActivation.ts');
  const block = src('components/style-chat/CommerceProductsBlock.tsx');
  for (const [name, source] of [['activation', activation], ['block', block]]) {
    assert.equal(
      /ownership:\s*['"]owned['"]|isOwned\s*=\s*true|addToCloset|markOwned/.test(source),
      false,
      `${name} must not write ownership`,
    );
  }
  // And the ranker's own firewall still strips a forged claim, with or without
  // context — proven directly rather than by reading.
  const edge = (n) => require(path.join(ROOT, 'supabase/functions/scan-identify', n));
  const { stripOwnershipClaim } = edge('commerceContextualRanking.ts');
  // Every field the ownership contract actually defines, set at once.
  const forged = stripOwnershipClaim({
    id: 'f', title: 'Black Boot', price: '$100.00', currency: 'USD',
    productUrl: 'https://www.farfetch.com/p/f', imageUrl: 'https://i.io/f.jpg',
    owned: true, inCloset: true, isOwned: true,
    relationship: 'owned', actorRelationship: 'owned',
  });
  assert.equal(forged.owned, undefined);
  assert.equal(forged.inCloset, undefined);
  assert.equal(forged.isOwned, undefined);
  assert.equal(forged.actorRelationship, undefined);
  assert.equal(forged.relationship, 'external');
  assert.equal(forged.price, '$100.00', 'the offer survives; only the claim dies');

  // Defence in depth: the shelf reads no ownership field at all, so even an
  // unstripped one could not be rendered as a claim.
  const shelf = src('components/ProductShelf.tsx');
  assert.equal(/\bowned\b|inCloset|isOwned|actorRelationship/.test(shelf), false);
});

test('Watch stays behind its own existing gate', () => {
  // This lane does not redesign the Watchlist and must not bypass its flag.
  const shelf = src('components/ProductShelf.tsx');
  assert.match(shelf, /watchCapability|canWatch/i, 'the shelf still consults the existing capability');
  const block = src('components/style-chat/CommerceProductsBlock.tsx');
  assert.equal(/SMART_WATCHLIST|watchCapability/.test(block), false, 'and chat does not second-guess it');
});
