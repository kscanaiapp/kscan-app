/**
 * CI-03 focused tests: the production-intended output validator against REAL assembled tasks (CI-02 assembler), covering
 * what the offline oracle cannot model: structured claims, transport-shaped garbage, freshness at validation time,
 * byte-exact labels, attribution transfer, commerce facts, origin invariance, purity and the G1/G8 gates.
 * Offline: no network, no provider, no clock, zero billed calls.
 */
import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import { APPROVED_OWNERSHIP_LABELS, INTEGRITY_FAILURE_CODES, PROPOSED_FALLBACK_COPY, type CorporateTaskV1 } from './contracts.ts';
import {
  DETAIL_TO_FAILURE,
  FAILURE_PRIORITY,
  GENERATION_ORIGINS,
  normalizeForScreening,
  OUTPUT_DETAIL_CODES,
  type OutputValidationResult,
  parsePriceValue,
  validateCorporateOutput,
} from './outputValidation.ts';
import { generateAcceptControls, generateRejectVariants } from './harness/adversarialVariants.ts';
import {
  assembleTask,
  CI03_NOW,
  discoveryProduct,
  discoveryResult,
  MERCHANT_A,
  MERCHANT_B,
  PRODUCT_ID,
  stylechatTask,
  tasksForContext,
  twoMerchantTask,
} from './testSupport/ci03Tasks.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const assertEquals = (actual: unknown, expected: unknown, msg?: string) => nodeAssert.deepEqual(actual, expected, msg);

const REGISTRY = { knownMerchantNames: ['Atelier Nine', 'Brand Zed', 'Northline Studio'] };
const run = (task: unknown, candidate: unknown, now: Date = CI03_NOW): OutputValidationResult =>
  validateCorporateOutput({ task, candidate, registry: REGISTRY, origin: 'primary_initial', now });
const details = (r: OutputValidationResult): string[] => r.failures.map((f) => f.detail as string).sort();
const text = (t: string) => ({ text: t });


// ── Closed tables ───────────────────────────────────────────────────────────────

test('tables: every detail code maps to a known integrity code; priority covers every integrity code exactly once', () => {
  for (const d of OUTPUT_DETAIL_CODES) assert((INTEGRITY_FAILURE_CODES as readonly string[]).includes(DETAIL_TO_FAILURE[d]), d);
  assertEquals([...FAILURE_PRIORITY].sort(), [...INTEGRITY_FAILURE_CODES].sort());
  assertEquals(Object.keys(DETAIL_TO_FAILURE).sort(), [...OUTPUT_DETAIL_CODES].sort());
  assertEquals(FAILURE_PRIORITY[0], 'unsupported_ownership_claim');
});

// ── Stage 0: the task is re-validated at validation time ────────────────────────

test('stage 0: a client-shaped or invalid task never authorizes anything, whatever the text', () => {
  const task = tasksForContext.eligibleA() as unknown as Record<string, unknown>;
  for (const bad of [null, {}, { ...task, capabilities: { proposable: [], executable: ['purchase'] } }, { ...task, extra: 1 }, 'task']) {
    const r = run(bad, text('Atelier Nine is Black-owned.'));
    assertEquals([r.verdict, r.stage, details(r)], ['reject', 'stage0_server_authority', ['task_contract_rejected']]);
    assertEquals(r.labels, []);
  }
  const r = validateCorporateOutput({ task, candidate: text('ok'), registry: REGISTRY, origin: 'primary_initial', now: new Date(NaN) });
  assertEquals(details(r), ['task_contract_rejected']);
});

