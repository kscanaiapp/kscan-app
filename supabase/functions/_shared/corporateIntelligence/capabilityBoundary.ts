/**
 * CI-05 — Option C compatibility layer (OFFLINE SPECIFICATION, NON-EXECUTING).
 *
 * Defines, versions and tests the boundary a future Option C would have to
 * cross, so that boundary exists and is tested BEFORE any executor exists:
 *   - a closed capability registry with classes and permission requirements;
 *   - server-authoritative approval requirements;
 *   - the Option B guarantee: whatever the inputs, nothing is executable.
 *
 * Option B is the active implementation. `OPTION_B_ACTIVE` is the literal type
 * `true`, `proposable` / `executable` capability arrays are always empty, and
 * `evaluateExecutionEligibility` can only return `executable: false`. No
 * runtime module may import this file (boundaries test: exact importer set).
 *
 * The model proposes language; the server controls facts and permitted
 * behavior. Model output can never be an approval, a permission or a
 * completion record.
 */
import { rejectForbiddenModelShape } from '../aiSecurity/outputValidation.ts';

export const CAPABILITY_BOUNDARY_VERSION = 'capability-boundary-v1-draft' as const;
export const ACTION_PROPOSAL_V2_CONTRACT_VERSION = 'action-proposal-v2-draft' as const;
export const OPTION_B_ACTIVE = true as const;

// ── Capability registry (closed) ────────────────────────────────────────────────

export type CapabilityClass =
  /** Text-only recommendation derived from verified facts. Permitted in Option B. */
  | 'read_only_recommendation'
  /** Opens an existing app screen; the app renders the control and the USER taps it. */
  | 'app_navigation'
  /** Changes K Scan state for the actor (closet, watchlist, preferences). */
  | 'account_mutation'
  /** Leaves K Scan (messages, merchant registration, third-party calls). */
  | 'external_effect'
  /** Moves money or commits to a purchase. */
  | 'financial';

export type Permission =
  | 'authenticated_non_anonymous'
  | 'ai_processing_consent'
  | 'account_active'
  | 'kplus_entitlement'
  | 'fresh_reauthentication';

export type ApprovalRequirement =
  /** Nothing to approve: no state change. */
  | 'none'
  /** Authenticated, app-rendered control tapped by the user. Never satisfiable by text. */
  | 'app_control_tap'
  /** Tap plus recent re-authentication (e.g. payment, account changes). */
  | 'app_control_tap_plus_reauth';

export interface CapabilityDefinitionV1 {
  id: string;
  class: CapabilityClass;
  requiredPermissions: readonly Permission[];
  approval: ApprovalRequirement;
  /** Who may perform it. Only the server, never the model. */
  executionAuthority: 'server_only' | 'not_applicable';
  /** What Option B allows: read-only text, an app-rendered control, or nothing. */
  optionB: 'text_only' | 'app_control_only' | 'not_available';
}

const def = (d: CapabilityDefinitionV1) => Object.freeze({ ...d, requiredPermissions: Object.freeze([...d.requiredPermissions]) });

export const CAPABILITY_REGISTRY_V1: Readonly<Record<string, CapabilityDefinitionV1>> = Object.freeze({
  // Read-only recommendations (Option B: text only)
  recommend_styling: def({ id: 'recommend_styling', class: 'read_only_recommendation', requiredPermissions: ['authenticated_non_anonymous', 'ai_processing_consent'], approval: 'none', executionAuthority: 'not_applicable', optionB: 'text_only' }),
  explain_verified_fact: def({ id: 'explain_verified_fact', class: 'read_only_recommendation', requiredPermissions: ['authenticated_non_anonymous', 'ai_processing_consent'], approval: 'none', executionAuthority: 'not_applicable', optionB: 'text_only' }),
  compare_visible_items: def({ id: 'compare_visible_items', class: 'read_only_recommendation', requiredPermissions: ['authenticated_non_anonymous', 'ai_processing_consent'], approval: 'none', executionAuthority: 'not_applicable', optionB: 'text_only' }),
  // Existing app-controlled navigation (StyleChat structured actions): the app renders, the user taps.
  open_stylist: def({ id: 'open_stylist', class: 'app_navigation', requiredPermissions: ['authenticated_non_anonymous'], approval: 'app_control_tap', executionAuthority: 'server_only', optionB: 'app_control_only' }),
  open_look: def({ id: 'open_look', class: 'app_navigation', requiredPermissions: ['authenticated_non_anonymous'], approval: 'app_control_tap', executionAuthority: 'server_only', optionB: 'app_control_only' }),
  // Future Option C mutations / effects: NOT available in Option B.
  save_item_to_closet: def({ id: 'save_item_to_closet', class: 'account_mutation', requiredPermissions: ['authenticated_non_anonymous', 'account_active'], approval: 'app_control_tap', executionAuthority: 'server_only', optionB: 'not_available' }),
  add_to_watchlist: def({ id: 'add_to_watchlist', class: 'account_mutation', requiredPermissions: ['authenticated_non_anonymous', 'account_active', 'kplus_entitlement'], approval: 'app_control_tap', executionAuthority: 'server_only', optionB: 'not_available' }),
  edit_account: def({ id: 'edit_account', class: 'account_mutation', requiredPermissions: ['authenticated_non_anonymous', 'account_active', 'fresh_reauthentication'], approval: 'app_control_tap_plus_reauth', executionAuthority: 'server_only', optionB: 'not_available' }),
  send_external_message: def({ id: 'send_external_message', class: 'external_effect', requiredPermissions: ['authenticated_non_anonymous', 'account_active'], approval: 'app_control_tap', executionAuthority: 'server_only', optionB: 'not_available' }),
  register_merchant: def({ id: 'register_merchant', class: 'external_effect', requiredPermissions: ['authenticated_non_anonymous', 'account_active', 'fresh_reauthentication'], approval: 'app_control_tap_plus_reauth', executionAuthority: 'server_only', optionB: 'not_available' }),
  open_checkout: def({ id: 'open_checkout', class: 'financial', requiredPermissions: ['authenticated_non_anonymous', 'account_active'], approval: 'app_control_tap_plus_reauth', executionAuthority: 'server_only', optionB: 'not_available' }),
  purchase: def({ id: 'purchase', class: 'financial', requiredPermissions: ['authenticated_non_anonymous', 'account_active', 'fresh_reauthentication'], approval: 'app_control_tap_plus_reauth', executionAuthority: 'server_only', optionB: 'not_available' }),
});

