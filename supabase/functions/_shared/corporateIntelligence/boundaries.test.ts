/**
 * CI-01 boundary tests: Option B isolation, empty executor type, trust-tier mapping, discovery contract binding,
 * and tripwires that pin the Build 35 StyleChat baseline (9047ce43) so Corporate v2 cannot drift it silently.
 * Offline: no network, no provider, no Supabase.
 */
import nodeAssert from 'node:assert/strict';
import test from 'node:test';
import { TRUST_FOR_SECTION } from '../aiSecurity/trustTypes.ts';
import { stripUnsafeModelOutput } from '../../stylechat-generate/promptHardening.ts';
import { buildStylistPersonaBlock } from '../../stylechat-generate/stylistIdentity.ts';
import { ELISE_BRAND_VOICE_SYSTEM_BLOCK, appendEliseBrandVoice } from '../../stylechat-generate/eliseBrandVoice.ts';
import {
  CORPORATE_TASK_CONTRACT_VERSION,
  INTEGRITY_FAILURE_CODES,
  PROPOSED_FALLBACK_COPY,
  selectFallback,
  TASK_VERB_POLICY,
  TASK_VERBS,
  TIER_APPLICATION_AUTHORITY,
  TOKEN_BUDGET_TARGETS,
  TRUST_TIERS,
  TRUST_TIER_TO_AI_CONTENT_TRUST,
  validateCorporateTaskV1,
  type CorporateTaskV1,
} from './contracts.ts';
import { checkOwnershipClaimsReference } from './testSupport/referenceOracle.ts';
import { baseValidTask } from './testSupport/baseTask.ts';

const assert = (cond: unknown, msg?: string) => nodeAssert.ok(cond, msg);
const here = new URL('.', import.meta.url);
const functionsRoot = new URL('../../', import.meta.url);
const read = (rel: string, base: URL = functionsRoot) => Deno.readTextFile(new URL(rel, base));
const norm = (s: string) => s.replace(/\r\n/g, '\n');
async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(norm(text)));
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

async function* walk(dir: URL): AsyncGenerator<URL> {
  for await (const entry of Deno.readDir(dir)) {
    if (entry.name === 'node_modules') continue;
    const child = new URL(entry.name + (entry.isDirectory ? '/' : ''), dir);
    if (entry.isDirectory) yield* walk(child);
    else if (entry.name.endsWith('.ts')) yield child;
  }
}

// ── Option B isolation ──────────────────────────────────────────────────────────

test('Option B: no Edge Function or other shared module imports corporateIntelligence (no runtime wiring before the gate)', async () => {
  const offenders: string[] = [];
  for await (const file of walk(functionsRoot)) {
    if (file.pathname.includes('/_shared/corporateIntelligence/')) continue;
    if (/corporateIntelligence/.test(await Deno.readTextFile(file))) offenders.push(file.pathname);
  }
  nodeAssert.deepEqual(offenders, [], `runtime wiring is not authorized: ${offenders.join(', ')}`);
});

test('Option B: the action-proposal module is imported only by tests', async () => {
  const importers: string[] = [];
  for await (const file of walk(here)) {
    if (file.pathname.endsWith('/actionProposal.ts') || file.pathname.endsWith('.test.ts')) continue;
    if (/actionProposal/.test(await Deno.readTextFile(file))) importers.push(file.pathname);
  }
  nodeAssert.deepEqual(importers, []);
});

test('Option B: executor and proposable capability types are empty at the type level and rejected at runtime', async () => {
  const source = await read('contracts.ts', here);
  assert(/export type NoCapabilities = readonly never\[\];/.test(source));
  assert(/capabilities: \{ proposable: NoCapabilities; executable: NoCapabilities \};/.test(source));
  assert(/actionContractRef: null;/.test(source));

  // Compile-time enforcement (active under `deno check`): a non-empty literal must not type-check.
  // @ts-expect-error -- executable capabilities are not representable in the Option B contract
  const impossible: CorporateTaskV1['capabilities'] = { proposable: [], executable: ['purchase'] };
  void impossible;

  const mutated = baseValidTask() as any;
  mutated.capabilities.executable = ['purchase'];
  const result = validateCorporateTaskV1(mutated, new Date('2026-11-03T12:00:00Z'));
  nodeAssert.equal(result.ok, false);
});

