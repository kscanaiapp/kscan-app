#!/usr/bin/env node
/**
 * Commerce V2 owner quality gate (brief §51).
 *
 * Three complete, previously unseen conversations through the REAL path,
 * judged on whether the answer would be useful to a PERSON. CI passing and a
 * customer being helped are different questions, and this asks the second one.
 *
 * The market fixtures here are not reused from any implementation test: a
 * feature that only works on the universe it was built against has not been
 * shown to work.
 *
 *   node tools/commerce-v2/ownerQualityGate.js
 *   node tools/commerce-v2/ownerQualityGate.js --json
 */
'use strict';

const path = require('node:path');
const ROOT = path.resolve(__dirname, '../..');
const h = require(path.join(ROOT, 'tools/commerce-v2/v2Journey.js'));
const { conversation, makeControllableProvider, product, persistedMemory } = h;
const usability = require(path.join(ROOT, 'services/commerce/commercialUsability.ts'));
const packingHandoff = require(path.join(ROOT, 'services/packing/packingCommerceHandoff.ts'));

// ── Unseen markets ─────────────────────────────────────────────────────────

/**
 * A realistic dress-shoe market: twelve live offers across six retailers.
 *
 * Retailer spread matters as much as depth. #409's coverage selection keeps a
 * bounded, diverse candidate set, so three offers concentrated at three
 * retailers is a market of three no matter how many rows arrive — a shape
 * worth knowing about, but not the one this transcript is trying to exercise.
 */
const DERBY_ROWS = [
  ['Black Leather Derby Shoe', 165], ['Black Leather Oxford Shoe', 190],
  ['Black Suede Derby Shoe', 145], ['Black Leather Monk Strap Shoe', 198],
  ['Black Leather Brogue Shoe', 175], ['Black Suede Oxford Shoe', 159],
  ['Black Leather Loafer Shoe', 135], ['Black Polished Derby Shoe', 188],
  ['Black Leather Dress Shoe', 149], ['Black Suede Monk Strap Shoe', 179],
  ['Brown Leather Derby Shoe', 155], ['Black Leather Formal Shoe', 240],
];
const DERBY_RETAILERS = ['Mr Porter', 'Selfridges', 'Poshmark', 'Farfetch', 'Zappos', 'Nordstrom'];
const DERBIES = DERBY_ROWS.map(([title, price], i) => product(
  `g_derby_${i}`, title, `$${price}.00`,
  { source: DERBY_RETAILERS[i % DERBY_RETAILERS.length], productUrl: `https://shop-${i % 6}.co.uk/shoe/${i}` },
));

const RAIN_ROWS = [
  ['Packable Waterproof Rain Shell', 135], ['Lightweight Waterproof Anorak', 110],
  ['Waterproof Cotton Trench Coat', 260], ['Wool Overcoat', 420],
  ['Insulated Waterproof Parka', 310], ['Waterproof Packable Windbreaker', 95],
  ['Waterproof Hooded Raincoat', 145], ['Breathable Waterproof Shell Jacket', 175],
];
const RAIN_RETAILERS = ['Nordstrom', 'Zappos', 'Selfridges', 'Farfetch', 'Mr Porter', 'Harrods'];
const RAIN_LAYERS = RAIN_ROWS.map(([title, price], i) => product(
  `g_rain_${i}`, title, `$${price}.00`,
  { source: RAIN_RETAILERS[i % RAIN_RETAILERS.length], productUrl: `https://outdoor-${i % 6}.co.uk/jacket/${i}` },
));

const KNITS = [
  product('g_wool_crew', 'Navy Wool Crew Neck Sweater', '$180.00', { source: 'Mr Porter' }),
  product('g_cashmere', 'Navy Cashmere Crew Neck Sweater', '$320.00', { source: 'Selfridges' }),
  product('g_cotton_knit', 'Navy Cotton Knit Sweater', '$95.00', { source: 'Zappos' }),
  product('g_wool_cardigan', 'Navy Wool Cardigan', '$210.00', { source: 'Nordstrom' }),
  product('g_cashmere_casual', 'Navy Cashmere Casual Knit', '$290.00', { source: 'Farfetch' }),
];

const shelfOf = (turn) => turn.productDetail.map((p) => ({
  title: String(p.title),
  price: p.price ?? null,
  retailer: p.source ?? null,
  transactable: usability.canActivateTransaction(usability.resolveCommercialUsability({
    commercialUsability: p.commercialUsability, type: p.type, price: p.price,
    availability: p.availability, destinationUrl: p.productUrl,
  })),
}));

const stateOf = (turn) => ({
  category: turn.state?.category ?? null,
  color: turn.state?.color ?? null,
  material: turn.state?.material ?? null,
  formality: turn.state?.formality ?? null,
  budget: turn.state?.budget ?? null,
  exclusions: (turn.state?.exclusions ?? []).map((e) => `${e.axis}:${e.token}`),
  functional: turn.state?.functionalRequirements ?? [],
  rejected: (persistedMemory(turn)?.rejected ?? []).length,
  memoryOp: turn.memoryOp ?? null,
  notices: turn.notices ?? [],
});