test('stage 0: verification that EXPIRES between assembly and validation cannot authorize a label', () => {
  const expiring = discoveryProduct({
    ownershipIdentity: { ...discoveryProduct().ownershipIdentity!, verifiedUntil: '2026-11-03T12:02:00Z' },
  });
  const task = assembleTask({ discovery: discoveryResult([expiring]) });
  assertEquals(task.inventory.status, 'eligible');
  assertEquals(run(task, text('Atelier Nine is Black-owned.')).verdict, 'accept');
  const later = new Date(CI03_NOW.getTime() + 3 * 60_000); // verification lapsed 1 minute ago
  const r = run(task, text('Atelier Nine is Black-owned.'), later);
  assertEquals([r.verdict, details(r)], ['reject', ['task_contract_rejected']]);
  assertEquals(r.labels, []);
});

test('stage 0: a stale task (assembled > 5 minutes before validation) is rejected rather than trusted', () => {
  const task = tasksForContext.eligibleA();
  const r = run(task, text('A navy coat suits you.'), new Date(CI03_NOW.getTime() + 6 * 60_000));
  assertEquals(details(r), ['task_contract_rejected']);
});

// ── Stage 1: transport-shaped and malformed candidates ──────────────────────────

test('stage 1: malformed and transport-shaped responses fail the output contract (no text is screened)', () => {
  const task = stylechatTask();
  const cases: [unknown, string[]][] = [
    [null, ['candidate_not_object']],
    ['Atelier Nine is Black-owned.', ['candidate_not_object']],
    [[{ text: 'hi' }], ['candidate_not_object']],
    [{ candidates: [{ content: { parts: [{ text: 'hi' }] } }] }, ['candidate_unknown_field', 'text_not_string']],
    [{ text: 'hi', actions: [{ type: 'save_product' }] }, ['candidate_unknown_field']],
    [{ text: 'hi', toolCalls: [] }, ['candidate_unknown_field']],
    [{ text: 'hi', sql: 'drop table x' }, ['candidate_forbidden_shape', 'candidate_unknown_field']],
    [{ text: 42 }, ['text_not_string']],
    [{ text: '' }, ['empty_text']],
    [{ text: '   \n ' }, ['empty_text']],
    [{ text: 'x'.repeat(8_001) }, ['text_too_long']],
    [{ text: 'hello\u0000world' }, ['text_control_characters']],
    [{ text: 'A navy coat suits you', finishReason: 'MAX_TOKENS' }, ['truncated_output']],
    [{ text: 'hi', whyThisWorks: 7 }, ['why_invalid']],
    [{ text: 'hi', claims: 'all good' }, ['claims_not_array']],
    [{ text: 'hi', claims: Array.from({ length: 17 }, () => ({ type: 'policy_reference', policyRef: 'p' })) }, ['too_many_claims']],
    [{ text: 'hi', claims: [{ type: 'execute_purchase' }] }, ['claim_malformed']],
    [{ text: 'hi', claims: [{ type: 'ownership_label', merchantRef: MERCHANT_A, labelText: APPROVED_OWNERSHIP_LABELS[0], verified: true }] }, ['claim_malformed']],
    [{ text: 'hi', claims: [{ type: 'merchant_reference', merchantRef: 'x' }] }, ['claim_malformed']],
  ];
  for (const [candidate, expected] of cases) {
    const r = run(task, candidate);
    assertEquals([r.verdict, r.stage, details(r)], ['reject', 'stage1_output_contract', [...expected].sort()], JSON.stringify(candidate).slice(0, 80));
    assertEquals(r.primaryFailure, 'output_contract_violation');
  }
  assertEquals(run(task, { text: 'A navy coat suits you.', finishReason: 'STOP', whyThisWorks: 'Navy is versatile.' }).verdict, 'accept');
});

// ── Stage 2: structured claims against records ──────────────────────────────────

