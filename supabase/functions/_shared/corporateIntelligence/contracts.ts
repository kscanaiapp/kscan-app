/**
 * Corporate Intelligence v2 -- CI-01 contract SPECIFICATION (types, frozen tables, strict validator).
 *
 * STATUS: DRAFT for Product/Trust approval. NOT wired into any Edge Function.
 * Option B runtime restriction: nothing under supabase/functions/<function>/ may import this module
 * until the Phase 1 architecture gate is recorded (enforced by isolation.test.ts). The deterministic
 * mode selector, context assembler and validation library are CI-02/CI-03 and are deliberately absent.
 *
 * Reuse: trust tiers map onto the existing AIContentTrust vocabulary in ../aiSecurity/trustTypes.ts; they do
 * not replace it.
 */
import type { AIContentTrust } from '../aiSecurity/trustTypes.ts';

export const CORPORATE_TASK_CONTRACT_VERSION = 'corporate-task-v1' as const;
export const CORPORATE_CHARTER_VERSION = 'kscan-corporate-charter-v1-draft' as const;
export const ACTION_CONTRACT_REF = 'action-proposal-v1-draft' as const;

// ── Provenance (spec section 4.4) ───────────────────────────────────────────────

export const TRUST_TIERS = ['system_policy', 'verified_db_record', 'user_message', 'untrusted_text'] as const;
export type TrustTier = (typeof TRUST_TIERS)[number];

/** Which existing aiSecurity trust classes each corporate tier may be rendered as. */
export const TRUST_TIER_TO_AI_CONTENT_TRUST: Readonly<Record<TrustTier, readonly AIContentTrust[]>> = Object.freeze({
  system_policy: ['trusted_system'],
  verified_db_record: ['trusted_server_context'],
  user_message: ['untrusted_user'],
  untrusted_text: ['untrusted_derived', 'untrusted_external'],
});

/** 'within_security_hierarchy' still sits beneath consent/authorization (precedence level 1). */
export const TIER_APPLICATION_AUTHORITY: Readonly<Record<TrustTier, 'within_security_hierarchy' | 'factual_only' | 'none'>> =
  Object.freeze({
    system_policy: 'within_security_hierarchy',
    verified_db_record: 'factual_only',
    user_message: 'none',
    untrusted_text: 'none',
  });

// ── Task verbs, modes, registers (spec sections 4.2 / 4.3) ──────────────────────

export const COMMUNICATION_MODES = [
  'professional',
  'style_consultant',
  'analytical',
  'service_recovery',
  'trust_privacy',
] as const;
export type CommunicationMode = (typeof COMMUNICATION_MODES)[number];

export const PRESENTATION_REGISTERS = [
  'scan_summary',
  'conversational_answer',
  'merchant_explanation',
  'empty_state_notice',
  'error_status_notice',
] as const;
export type PresentationRegister = (typeof PRESENTATION_REGISTERS)[number];

export const TASK_VERBS = [
  'stylechat_conversation',
  'stylechat_analysis',
  'scan_result_summary',
  'merchant_discovery_explanation',
  'discovery_empty_state',
  'grounded_error_recovery',
  'privacy_trust_question',
] as const;
export type TaskVerb = (typeof TASK_VERBS)[number];

/**
 * The server-owned mapping. A task verb fixes exactly one mode and a closed set of registers.
 * Gemini never supplies either dimension; user text never selects a verb.
 */
export const TASK_VERB_POLICY: Readonly<
  Record<TaskVerb, { mode: CommunicationMode; registers: readonly PresentationRegister[] }>
> = Object.freeze({
  stylechat_conversation: { mode: 'style_consultant', registers: ['conversational_answer'] },
  stylechat_analysis: { mode: 'analytical', registers: ['conversational_answer'] },
  scan_result_summary: { mode: 'professional', registers: ['scan_summary'] },
  merchant_discovery_explanation: { mode: 'professional', registers: ['merchant_explanation'] },
  // A neutral empty catalog is NOT a service failure.
  discovery_empty_state: { mode: 'professional', registers: ['empty_state_notice'] },
  // Only reachable from a grounded server error/recovery state, never from customer tone.
  grounded_error_recovery: { mode: 'service_recovery', registers: ['error_status_notice'] },
  privacy_trust_question: { mode: 'trust_privacy', registers: ['conversational_answer'] },
});

