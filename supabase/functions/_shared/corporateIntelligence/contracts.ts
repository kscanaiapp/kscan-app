/**
 * Corporate Intelligence v2 -- contract SPECIFICATION (types, frozen tables, strict validator).
 *
 * STATUS: DRAFT for Product/Trust approval. NOT wired into any Edge Function.
 * Nothing under supabase/functions/<function>/ may import this module until the CI-04 gate is recorded
 * (enforced by boundaries.test.ts).
 *
 * Reuse: trust tiers map onto the existing AIContentTrust vocabulary in ../aiSecurity/trustTypes.ts.
 *
 * AUTHORITY RULE: a CorporateTaskV1 is only ever produced by the server-side assembler from trusted server
 * records. The validator is a defence-in-depth check on that output; it is never a way to accept a task or
 * facts supplied by a client. Client request bodies are not an input of the assembler at all.
 */
import type { AIContentTrust } from '../aiSecurity/trustTypes.ts';

export const CORPORATE_TASK_CONTRACT_VERSION = 'corporate-task-v1' as const;
export const CORPORATE_CHARTER_VERSION = 'kscan-corporate-charter-v1-draft' as const;
export const ACTION_CONTRACT_REF = 'action-proposal-v1-draft' as const;
/** Brand-policy versions a task may declare. A new charter version is added here only by a reviewed diff. */
export const SUPPORTED_BRAND_POLICY_VERSIONS: readonly string[] = Object.freeze([CORPORATE_CHARTER_VERSION]);

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

// ── Task verbs, modes, registers, surfaces, objectives (spec sections 4.2 / 4.3) ─

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

export const SURFACES = ['stylechat', 'scan_results', 'discovery_shelf', 'status'] as const;
export type Surface = (typeof SURFACES)[number];

/**
 * The server-owned mapping. A task verb fixes exactly one mode, a closed set of registers, the surfaces it may run
 * on, and the only objective codes it may carry. Gemini never supplies any of these; user text never selects a verb.
 */
export const TASK_VERB_POLICY: Readonly<
  Record<
    TaskVerb,
    {
      mode: CommunicationMode;
      registers: readonly PresentationRegister[];
      surfaces: readonly Surface[];
      objectiveCodes: readonly string[];
    }
  >
> = Object.freeze({
  stylechat_conversation: {
    mode: 'style_consultant', registers: ['conversational_answer'], surfaces: ['stylechat'],
    objectiveCodes: ['answer_style_question'],
  },
  stylechat_analysis: {
    mode: 'analytical', registers: ['conversational_answer'], surfaces: ['stylechat'],
    objectiveCodes: ['compare_or_analyze_wardrobe'],
  },
  scan_result_summary: {
    mode: 'professional', registers: ['scan_summary'], surfaces: ['scan_results'],
    objectiveCodes: ['summarize_scan_result'],
  },
  merchant_discovery_explanation: {
    mode: 'professional', registers: ['merchant_explanation'], surfaces: ['discovery_shelf', 'scan_results'],
    objectiveCodes: ['explain_verified_discovery_result'],
  },
  // A neutral empty catalog is NOT a service failure.
  discovery_empty_state: {
    mode: 'professional', registers: ['empty_state_notice'], surfaces: ['discovery_shelf', 'scan_results'],
    objectiveCodes: ['explain_empty_discovery'],
  },
  // Only reachable from a grounded server error/recovery state, never from customer tone.
  grounded_error_recovery: {
    mode: 'service_recovery', registers: ['error_status_notice'], surfaces: ['stylechat', 'scan_results', 'discovery_shelf', 'status'],
    objectiveCodes: ['report_recoverable_error'],
  },
  privacy_trust_question: {
    mode: 'trust_privacy', registers: ['conversational_answer'], surfaces: ['stylechat', 'status'],
    objectiveCodes: ['answer_privacy_question'],
  },
});

/** Only these verbs may carry ownership/merchant facts at all. */
export const OWNERSHIP_FACT_VERBS: readonly TaskVerb[] = Object.freeze([
  'merchant_discovery_explanation',
  'scan_result_summary',
]);