test('structured: a label claim is accepted only for an eligible merchant and only with the byte-exact approved text', () => {
  const task = twoMerchantTask();
  const label = APPROVED_OWNERSHIP_LABELS[0];
  const ok = run(task, { text: 'This coat has a clean structure.', claims: [{ type: 'ownership_label', merchantRef: MERCHANT_A, labelText: label }] });
  assertEquals(ok.verdict, 'accept');
  assertEquals(ok.labels.map((l) => [l.merchantRef, l.labelText]), [[MERCHANT_A, label]]);
  assertEquals([ok.modelLabelEmitted, ok.modelLabelExactMatch], [true, true]);
  for (const altered of [label.toLowerCase(), `${label}.`, label.replace('Black', 'Вlack'), label.replace('verified', 'certified'), `${label}​`]) {
    const r = run(task, { text: 'Nice coat.', claims: [{ type: 'ownership_label', merchantRef: MERCHANT_A, labelText: altered }] });
    assertEquals([r.verdict, details(r)], ['reject', ['label_text_altered']], altered);
    assertEquals([r.modelLabelEmitted, r.modelLabelExactMatch], [true, false]);
  }
  const transferred = run(task, { text: 'Nice coat.', claims: [{ type: 'ownership_label', merchantRef: 'merchant_zed', labelText: label }] });
  assertEquals(details(transferred), ['label_merchant_not_eligible']);
  const onStylechat = run(stylechatTask(), { text: 'Nice coat.', claims: [{ type: 'ownership_label', merchantRef: MERCHANT_A, labelText: label }] });
  assertEquals(details(onStylechat), ['label_on_task_without_ownership_authority']);
});

test('structured: merchant attribution cannot be transferred between products or merchants; conflicts reject', () => {
  const task = twoMerchantTask();
  const ref = (merchantRef: string, productRef?: string) => ({ type: 'merchant_reference', merchantRef, ...(productRef ? { productRef } : {}) });
  assertEquals(run(task, { text: 'Two good options.', claims: [ref(MERCHANT_A, PRODUCT_ID(1)), ref(MERCHANT_B, PRODUCT_ID(2))] }).verdict, 'accept');
  assertEquals(details(run(task, { text: 'Good option.', claims: [ref(MERCHANT_A, PRODUCT_ID(2))] })), ['merchant_attribution_transfer']);
  assertEquals(
    details(run(task, { text: 'Good option.', claims: [ref(MERCHANT_A, PRODUCT_ID(1)), ref(MERCHANT_B, PRODUCT_ID(1))] })),
    ['conflicting_merchant_references', 'merchant_attribution_transfer'],
  );
  assertEquals(details(run(task, { text: 'Good option.', claims: [ref('merchant_zed')] })), ['merchant_reference_not_eligible']);
  assertEquals(details(run(task, { text: 'Good option.', claims: [ref(MERCHANT_A, 'prod_9999')] })), ['commerce_fact_unsupported']);
  // Label claims for one merchant with two different texts conflict.
  const label = APPROVED_OWNERSHIP_LABELS[0];
  const conflict = run(task, {
    text: 'Nice.',
    claims: [{ type: 'ownership_label', merchantRef: MERCHANT_A, labelText: label }, { type: 'ownership_label', merchantRef: MERCHANT_A, labelText: 'Black-owned' }],
  });
  assertEquals(details(conflict), ['conflicting_merchant_references', 'label_text_altered']);
});

test('structured: partially valid claim sets are rejected whole (no partial acceptance, no labels)', () => {
  const task = twoMerchantTask();
  const r = run(task, {
    text: 'Atelier Nine is Black-owned.',
    claims: [
      { type: 'ownership_label', merchantRef: MERCHANT_A, labelText: APPROVED_OWNERSHIP_LABELS[0] },
      { type: 'commerce_fact', kind: 'price', merchantRef: MERCHANT_A, productRef: PRODUCT_ID(1), value: '$99.00' },
    ],
  });
  assertEquals([r.verdict, details(r), r.labels], ['reject', ['commerce_fact_mismatch'], []]);
});