// ── Verified facts / observations ───────────────────────────────────────────────

export const VERIFIED_FACT_KINDS = [
  'price',
  'currency',
  'availability',
  'ownership_label',
  'merchant_attribution',
  'product_ref',
  'action_state',
] as const;
export type VerifiedFactKind = (typeof VERIFIED_FACT_KINDS)[number];

export const FACT_SOURCE_SYSTEMS = [
  'black_owned_discovery',
  'catalog',
  'commerce_canonical',
  'entitlement',
  'application_state',
] as const;
export type FactSourceSystem = (typeof FACT_SOURCE_SYSTEMS)[number];

export interface VerifiedFactRef {
  factId: string;
  kind: VerifiedFactKind;
  sourceSystem: FactSourceSystem;
  /** Opaque authoritative record reference. Never raw owner evidence or an account id. */
  sourceRecordRef: string;
  observedAt: string; // ISO-8601
  ttlSeconds: number; // freshness window; fact is stale at observedAt + ttl
  /** Server-rendered, immutable display value (e.g. the approved ownership label). */
  value: string;
  immutable: true;
}

export interface VisualObservation {
  label: string;
  /** Observation is never a verified fact. Uncertainty is mandatory. */
  confidence: 'low' | 'medium' | 'high';
  tier: 'untrusted_text';
}

// ── Capabilities (Option B: executor type is EMPTY and machine-enforced) ────────

export const ALLOWED_READ_CAPABILITIES = [
  'read_verified_facts',
  'read_visual_observations',
  'read_policy_refs',
] as const;
export type ReadCapability = (typeof ALLOWED_READ_CAPABILITIES)[number];

/** `never[]` makes any non-empty literal a compile error; the validator makes it a runtime error. */
export type NoCapabilities = readonly never[];

export const REQUIRED_FORBIDDEN_ACTIONS = [
  'purchase',
  'save_item',
  'edit_account',
  'modify_inventory',
  'execute_tool',
  'verify_ownership',
  'claim_action_completed',
  'commit_company_policy',
] as const;

export const REQUIRED_IMMUTABLE_FIELDS = [
  'ownership_label',
  'merchant_attribution',
  'price',
  'currency',
  'availability',
] as const;

/** Design targets (CI spec section 7): require approval and a measured Build 35 baseline before release. */
export const TOKEN_BUDGET_TARGETS = Object.freeze({ staticMax: 1200, dynamicMax: 1600, totalMax: 2800 });

export interface CorporateTaskV1 {
  contractVersion: typeof CORPORATE_TASK_CONTRACT_VERSION;
  /** Opaque correlation id (request id). Never an email, user id or free text. */
  correlationId: string;
  taskVerb: TaskVerb;
  /** Server-authored objective code (template id), not model- or user-authored prose. */
  objectiveCode: string;
  surface: 'stylechat' | 'scan_results' | 'discovery_shelf' | 'status';
  locale: string;
  brandPolicyVersion: string;
  stylist: { displayName: string };
  verifiedFacts: readonly VerifiedFactRef[];
  visualObservations: readonly VisualObservation[];
  policyRefs: readonly string[];
  forbiddenActions: readonly string[];
  immutableFields: readonly string[];
  communicationMode: CommunicationMode;
  presentationRegister: PresentationRegister;
  tokenBudget: { staticMax: number; dynamicMax: number; outputMax: number };
  allowedReadCapabilities: readonly ReadCapability[];
  inventory: { status: 'not_applicable' | 'eligible' | 'zero_eligible'; eligibleCount: number };
  /** null in the deployed Option B contract; a string reference only in offline Option C design tests. */
  actionContractRef: null;
  capabilities: { proposable: NoCapabilities; executable: NoCapabilities };
}