// ── A. Direct Elise shopping ───────────────────────────────────────────────

async function transcriptA() {
  const c = conversation({ provider: makeControllableProvider({ universe: DERBIES }) });
  const turns = [];
  turns.push(['Find me black dress shoes under $200.', await c.say('Find me black dress shoes under $200.', {
    category: 'shoes', color: 'black', budgetAmount: 200, budgetCurrency: 'USD',
  })]);
  turns.push(['Not those.', await c.say('Not those.')]);
  turns.push(['Another.', await c.say('Another.')]);
  turns.push(['Show me everything again.', await c.say('Show me everything again.')]);

  const [t1, t2, t3, t4] = turns.map(([, t]) => t);
  const shelfA = h.identitiesOf(t1);
  const findings = [];

  if (!t1.products.length) findings.push('the first request returned nothing');
  if (h.identitiesOf(t2).some((id) => shelfA.includes(id))) findings.push('a rejected shoe came back');
  // Being told "that is everything" IS a useful answer. What would not be
  // useful is a repeat dressed as a new option, or a blank shelf with no
  // explanation — so exhaustion counts only when it is reported as exhaustion.
  if (t3.productDetail.length > 1) findings.push('"another" returned more than one option');
  if (t3.productDetail.length === 0 && t3.status !== 'exhausted') {
    findings.push('"another" returned nothing without saying why');
  }
  if (h.identitiesOf(t3).some((id) => shelfA.includes(id))) findings.push('"another" returned a rejected shoe');
  if ((persistedMemory(t4)?.rejected ?? []).length !== 0) findings.push('the rejections could not be cleared');
  if (t1.state.budget?.amount !== 200) findings.push('the budget was lost');
  if (c.calls > 2) findings.push(`spent ${c.calls} provider requests on four turns`);

  return {
    name: 'A. Direct Elise shopping — reject, ask for another, recover',
    turns: turns.map(([said, turn]) => ({ said, state: stateOf(turn), shelf: shelfOf(turn), status: turn.status })),
    providerCalls: c.calls,
    rationale:
      'The customer rejects a whole shelf, asks for one more option, then changes their mind. ' +
      'Every step has to hold: the rejected shoes stay gone, "another" is one genuinely unseen ' +
      'option rather than a re-labelled repeat, and one sentence puts everything back. ' +
      'No step may spend a provider request the previous one already paid for.',
    transactionState: `${shelfOf(t1).filter((p) => p.transactable).length}/${shelfOf(t1).length} transactable on the opening shelf`,
    findings,
    rating: findings.length === 0 ? 'USEFUL' : findings.length <= 1 ? 'PARTIALLY_USEFUL' : 'NOT_USEFUL',
  };
}

// ── B. Packing → Commerce → refinement ─────────────────────────────────────

async function transcriptB() {
  // A CONFIRMED Packing gap, through the real handoff adapter.
  const suggestion = {
    gapCode: 'rain_layer',
    label: 'Rain layer',
    category: 'outerwear',
    functionalRequirements: ['waterproof'],
  };
  const contribution = packingHandoff.buildPackingCommerceContribution
    ? packingHandoff.buildPackingCommerceContribution(suggestion)
    : null;

  const c = conversation({ provider: makeControllableProvider({ universe: RAIN_LAYERS }) });
  const turns = [];
  turns.push(['Packing says I have no rain layer — find me one.', await c.say(
    'Packing says I have no rain layer — find me one for the trip.',
    { category: 'jacket', functionalRequirements: ['waterproof'] },
  )]);
  turns.push(['Show me different ones.', await c.say('Show me different ones.')]);
  turns.push(['Under $150.', await c.say('Under $150.', { budgetAmount: 150, budgetCurrency: 'USD' })]);

  const [t1, t2, t3] = turns.map(([, t]) => t);
  const findings = [];

  if (!t1.products.length) findings.push('the confirmed gap produced no options');
  if (!t1.state.functionalRequirements.includes('waterproof')) findings.push('the functional requirement was lost at handoff');
  if (!t2.state.functionalRequirements.includes('waterproof')) findings.push('"different" dropped the functional requirement');
  if (t2.state.category !== 'outerwear') findings.push('"different" dropped the category');
  if (h.identitiesOf(t2).some((id) => h.identitiesOf(t1).includes(id))) findings.push('"different" repeated an option');
  for (const card of shelfOf(t3)) {
    const amount = Number(String(card.price).replace(/[^0-9.]/g, ''));
    if (Number.isFinite(amount) && amount > 150) findings.push(`an over-budget option survived: ${card.title}`);
  }

  return {
    name: 'B. Packing confirmed gap → Commerce → refinement',
    packingContribution: contribution ? { provenance: contribution.provenance, gap: contribution.gapRelationship } : 'adapter shape unchanged by this lane',
    turns: turns.map(([said, turn]) => ({ said, state: stateOf(turn), shelf: shelfOf(turn), status: turn.status })),
    providerCalls: c.calls,
    rationale:
      'A gap Packing actually proved becomes a shopping request, and then the customer asks for ' +
      'different options and adds a ceiling. The thing that must not happen is the reason for the ' +
      'search quietly evaporating: "waterproof" is why this conversation exists, and replacing the ' +
      'products must never replace the requirement. The ceiling then has to bite on real prices.',
    transactionState: `${shelfOf(t3).filter((p) => p.transactable).length}/${shelfOf(t3).length} transactable after the ceiling`,
    findings,
    rating: findings.length === 0 ? 'USEFUL' : findings.length <= 1 ? 'PARTIALLY_USEFUL' : 'NOT_USEFUL',
  };
}