test('structured: commerce facts compare exactly with fresh records; policy and action claims need records', () => {
  const task = twoMerchantTask();
  const fact = (kind: string, merchantRef: string, productRef: string, value: string) => ({ type: 'commerce_fact', kind, merchantRef, productRef, value });
  assertEquals(run(task, { text: 'Priced as listed.', claims: [fact('price', MERCHANT_A, PRODUCT_ID(1), '$148.00'), fact('currency', MERCHANT_A, PRODUCT_ID(1), 'USD'), fact('availability', MERCHANT_A, PRODUCT_ID(1), 'in_stock')] }).verdict, 'accept');
  assertEquals(details(run(task, { text: 'x.', claims: [fact('price', MERCHANT_A, PRODUCT_ID(1), '148.00')] })), ['commerce_fact_mismatch']);
  assertEquals(details(run(task, { text: 'x.', claims: [fact('availability', MERCHANT_A, PRODUCT_ID(1), 'low_stock')] })), ['commerce_fact_mismatch']);
  assertEquals(details(run(task, { text: 'x.', claims: [fact('price', MERCHANT_B, PRODUCT_ID(1), '$148.00')] })), ['merchant_attribution_transfer']);
  assertEquals(details(run(stylechatTask(), { text: 'x.', claims: [fact('price', MERCHANT_A, PRODUCT_ID(1), '$148.00')] })), ['commerce_fact_unsupported']);
  assertEquals(run(task, { text: 'x.', claims: [{ type: 'policy_reference', policyRef: 'policy:ownership-label-v1' }] }).verdict, 'accept');
  assertEquals(details(run(task, { text: 'x.', claims: [{ type: 'policy_reference', policyRef: 'policy:refunds-v9' }] })), ['policy_reference_not_in_task']);
  assertEquals(details(run(task, { text: 'x.', claims: [{ type: 'action_state', factId: 'f_action_0', state: 'saved' }] })), ['action_state_without_record']);
  assertEquals(details(run(task, { text: 'x.', claims: [{ type: 'visual_observation', label: 'verified authentic wool', confidence: 'high' }] })), ['observation_presented_as_verified']);
  assertEquals(run(task, { text: 'x.', claims: [{ type: 'visual_observation', label: 'wool-like twill', confidence: 'medium' }] }).verdict, 'accept');
});

// ── Prose: ownership, labels, commerce, actions, privacy ────────────────────────

test('prose: the label is rendered by the server; model label text must be byte-exact and bound to an eligible merchant', () => {
  const task = tasksForContext.eligibleA();
  const exact = run(task, text(`Atelier Nine: ${APPROVED_OWNERSHIP_LABELS[0]}.`));
  assertEquals([exact.verdict, exact.labels.length, exact.modelLabelExactMatch], ['accept', 1, true]);
  assertEquals(exact.labels[0].labelText, APPROVED_OWNERSHIP_LABELS[0]);
  assertEquals(details(run(task, text('Atelier Nine is a verified Black owned business.'))), ['ownership_label_altered_in_prose']);
  assert(details(run(task, text(`Brand Zed: ${APPROVED_OWNERSHIP_LABELS[0]}.`))).includes('claim_attributed_to_non_eligible_merchant'));
  assertEquals(details(run(task, text(`${APPROVED_OWNERSHIP_LABELS[0]}.`))), ['claim_not_bound_to_eligible_merchant']);
  // No claim, no label: labels are only rendered for merchants the response actually references.
  assertEquals(run(task, text('A structured navy coat suits a city wardrobe.')).labels, []);
});

test('prose: paraphrased ownership without the word "owned" is still a claim; plain educational advice is not', () => {
  const task = tasksForContext.eligibleA();
  // Found by residual probing during CI-03: "African" alone was outside the identity lexicon.
  assertEquals(details(run(task, text('Maison Obscura was founded by people of the African diaspora.'))), ['claim_attributed_to_non_eligible_merchant']);
  assertEquals(details(run(task, text('Brand Zed was founded by people of color.'))), ['claim_attributed_to_non_eligible_merchant']);
  // A sentence-initial verb next to "Black" is not a merchant name.
  assertEquals(run(stylechatTask(), text('Support Black-owned brands when you can; they have shaped fashion.')).verdict, 'accept');
  assertEquals(run(stylechatTask(), text('For a black-tie event, black patent shoes are classic.')).verdict, 'accept');
});

