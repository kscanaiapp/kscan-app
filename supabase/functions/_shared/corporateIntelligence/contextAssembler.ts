/**
 * Corporate Intelligence v2 -- pure task-context assembly (CI-02).
 *
 * WHAT THIS IS: a PURE, TRANSPORT-INDEPENDENT function from trusted server records to a validated
 * `CorporateTaskV1` plus the prompt sections that render it through the EXISTING aiSecurity envelope.
 *
 * WHAT THIS IS NOT: it calls no model, performs no write, reads no database, has no clock of its own (the caller passes
 * `now`), introduces no authorization mechanism (consent, entitlement and actor checks stay Stage 0 in the function), and
 * is imported by NO Edge Function (boundaries.test.ts). Runtime wiring is CI-04 and is gated.
 *
 * AUTHORITY RULE: every fact originates from a server service record. A client request body is never an input.
 * `sealTrustedAssemblerInput` is the only constructor the assembler accepts; it copies a CLOSED set of fields, rejects
 * any unknown key (including `verifiedFacts`/`facts`), and drops everything it does not need (data minimization).
 * The seal is a hygiene tripwire against accidentally passing a request body into the assembler -- it is NOT a security
 * boundary against code that already runs on the server.
 *
 * FRESHNESS: a fact that is not fresh is OMITTED, never relabelled. Staleness of an ownership/product record removes the
 * whole product from the eligible set (so it can never support an ownership claim); staleness of price/availability
 * removes only that fact (the model then has nothing to say about it).
 */
import { assembleStyleChatPrompt, type StyleChatPromptAssemblyInput } from '../aiSecurity/styleChatPromptAssembly.ts';
import {
  ALLOWED_READ_CAPABILITIES,
  APPROVED_OWNERSHIP_LABELS,
  CORPORATE_CHARTER_VERSION,
  CORPORATE_TASK_CONTRACT_VERSION,
  FACT_MAX_TTL_SECONDS,
  FUTURE_SKEW_MS,
  OWNERSHIP_POLICY_REF,
  REQUIRED_FORBIDDEN_ACTIONS,
  REQUIRED_IMMUTABLE_FIELDS,
  TASK_VERB_POLICY,
  TOKEN_BUDGET_TARGETS,
  validateCorporateTaskV1,
  type ContractErrorCode,
  type CorporateTaskV1,
  type PresentationRegister,
  type TaskVerb,
  type VerifiedFactRef,
  type VisualObservation,
} from './contracts.ts';
import { selectCommunicationMode, surfaceForRoute, type TrustedTaskState } from './modeSelector.ts';

export const ASSEMBLER_VERSION = 'ci02-assembler-v1' as const;
/** At most this many eligible products are described to the model in one brief (the rest stay on the server shelf). */
export const MAX_BRIEF_PRODUCTS = 3;
/** Hard ceiling for products accepted from the discovery service (the engine returns at most 8). */
export const MAX_INPUT_PRODUCTS = 20;
/** `buildTrustedServerContext` silently truncates at 2,000 characters; the brief must fit with headroom or fail closed. */
export const TRUSTED_BRIEF_CHAR_BUDGET = 1_900;
export const BRIEF_END_MARKER = 'end_task_brief';

/**
 * Visible-answer token targets per register -- DESIGN PROPOSALS pending approval. They do not change the existing
 * StyleChat provider cap (2048 output tokens including thinking tokens).
 */
export const OUTPUT_TOKEN_TARGETS: Readonly<Record<PresentationRegister, number>> = Object.freeze({
  scan_summary: 400,
  conversational_answer: 600,
  merchant_explanation: 400,
  empty_state_notice: 120,
  error_status_notice: 120,
});