/** Closed policy-reference allowlist. A ref is a pointer to approved policy text, never policy content. */
export const POLICY_REF_ALLOWLIST: readonly string[] = Object.freeze([
  'policy:ownership-label-v1',
  'policy:no-invented-commerce-facts-v1',
  'policy:privacy-ai-processing-v1',
  'policy:error-recovery-v1',
]);
export const OWNERSHIP_POLICY_REF = 'policy:ownership-label-v1';

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

/** Which source systems are authoritative for which kind of fact. */
export const FACT_KIND_SOURCES: Readonly<Record<VerifiedFactKind, readonly FactSourceSystem[]>> = Object.freeze({
  ownership_label: ['black_owned_discovery'],
  merchant_attribution: ['black_owned_discovery'],
  product_ref: ['black_owned_discovery', 'catalog'],
  // Scan offers are priced by canonical commerce; a Black-owned discovery product is priced by the discovery catalog row that
  // produced it. Either owns its own product's price -- no other system does.
  price: ['commerce_canonical', 'black_owned_discovery'],
  currency: ['commerce_canonical', 'black_owned_discovery'],
  availability: ['catalog', 'black_owned_discovery'],
  action_state: ['application_state'],
});

/** Maximum freshness window per kind. Volatile commerce facts get shorter windows. */
export const FACT_MAX_TTL_SECONDS: Readonly<Record<VerifiedFactKind, number>> = Object.freeze({
  ownership_label: 24 * 3600,
  merchant_attribution: 24 * 3600,
  product_ref: 24 * 3600,
  price: 6 * 3600,
  currency: 6 * 3600,
  availability: 6 * 3600,
  action_state: 15 * 60,
});
/** Clock-skew tolerance for facts observed "in the future". */
export const FUTURE_SKEW_MS = 60_000;
export const AUDIT_CLOCK_SKEW_MS = 5 * 60_000;

/** Approved server-rendered ownership label text. PENDING Product/Legal approval. */
export const APPROVED_OWNERSHIP_LABELS: readonly string[] = Object.freeze(['From a verified Black-owned business']);

export interface VerifiedFactRef {
  factId: string;
  kind: VerifiedFactKind;
  sourceSystem: FactSourceSystem;
  /** Opaque authoritative record reference. Never raw owner evidence or an account id. */
  sourceRecordRef: string;
  /** Merchant binding: required on every merchant-scoped or product-scoped kind. */
  merchantRef?: string;
  /** Product binding: required on product-scoped kinds (product_ref, price, currency, availability). */
  productRef?: string;
  observedAt: string; // ISO-8601
  ttlSeconds: number; // finite, > 0, <= FACT_MAX_TTL_SECONDS[kind]
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

const MERCHANT_SCOPED: ReadonlySet<VerifiedFactKind> = new Set(['ownership_label', 'merchant_attribution']);
const PRODUCT_SCOPED: ReadonlySet<VerifiedFactKind> = new Set(['product_ref', 'price', 'currency', 'availability']);

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
  /** Server-authored objective code (template id) drawn from TASK_VERB_POLICY, not model- or user-authored prose. */
  objectiveCode: string;
  surface: Surface;
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
  /** Audit/correlation information; contains no personal data. */
  audit: { assembledAt: string; assemblerVersion: string; factCount: number };
  /** null in the deployed Option B contract; a string reference only in offline Option C design tests. */
  actionContractRef: null;
  capabilities: { proposable: NoCapabilities; executable: NoCapabilities };
}