export const CAPABILITY_IDS: readonly string[] = Object.freeze(Object.keys(CAPABILITY_REGISTRY_V1));

// ── Option B capability exposure ────────────────────────────────────────────────

export interface ActorContext {
  actorId: string;
  permissions: readonly Permission[];
}

/**
 * The capabilities the model may be TOLD about. In Option B this is ALWAYS
 * `{ proposable: [], executable: [] }`, whatever the actor holds — matching
 * `CorporateTaskV1.capabilities`. Read-only text needs no capability.
 */
export function capabilitiesForTask(_actor: ActorContext): { proposable: readonly never[]; executable: readonly never[] } {
  return { proposable: Object.freeze([]) as readonly never[], executable: Object.freeze([]) as readonly never[] };
}

// ── Proposal contract v2 (versioned; parse-only) ────────────────────────────────

export interface ActionProposalV2 {
  contractVersion: typeof ACTION_PROPOSAL_V2_CONTRACT_VERSION;
  /** Server-generated, single-use. */
  proposalId: string;
  capabilityId: string;
  /** Typed scalars only. Never an actor id, token, price or ownership value. */
  arguments: Readonly<Record<string, string | number | boolean>>;
  /** Opaque references to authoritative records the arguments were validated against. */
  sourceRefs: readonly string[];
  status: 'proposed';
  expiresAt: string;
}

export type ProposalV2Error =
  | 'not_object' | 'unknown_field' | 'bad_version' | 'bad_proposal_id' | 'unknown_capability'
  | 'capability_not_proposable_in_option_b' | 'bad_arguments' | 'forbidden_argument' | 'forbidden_shape'
  | 'status_not_proposed' | 'completion_claim' | 'approval_claim' | 'bad_expiry' | 'expired';

const PROPOSAL_KEYS = new Set(['contractVersion', 'proposalId', 'capabilityId', 'arguments', 'sourceRefs', 'status', 'expiresAt']);
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;
/** Argument names that would let a proposal smuggle authority. */
const FORBIDDEN_ARGUMENT_RE = /^(actor_?id|user_?id|owner|ownership|verified|approved|approval|token|session|price|amount|currency|permission|role|scope|confirm(ed)?|executed?)$/i;