const POLICY_REFS_BY_VERB: Readonly<Record<TaskVerb, readonly string[]>> = Object.freeze({
  stylechat_conversation: ['policy:no-invented-commerce-facts-v1'],
  stylechat_analysis: ['policy:no-invented-commerce-facts-v1'],
  scan_result_summary: ['policy:no-invented-commerce-facts-v1'],
  merchant_discovery_explanation: [OWNERSHIP_POLICY_REF, 'policy:no-invented-commerce-facts-v1'],
  discovery_empty_state: [OWNERSHIP_POLICY_REF, 'policy:no-invented-commerce-facts-v1'],
  grounded_error_recovery: ['policy:error-recovery-v1'],
  privacy_trust_question: ['policy:privacy-ai-processing-v1'],
});

// ── Trusted input (closed, minimized) ───────────────────────────────────────────

/** The minimal subset of the discovery engine's `DiscoveryProduct` that the assembler reads. Structural, drift-checked. */
export interface TrustedDiscoveryProduct {
  productId: string;
  brandId: string;
  brandName: string;
  price?: string;
  currency?: string;
  inventoryVerifiedAt: string;
  ownershipIdentity?: {
    brandId: string;
    brandName: string;
    ownershipVerificationStatus: string;
    publicOwnershipLabelAllowed: boolean;
    verifiedUntil: string;
  };
}

/** The minimal subset of the discovery engine's `DiscoveryResponse` that the assembler reads. */
export interface TrustedDiscoveryResult {
  status: 'ready' | 'empty' | 'unavailable';
  generatedAt: string;
  products: readonly TrustedDiscoveryProduct[];
}

export interface TrustedAssemblerFields {
  correlationId: string;
  taskState: TrustedTaskState;
  locale: string;
  /** Server-resolved stylist display name (already validated by the stylist identity layer). */
  stylistDisplayName: string;
  discovery?: TrustedDiscoveryResult | null;
  /** Observations derived from image analysis. Always treated as untrusted. */
  visualObservations?: readonly { label: string; confidence: 'low' | 'medium' | 'high' }[];
}

declare const sealBrand: unique symbol;
export type SealedAssemblerInput = Readonly<TrustedAssemblerFields> & { readonly [sealBrand]: true };

export type SealFailure =
  | 'not_object'
  | 'client_authority_attempt'
  | 'unknown_task_state_field'
  | 'unknown_discovery_field'
  | 'discovery_not_allowed_for_route'
  | 'too_many_products'
  | 'bad_discovery_shape'
  | 'bad_observation_shape'
  | 'bad_scalar';

const SEALED = new WeakSet<object>();
const TOP_KEYS = new Set(['correlationId', 'taskState', 'locale', 'stylistDisplayName', 'discovery', 'visualObservations']);
const STATE_KEYS = new Set(['route', 'adviceIntentResolved', 'discoveryStatus', 'groundedErrorClass']);
const DISCOVERY_KEYS = new Set(['status', 'generatedAt', 'products', 'version', 'canonicalCommerce', 'primaryOwnership']);

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
const str = (v: unknown): string | undefined => (typeof v === 'string' ? v : undefined);

/**
 * Copies a CLOSED set of fields from a server-built object and registers the copy as sealed. Anything outside the set
 * (a smuggled `verifiedFacts`, `ownership`, `userId`, ...) is a hard failure, not a silently ignored field.
 */