export type ContractErrorCode =
  | 'not_object'
  | 'unknown_field'
  | 'bad_version'
  | 'bad_correlation_id'
  | 'bad_task_verb'
  | 'mode_mismatch'
  | 'register_not_allowed'
  | 'bad_surface'
  | 'bad_locale'
  | 'bad_stylist_name'
  | 'bad_fact'
  | 'stale_fact'
  | 'untrusted_fact_source'
  | 'missing_forbidden_action'
  | 'missing_immutable_field'
  | 'bad_token_budget'
  | 'bad_read_capability'
  | 'executable_capability_present'
  | 'proposable_capability_present'
  | 'action_contract_ref_present'
  | 'bad_inventory'
  | 'zero_eligible_with_merchant_facts'
  | 'eligible_without_ownership_fact';

export type ContractResult =
  | { ok: true; value: CorporateTaskV1 }
  | { ok: false; errors: ContractErrorCode[] };

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'contractVersion', 'correlationId', 'taskVerb', 'objectiveCode', 'surface', 'locale',
  'brandPolicyVersion', 'stylist', 'verifiedFacts', 'visualObservations', 'policyRefs',
  'forbiddenActions', 'immutableFields', 'communicationMode', 'presentationRegister',
  'tokenBudget', 'allowedReadCapabilities', 'inventory', 'actionContractRef', 'capabilities',
]);
const SURFACES: ReadonlySet<string> = new Set(['stylechat', 'scan_results', 'discovery_shelf', 'status']);
const CORRELATION_RE = /^[A-Za-z0-9_-]{8,80}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const CONTROL_RE = /[\x00-\x1F\x7F]/;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