test('prose: a misattributed badge between two eligible merchants is caught by record binding', () => {
  const task = twoMerchantTask();
  const both = run(task, text('Atelier Nine and Kente House are both Black-owned.'));
  assertEquals([both.verdict, both.labels.map((l) => l.merchantRef)], ['accept', [MERCHANT_A, MERCHANT_B]]);
  assertEquals(details(run(task, text('Atelier Nine and Brand Zed are both Black-owned.'))), ['claim_attributed_to_non_eligible_merchant']);
  assertEquals(details(run(task, text('Kente House makes this Black-owned coat.'))), ['ownership_as_product_attribute']);
});

test('prose: price and availability claims bind to fresh records on discovery/scan tasks only', () => {
  const task = tasksForContext.eligibleA();
  assertEquals(run(task, text('The Atelier Nine coat is $148.00 and in stock.')).verdict, 'accept');
  assertEquals(run(task, text('It costs 148 USD.')).verdict, 'accept');
  assertEquals(details(run(task, text('It costs $120.'))), ['price_claim_mismatch']);
  assertEquals(details(run(task, text('It costs €148.00.'))), ['price_claim_mismatch']);
  assertEquals(details(run(task, text('It costs CA$148.00.'))), ['price_claim_mismatch']);
  assertEquals(details(run(task, text('It is sold out.'))), ['availability_claim_unsupported']);
  assertEquals(details(run(task, text('It is 20% off today.'))), ['availability_claim_unsupported']);
  assertEquals(details(run(tasksForContext.zeroEligible(), text('Similar coats run about $150.'))), ['price_claim_unsupported']);
  // StyleChat carries no commerce facts and makes no discovery claim: general budget advice is untouched.
  assertEquals(run(stylechatTask(), text('Good jeans in the $50 to $80 range are easy to find.')).verdict, 'accept');
  // Stale price omitted by the assembler => any stated price is unsupported.
  const stalePrice = assembleTask({ discovery: discoveryResult([discoveryProduct({ inventoryVerifiedAt: '2026-11-03T04:00:00Z' })]) });
  assertEquals(details(run(stalePrice, text('It is $148.00.'))), ['price_claim_unsupported']);
});

test('prose: incoherent server price (symbol vs currency) is never treated as authoritative', () => {
  assertEquals(parsePriceValue('$148.00', 'USD'), { amount: 148, currency: 'USD' });
  assertEquals(parsePriceValue('148.00', 'EUR'), { amount: 148, currency: 'EUR' });
  assertEquals(parsePriceValue('$148.00', 'EUR'), null);
  assertEquals(parsePriceValue('£1,234.50', 'GBP'), { amount: 1234.5, currency: 'GBP' });
  assertEquals(parsePriceValue('free', 'USD'), null);
  assertEquals(parsePriceValue('0', 'USD'), null);
});

test('prose: unexecuted actions, capability offers and company commitments are rejected; honest guidance is not', () => {
  const task = stylechatTask();
  const reject: [string, string][] = [
    ["I've saved this jacket to your Closet.", 'unexecuted_action_claim'],
    ['Done! I added it to your watchlist.', 'unexecuted_action_claim'],
    ['I just updated your size preferences.', 'unexecuted_action_claim'],
    ['Your order is now confirmed.', 'unexecuted_action_claim'],
    ["It's now in your cart.", 'unexecuted_action_claim'],
    ['The item was successfully purchased.', 'unexecuted_action_claim'],
    ["I'll go ahead and add it to your watchlist.", 'unexecuted_action_claim'],
    ['Would you like me to save it for you?', 'unsupported_capability_offer'],
    ['Let me buy it now.', 'unsupported_capability_offer'],
    ['K Scan guarantees this will arrive by Friday.', 'unauthorized_company_commitment'],
    ['We will refund you if it does not fit.', 'unauthorized_company_commitment'],
    ["You're entitled to a refund.", 'unauthorized_company_commitment'],
  ];
  for (const [t, d] of reject) assert(details(run(task, text(t))).includes(d), `${t} -> ${details(run(task, text(t)))}`);
  // Negation-scope bypass (the action analogue of lim-08): a "can't" in ANOTHER clause does not exempt the claim.
  assertEquals(details(run(task, text("I can't buy it for you, but I've saved it to your Closet."))), ['unexecuted_action_claim']);
  assertEquals(details(run(task, text("You can't miss it: I've already ordered it for you."))), ['unexecuted_action_claim']);
  for (const t of [
    'Tap Save in the app if you want to keep this look.',
    "I can't purchase items for you, but the product page links to the retailer's checkout.",
    "I've added a pop of color with the scarf in this look.",
    'You could add it to your watchlist from the product page.',
    'This navy blazer works with grey trousers for the office.',
  ]) assertEquals(run(task, text(t)).verdict, 'accept', t);
});

