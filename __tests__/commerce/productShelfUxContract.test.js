/**
 * Build 35 Commerce / ProductShelf shopping UX refinement -- deterministic
 * UX-contract fixtures (§59 BLOCK-COM-UX-00..25, §61).
 *
 * These pin what the shelf COMMUNICATES, not how Commerce ranks. FMQ measures
 * matching; nothing there proves a customer can tell a buyable card from a
 * link, a declared currency from a dollar sign, or a constraint from a command.
 *
 * Pure modules run for real under `node --test`. React Native components do not
 * load here, so their wiring is asserted against source -- the same established
 * pattern as commerceRationaleSurface.test.js.
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '../..');
const client = (rel) => require(path.join(ROOT, rel));
// Computed paths so the root tsc never follows into the Deno tree.
const edge = (fn, name) => require(path.join(ROOT, 'supabase/functions', fn, name));
const src = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const code = (rel) => src(rel).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');

const P = client('services/commerce/productShelfPresentation.ts');
const R = client('services/commerce/shelfRefinements.ts');

const SHELF = src('components/ProductShelf.tsx');
const BLOCK = src('components/style-chat/CommerceProductsBlock.tsx');
const COMPARE = src('components/commerce/ProductCompareSheet.tsx');
const CHIPS = src('components/commerce/ShelfRefinementChips.tsx');
const BUBBLE = src('components/style-chat/StyleChatBubble.tsx');
const SCREEN = src('app/style-chat/[sessionId].tsx');

const URL_A = 'https://www.nordstrom.com/s/black-suede-loafer/111';
const URL_B = 'https://www.ssense.com/en-us/men/product/black-loafer/222';

const offer = (over = {}) => ({
  id: 'a',
  title: 'Black Suede Loafer',
  productUrl: URL_A,
  type: 'retail',
  price: 129,
  currency: 'USD',
  ...over,
});

// ── BLOCK-COM-UX-01 / 02 / 13: price truth ─────────────────────────────────

test('BLOCK-COM-UX-01: a declared currency is shown, not implied by a symbol', () => {
  const view = P.shelfPriceView(offer());
  assert.equal(view.text, '$129.00 USD');
  assert.equal(view.currency, 'USD');
  assert.equal(view.currencyUnconfirmed, false);
  assert.equal(view.amount, 129);
  assert.match(view.accessibilityText, /USD/);
});

test('BLOCK-COM-UX-01: a self-describing currency is not double-labelled', () => {
  assert.equal(P.shelfPriceView(offer({ price: 129.99, currency: 'CAD' })).text, 'CA$129.99');
});

test('BLOCK-COM-UX-01: "$129.99" with no declared currency is marked unconfirmed and never comparable', () => {
  const view = P.shelfPriceView(offer({ price: '$129.99', currency: undefined }));
  assert.equal(view.text, '$129.99', "the retailer's own text, untouched (RP-110)");
  assert.equal(view.currency, null, 'a dollar sign is not a currency');
  assert.equal(view.currencyUnconfirmed, true);
  assert.equal(view.amount, null);
  assert.match(view.accessibilityText, /currency not confirmed/);
  // The card says so in words, not only in the announcement.
  assert.match(SHELF, /priceView\.currencyUnconfirmed \? \([\s\S]{0,160}Currency not confirmed/);
});

test('BLOCK-COM-UX-02: a missing or zero price is never fabricated', () => {
  for (const price of [undefined, null, '', 0, '0', '$0.00', -5]) {
    const view = P.shelfPriceView(offer({ price }));
    assert.equal(view.text, null, `price ${JSON.stringify(price)} must render nothing`);
    assert.equal(view.amount, null);
  }
});

test('BLOCK-COM-UX-13: relative price only between the SAME declared currency', () => {
  const cheaper = offer({ id: 'b', productUrl: URL_B, price: 99 });
  assert.equal(P.relativePriceText(cheaper, offer()), '$30.00 USD less');
  assert.equal(P.relativePriceText(offer(), cheaper), '$30.00 USD more');
  assert.equal(P.relativePriceText(offer(), offer({ id: 'c' })), 'Same price');
  assert.equal(P.relativePriceText(cheaper, offer({ currency: 'CAD' })), null, 'no cross-currency arithmetic');
  assert.equal(P.relativePriceText(cheaper, offer({ price: '$129.00', currency: undefined })), null, 'no undeclared currency');
  assert.equal(P.relativePriceText(cheaper, offer({ price: '$100 - $140' })), null, 'a range is not one amount');
});

// ── BLOCK-COM-UX-03 / 04 / 22: buyability ──────────────────────────────────

test('BLOCK-COM-UX-04: only a transaction-ready offer with a verified destination gets SHOP', () => {
  assert.equal(P.shelfBuyability(offer()), 'shop');
  assert.equal(P.shelfBuyability(offer({ type: 'similar' })), 'view', 'a similar item opens, never "Shop"');
  assert.equal(P.shelfBuyability(offer({ price: undefined })), 'view', 'unknown price cannot promise a purchase');
  assert.equal(P.shelfBuyability(offer({ commercialUsability: 'BROWSE_ONLY' })), 'view', 'server floor is trusted');
  assert.equal(P.shelfBuyability(offer({ availability: 'out_of_stock' })), 'out_of_stock');
  assert.equal(P.shelfBuyability(offer({ productUrl: undefined })), 'no_link');
  assert.equal(P.shelfBuyability(offer({ productUrl: 'javascript:alert(1)' })), 'no_link');
  assert.equal(P.BUYABILITY_COPY.no_link.action, null, 'no purchase path -> no control at all');
  assert.equal(P.BUYABILITY_COPY.view.action, 'VIEW AT RETAILER');
});

test('BLOCK-COM-UX-03: the Shop destination is the offer\'s own URL -- never built from text', () => {
  assert.equal(P.shelfDestinationUrl(offer()), URL_A);
  assert.equal(P.shelfDestinationUrl({ title: 'Black Loafer', brand: 'Gucci' }), null);
  const body = code('services/commerce/productShelfPresentation.ts');
  assert.equal(/encodeURIComponent|google\.com\/search|amazon\.com|\?q=/.test(body), false);
  // The primary control opens through the governed exit, same handler as the card.
  const primary = SHELF.slice(SHELF.indexOf('{buyCopy.action && hasLink ? ('));
  assert.match(primary.slice(0, 800), /onPress=\{\(\) => handleLinkPress\(purchaseUrl\)\}/);
});

test('BLOCK-COM-UX-22: availability is never upgraded to "in stock"', () => {
  for (const file of ['components/ProductShelf.tsx', 'components/commerce/ProductCompareSheet.tsx',
    'services/commerce/productShelfPresentation.ts', 'components/style-chat/CommerceProductsBlock.tsx']) {
    assert.equal(/in stock/i.test(code(file)), false, `${file} must not claim stock`);
  }
});

test('no-buyable shelf is a distinct, truthful state -- not "nothing matches"', () => {
  assert.equal(P.shelfHasBuyableOffer([offer({ type: 'similar' }), offer({ productUrl: undefined })]), false);
  assert.equal(P.shelfHasBuyableOffer([offer({ type: 'similar' }), offer({ id: 'b', productUrl: URL_B })]), true);
  const noBuyable = BLOCK.match(/const NO_BUYABLE_COPY =\s*"([^"]+)"/)[1];
  const noMatches = BLOCK.match(/const NO_MATCHES_COPY = "([^"]+)"/)[1];
  assert.notEqual(noBuyable, noMatches);
  assert.match(noBuyable, /verified purchase path/);
  assert.match(BLOCK, /const noBuyable = !shelfHasBuyableOffer\(verified\)/);
});

// ── BLOCK-COM-UX-23 / 15 / 16: no invented claims, no new ranking ──────────

test('BLOCK-COM-UX-23 / 54: no discount, scarcity or popularity language in the new UI', () => {
  for (const file of ['components/ProductShelf.tsx', 'components/commerce/ProductCompareSheet.tsx',
    'components/commerce/ShelfRefinementChips.tsx', 'services/commerce/productShelfPresentation.ts',
    'services/commerce/shelfRefinements.ts']) {
    const body = code(file);
    for (const re of [/% off/i, /\bsale\b/i, /\bdeal\b/i, /only \d+ left/i, /popular/i, /trending/i, /hurry/i]) {
      assert.equal(re.test(body), false, `${file} must not say ${re}`);
    }
  }
});

test('BLOCK-COM-UX-15: presentation carries no retailer preference', () => {
  for (const file of ['components/ProductShelf.tsx', 'components/commerce/ProductCompareSheet.tsx',
    'services/commerce/productShelfPresentation.ts']) {
    const body = code(file);
    assert.equal(/sponsored|recommended retailer|preferred retailer|affiliate(?!Url)/i.test(body), false, file);
  }
});

test('BLOCK-COM-UX-16: no new ordering authority -- the shelf keeps the ranker\'s order', () => {
  for (const file of ['services/commerce/productShelfPresentation.ts', 'services/commerce/shelfRefinements.ts',
    'components/commerce/ProductCompareSheet.tsx', 'components/commerce/ShelfRefinementChips.tsx']) {
    const body = code(file);
    assert.equal(/\.sort\(|\.reverse\(/.test(body), false, `${file} must not order candidates`);
    assert.equal(/score/i.test(body), false, `${file} must not score`);
  }
  const ranked = [offer({ id: '1' }), offer({ id: '2', productUrl: URL_B }), offer({ id: '3', productUrl: `${URL_B}9` })];
  assert.deepEqual(P.presentableShelf(ranked).map((p) => p.id), ['1', '2', '3']);
});

// ── BLOCK-COM-UX-00 / 17: identity ─────────────────────────────────────────

test('BLOCK-COM-UX-17: exact duplicates collapse through the EXISTING canonical identity only', () => {
  const tracked = offer({ id: 'dup', productUrl: `${URL_A}?utm_source=x` });
  const shelf = P.presentableShelf([offer(), tracked, offer({ id: 'b', productUrl: URL_B })]);
  assert.deepEqual(shelf.map((p) => p.id), ['a', 'b']);
  // Same title + price at another retailer is a DIFFERENT offer.
  const lookalike = offer({ id: 'look', productUrl: URL_B });
  assert.equal(P.presentableShelf([offer(), lookalike]).length, 2, 'no title/price heuristics');
  // No canonical identity -> kept as its own candidate.
  assert.equal(P.presentableShelf([{ title: 'x' }, { title: 'x' }]).length, 2);
  assert.match(SHELF, /const shelfProducts = presentableShelf\(products \?\? \[\]\)/);
});

test('BLOCK-COM-UX-00: every card key is unique and stable, so no action can slide to a neighbour', () => {
  const list = [offer(), offer({ id: 'a', productUrl: URL_B }), { title: 'no link', id: 'a' }, { title: 'bare' }];
  const keys = list.map((p, i) => P.shelfCardKey(p, i));
  assert.equal(new Set(keys).size, keys.length, 'a repeated id cannot produce a repeated key');
  assert.deepEqual(list.map((p, i) => P.shelfCardKey(p, i)), keys, 'stable across renders');
  // Every per-card action is built from the SAME `p` the card renders.
  assert.match(SHELF, /keyedProducts\.map\(\(\{ product: p, key: productKey \}\)/);
  assert.match(SHELF, /onPress=\{\(\) => handleLinkPress\(purchaseUrl\)\}/);
  assert.match(SHELF, /const purchaseUrl = getPurchaseUrl\(p\);/);
  // Compare resolves each column's actions from its own entry and refuses a mismatch.
  assert.match(SHELF, /if \(!entry \|\| entry\.product !== product\) return null;/);
  // A confirmed Watch marks the exact product object it was created for.
  assert.match(SHELF, /candidate\.product === watchedProduct/);
});

// ── Why This (BLOCK-COM-UX-14) ─────────────────────────────────────────────

test('BLOCK-COM-UX-14: "Why this" reads the ranker\'s facts -- zero requests, zero model calls', () => {
  const facts = {
    matchedAttributes: ['black', 'suede'],
    factCodes: ['explicit_color_match', 'explicit_material_match', 'budget_within', 'occasion_match'],
    budgetFit: 'within',
    usability: 'TRANSACTION_READY',
    gap: null,
    relationship: 'external',
    priceComparable: true,
  };
  const withFacts = offer({ commerceRationale: facts });
  assert.deepEqual(P.shelfReasonLines(withFacts), [
    'Matches the colour you asked for',
    'Matches the material you asked for',
  ]);
  assert.equal(P.shelfReasonLines(withFacts, 3).length, 3);
  assert.deepEqual(P.shelfMatchedAttributes(withFacts), ['black', 'suede']);
  assert.deepEqual(P.shelfReasonLines(offer()), [], 'no facts -> no reason, never a caption');
  assert.deepEqual(P.shelfReasonLines(offer({ commerceRationale: { factCodes: 'nope' } })), []);
  for (const file of ['services/commerce/productShelfPresentation.ts', 'services/commerce/shelfRefinements.ts',
    'components/commerce/ProductCompareSheet.tsx', 'components/commerce/ShelfRefinementChips.tsx']) {
    const body = code(file);
    for (const forbidden of ['fetch(', 'supabase', 'invoke(', 'generateContent', 'gemini', 'anthropic', 'openai', 'createWatch', 'watchlistClient']) {
      assert.equal(body.includes(forbidden), false, `${file} must not reach the network (${forbidden})`);
    }
  }
});

test('an unconfirmed Packing gap stays hedged on the card', () => {
  const lines = P.shelfReasonLines(offer({ commerceRationale: { factCodes: ['unconfirmed_gap_context'], matchedAttributes: [] } }));
  assert.match(lines[0], /couldn't confirm/);
});

// ── Compare (BLOCK-COM-UX-12 / 13) ────────────────────────────────────────

test('Compare selection is bounded to 2-3 and preserves selection order', () => {
  let sel = [];
  for (const key of ['a', 'b', 'c', 'd']) sel = P.toggleCompareSelection(sel, key);
  assert.deepEqual(sel, ['a', 'b', 'c'], 'a fourth pick is refused, not rotated in');
  assert.deepEqual(P.toggleCompareSelection(sel, 'b'), ['a', 'c']);
  assert.equal(P.COMPARE_MIN, 2);
  assert.equal(P.COMPARE_MAX, 3);
});

test('BLOCK-COM-UX-12: Compare shows only facts the offers carry; gaps read "Not listed"', () => {
  const a = offer({ brand: 'Aldo', category: 'footwear', commerceType: 'retail' });
  const b = offer({ id: 'b', productUrl: URL_B, price: 99, brand: undefined });
  const rows = P.buildCompareRows([a, b], (p) => (p.id === 'a' ? 'Nordstrom' : 'SSENSE'));
  const row = (label) => rows.find((r) => r.label === label);
  assert.deepEqual(row('Brand').values, ['Aldo', null], 'missing brand is null, never lifted from the title');
  assert.deepEqual(row('Retailer').values, ['Nordstrom', 'SSENSE']);
  assert.deepEqual(row('Price vs option 1').values, ['Reference', '$30.00 USD less']);
  assert.deepEqual(row('Purchase').values, ['Ready to shop', 'Ready to shop']);
  // A fact NO offer carries is not a row at all.
  assert.equal(row('Matches your request'), undefined);
  assert.equal(row('Why it’s here'), undefined);
  // Material and colour are never parsed out of a title.
  assert.equal(rows.some((r) => /material|colou?r/i.test(r.label)), false);
  assert.match(COMPARE, /COMPARE_NOT_LISTED = 'Not listed'/);
});

test('BLOCK-COM-UX-13: Compare price difference disappears across currencies', () => {
  const rows = P.buildCompareRows([offer(), offer({ id: 'b', productUrl: URL_B, currency: 'EUR' })], () => null);
  assert.equal(rows.find((r) => r.label === 'Price vs option 1'), undefined);
});

test('§23: Compare has no action implementation of its own', () => {
  const body = code('components/commerce/ProductCompareSheet.tsx');
  for (const forbidden of ['createWatch', 'addProductToDressingRoom', 'Linking', 'openCommerceOffer', 'TryItOnEntry']) {
    assert.equal(body.includes(forbidden), false, `Compare must not implement ${forbidden}`);
  }
  // The shelf hands it the SAME handlers its cards use.
  assert.match(SHELF, /onPress: \(\) => handleLinkPress\(url\)/);
  assert.match(SHELF, /setSelectedProduct\(entry\.product\)/);
  assert.match(SHELF, /setWatchModalProduct\(entry\.product\)/);
});

// ── Watch / Save (BLOCK-COM-UX-05 / 06 / 21 / 24) ─────────────────────────

test('BLOCK-COM-UX-05/24: Watch uses the Watchlist authority and cannot double-create', () => {
  assert.match(SHELF, /const result = await createWatch\(\{/);
  assert.match(SHELF, /if \(!product \|\| saving \|\| created \|\| inFlightRef\.current\) return;/);
  assert.match(SHELF, /inFlightRef\.current = true;\n\s*const result = await createWatch/);
  assert.match(SHELF, /disabled=\{saving \|\| created\}/);
  // "Watching" is written only inside the success branch.
  const success = SHELF.slice(SHELF.indexOf('if (result.ok) {'), SHELF.indexOf('} else {', SHELF.indexOf('if (result.ok) {')));
  assert.match(success, /setCreated\(true\);\s*onWatched\?\.\(product\);/);
  assert.equal((SHELF.match(/onWatched\?\.\(/g) || []).length, 1, 'no other path marks a card Watching');
  assert.match(SHELF, /canWatch && isWatched \?/, 'Watching needs both eligibility and a confirmed create');
});

test('Watch price carries the offer\'s OWN declared currency the server can read', () => {
  const { resolveObservedCurrency } = edge('commerce-watch-refresh', 'watchCurrency.ts');
  // The defect: numeric price + declared currency was sent as "129" and refused.
  assert.equal(resolveObservedCurrency(String(129)), null, 'the old payload was unreadable');
  const fixed = P.watchListingPrice(offer());
  assert.equal(fixed, '129 USD');
  assert.equal(resolveObservedCurrency(fixed), 'USD');
  assert.equal(P.watchListingPrice(offer({ price: 'CA$1,299.99', currency: 'CAD' })), 'CA$1,299.99 CAD');
  assert.equal(resolveObservedCurrency(P.watchListingPrice(offer({ price: '$99', currency: 'CAD' }))), 'CAD',
    'a declared currency is never overridden by the "$" prefix scan');
  assert.equal(P.watchListingPrice(offer({ price: '129.00 USD', currency: 'USD' })), '129.00 USD', 'no double label');
  assert.equal(P.watchListingPrice(offer({ price: '$129.99', currency: undefined })), '$129.99', 'nothing guessed');
  assert.equal(P.watchListingPrice(offer({ price: null })), undefined);
  assert.match(SHELF, /price: watchListingPrice\(product\),/);
});

test('BLOCK-COM-UX-06/07/21: Save, Watch and Try On never write or claim ownership', () => {
  for (const file of ['components/ProductShelf.tsx', 'components/commerce/ProductCompareSheet.tsx',
    'components/commerce/ShelfRefinementChips.tsx', 'services/commerce/productShelfPresentation.ts']) {
    const body = code(file);
    assert.equal(/in your closet|isOwned|markOwned|addToCloset|ownership:\s*['"]owned/i.test(body), false, file);
  }
  // Save names its destination, not a purchase.
  assert.match(SHELF, /canSaveToRoom \? 'Save to a Dressing Room'/);
});

// ── VTO (BLOCK-COM-UX-08) ──────────────────────────────────────────────────

test('BLOCK-COM-UX-08: Try On stays behind the canonical resolver, bound to the same card', () => {
  assert.match(SHELF, /const vtoGarment = buildVtoGarmentFromProduct\(p\);/);
  assert.match(SHELF, /<TryItOnEntry\s+garment=\{vtoGarment\}/);
  for (const file of ['components/commerce/ProductCompareSheet.tsx', 'services/commerce/productShelfPresentation.ts']) {
    assert.equal(/vto/i.test(code(file)), false, `${file} must not decide VTO eligibility`);
  }
});

// ── Refinements (BLOCK-COM-UX-10 / 20) ─────────────────────────────────────

test('BLOCK-COM-UX-10: retained constraints are visible, including exclusions and budget', () => {
  const chips = R.activeConstraintChips({
    color: 'black', category: 'loafers', budget: { amount: 150, currency: 'usd' },
    exclusions: ['material:leather', 'bogus', 'color:<script>'],
  }, 2);
  assert.deepEqual(chips.map((c) => c.label), ['black', 'loafers', 'Under 150 USD', 'No leather', '2 hidden']);
  assert.ok(chips.every((c) => c.accessibilityLabel.length > 0));
  assert.deepEqual(R.activeConstraintChips({ budget: { amount: 150, currency: '$' } }).map((c) => c.label), [],
    'a budget without a known currency is not shown as one');
});

test('BLOCK-COM-UX-20: every chip sends a sentence Commerce V2 ALREADY parses -- no chip semantics', () => {
  const intent = edge('stylechat-generate', 'eliseCommerceIntent.ts');
  const M = R.REFINEMENT_MESSAGES;
  const op = (m) => intent.detectShelfMemoryDirective(m, null, null)?.op ?? null;
  assert.equal(op(M.different.message), 'different');
  assert.equal(op(M.another.message), 'another');
  assert.equal(op(M.not_those.message), 'not_those');
  assert.equal(op(M.clear.message), 'clear');
  const state = { ...intent.emptyShoppingIntentState(), budget: { amount: 150, currency: 'USD' }, formality: 'smart' };
  assert.deepEqual(intent.resolveRelativeBudget(M.cheaper.message, state), { kind: 'resolved', amount: 150, currency: 'USD' });
  assert.deepEqual(intent.resolveRelativeFormality(M.more_casual.message, state), { kind: 'resolved', token: 'casual' });
  assert.deepEqual(intent.resolveRelativeFormality(M.dressier.message, state), { kind: 'resolved', token: 'dressy' });
  // Relative chips never also trip a memory op.
  for (const key of ['cheaper', 'more_casual', 'dressier']) assert.equal(op(M[key].message), null, key);
  // No client-side shelf memory exists in the chip layer.
  for (const file of ['services/commerce/shelfRefinements.ts', 'components/commerce/ShelfRefinementChips.tsx']) {
    assert.equal(/commerceShelfMemory|recordShelf|rejectLatestShelf|activeExclusions/.test(code(file)), false, file);
  }
});

test('chips are offered only when the parser can resolve them from visible state', () => {
  const keys = (input) => R.refinementActions(input).map((a) => a.key);
  const base = { status: 'results', products: [offer()], summary: {}, hiddenCount: 0 };
  assert.deepEqual(keys(base), ['different', 'another', 'not_those', 'cheaper']);
  assert.deepEqual(keys({ ...base, products: [offer({ currency: undefined, price: '$120' })] }),
    ['different', 'another', 'not_those'], 'no reference price -> no Cheaper chip');
  assert.ok(keys({ ...base, summary: { formality: 'smart' } }).includes('dressier'));
  assert.deepEqual(keys({ ...base, status: 'exhausted', products: [], hiddenCount: 3 }), ['clear']);
  assert.deepEqual(keys({ ...base, status: 'error' }), [], 'nothing to refine when the lookup failed');
  assert.equal(keys({ ...base, memoryOp: 'reference' }).includes('another'), false,
    'a restored single option is not a shelf to page through');
});

test('§16: constraints and commands are different kinds of control', () => {
  const constraints = CHIPS.slice(CHIPS.indexOf('export function ActiveConstraints'), CHIPS.indexOf('export function RefinementChips'));
  const commands = CHIPS.slice(CHIPS.indexOf('export function RefinementChips'));
  assert.equal(/onPress|TouchableOpacity/.test(constraints), false, 'a constraint chip is not a button');
  assert.match(commands, /accessibilityRole="button"/);
  assert.match(commands, /onRefine\(action\.message\)/);
  // The block itself still defines no action handler (§24 contract).
  assert.equal(/onPress=/.test(BLOCK), false);
});

// ── Stale shelf / refinement transport (BLOCK-COM-UX-11) ───────────────────

test('BLOCK-COM-UX-11: only the latest shelf can refine, through the one send path', () => {
  assert.match(SCREEN, /item\.id === latestCommerceMessageId && canSend && !isSending/);
  assert.match(SCREEN, /if \(!canSend \|\| isSending\) return;\s*setRefiningFromMessageId\(messageId\);\s*void sendMessage\(text\);/);
  assert.match(BUBBLE, /onRefine=\{onCommerceRefine\}/);
  // Turns are serialised by the existing send lock, so a late shelf cannot land
  // over a newer one; this lane adds no second concurrency mechanism.
  const hook = src('hooks/useStyleChat.ts');
  assert.match(hook, /isSendingRef/);
  for (const file of ['services/commerce/shelfRefinements.ts', 'components/commerce/ShelfRefinementChips.tsx']) {
    assert.equal(/AbortController|epoch|setTimeout/.test(code(file)), false, file);
  }
});

test('§50: an updating shelf stays visible but cannot be acted on or mistaken for new results', () => {
  assert.match(SHELF, /Updating options…/);
  assert.match(SHELF, /pointerEvents=\{updating \? 'none' : 'auto'\}/);
  assert.match(SHELF, /if \(!url \|\| updating\) return;/);
  assert.match(SHELF, /const compareEnabled = keyedProducts\.length >= COMPARE_MIN && !updating;/);
  assert.match(BLOCK, /updating=\{refining\}/);
});

// ── Accessibility (§51) ────────────────────────────────────────────────────

test('§51: state is announced in words, never by colour or icon alone', () => {
  assert.match(SHELF, /accessibilityRole="checkbox"[\s\S]{0,200}accessibilityState=\{\{ checked: isCompared, disabled: compareFull \}\}/);
  assert.match(SHELF, /\{isCompared \? '✓ COMPARE' : 'COMPARE'\}/);
  assert.match(SHELF, /accessibilityLabel=\{`Watching \$\{productTitle\}`\}/);
  assert.match(SHELF, /accessibilityLabel=\{cardSummary\}/);
  assert.match(SHELF, /accessibilityLabel="Finding options"/);
  assert.match(SHELF, /buyability === 'shop' \? `Shop \$\{productTitle\}` : `View \$\{productTitle\} at the retailer`/);
  assert.match(CHIPS, /accessibilityLabel=\{`Shopping for: /);
});

test('§52: a card never stacks four equal-weight CTAs', () => {
  // Primary (Shop/View) + optional Try On + ONE shared Save|Watch row.
  assert.match(SHELF, /<View style=\{styles\.secondaryRow\}>/);
  assert.match(SHELF, /secondaryRow: \{\s*flexDirection: 'row'/);
  // The old decorative link dot is gone: buyability is stated, not implied.
  assert.equal(/Has product link/.test(SHELF), false);
});