export function sealTrustedAssemblerInput(
  raw: unknown,
): { ok: true; input: SealedAssemblerInput } | { ok: false; reason: SealFailure } {
  if (!isRecord(raw)) return { ok: false, reason: 'not_object' };
  for (const key of Object.keys(raw)) if (!TOP_KEYS.has(key)) return { ok: false, reason: 'client_authority_attempt' };
  if (typeof raw.correlationId !== 'string' || typeof raw.locale !== 'string' || typeof raw.stylistDisplayName !== 'string') {
    return { ok: false, reason: 'bad_scalar' };
  }
  if (!isRecord(raw.taskState)) return { ok: false, reason: 'bad_scalar' };
  for (const key of Object.keys(raw.taskState)) if (!STATE_KEYS.has(key)) return { ok: false, reason: 'unknown_task_state_field' };
  const state = raw.taskState;
  const taskState: TrustedTaskState = {
    route: state.route as TrustedTaskState['route'],
    ...(state.adviceIntentResolved !== undefined ? { adviceIntentResolved: state.adviceIntentResolved as 'analysis' | 'none' } : {}),
    ...(state.discoveryStatus !== undefined ? { discoveryStatus: state.discoveryStatus as 'ready' | 'empty' | 'unavailable' } : {}),
    ...(state.groundedErrorClass !== undefined ? { groundedErrorClass: state.groundedErrorClass as string } : {}),
  };

  let discovery: TrustedDiscoveryResult | null = null;
  if (raw.discovery !== undefined && raw.discovery !== null) {
    if (state.route !== 'discovery') return { ok: false, reason: 'discovery_not_allowed_for_route' };
    const d = raw.discovery;
    if (!isRecord(d)) return { ok: false, reason: 'bad_discovery_shape' };
    for (const key of Object.keys(d)) if (!DISCOVERY_KEYS.has(key)) return { ok: false, reason: 'unknown_discovery_field' };
    if (!Array.isArray(d.products)) return { ok: false, reason: 'bad_discovery_shape' };
    if (d.products.length > MAX_INPUT_PRODUCTS) return { ok: false, reason: 'too_many_products' };
    const products: TrustedDiscoveryProduct[] = [];
    for (const p of d.products) {
      if (!isRecord(p)) return { ok: false, reason: 'bad_discovery_shape' };
      const o = isRecord(p.ownershipIdentity) ? p.ownershipIdentity : null;
      // Pick only what the assembler needs; titles, URLs, images and merchant prose never travel further.
      products.push({
        productId: str(p.productId) ?? '',
        brandId: str(p.brandId) ?? '',
        brandName: str(p.brandName) ?? '',
        ...(str(p.price) !== undefined ? { price: str(p.price) } : {}),
        ...(str(p.currency) !== undefined ? { currency: str(p.currency) } : {}),
        inventoryVerifiedAt: str(p.inventoryVerifiedAt) ?? '',
        ...(o
          ? {
            ownershipIdentity: {
              brandId: str(o.brandId) ?? '',
              brandName: str(o.brandName) ?? '',
              ownershipVerificationStatus: str(o.ownershipVerificationStatus) ?? '',
              publicOwnershipLabelAllowed: o.publicOwnershipLabelAllowed === true,
              verifiedUntil: str(o.verifiedUntil) ?? '',
            },
          }
          : {}),
      });
    }
    discovery = {
      status: d.status as TrustedDiscoveryResult['status'],
      generatedAt: str(d.generatedAt) ?? '',
      products,
    };
  }

  const observations: { label: string; confidence: 'low' | 'medium' | 'high' }[] = [];
  if (raw.visualObservations !== undefined) {
    if (!Array.isArray(raw.visualObservations)) return { ok: false, reason: 'bad_observation_shape' };
    for (const o of raw.visualObservations) {
      if (!isRecord(o) || typeof o.label !== 'string') return { ok: false, reason: 'bad_observation_shape' };
      observations.push({ label: o.label, confidence: o.confidence as 'low' | 'medium' | 'high' });
    }
  }

  const sealed = Object.freeze({
    correlationId: raw.correlationId,
    taskState: Object.freeze(taskState),
    locale: raw.locale,
    stylistDisplayName: raw.stylistDisplayName,
    discovery,
    visualObservations: Object.freeze(observations),
  }) as unknown as SealedAssemblerInput;
  SEALED.add(sealed);
  return { ok: true, input: sealed };
}

// ── Result types ────────────────────────────────────────────────────────────────

export type DropReason =
  | 'missing_or_unverified_ownership'
  | 'ownership_not_public'
  | 'ownership_brand_mismatch'
  | 'ownership_expired'
  | 'invalid_reference'
  | 'invalid_brand_name'
  | 'inventory_timestamp_invalid'
  | 'inventory_future_dated'
  | 'inventory_stale'
  | 'duplicate_product';