test('contract: version string and task-verb policy table are complete and closed', () => {
  nodeAssert.equal(CORPORATE_TASK_CONTRACT_VERSION, 'corporate-task-v1');
  nodeAssert.deepEqual(Object.keys(TASK_VERB_POLICY).sort(), [...TASK_VERBS].sort());
  for (const verb of TASK_VERBS) {
    assert(TASK_VERB_POLICY[verb].registers.length >= 1);
  }
  // service_recovery is reachable from exactly one verb, and only the error register is allowed there.
  const recoveryVerbs = TASK_VERBS.filter((v) => TASK_VERB_POLICY[v].mode === 'service_recovery');
  nodeAssert.deepEqual(recoveryVerbs, ['grounded_error_recovery']);
  nodeAssert.deepEqual(TASK_VERB_POLICY.grounded_error_recovery.registers, ['error_status_notice']);
  assert(Object.isFrozen(TASK_VERB_POLICY));
  assert(TOKEN_BUDGET_TARGETS.staticMax + TOKEN_BUDGET_TARGETS.dynamicMax === TOKEN_BUDGET_TARGETS.totalMax);
});

// ── Provenance mapping onto the existing aiSecurity vocabulary ──────────────────

test('trust tiers: map onto existing AIContentTrust; only system_policy may carry application authority', () => {
  nodeAssert.deepEqual([...TRUST_TIERS].sort(), ['system_policy', 'untrusted_text', 'user_message', 'verified_db_record']);
  nodeAssert.deepEqual(TRUST_TIER_TO_AI_CONTENT_TRUST.system_policy, ['trusted_system']);
  nodeAssert.deepEqual(TRUST_TIER_TO_AI_CONTENT_TRUST.verified_db_record, ['trusted_server_context']);
  nodeAssert.deepEqual(TRUST_TIER_TO_AI_CONTENT_TRUST.user_message, ['untrusted_user']);
  assert(TRUST_TIER_TO_AI_CONTENT_TRUST.untrusted_text.every((t) => t.startsWith('untrusted_')));
  nodeAssert.equal(TIER_APPLICATION_AUTHORITY.system_policy, 'within_security_hierarchy');
  nodeAssert.equal(TIER_APPLICATION_AUTHORITY.verified_db_record, 'factual_only');
  nodeAssert.equal(TIER_APPLICATION_AUTHORITY.user_message, 'none');
  nodeAssert.equal(TIER_APPLICATION_AUTHORITY.untrusted_text, 'none');
  // Existing section->trust assignments stay consistent with the corporate tiers.
  assert(TRUST_TIER_TO_AI_CONTENT_TRUST.untrusted_text.includes(TRUST_FOR_SECTION.commerce_context));
  assert(TRUST_TIER_TO_AI_CONTENT_TRUST.untrusted_text.includes(TRUST_FOR_SECTION.retrieved_context));
  assert(TRUST_TIER_TO_AI_CONTENT_TRUST.user_message.includes(TRUST_FOR_SECTION.user_input));
});

// ── Binding to the independently-owned Black-owned discovery contract ───────────