export type ContractErrorCode =
  | 'not_object'
  | 'unknown_field'
  | 'unknown_nested_field'
  | 'bad_version'
  | 'bad_correlation_id'
  | 'bad_task_verb'
  | 'bad_objective_code'
  | 'unsupported_brand_policy_version'
  | 'mode_mismatch'
  | 'register_not_allowed'
  | 'surface_not_allowed'
  | 'bad_surface'
  | 'bad_locale'
  | 'bad_stylist_name'
  | 'bad_policy_ref'
  | 'missing_required_policy_ref'
  | 'bad_visual_observation'
  | 'bad_fact'
  | 'bad_ttl'
  | 'excessive_ttl'
  | 'stale_fact'
  | 'future_dated_fact'
  | 'untrusted_fact_source'
  | 'fact_kind_source_mismatch'
  | 'unapproved_ownership_label'
  | 'bad_merchant_reference'
  | 'unbound_merchant_reference'
  | 'ambiguous_merchant_reference'
  | 'price_without_currency'
  | 'ownership_fact_not_allowed_for_task'
  | 'ownership_fact_on_non_discovery_inventory'
  | 'missing_forbidden_action'
  | 'missing_immutable_field'
  | 'bad_token_budget'
  | 'bad_read_capability'
  | 'bad_audit'
  | 'audit_fact_count_mismatch'
  | 'executable_capability_present'
  | 'proposable_capability_present'
  | 'action_contract_ref_present'
  | 'bad_inventory'
  | 'eligible_count_mismatch'
  | 'zero_eligible_with_merchant_facts'
  | 'eligible_without_ownership_fact';

export type ContractResult =
  | { ok: true; value: CorporateTaskV1 }
  | { ok: false; errors: ContractErrorCode[] };