export type OmittedFactReason = 'price_unusable' | 'price_stale' | 'currency_unusable' | 'availability_stale';

export interface AssemblyDiagnostics {
  /** Counts only -- never merchant names, ids or any text. */
  droppedProducts: Partial<Record<DropReason, number>>;
  omittedFacts: Partial<Record<OmittedFactReason, number>>;
  droppedObservations: number;
  eligibleTotal: number;
  includedProducts: number;
  statusOverride: 'none' | 'ready_with_zero_eligible_became_empty' | 'ignored_products_for_non_ready_status';
}

export interface RenderedSections {
  /** Goes in the `trusted_server_context` section: ids, enums and server constants only -- no free text. */
  trustedServerContext: string;
  /** Goes in the untrusted `commerce_context` section: merchant display names (merchant-authored, escaped by the envelope). */
  commerceContext: string;
  /** Goes in the untrusted `visual_context` section. */
  visualContext: string;
}

export type AssemblyFailure =
  | 'unsealed_input'
  | 'invalid_input'
  | 'mode_unresolved'
  | 'ungrounded_error'
  | 'brief_budget_exceeded'
  | 'contract_rejected';

export type AssemblyResult =
  | { ok: true; task: CorporateTaskV1; sections: RenderedSections; diagnostics: AssemblyDiagnostics }
  | { ok: false; reason: AssemblyFailure; contractErrors?: ContractErrorCode[]; diagnostics: AssemblyDiagnostics };

const emptyDiagnostics = (): AssemblyDiagnostics => ({
  droppedProducts: {},
  omittedFacts: {},
  droppedObservations: 0,
  eligibleTotal: 0,
  includedProducts: 0,
  statusOverride: 'none',
});
const bump = <K extends string>(bag: Partial<Record<K, number>>, key: K) => {
  bag[key] = (bag[key] ?? 0) + 1;
};

// ── Validation helpers (conservative charsets: values are interpolated into the trusted brief) ────

const REF_RE = /^[A-Za-z0-9_-]{3,64}$/;
const CURRENCY_RE = /^[A-Z]{3}$/;
const PRICE_RE = /^[0-9][0-9.,]{0,14}$|^[$€£¥]\s?[0-9][0-9.,]{0,14}$/;
// deno-lint-ignore no-control-regex
const CONTROL_RE = /[\x00-\x1F\x7F]/;
const iso = (ms: number) => new Date(ms).toISOString();
const MS_PER_SECOND = 1_000;