test('discovery binding: ownership identity shape and eligibility controls are still what Corporate v2 assumes', async () => {
  const contracts = await read('black-owned-discovery/contracts.ts');
  assert(/ownershipVerificationStatus: 'verified';/.test(contracts));
  assert(/publicOwnershipLabelAllowed: true;/.test(contracts));
  assert(/verifiedUntil: string;/.test(contracts));
  assert(/export type OwnershipIdentity = \{/.test(contracts));
  const engine = await read('black-owned-discovery/engine.ts');
  // Fresh purchasable product + active merchant verification are enforced by the discovery service itself.
  assert(/row\.availability !== 'in_stock'/.test(engine));
  assert(/Date\.parse\(row\.verified_until\) <= now/.test(engine));
  assert(/Date\.parse\(row\.expires_at\) <= now/.test(engine));
  // StyleChat does not receive discovery/ownership records today (so v2 must ADD an authority path, not assume one).
  const stylechat = await read('stylechat-generate/index.ts');
  assert(!/ownershipIdentity|publicOwnershipLabelAllowed|black-owned-discovery/i.test(stylechat));
});

// ── Build 35 StyleChat baseline tripwires (pinned at 9047ce43) ──────────────────

function extract(source: string, re: RegExp, name: string): string {
  const m = norm(source).match(re);
  if (!m) throw new Error(`could not extract ${name} from index.ts (baseline drift - update inventory deliberately)`);
  return m[1];
}

test('baseline: StyleChat Gemini call-site inventory is unchanged (parity guard)', async () => {
  const index = await read('stylechat-generate/index.ts');
  // initial (via callGeminiWithOptionalRetry), provider-retry, completeness retry
  nodeAssert.equal((index.match(/await callGemini\(/g) ?? []).length, 3);
  // Both bodies are built from the SAME assembled system text (primary/retry prompt parity by construction).
  nodeAssert.equal((index.match(/buildGeminiBody\(systemTextWithAttachments/g) ?? []).length, 2);
  nodeAssert.equal((index.match(/appendEliseBrandVoice\(/g) ?? []).length, 1);
  // FINDING F1: the configured fallback model is never invoked in this function. If someone wires a provider
  // fallback, this fails on purpose: the new path must receive the same task brief, validation and consent controls.
  assert(!/fallbackModelName|isDirectFallbackFailure|isRepairableFailure/.test(index),
    'a provider fallback appears to have been wired into stylechat-generate; update the inventory and add parity tests');
});

test('baseline: legacy prompt constituents are byte-pinned (flag-OFF identity tripwire)', async () => {
  const index = await read('stylechat-generate/index.ts');
  const golden = JSON.parse(await read('fixtures/legacy-baseline-golden.json', here));
  const actual = {
    SYSTEM_PROMPT: await sha256(extract(index, /const SYSTEM_PROMPT = `([\s\S]*?)`\n/, 'SYSTEM_PROMPT')),
    EXPLANATION_INSTRUCTIONS: await sha256(extract(index, /const EXPLANATION_INSTRUCTIONS = `([\s\S]*?)`;/, 'EXPLANATION_INSTRUCTIONS')),
    ATTACHMENT_INSTRUCTIONS: await sha256(extract(index, /const ATTACHMENT_INSTRUCTIONS = `([\s\S]*?)`\n/, 'ATTACHMENT_INSTRUCTIONS')),
    ELISE_BRAND_VOICE_SYSTEM_BLOCK: await sha256(ELISE_BRAND_VOICE_SYSTEM_BLOCK),
    STYLIST_PERSONA_BLOCK_ELISE: await sha256(buildStylistPersonaBlock('Elise')),
  };
  nodeAssert.deepEqual(actual, golden.sha256, `legacy prompt drift; actual=${JSON.stringify(actual, null, 2)}`);
  nodeAssert.equal(golden.baselineSha, '9047ce434e16a7b52f1f45edaeebafc2f1800757');
});

test('baseline: appendEliseBrandVoice(base, false) returns the base unchanged for any base', () => {
  const realLog = console.log;
  console.log = () => {};
  try {
    for (const base of ['', 'x', 'Original system constraints\n\nApproved explanation instructions', 'é\r\n\u0000']) {
      nodeAssert.equal(appendEliseBrandVoice(base, false), base);
      nodeAssert.equal(appendEliseBrandVoice(base, undefined as unknown as boolean), base);
    }
  } finally {
    console.log = realLog;
  }
});

// ── Deterministic copy must survive the legacy output sanitizer ─────────────────

// Product/Legal wording is PENDING; the strings under test are the Management Checkpoint 1 proposal.
const PROPOSED_COPY: Record<string, string> = { ...PROPOSED_FALLBACK_COPY };

test('deterministic copy: exact wording specified by Management Checkpoint 1 (changes need a reviewed diff)', () => {
  nodeAssert.equal(PROPOSED_FALLBACK_COPY.zero_eligible, 'No matches from verified Black-owned businesses are available for this item right now.');
  nodeAssert.equal(
    PROPOSED_FALLBACK_COPY.ownership_integrity_failure,
    "I can't confirm that business's ownership from its name or product images. K Scan only labels businesses that meet its verification requirements.",
  );
  nodeAssert.equal(PROPOSED_FALLBACK_COPY.generic_integrity_failure, "I wasn't able to complete that response. Please try again.");
  nodeAssert.deepEqual(Object.keys(PROPOSED_FALLBACK_COPY).sort(), ['generic_integrity_failure', 'ownership_integrity_failure', 'zero_eligible']);
});

test('deterministic copy: unchanged by the legacy stripUnsafeModelOutput (defect D-1 would otherwise corrupt it)', () => {
  for (const [key, copy] of Object.entries(PROPOSED_COPY)) {
    nodeAssert.equal(stripUnsafeModelOutput(copy), copy, `${key} is altered by the legacy sanitizer`);
  }
});

test('deterministic copy: itself passes the ownership-claim oracle under zero-eligible and eligible contexts', () => {
  const zero = { eligible: [], knownBrands: ['Atelier Nine', 'Brand Zed'] };
  const eligible = { eligible: [{ merchantRef: 'm', brandName: 'Atelier Nine' }], knownBrands: ['Atelier Nine', 'Brand Zed'] };
  for (const copy of Object.values(PROPOSED_COPY)) {
    nodeAssert.equal(checkOwnershipClaimsReference(copy, zero).verdict, 'accept', copy);
    nodeAssert.equal(checkOwnershipClaimsReference(copy, eligible).verdict, 'accept', copy);
  }
});

test('deterministic copy: no unsupported buttons, filters or next steps; never implies verified results exist', () => {
  // The app has no filter/browse/adjust affordance wired to these notices, so none may be promised.
  const NEXT_STEP = /\b(?:tap|click|press|select|filter|browse|adjust|refine|explore|see (?:more|all)|view (?:more|all)|search again|button|menu|link|below|above|here (?:are|is)|we found|i found|alternatives?|similar)\b/i;
  for (const [key, copy] of Object.entries(PROPOSED_COPY)) {
    nodeAssert.ok(!NEXT_STEP.test(copy), `${key} promises a control, filter or next step: ${copy}`);
  }
  // The only instruction permitted anywhere is the generic retry in the generic failure notice.
  nodeAssert.ok(!/try/i.test(PROPOSED_FALLBACK_COPY.zero_eligible));
  nodeAssert.ok(!/try/i.test(PROPOSED_FALLBACK_COPY.ownership_integrity_failure));
  // Zero-eligible copy is a negative statement: it must not read as a positive ownership claim or a result list.
  nodeAssert.ok(/^No matches\b/.test(PROPOSED_FALLBACK_COPY.zero_eligible));
  // Ownership-integrity copy neither asserts nor denies ownership of any named business.
  nodeAssert.ok(!/\bis (?:not )?(?:black|verified)/i.test(PROPOSED_FALLBACK_COPY.ownership_integrity_failure));
});

test('fallback policy: every integrity failure maps to approved copy and never to another generation', () => {
  const statuses = ['not_applicable', 'eligible', 'zero_eligible'] as const;
  for (const code of INTEGRITY_FAILURE_CODES) {
    for (const status of statuses) {
      const fb = selectFallback(code, status);
      nodeAssert.equal(fb.regenerate, false, `${code}/${status} must not trigger repair generation`);
      nodeAssert.ok(fb.copyKey in PROPOSED_FALLBACK_COPY, `${code}/${status} -> unknown copy key ${fb.copyKey}`);
    }
  }
  nodeAssert.equal(selectFallback('unsupported_ownership_claim', 'eligible').copyKey, 'ownership_integrity_failure');
  nodeAssert.equal(selectFallback('unsupported_ownership_claim', 'zero_eligible').copyKey, 'ownership_integrity_failure');
  nodeAssert.equal(selectFallback('fabricated_merchant_recommendation', 'zero_eligible').copyKey, 'zero_eligible');
  nodeAssert.equal(selectFallback('fabricated_merchant_recommendation', 'eligible').copyKey, 'generic_integrity_failure');
  nodeAssert.equal(selectFallback('unexecuted_action_claim', 'zero_eligible').copyKey, 'generic_integrity_failure');
  nodeAssert.equal(selectFallback('sensitive_data_exposure', 'eligible').copyKey, 'generic_integrity_failure');
});

// ── Draft Employee Contract size gate (spec section 7 design target) ────────────

test('charter: draft Employee Contract block fits the static token target (estimate = chars / 4)', async () => {
  const doc = await Deno.readTextFile(
    new URL('../../../../docs/build36/corporate-intelligence-v2/CI-V2-PHASE1-CORPORATE-CHARTER.md', import.meta.url),
  );
  const m = norm(doc).match(/<!-- EMPLOYEE_CONTRACT_DRAFT_START -->\n```text\n([\s\S]*?)\n```\n<!-- EMPLOYEE_CONTRACT_DRAFT_END -->/);
  assert(m, 'Employee Contract draft markers not found in the charter document');
  const estimatedTokens = Math.ceil(m![1].length / 4);
  assert(estimatedTokens <= TOKEN_BUDGET_TARGETS.staticMax, `draft is ~${estimatedTokens} tokens > ${TOKEN_BUDGET_TARGETS.staticMax}`);
  // The draft must restate the non-negotiables rather than defer them to the model.
  for (const needle of [/ownership/i, /never determine|must never determine|do not determine/i, /not a human/i, /untrusted/i]) {
    assert(needle.test(m![1]), `draft lacks required clause ${needle}`);
  }
});