/** Strict structural validation. Fail closed: any unknown key or non-empty capability rejects the task. */
export function validateCorporateTaskV1(input: unknown, now: Date = new Date()): ContractResult {
  if (!isRecord(input)) return { ok: false, errors: ['not_object'] };
  const errors = new Set<ContractErrorCode>();
  for (const key of Object.keys(input)) if (!TOP_LEVEL_KEYS.has(key)) errors.add('unknown_field');

  if (input.contractVersion !== CORPORATE_TASK_CONTRACT_VERSION) errors.add('bad_version');
  if (typeof input.correlationId !== 'string' || !CORRELATION_RE.test(input.correlationId)) {
    errors.add('bad_correlation_id');
  }
  if (typeof input.surface !== 'string' || !SURFACES.has(input.surface)) errors.add('bad_surface');
  if (typeof input.locale !== 'string' || !LOCALE_RE.test(input.locale)) errors.add('bad_locale');

  const stylist = input.stylist;
  const stylistName = isRecord(stylist) ? stylist.displayName : undefined;
  if (
    typeof stylistName !== 'string' || stylistName.length < 2 || stylistName.length > 24 ||
    CONTROL_RE.test(stylistName)
  ) {
    errors.add('bad_stylist_name');
  }

  // Task verb -> mode -> register (server-owned table).
  const verb = input.taskVerb;
  if (typeof verb !== 'string' || !(TASK_VERBS as readonly string[]).includes(verb)) {
    errors.add('bad_task_verb');
  } else {
    const policy = TASK_VERB_POLICY[verb as TaskVerb];
    if (input.communicationMode !== policy.mode) errors.add('mode_mismatch');
    if (!(policy.registers as readonly string[]).includes(String(input.presentationRegister))) {
      errors.add('register_not_allowed');
    }
  }

  // Option B: the executor capability type is empty.
  const caps = input.capabilities;
  if (!isRecord(caps)) {
    errors.add('executable_capability_present');
  } else {
    for (const key of Object.keys(caps)) {
      if (key !== 'proposable' && key !== 'executable') errors.add('unknown_field');
    }
    if (!Array.isArray(caps.executable) || caps.executable.length !== 0) errors.add('executable_capability_present');
    if (!Array.isArray(caps.proposable) || caps.proposable.length !== 0) errors.add('proposable_capability_present');
  }
  if (input.actionContractRef !== null) errors.add('action_contract_ref_present');

  if (
    !Array.isArray(input.allowedReadCapabilities) ||
    input.allowedReadCapabilities.some((c) => !(ALLOWED_READ_CAPABILITIES as readonly string[]).includes(String(c)))
  ) {
    errors.add('bad_read_capability');
  }

  for (const required of REQUIRED_FORBIDDEN_ACTIONS) {
    if (!Array.isArray(input.forbiddenActions) || !input.forbiddenActions.includes(required)) {
      errors.add('missing_forbidden_action');
    }
  }
  for (const required of REQUIRED_IMMUTABLE_FIELDS) {
    if (!Array.isArray(input.immutableFields) || !input.immutableFields.includes(required)) {
      errors.add('missing_immutable_field');
    }
  }

  const budget = input.tokenBudget;
  if (
    !isRecord(budget) ||
    !Number.isInteger(budget.staticMax) || !Number.isInteger(budget.dynamicMax) || !Number.isInteger(budget.outputMax) ||
    (budget.staticMax as number) < 0 || (budget.dynamicMax as number) < 0 || (budget.outputMax as number) <= 0 ||
    (budget.staticMax as number) > TOKEN_BUDGET_TARGETS.staticMax ||
    (budget.dynamicMax as number) > TOKEN_BUDGET_TARGETS.dynamicMax ||
    (budget.staticMax as number) + (budget.dynamicMax as number) > TOKEN_BUDGET_TARGETS.totalMax
  ) {
    errors.add('bad_token_budget');
  }

  // Verified facts: authoritative source, provenance, freshness, immutability.
  let hasOwnershipLabelFact = false;
  let hasMerchantFact = false;
  if (!Array.isArray(input.verifiedFacts)) {
    errors.add('bad_fact');
  } else {
    for (const fact of input.verifiedFacts) {
      if (!isRecord(fact)) {
        errors.add('bad_fact');
        continue;
      }
      const kindOk = (VERIFIED_FACT_KINDS as readonly string[]).includes(String(fact.kind));
      const sourceOk = (FACT_SOURCE_SYSTEMS as readonly string[]).includes(String(fact.sourceSystem));
      if (!sourceOk) errors.add('untrusted_fact_source');
      if (
        !kindOk || typeof fact.factId !== 'string' || !fact.factId ||
        typeof fact.sourceRecordRef !== 'string' || !fact.sourceRecordRef ||
        typeof fact.value !== 'string' || fact.immutable !== true ||
        typeof fact.ttlSeconds !== 'number' || !(fact.ttlSeconds > 0) ||
        typeof fact.observedAt !== 'string' || !Number.isFinite(Date.parse(fact.observedAt))
      ) {
        errors.add('bad_fact');
        continue;
      }
      if (Date.parse(fact.observedAt) + fact.ttlSeconds * 1000 <= now.getTime()) errors.add('stale_fact');
      if (fact.kind === 'ownership_label') {
        hasOwnershipLabelFact = true;
        // Ownership labels may only come from the discovery service's verified record.
        if (fact.sourceSystem !== 'black_owned_discovery') errors.add('untrusted_fact_source');
      }
      if (fact.kind === 'merchant_attribution') hasMerchantFact = true;
    }
  }

  // Inventory status and ownership facts must agree (zero-eligible => no speculative merchant facts).
  const inventory = input.inventory;
  if (
    !isRecord(inventory) ||
    !['not_applicable', 'eligible', 'zero_eligible'].includes(String(inventory.status)) ||
    !Number.isInteger(inventory.eligibleCount) || (inventory.eligibleCount as number) < 0
  ) {
    errors.add('bad_inventory');
  } else {
    if (inventory.status === 'zero_eligible' && (inventory.eligibleCount !== 0 || hasOwnershipLabelFact || hasMerchantFact)) {
      errors.add('zero_eligible_with_merchant_facts');
    }
    if (inventory.status === 'eligible' && ((inventory.eligibleCount as number) < 1 || !hasOwnershipLabelFact)) {
      errors.add('eligible_without_ownership_fact');
    }
  }

  return errors.size === 0
    ? { ok: true, value: input as unknown as CorporateTaskV1 }
    : { ok: false, errors: [...errors].sort() };
}