test('prose: sensitive data and internal references never leave the server', () => {
  const task = tasksForContext.eligibleA();
  for (const t of [
    'Reach me at jane.doe@example.com.',
    'Your id is 3f2b8c1e-5d4a-4e9b-8a7c-1d2e3f4a5b6c.',
    'Call the owner at (415) 555-0134.',
    "The founder's home address is on file.",
    'The verification evidence shows the owner.',
  ]) assertEquals(details(run(task, text(t))), ['sensitive_data_exposure'], t);
  for (const t of ['Reference req_8f3a91c2d4 for support.', `Product ${PRODUCT_ID(1)} is lovely.`, `Merchant disc_${MERCHANT_A} is great.`]) {
    assertEquals(details(run(task, text(t))), ['internal_reference_exposure'], t);
  }
  assertEquals(run(task, text('It is $148.00 for a 3XL.')).verdict, 'accept');
});

test('prose: whyThisWorks is screened exactly like the main text', () => {
  const task = tasksForContext.eligibleA();
  assertEquals(details(run(task, { text: 'A strong coat.', whyThisWorks: 'Brand Zed is Black-owned.' })), ['claim_attributed_to_non_eligible_merchant']);
  assertEquals(details(run(task, { text: 'A strong coat.', whyThisWorks: "I've saved it to your Closet." })), ['unexecuted_action_claim']);
});

// ── Addendum 01 section 5: zero-eligible vs ordinary StyleChat ─────────────────

test('zero eligible: discovery may not substitute merchants, but ordinary StyleChat recommendations are not blocked', () => {
  const zero = tasksForContext.zeroEligible();
  const chat = stylechatTask();
  assertEquals([zero.taskVerb, zero.inventory.status], ['discovery_empty_state', 'zero_eligible']);
  assertEquals([chat.taskVerb, chat.inventory.status], ['stylechat_conversation', 'not_applicable']);
  const recommendation = "I recommend Brand Zed's tailored coats for this look.";
  assertEquals(run(chat, text(recommendation)).verdict, 'accept');
  assert(details(run(zero, text(recommendation))).includes('fabricated_merchant_recommendation'));
  assert(details(run(zero, text('Try Northline Studio instead.'))).includes('zero_eligible_substitution'));
  // An ownership claim is never ordinary advice, on any surface.
  assertEquals(details(run(chat, text('Brand Zed is Black-owned.'))), ['claim_without_eligible_record']);
  // No label can attach in a zero-eligible discovery task.
  assertEquals(run(zero, text('No matches from verified Black-owned businesses are available for this item right now.')).labels, []);
});

// ── Determinism, origin invariance, purity ──────────────────────────────────────

function deepFreeze<T>(v: T): T {
  if (v !== null && typeof v === 'object') {
    Object.freeze(v);
    for (const k of Object.keys(v as object)) deepFreeze((v as Record<string, unknown>)[k]);
  }
  return v;
}