export function parseActionProposalV2(input: unknown, now: Date): { ok: true; value: ActionProposalV2 } | { ok: false; errors: ProposalV2Error[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return { ok: false, errors: ['not_object'] };
  const rec = input as Record<string, unknown>;
  const errors = new Set<ProposalV2Error>();
  for (const k of Object.keys(rec)) {
    if (!PROPOSAL_KEYS.has(k)) errors.add(/approv|authoriz|confirm/i.test(k) ? 'approval_claim' : 'unknown_field');
  }
  if (rec.contractVersion !== ACTION_PROPOSAL_V2_CONTRACT_VERSION) errors.add('bad_version');
  if (typeof rec.proposalId !== 'string' || !PROPOSAL_ID_RE.test(rec.proposalId)) errors.add('bad_proposal_id');
  const cap = typeof rec.capabilityId === 'string' ? CAPABILITY_REGISTRY_V1[rec.capabilityId] : undefined;
  if (!cap) errors.add('unknown_capability');
  // Option B: nothing is proposable — not even navigation, which the APP renders from its own validated actions.
  else if (OPTION_B_ACTIVE) errors.add('capability_not_proposable_in_option_b');
  if (rec.status !== 'proposed') {
    errors.add(typeof rec.status === 'string' && /execut|confirm|complet|done|success/i.test(rec.status) ? 'completion_claim' : 'status_not_proposed');
  }
  const args = rec.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) errors.add('bad_arguments');
  else {
    for (const [k, v] of Object.entries(args as Record<string, unknown>)) {
      if (FORBIDDEN_ARGUMENT_RE.test(k)) errors.add('forbidden_argument');
      if (!['string', 'number', 'boolean'].includes(typeof v)) errors.add('bad_arguments');
    }
    if (!rejectForbiddenModelShape(args).ok) errors.add('forbidden_shape');
  }
  if (!Array.isArray(rec.sourceRefs) || rec.sourceRefs.some((r) => typeof r !== 'string' || !r)) errors.add('bad_arguments');
  const exp = typeof rec.expiresAt === 'string' ? Date.parse(rec.expiresAt) : NaN;
  if (!Number.isFinite(exp)) errors.add('bad_expiry');
  else if (exp <= now.getTime()) errors.add('expired');
  return errors.size === 0 ? { ok: true, value: rec as unknown as ActionProposalV2 } : { ok: false, errors: [...errors].sort() };
}

// ── Server-authoritative approval requirements ──────────────────────────────────

/** An approval is a SERVER record created from an authenticated app event. It is never parsed from model output. */
export interface ServerApprovalRecord {
  source: 'app_control_event';
  proposalId: string;
  actorId: string;
  capabilityId: string;
  argumentsHash: string;
  approvedAt: string;
  expiresAt: string;
  reauthenticatedAt?: string;
  consumed: boolean;
}

export type ExecutionDenial =
  | 'option_b_non_executing'
  | 'no_server_approval'
  | 'approval_not_from_app'
  | 'actor_mismatch'
  | 'capability_mismatch'
  | 'arguments_changed'
  | 'approval_expired'
  | 'approval_replayed'
  | 'missing_permission'
  | 'reauthentication_required'
  | 'capability_not_available';

export type ExecutionEligibility = { executable: false; denials: readonly ExecutionDenial[] };

/**
 * The future gate between AUTHORIZED and EXECUTED, specified now so its checks
 * are tested. Every requirement is evaluated (all denials reported). Under
 * Option B the result is ALWAYS non-executable — even a fully valid approval
 * only removes the other denials; `option_b_non_executing` always remains.
 */
export function evaluateExecutionEligibility(input: {
  proposal: ActionProposalV2 | null;
  approval: ServerApprovalRecord | null;
  actor: ActorContext;
  argumentsHash: string;
  now: Date;
  reauthWindowMs?: number;
}): ExecutionEligibility {
  const denials = new Set<ExecutionDenial>(['option_b_non_executing']);
  const cap = input.proposal ? CAPABILITY_REGISTRY_V1[input.proposal.capabilityId] : undefined;
  if (!cap || cap.optionB === 'not_available' || cap.executionAuthority !== 'server_only') denials.add('capability_not_available');
  const a = input.approval;
  if (!a) denials.add('no_server_approval');
  else {
    if (a.source !== 'app_control_event') denials.add('approval_not_from_app');
    if (a.actorId !== input.actor.actorId) denials.add('actor_mismatch');
    if (!input.proposal || a.proposalId !== input.proposal.proposalId || a.capabilityId !== input.proposal.capabilityId) denials.add('capability_mismatch');
    if (a.argumentsHash !== input.argumentsHash) denials.add('arguments_changed');
    const exp = Date.parse(a.expiresAt);
    if (!Number.isFinite(exp) || exp <= input.now.getTime()) denials.add('approval_expired');
    if (a.consumed) denials.add('approval_replayed');
    if (cap?.approval === 'app_control_tap_plus_reauth') {
      const re = a.reauthenticatedAt ? Date.parse(a.reauthenticatedAt) : NaN;
      if (!Number.isFinite(re) || input.now.getTime() - re > (input.reauthWindowMs ?? 5 * 60_000)) denials.add('reauthentication_required');
    }
  }
  for (const p of cap?.requiredPermissions ?? []) if (!input.actor.permissions.includes(p)) denials.add('missing_permission');
  return { executable: false, denials: Object.freeze([...denials].sort()) };
}

// ── Completion claims in prose (Option B) ───────────────────────────────────────

/**
 * A narrow, conservative screen used by tests to show Option B text never
 * reports a completed action. The production check is CI-03's validator
 * (`unexecuted_action_claim`); this helper documents the cases.
 */
export const COMPLETION_CLAIM_RE = /\b(i(?:'ve| have)?|we(?:'ve| have)?)\s+(?:just\s+)?(?:added|saved|bought|purchased|ordered|booked|placed|sent|registered|updated|changed|deleted)\b|\b(?:done|all set)[!.]\s/i;