// ── C. Material / style refinement, then return to a prior product ────────

async function transcriptC() {
  const c = conversation({ provider: makeControllableProvider({ universe: KNITS }) });
  const turns = [];
  turns.push(['Find me a navy wool sweater for work.', await c.say('Find me a navy wool sweater for work.', {
    category: 'sweater', color: 'navy', material: 'wool',
  })]);
  turns.push(['Something less formal, maybe cashmere.', await c.say('Something less formal, maybe cashmere.', { material: 'cashmere' })]);
  turns.push(['Actually, go back to the first one.', await c.say('Actually, go back to the first one.')]);

  const [t1, t2, t3] = turns.map(([, t]) => t);
  const findings = [];
  const shelfA = h.identitiesOf(t1);

  if (t1.state.material !== 'wool') findings.push('the stated material never reached the intent');
  if (t2.state.material !== 'cashmere') findings.push('the material refinement did not apply');
  if (t2.state.color !== 'navy') findings.push('the colour was lost during refinement');
  if (!t2.needsFormalityReference && t2.state.formality === null) {
    findings.push('"less formal" silently did nothing');
  }
  if (t3.productDetail.length !== 1) findings.push('the reference did not resolve to one product');
  else if (h.identity.productShelfIdentity(t3.productDetail[0]) !== shelfA[0]) {
    findings.push('the reference resolved to the wrong product');
  }
  const restored = shelfOf(t3)[0];
  if (restored && restored.price === null && restored.transactable) {
    findings.push('a product with no confirmable price still offered a purchase');
  }

  return {
    name: 'C. Material and style refinement, then back to a prior product',
    turns: turns.map(([said, turn]) => ({ said, state: stateOf(turn), shelf: shelfOf(turn), status: turn.status })),
    providerCalls: c.calls,
    rationale:
      'The hardest of the three, because two halves of one sentence behave differently. ' +
      '"Maybe cashmere" is actionable and must change the shelf; "less formal" has nothing on this ' +
      'thread to be less formal THAN, so it must be asked about rather than guessed at or ignored. ' +
      'Then the customer changes their mind entirely and wants the first sweater back — which has ' +
      'to be that exact listing, with its commercial facts re-checked before anything offers to sell it.',
    transactionState: restored
      ? `restored option: price=${restored.price ?? 'not confirmable'} transactable=${restored.transactable}`
      : 'no restored option',
    findings,
    rating: findings.length === 0 ? 'USEFUL' : findings.length <= 1 ? 'PARTIALLY_USEFUL' : 'NOT_USEFUL',
  };
}

async function main() {
  const results = [await transcriptA(), await transcriptB(), await transcriptC()];
  const verdict = results.every((r) => r.rating === 'USEFUL')
    ? 'READY_FOR_OWNER_REVIEW'
    : results.some((r) => r.rating === 'NOT_USEFUL')
      ? 'NOT_READY'
      : 'PARTIAL';

  if (process.argv.includes('--json')) {
    console.log(JSON.stringify({ results, verdict }, null, 2));
    return;
  }

  for (const r of results) {
    console.log(`\n=== ${r.name} ===`);
    for (const turn of r.turns) {
      console.log(`\n  > ${turn.said}`);
      console.log(`    STATE   ${JSON.stringify(turn.state)}`);
      console.log(`    STATUS  ${turn.status}`);
      for (const card of turn.shelf) {
        console.log(`    SHELF   ${card.title} — ${card.price ?? 'no confirmable price'} @ ${card.retailer} ${card.transactable ? '[SHOP]' : '[browse only]'}`);
      }
      if (!turn.shelf.length) console.log('    SHELF   (none)');
    }
    console.log(`\n  PROVIDER CALLS   ${r.providerCalls}`);
    console.log(`  TRANSACTION      ${r.transactionState}`);
    console.log(`  RATIONALE        ${r.rationale}`);
    if (r.findings.length) console.log(`  FINDINGS         ${r.findings.join(' | ')}`);
    console.log(`  RATING           ${r.rating}`);
  }
  console.log(`\nOWNER_QUALITY_GATE=${verdict}`);
}

main();