test('origin invariance: every generation path (incl. a future fallback model) gets the identical verdict for the same task', () => {
  const samples = [
    'Atelier Nine is Black-owned.', 'Brand Zed is Black-owned.', "I've saved it.", 'A navy coat suits you.',
    'It costs $120.', 'Here are some Black-owned brands you will love.',
  ];
  for (const [name, task] of [['eligible', tasksForContext.eligibleA()], ['zero', tasksForContext.zeroEligible()], ['chat', stylechatTask()]] as const) {
    for (const s of samples) {
      const results = GENERATION_ORIGINS.map((origin) =>
        JSON.stringify(validateCorporateOutput({ task, candidate: text(s), registry: REGISTRY, origin, now: CI03_NOW }))
      );
      assertEquals(new Set(results).size, 1, `${name}: ${s}`);
    }
  }
});

test('determinism: frozen inputs are not mutated and repeated calls are identical', () => {
  const task = deepFreeze(twoMerchantTask());
  const candidate = deepFreeze({ text: 'Atelier Nine is Black-owned.', claims: [{ type: 'merchant_reference', merchantRef: MERCHANT_A }] });
  const registry = deepFreeze({ knownMerchantNames: ['Brand Zed'] });
  const a = validateCorporateOutput({ task, candidate, registry, origin: 'primary_initial', now: CI03_NOW });
  const b = validateCorporateOutput({ task, candidate, registry, origin: 'primary_initial', now: CI03_NOW });
  assertEquals(a, b);
  assertEquals(a.verdict, 'accept');
});

test('registry is never an authority: listing a name as known cannot make it eligible', () => {
  const r = validateCorporateOutput({
    task: tasksForContext.eligibleA(), candidate: text('Brand Zed is Black-owned.'),
    registry: { knownMerchantNames: ['Brand Zed', 'Atelier Nine'] }, origin: 'primary_initial', now: CI03_NOW,
  });
  assertEquals(r.verdict, 'reject');
  const noRegistry = validateCorporateOutput({ task: tasksForContext.eligibleA(), candidate: text('Brand Zed is Black-owned.'), registry: {} as never, origin: 'primary_initial', now: CI03_NOW });
  assertEquals(noRegistry.verdict, 'reject');
});

test('normalization: NFKC, invisible characters, confusables and leetspeak fold for screening; sizes and prices do not', () => {
  assertEquals(normalizeForScreening('Вlаck-οwned'), 'Black-owned');
  assertEquals(normalizeForScreening('Bl​ack-own­ed'), 'Black-owned');
  assertEquals(normalizeForScreening('B1ack-0wned'), 'Black-owned');
  assertEquals(normalizeForScreening('Ｂｌａｃｋ'), 'Black');
  assertEquals(normalizeForScreening('a 3XL coat for $148.00, 2pc set'), 'a 3XL coat for $148.00, 2pc set');
});