const TOP_LEVEL_KEYS: ReadonlySet<string> = new Set([
  'contractVersion', 'correlationId', 'taskVerb', 'objectiveCode', 'surface', 'locale',
  'brandPolicyVersion', 'stylist', 'verifiedFacts', 'visualObservations', 'policyRefs',
  'forbiddenActions', 'immutableFields', 'communicationMode', 'presentationRegister',
  'tokenBudget', 'allowedReadCapabilities', 'inventory', 'audit', 'actionContractRef', 'capabilities',
]);
const FACT_KEYS: ReadonlySet<string> = new Set([
  'factId', 'kind', 'sourceSystem', 'sourceRecordRef', 'merchantRef', 'productRef',
  'observedAt', 'ttlSeconds', 'value', 'immutable',
]);
const OBSERVATION_KEYS: ReadonlySet<string> = new Set(['label', 'confidence', 'tier']);
const CORRELATION_RE = /^[A-Za-z0-9_-]{8,80}$/;
const REF_RE = /^[A-Za-z0-9_-]{3,64}$/;
const FACT_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const LOCALE_RE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const ASSEMBLER_VERSION_RE = /^[a-z0-9._-]{3,40}$/;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/;
const MAX_FACTS = 40;
const MAX_OBSERVATIONS = 8;
const MAX_POLICY_REFS = 6;
const MAX_VALUE_CHARS = 120;

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}
function hasOnlyKeys(rec: Record<string, unknown>, allowed: ReadonlySet<string>): boolean {
  return Object.keys(rec).every((k) => allowed.has(k));
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
  if (typeof input.brandPolicyVersion !== 'string' || !SUPPORTED_BRAND_POLICY_VERSIONS.includes(input.brandPolicyVersion)) {
    errors.add('unsupported_brand_policy_version');
  }
  if (typeof input.surface !== 'string' || !(SURFACES as readonly string[]).includes(input.surface)) errors.add('bad_surface');
  if (typeof input.locale !== 'string' || !LOCALE_RE.test(input.locale)) errors.add('bad_locale');

  const stylist = input.stylist;
  const stylistName = isRecord(stylist) ? stylist.displayName : undefined;
  if (isRecord(stylist) && !hasOnlyKeys(stylist, new Set(['displayName']))) errors.add('unknown_nested_field');
  if (
    typeof stylistName !== 'string' || stylistName.length < 2 || stylistName.length > 24 ||
    CONTROL_RE.test(stylistName)
  ) {
    errors.add('bad_stylist_name');
  }

  // Task verb -> mode -> register -> surface -> objective (server-owned table).
  const verb = input.taskVerb;
  let verbPolicy: (typeof TASK_VERB_POLICY)[TaskVerb] | null = null;
  if (typeof verb !== 'string' || !(TASK_VERBS as readonly string[]).includes(verb)) {
    errors.add('bad_task_verb');
  } else {
    verbPolicy = TASK_VERB_POLICY[verb as TaskVerb];
    if (input.communicationMode !== verbPolicy.mode) errors.add('mode_mismatch');
    if (!(verbPolicy.registers as readonly string[]).includes(String(input.presentationRegister))) {
      errors.add('register_not_allowed');
    }
    if (typeof input.surface === 'string' && (SURFACES as readonly string[]).includes(input.surface) &&
      !(verbPolicy.surfaces as readonly string[]).includes(input.surface)) {
      errors.add('surface_not_allowed');
    }
    if (typeof input.objectiveCode !== 'string' || !(verbPolicy.objectiveCodes as readonly string[]).includes(input.objectiveCode)) {
      errors.add('bad_objective_code');
    }
  }

  // Option B: the executor capability type is empty.
  const caps = input.capabilities;
  if (!isRecord(caps)) {
    errors.add('executable_capability_present');
  } else {
    for (const key of Object.keys(caps)) {
      if (key !== 'proposable' && key !== 'executable') errors.add('unknown_nested_field');
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

  // Policy references: closed, unique, bounded.
  const policyRefs = input.policyRefs;
  if (
    !Array.isArray(policyRefs) || policyRefs.length > MAX_POLICY_REFS ||
    policyRefs.some((p) => typeof p !== 'string' || !POLICY_REF_ALLOWLIST.includes(p)) ||
    new Set(policyRefs).size !== policyRefs.length
  ) {
    errors.add('bad_policy_ref');
  }

  // Visual observations: strict shape, bounded, always untrusted.
  const observations = input.visualObservations;
  if (!Array.isArray(observations) || observations.length > MAX_OBSERVATIONS) {
    errors.add('bad_visual_observation');
  } else {
    for (const obs of observations) {
      if (!isRecord(obs)) {
        errors.add('bad_visual_observation');
        continue;
      }
      if (!hasOnlyKeys(obs, OBSERVATION_KEYS)) errors.add('unknown_nested_field');
      if (
        typeof obs.label !== 'string' || obs.label.trim().length === 0 || obs.label.length > MAX_VALUE_CHARS ||
        CONTROL_RE.test(obs.label) || !['low', 'medium', 'high'].includes(String(obs.confidence)) ||
        obs.tier !== 'untrusted_text'
      ) {
        errors.add('bad_visual_observation');
      }
    }
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
  if (isRecord(budget) && !hasOnlyKeys(budget, new Set(['staticMax', 'dynamicMax', 'outputMax']))) {
    errors.add('unknown_nested_field');
  }
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

  // ── Verified facts: authoritative source, provenance, freshness, immutability, binding ──
  let structurallyValid = true;
  const factList: VerifiedFactRef[] = [];
  const labelFacts: VerifiedFactRef[] = [];
  if (!Array.isArray(input.verifiedFacts) || input.verifiedFacts.length > MAX_FACTS) {
    errors.add('bad_fact');
    structurallyValid = false;
  } else {
    const seenIds = new Set<string>();
    for (const raw of input.verifiedFacts) {
      if (!isRecord(raw)) {
        errors.add('bad_fact');
        structurallyValid = false;
        continue;
      }
      if (!hasOnlyKeys(raw, FACT_KEYS)) errors.add('unknown_nested_field');
      const fact = raw as Record<string, any>;
      const kindOk = (VERIFIED_FACT_KINDS as readonly string[]).includes(String(fact.kind));
      const sourceOk = (FACT_SOURCE_SYSTEMS as readonly string[]).includes(String(fact.sourceSystem));
      if (!sourceOk) errors.add('untrusted_fact_source');
      const ttlFinite = typeof fact.ttlSeconds === 'number' && Number.isFinite(fact.ttlSeconds);
      if (typeof fact.ttlSeconds !== 'number' || !ttlFinite || !(fact.ttlSeconds > 0)) errors.add('bad_ttl');
      if (
        !kindOk || typeof fact.factId !== 'string' || !FACT_ID_RE.test(fact.factId) || seenIds.has(fact.factId) ||
        typeof fact.sourceRecordRef !== 'string' || !fact.sourceRecordRef ||
        typeof fact.value !== 'string' || fact.value.length === 0 || fact.value.length > MAX_VALUE_CHARS ||
        CONTROL_RE.test(fact.value) || fact.immutable !== true || !sourceOk || !ttlFinite || !(fact.ttlSeconds > 0) ||
        typeof fact.observedAt !== 'string' || !Number.isFinite(Date.parse(fact.observedAt))
      ) {
        errors.add('bad_fact');
        structurallyValid = false;
        continue;
      }
      seenIds.add(fact.factId);
      const kind = fact.kind as VerifiedFactKind;
      const observedMs = Date.parse(fact.observedAt);
      if (fact.ttlSeconds > FACT_MAX_TTL_SECONDS[kind]) errors.add('excessive_ttl');
      if (observedMs > now.getTime() + FUTURE_SKEW_MS) errors.add('future_dated_fact');
      else if (observedMs + fact.ttlSeconds * 1000 <= now.getTime()) errors.add('stale_fact');

      // Source-system versus fact-kind relationship.
      if (!FACT_KIND_SOURCES[kind].includes(fact.sourceSystem)) {
        // Ownership labels keep their original, narrower error code.
        errors.add(kind === 'ownership_label' ? 'untrusted_fact_source' : 'fact_kind_source_mismatch');
      }

      // Merchant/product references must be present exactly where the kind requires them.
      const merchantOk = typeof fact.merchantRef === 'string' && REF_RE.test(fact.merchantRef);
      const productOk = typeof fact.productRef === 'string' && REF_RE.test(fact.productRef);
      if (MERCHANT_SCOPED.has(kind) && (!merchantOk || fact.productRef !== undefined)) {
        errors.add('bad_merchant_reference');
        structurallyValid = false;
      }
      if (PRODUCT_SCOPED.has(kind) && (!merchantOk || !productOk)) {
        errors.add('bad_merchant_reference');
        structurallyValid = false;
      }
      if (!MERCHANT_SCOPED.has(kind) && !PRODUCT_SCOPED.has(kind) &&
        (fact.merchantRef !== undefined || fact.productRef !== undefined)) {
        errors.add('bad_merchant_reference');
        structurallyValid = false;
      }
      if (kind === 'ownership_label') {
        if (!APPROVED_OWNERSHIP_LABELS.includes(fact.value)) errors.add('unapproved_ownership_label');
        labelFacts.push(fact as VerifiedFactRef);
      }
      factList.push(fact as VerifiedFactRef);
    }
  }

  // Binding: labels <-> merchant attribution <-> products. Only meaningful when every fact is structurally sound,
  // so a single malformed fact does not fan out into unrelated binding errors.
  if (structurallyValid && factList.length > 0) {
    const merchantLabel = new Map<string, number>();
    const merchantAttribution = new Map<string, number>();
    const productKinds = new Map<string, Map<string, number>>(); // "merchant|product" -> kind -> count
    const productOwner = new Map<string, string>();
    for (const f of factList) {
      if (f.kind === 'ownership_label') merchantLabel.set(f.merchantRef!, (merchantLabel.get(f.merchantRef!) ?? 0) + 1);
      else if (f.kind === 'merchant_attribution') merchantAttribution.set(f.merchantRef!, (merchantAttribution.get(f.merchantRef!) ?? 0) + 1);
      else if (PRODUCT_SCOPED.has(f.kind)) {
        const key = `${f.merchantRef}|${f.productRef}`;
        const kinds = productKinds.get(key) ?? new Map<string, number>();
        kinds.set(f.kind, (kinds.get(f.kind) ?? 0) + 1);
        productKinds.set(key, kinds);
        const owner = productOwner.get(f.productRef!);
        if (owner !== undefined && owner !== f.merchantRef) errors.add('ambiguous_merchant_reference');
        productOwner.set(f.productRef!, f.merchantRef!);
      }
    }
    for (const count of [...merchantLabel.values(), ...merchantAttribution.values()]) {
      if (count > 1) errors.add('ambiguous_merchant_reference');
    }
    for (const [merchant] of merchantLabel) if (!merchantAttribution.has(merchant)) errors.add('unbound_merchant_reference');
    for (const [merchant] of merchantAttribution) if (!merchantLabel.has(merchant)) errors.add('unbound_merchant_reference');
    for (const [key, kinds] of productKinds) {
      const merchant = key.split('|')[0];
      if (!merchantLabel.has(merchant)) errors.add('unbound_merchant_reference');
      for (const count of kinds.values()) if (count > 1) errors.add('ambiguous_merchant_reference');
      if (!kinds.has('product_ref')) errors.add('unbound_merchant_reference');
      if (kinds.has('price') && !kinds.has('currency')) errors.add('price_without_currency');
    }
    // CI-03 repair R2 (price provenance). FACT_KIND_SOURCES lets two systems price a product, but each may only price
    // ITS OWN product, and one product's price/currency pair comes from exactly one record:
    //   * price and currency of one product share a source system (no mixing a discovery amount with a canonical code);
    //   * a discovery-sourced price/currency is only valid on a product whose product_ref is itself discovery-sourced,
    //     and it must cite the SAME discovery record (the catalog row that produced the product -- see the assembler).
    for (const f of factList) {
      if (f.kind !== 'price' && f.kind !== 'currency') continue;
      const siblings = factList.filter((g) => g.merchantRef === f.merchantRef && g.productRef === f.productRef);
      const partner = siblings.find((g) => g.kind === (f.kind === 'price' ? 'currency' : 'price'));
      if (partner && partner.sourceSystem !== f.sourceSystem) errors.add('fact_kind_source_mismatch');
      if (f.sourceSystem === 'black_owned_discovery') {
        const product = siblings.find((g) => g.kind === 'product_ref');
        if (product && (product.sourceSystem !== 'black_owned_discovery' || product.sourceRecordRef !== f.sourceRecordRef)) {
          errors.add('fact_kind_source_mismatch');
        }
      }
    }
    // A labelled merchant with no product is an orphan label.
    const merchantsWithProducts = new Set([...productKinds.keys()].map((k) => k.split('|')[0]));
    for (const [merchant] of merchantLabel) if (!merchantsWithProducts.has(merchant)) errors.add('unbound_merchant_reference');
  }

  // Ownership facts: only for permitted verbs and only with the ownership policy reference.
  // (An unknown verb is already rejected as bad_task_verb; do not stack a derived error on top of it.)
  if (labelFacts.length > 0 && verbPolicy !== null && typeof verb === 'string') {
    if (!(OWNERSHIP_FACT_VERBS as readonly string[]).includes(verb)) errors.add('ownership_fact_not_allowed_for_task');
    if (Array.isArray(policyRefs) && !policyRefs.includes(OWNERSHIP_POLICY_REF)) errors.add('missing_required_policy_ref');
  }

  // Inventory status and ownership facts must agree (zero-eligible => no speculative merchant facts).
  const hasMerchantFact = factList.some((f) => f.kind === 'merchant_attribution');
  const inventory = input.inventory;
  if (isRecord(inventory) && !hasOnlyKeys(inventory, new Set(['status', 'eligibleCount']))) errors.add('unknown_nested_field');
  if (
    !isRecord(inventory) ||
    !['not_applicable', 'eligible', 'zero_eligible'].includes(String(inventory.status)) ||
    !Number.isInteger(inventory.eligibleCount) || (inventory.eligibleCount as number) < 0
  ) {
    errors.add('bad_inventory');
  } else {
    if (inventory.status === 'zero_eligible' && (inventory.eligibleCount !== 0 || labelFacts.length > 0 || hasMerchantFact)) {
      errors.add('zero_eligible_with_merchant_facts');
    }
    if (inventory.status === 'not_applicable') {
      if (inventory.eligibleCount !== 0) errors.add('bad_inventory');
      if (labelFacts.length > 0 || hasMerchantFact) errors.add('ownership_fact_on_non_discovery_inventory');
    }
    if (inventory.status === 'eligible') {
      if ((inventory.eligibleCount as number) < 1 || labelFacts.length === 0) {
        errors.add('eligible_without_ownership_fact');
      } else if (structurallyValid) {
        const products = new Set(factList.filter((f) => f.kind === 'product_ref').map((f) => `${f.merchantRef}|${f.productRef}`));
        if (products.size !== inventory.eligibleCount) errors.add('eligible_count_mismatch');
      }
    }
  }

  // Audit/correlation block.
  const audit = input.audit;
  if (isRecord(audit) && !hasOnlyKeys(audit, new Set(['assembledAt', 'assemblerVersion', 'factCount']))) {
    errors.add('unknown_nested_field');
  }
  if (
    !isRecord(audit) || typeof audit.assembledAt !== 'string' || !Number.isFinite(Date.parse(audit.assembledAt)) ||
    Math.abs(Date.parse(audit.assembledAt) - now.getTime()) > AUDIT_CLOCK_SKEW_MS ||
    typeof audit.assemblerVersion !== 'string' || !ASSEMBLER_VERSION_RE.test(audit.assemblerVersion) ||
    !Number.isInteger(audit.factCount)
  ) {
    errors.add('bad_audit');
  } else if (Array.isArray(input.verifiedFacts) && audit.factCount !== input.verifiedFacts.length) {
    errors.add('audit_fact_count_mismatch');
  }

  return errors.size === 0
    ? { ok: true, value: input as unknown as CorporateTaskV1 }
    : { ok: false, errors: [...errors].sort() };
}

// ── Output validation stages and deterministic fallbacks (spec section 6 / C3) ──

export const VALIDATION_STAGES = [
  'stage0_server_authority',
  'stage1_output_contract',
  'stage2_verified_fact_integrity',
  'stage3_claims_and_register',
  'stage4_safe_fallback',
] as const;
export type ValidationStage = (typeof VALIDATION_STAGES)[number];

export const INTEGRITY_FAILURE_CODES = [
  'unsupported_ownership_claim',
  'fabricated_merchant_recommendation',
  'verified_fact_mismatch',
  'unexecuted_action_claim',
  'unauthorized_company_commitment',
  'sensitive_data_exposure',
  'output_contract_violation',
] as const;
export type IntegrityFailureCode = (typeof INTEGRITY_FAILURE_CODES)[number];

/**
 * PROPOSED fallback copy -- pending Product/Legal review. Deliberately free of buttons, filters, next-step
 * promises and anything implying verified results exist when none are eligible.
 */
export const PROPOSED_FALLBACK_COPY = Object.freeze({
  zero_eligible: 'No matches from verified Black-owned businesses are available for this item right now.',
  ownership_integrity_failure:
    "I can't confirm that business's ownership from its name or product images. K Scan only labels businesses that meet its verification requirements.",
  generic_integrity_failure: "I wasn't able to complete that response. Please try again.",
});
export type FallbackCopyKey = keyof typeof PROPOSED_FALLBACK_COPY;

/**
 * Deterministic: a critical integrity failure maps to approved copy and NEVER to another generative call.
 * (The `regenerate` field exists only so a test can pin it to false.)
 */
export function selectFallback(
  code: IntegrityFailureCode,
  inventoryStatus: CorporateTaskV1['inventory']['status'],
): { copyKey: FallbackCopyKey; regenerate: false } {
  switch (code) {
    case 'unsupported_ownership_claim':
      return { copyKey: 'ownership_integrity_failure', regenerate: false };
    case 'fabricated_merchant_recommendation':
      return { copyKey: inventoryStatus === 'zero_eligible' ? 'zero_eligible' : 'generic_integrity_failure', regenerate: false };
    default:
      return { copyKey: 'generic_integrity_failure', regenerate: false };
  }
}