function parseTime(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function cleanDisplayName(raw: string): string | null {
  const name = raw.replace(/\s+/g, ' ').trim();
  return name.length >= 1 && name.length <= 120 && !CONTROL_RE.test(name) ? name : null;
}

interface EligibleProduct {
  brandId: string;
  brandName: string;
  productId: string;
  verifiedUntilMs: number;
  inventoryMs: number;
  price?: string;
  currency?: string;
}

/** Seconds the label fact stays valid: never beyond the verification window, never beyond the kind ceiling. */
export function labelTtlSeconds(generatedMs: number, verifiedUntilMs: number): number {
  return Math.min(FACT_MAX_TTL_SECONDS.ownership_label, Math.floor((verifiedUntilMs - generatedMs) / MS_PER_SECOND));
}

function selectEligibleProducts(
  discovery: TrustedDiscoveryResult,
  nowMs: number,
  diagnostics: AssemblyDiagnostics,
): EligibleProduct[] | 'invalid' {
  const generatedMs = parseTime(discovery.generatedAt);
  if (generatedMs === null || generatedMs > nowMs + FUTURE_SKEW_MS) return 'invalid';
  const seen = new Set<string>();
  const eligible: EligibleProduct[] = [];
  for (const p of discovery.products) {
    const drop = (reason: DropReason) => bump(diagnostics.droppedProducts, reason);
    const o = p.ownershipIdentity;
    if (!o || o.ownershipVerificationStatus !== 'verified') { drop('missing_or_unverified_ownership'); continue; }
    if (o.publicOwnershipLabelAllowed !== true) { drop('ownership_not_public'); continue; }
    if (o.brandId !== p.brandId) { drop('ownership_brand_mismatch'); continue; }
    if (!REF_RE.test(p.brandId) || !REF_RE.test(p.productId)) { drop('invalid_reference'); continue; }
    const brandName = cleanDisplayName(p.brandName);
    if (brandName === null) { drop('invalid_brand_name'); continue; }
    const verifiedUntilMs = parseTime(o.verifiedUntil);
    // The label may not outlive its verification, and its window starts at the response time and is capped.
    if (verifiedUntilMs === null || verifiedUntilMs <= nowMs) { drop('ownership_expired'); continue; }
    const labelTtl = labelTtlSeconds(generatedMs, verifiedUntilMs);
    if (labelTtl < 1 || generatedMs + labelTtl * MS_PER_SECOND <= nowMs) { drop('ownership_expired'); continue; }
    const inventoryMs = parseTime(p.inventoryVerifiedAt);
    if (inventoryMs === null) { drop('inventory_timestamp_invalid'); continue; }
    if (inventoryMs > nowMs + FUTURE_SKEW_MS) { drop('inventory_future_dated'); continue; }
    if (inventoryMs + FACT_MAX_TTL_SECONDS.product_ref * MS_PER_SECOND <= nowMs) { drop('inventory_stale'); continue; }
    if (seen.has(p.productId)) { drop('duplicate_product'); continue; }
    seen.add(p.productId);
    eligible.push({ brandId: p.brandId, brandName, productId: p.productId, verifiedUntilMs, inventoryMs, price: p.price, currency: p.currency });
  }
  return eligible;
}

function buildFacts(
  products: readonly EligibleProduct[],
  generatedAt: string,
  nowMs: number,
  diagnostics: AssemblyDiagnostics,
): VerifiedFactRef[] {
  const facts: VerifiedFactRef[] = [];
  const generatedMs = Date.parse(generatedAt);
  const labelText = APPROVED_OWNERSHIP_LABELS[0];
  const seenBrands = new Set<string>();
  const cap = (kind: keyof typeof FACT_MAX_TTL_SECONDS) => FACT_MAX_TTL_SECONDS[kind];
  products.forEach((p, i) => {
    if (!seenBrands.has(p.brandId)) {
      seenBrands.add(p.brandId);
      const b = seenBrands.size - 1;
      const labelTtl = labelTtlSeconds(generatedMs, p.verifiedUntilMs);
      const base = { sourceSystem: 'black_owned_discovery' as const, merchantRef: p.brandId, observedAt: generatedAt, immutable: true as const };
      facts.push({ ...base, factId: `f_label_${b}`, kind: 'ownership_label', sourceRecordRef: `disc_${p.brandId}`, ttlSeconds: labelTtl, value: labelText });
      facts.push({ ...base, factId: `f_attr_${b}`, kind: 'merchant_attribution', sourceRecordRef: `disc_${p.brandId}`, ttlSeconds: cap('merchant_attribution'), value: p.brandName });
    }
    const observedAt = iso(p.inventoryMs);
    const commerceBase = { sourceSystem: 'black_owned_discovery' as const, merchantRef: p.brandId, productRef: p.productId, observedAt, immutable: true as const };
    facts.push({ ...commerceBase, factId: `f_prod_${i}`, kind: 'product_ref', sourceRecordRef: `disc_${p.productId}`, ttlSeconds: cap('product_ref'), value: p.productId });
    if (p.inventoryMs + cap('availability') * MS_PER_SECOND > nowMs) {
      facts.push({ ...commerceBase, factId: `f_avail_${i}`, kind: 'availability', sourceRecordRef: `disc_${p.productId}`, ttlSeconds: cap('availability'), value: 'in_stock' });
    } else {
      bump(diagnostics.omittedFacts, 'availability_stale');
    }
    // A price is only ever stated together with a provider-declared currency (never inferred or defaulted).
    const priceOk = typeof p.price === 'string' && PRICE_RE.test(p.price.trim());
    const currencyOk = typeof p.currency === 'string' && CURRENCY_RE.test(p.currency);
    if (!priceOk) bump(diagnostics.omittedFacts, 'price_unusable');
    else if (!currencyOk) bump(diagnostics.omittedFacts, 'currency_unusable');
    else if (p.inventoryMs + cap('price') * MS_PER_SECOND <= nowMs) bump(diagnostics.omittedFacts, 'price_stale');
    else {
      facts.push({ ...commerceBase, factId: `f_price_${i}`, kind: 'price', sourceRecordRef: `disc_${p.productId}`, ttlSeconds: cap('price'), value: (p.price as string).trim() });
      facts.push({ ...commerceBase, factId: `f_cur_${i}`, kind: 'currency', sourceRecordRef: `disc_${p.productId}`, ttlSeconds: cap('currency'), value: p.currency as string });
    }
  });
  return facts;
}

function cleanObservations(
  raw: readonly { label: string; confidence: 'low' | 'medium' | 'high' }[],
  diagnostics: AssemblyDiagnostics,
): VisualObservation[] {
  const out: VisualObservation[] = [];
  for (const o of raw) {
    const label = typeof o.label === 'string' ? o.label.replace(/\s+/g, ' ').trim() : '';
    const valid = label.length > 0 && label.length <= 120 && !CONTROL_RE.test(label) &&
      (o.confidence === 'low' || o.confidence === 'medium' || o.confidence === 'high') && out.length < 8;
    if (valid) out.push({ label, confidence: o.confidence, tier: 'untrusted_text' });
    else diagnostics.droppedObservations++;
  }
  return out;
}

// ── Rendering (existing envelope; trusted block carries no free text) ───────────

const NL = String.fromCharCode(10);
const expiryMs = (f: VerifiedFactRef) => Date.parse(f.observedAt) + f.ttlSeconds * MS_PER_SECOND;
/** Floors to the minute so the rendered window never overstates freshness. */
const minute = (ms: number) => `${iso(ms).slice(0, 16)}Z`;

function renderSections(task: CorporateTaskV1, observations: readonly VisualObservation[]): RenderedSections {
  const lines: string[] = [
    `corporate_task_brief version=${task.contractVersion} charter=${task.brandPolicyVersion} correlation=${task.correlationId}`,
    `task=${task.taskVerb} objective=${task.objectiveCode} surface=${task.surface} mode=${task.communicationMode} register=${task.presentationRegister} locale=${task.locale}`,
    `inventory=${task.inventory.status} eligible_products=${task.inventory.eligibleCount} output_max_tokens=${task.tokenBudget.outputMax}`,
    `forbidden_actions=${task.forbiddenActions.join(',')}`,
    `immutable_fields=${task.immutableFields.join(',')}`,
    `policy_refs=${task.policyRefs.join(',')}`,
    `read_capabilities=${task.allowedReadCapabilities.join(',')}`,
  ];
  const labelByMerchant = new Map<string, VerifiedFactRef>();
  for (const f of task.verifiedFacts) if (f.kind === 'ownership_label' && f.merchantRef) labelByMerchant.set(f.merchantRef, f);
  if (labelByMerchant.size > 0) lines.push(`approved_ownership_label=${JSON.stringify(APPROVED_OWNERSHIP_LABELS[0])}`);

  // A projection of the VALIDATED facts only. Merchant-authored text is referenced by id here and rendered separately.
  const merchantNames: string[] = [];
  for (const f of task.verifiedFacts) {
    if (f.kind !== 'merchant_attribution' || !f.merchantRef) continue;
    lines.push(`merchant id=${f.merchantRef} ownership_label=approved`);
    merchantNames.push(`merchant ref=${f.merchantRef} display_name=${f.value}`);
  }
  for (const p of task.verifiedFacts) {
    if (p.kind !== 'product_ref' || !p.merchantRef || !p.productRef) continue;
    const mine = task.verifiedFacts.filter((f) => f.merchantRef === p.merchantRef && f.productRef === p.productRef);
    const value = (kind: string) => mine.find((f) => f.kind === kind)?.value;
    const label = labelByMerchant.get(p.merchantRef);
    const until = Math.min(...mine.map(expiryMs), ...(label ? [expiryMs(label)] : []));
    const parts = [`product merchant=${p.merchantRef} id=${p.productRef}`];
    if (value('price') !== undefined) parts.push(`price=${JSON.stringify(value('price'))} currency=${value('currency')}`);
    if (value('availability') !== undefined) parts.push(`availability=${value('availability')}`);
    parts.push(`fresh_until=${minute(until)}`);
    lines.push(parts.join(' '));
  }
  lines.push(BRIEF_END_MARKER);
  return {
    trustedServerContext: lines.join(NL),
    commerceContext: merchantNames.join(NL),
    visualContext: observations.map((o) => `observation confidence=${o.confidence} text=${o.label}`).join(NL),
  };
}

/** Maps the rendered sections onto the EXISTING StyleChat assembly input so the envelope does all escaping/bounding. */
export function toStyleChatPromptInput(
  sections: RenderedSections,
  base: Pick<StyleChatPromptAssemblyInput, 'systemRules' | 'userMessage'>,
): StyleChatPromptAssemblyInput {
  return {
    ...base,
    trustedServerContext: sections.trustedServerContext,
    commerceContext: sections.commerceContext || null,
    visualContextBlock: sections.visualContext || null,
  };
}

/** Convenience: render through the real envelope. Used by tests to prove isolation properties end to end. */
export function renderThroughEnvelope(
  sections: RenderedSections,
  base: Pick<StyleChatPromptAssemblyInput, 'systemRules' | 'userMessage'>,
) {
  return assembleStyleChatPrompt(toStyleChatPromptInput(sections, base));
}

// ── The assembler ───────────────────────────────────────────────────────────────

export function assembleCorporateTaskContext(input: unknown, now: Date): AssemblyResult {
  const diagnostics = emptyDiagnostics();
  const fail = (reason: AssemblyFailure, contractErrors?: ContractErrorCode[]): AssemblyResult => ({
    ok: false,
    reason,
    ...(contractErrors ? { contractErrors } : {}),
    diagnostics,
  });
  if (input === null || typeof input !== 'object' || !SEALED.has(input)) return fail('unsealed_input');
  const nowMs = now.getTime();
  if (!Number.isFinite(nowMs)) return fail('invalid_input');
  const sealed = input as SealedAssemblerInput;

  // 1. Resolve eligibility from trusted discovery data BEFORE selecting the mode, so the mode reflects what survives.
  let state: TrustedTaskState = { ...sealed.taskState };
  let eligible: EligibleProduct[] = [];
  let generatedAt = '';
  if (state.route === 'discovery') {
    const discovery = sealed.discovery;
    if (!discovery) return fail('invalid_input');
    if (state.discoveryStatus !== undefined && state.discoveryStatus !== discovery.status) return fail('invalid_input');
    state = { ...state, discoveryStatus: discovery.status };
    if (discovery.status === 'ready') {
      const picked = selectEligibleProducts(discovery, nowMs, diagnostics);
      if (picked === 'invalid') return fail('invalid_input');
      eligible = picked;
      generatedAt = discovery.generatedAt;
      diagnostics.eligibleTotal = eligible.length;
      if (eligible.length === 0) {
        // A "ready" response whose records are all stale/ineligible is an empty result, not a shelf to describe.
        state = { ...state, discoveryStatus: 'empty' };
        diagnostics.statusOverride = 'ready_with_zero_eligible_became_empty';
      }
    } else if (discovery.products.length > 0) {
      // Products alongside an empty/unavailable status are inconsistent; they are never described.
      diagnostics.statusOverride = 'ignored_products_for_non_ready_status';
    }
  }

  // 2. Deterministic mode selection from trusted server state only.
  const selection = selectCommunicationMode(state);
  if (!selection.ok) return fail(selection.reason === 'ungrounded_error' ? 'ungrounded_error' : 'mode_unresolved');
  const policy = TASK_VERB_POLICY[selection.taskVerb];
  const surface = surfaceForRoute(state.route);
  if (surface === null || !policy.surfaces.includes(surface)) return fail('mode_unresolved');

  // 3. Facts (only for the merchant explanation), bounded to the brief budget.
  let included = selection.taskVerb === 'merchant_discovery_explanation' ? eligible.slice(0, MAX_BRIEF_PRODUCTS) : [];
  const observations = cleanObservations(sealed.visualObservations ?? [], diagnostics);

  const build = (products: readonly EligibleProduct[]): { task: CorporateTaskV1; sections: RenderedSections } => {
    const verifiedFacts = buildFacts(products, generatedAt, nowMs, diagnostics);
    const discoveryRoute = state.route === 'discovery';
    const inventory: CorporateTaskV1['inventory'] = !discoveryRoute || selection.taskVerb === 'grounded_error_recovery'
      ? { status: 'not_applicable', eligibleCount: 0 }
      : products.length > 0
      ? { status: 'eligible', eligibleCount: products.length }
      : { status: 'zero_eligible', eligibleCount: 0 };
    const task: CorporateTaskV1 = {
      contractVersion: CORPORATE_TASK_CONTRACT_VERSION,
      correlationId: sealed.correlationId,
      taskVerb: selection.taskVerb,
      objectiveCode: policy.objectiveCodes[0],
      surface,
      locale: sealed.locale,
      brandPolicyVersion: CORPORATE_CHARTER_VERSION,
      stylist: { displayName: sealed.stylistDisplayName },
      verifiedFacts,
      visualObservations: observations,
      policyRefs: [...POLICY_REFS_BY_VERB[selection.taskVerb]],
      forbiddenActions: [...REQUIRED_FORBIDDEN_ACTIONS],
      immutableFields: [...REQUIRED_IMMUTABLE_FIELDS],
      communicationMode: selection.mode,
      presentationRegister: selection.register,
      tokenBudget: {
        staticMax: TOKEN_BUDGET_TARGETS.staticMax,
        dynamicMax: TOKEN_BUDGET_TARGETS.dynamicMax,
        outputMax: OUTPUT_TOKEN_TARGETS[selection.register],
      },
      allowedReadCapabilities: [...ALLOWED_READ_CAPABILITIES],
      inventory,
      audit: { assembledAt: now.toISOString(), assemblerVersion: ASSEMBLER_VERSION, factCount: verifiedFacts.length },
      actionContractRef: null,
      capabilities: { proposable: [], executable: [] },
    };
    return { task, sections: renderSections(task, observations) };
  };

  // 4. Fit the trusted brief into the envelope's 2,000-character bound by describing fewer products, never by truncating.
  let built = build(included);
  while (built.sections.trustedServerContext.length > TRUSTED_BRIEF_CHAR_BUDGET && included.length > 1) {
    included = included.slice(0, included.length - 1);
    diagnostics.omittedFacts = {};
    built = build(included);
  }
  if (built.sections.trustedServerContext.length > TRUSTED_BRIEF_CHAR_BUDGET) return fail('brief_budget_exceeded');
  diagnostics.includedProducts = included.length;

  // 5. Defence in depth: the strict contract must accept what we assembled.
  const verdict = validateCorporateTaskV1(built.task, now);
  if (!verdict.ok) return fail('contract_rejected', verdict.errors);
  return { ok: true, task: built.task, sections: built.sections, diagnostics };
}