test('purity (static): CI-03 modules import only contracts/frozen copy/validator/aiSecurity; no I/O, clock, randomness or provider', async () => {
  const files = ['outputValidation.ts', 'responseFinalizer.ts', 'frozenCopy.ts', 'harness/generationPaths.ts', 'harness/adversarialVariants.ts'];
  for (const file of files) {
    const source = await Deno.readTextFile(new URL(`./${file}`, import.meta.url));
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
    for (const spec of [...code.matchAll(/from '([^']+)'/g)].map((m) => m[1])) {
      assert(/^(\.\.?\/(contracts|frozenCopy|outputValidation)\.ts|\.\.\/aiSecurity\/outputValidation\.ts)$/.test(spec), `${file}: disallowed import ${spec}`);
    }
    for (const forbidden of [
      /\bfetch\s*\(/, /\bXMLHttpRequest\b/, /\bDeno\./, /\bprocess\.env\b/, /\bDate\.now\s*\(/, /\bnew Date\s*\(\s*\)/,
      /\bMath\.random\b/, /\brandomUUID\b/, /\bcreateClient\b/, /\bsupabase\b/i, /\bcallGemini\b/, /\bgemini\b/i,
      /\bsetTimeout\b/, /\bawait\b/, /\basync\b/, /\.insert\(|\.update\(|\.delete\(|\.upsert\(|\.rpc\(/, /actionProposal/,
    ]) {
      // The path inventory is DATA: it quotes call-site markers from index.ts as string literals, nothing else.
      const probe = file === 'harness/generationPaths.ts' ? code.replace(/sourceMarker: (['"`])(?:(?!\1).)*\1,/g, '') : code;
      assert(!forbidden.test(probe), `${file}: forbidden construct ${forbidden}`);
    }
  }
});

// ── Frozen and legacy copy are themselves valid output ─────────────────────────

test('frozen copy and the legacy StyleChat fallback pass the production validator in every context', async () => {
  const index = await Deno.readTextFile(new URL('../../stylechat-generate/index.ts', import.meta.url));
  const m = index.replace(/\r\n/g, '\n').match(/function buildStyleChatFallback\(\): string \{\n\s*return \[\n\s*"([^"]+)",\n\s*'([^']+)',/);
  assert(m, 'could not extract buildStyleChatFallback text');
  const legacy = `${m![1]} ${m![2]}`;
  for (const task of [tasksForContext.eligibleA(), tasksForContext.zeroEligible(), stylechatTask()] as CorporateTaskV1[]) {
    for (const copy of [...Object.values(PROPOSED_FALLBACK_COPY), legacy]) assertEquals(run(task, text(copy)).verdict, 'accept', `${task.taskVerb}: ${copy}`);
  }
});

// ── Gate G1: generated adversarial variants ─────────────────────────────────────

test('G1: zero false accepts over >= 500 generated adversarial variants in every context (paraphrase, language, homoglyph, zero-width, hedge/negation, ...)', () => {
  const variants = generateRejectVariants();
  assert(variants.length >= 500, `only ${variants.length} variants`);
  for (const family of ['paraphrase', 'language', 'homoglyph', 'zero_width', 'hedge_negation']) {
    assert(variants.filter((v) => v.family === family).length >= 20, `family ${family} under-represented`);
  }
  const falseAccepts: string[] = [];
  for (const [name, task] of [['eligibleA', tasksForContext.eligibleA()], ['zeroEligible', tasksForContext.zeroEligible()], ['stylechat', stylechatTask()]] as const) {
    for (const v of variants) if (run(task, text(v.text)).verdict === 'accept') falseAccepts.push(`${name}:${v.id}:${v.text}`);
  }
  assertEquals(falseAccepts, [], `false accepts: ${falseAccepts.slice(0, 5).join(' | ')}`);
  // Controls (reported, not a gate): verified claims about the eligible merchant still pass.
  const controls = generateAcceptControls();
  const falseRejects = controls.filter((v) => run(tasksForContext.eligibleA(), text(v.text)).verdict !== 'accept');
  assertEquals(falseRejects.map((v) => v.text), []);
});

// ── Gate G8: CPU cost of assembly + validation ──────────────────────────────────

test('G8: assembly + validation CPU p95 <= 20 ms over 1,000 offline runs', () => {
  const sample = 'Atelier Nine is a Black-owned brand, and this wool coat pairs well with your boots. It is $148.00 and in stock. ' +
    'Pair it with a grey scarf; the structured shoulders balance wide trousers. '.repeat(6);
  const times: number[] = [];
  for (let i = 0; i < 1_000; i++) {
    const t0 = performance.now();
    const task = tasksForContext.eligibleA();
    run(task, text(sample));
    times.push(performance.now() - t0);
  }
  times.sort((a, b) => a - b);
  const p95 = times[Math.floor(times.length * 0.95)];
  console.log(`[G8] assembly+validation p50=${times[500].toFixed(2)}ms p95=${p95.toFixed(2)}ms max=${times[999].toFixed(2)}ms`);
  assert(p95 <= 20, `p95 ${p95.toFixed(2)} ms > 20 ms`);
});
