/**
 * Option C action-proposal interface -- OFFLINE SPECIFICATION ONLY.
 *
 * Nothing here executes, authorizes or persists anything. It exists so the future boundary
 * (PROPOSED -> VALIDATED -> AUTHORIZED -> EXECUTED -> CONFIRMED, plus DENIED/CANCELLED/FAILED/EXPIRED) is
 * type-checked and tested before any executor is designed. No runtime module may import this file in
 * Option B (enforced by isolation.test.ts). A proposal NEVER confers permission.
 */
import { rejectForbiddenModelShape } from '../aiSecurity/outputValidation.ts';

export const ACTION_PROPOSAL_CONTRACT_VERSION = 'action-proposal-v1-draft' as const;

export const ACTION_STATES = [
  'proposed', 'validated', 'authorized', 'executed', 'confirmed',
  'denied', 'cancelled', 'failed', 'expired',
] as const;
export type ActionState = (typeof ACTION_STATES)[number];

/** The only legal edges. EXECUTED is reachable solely from AUTHORIZED, and CONFIRMED solely from EXECUTED. */
export const ACTION_TRANSITIONS: Readonly<Record<ActionState, readonly ActionState[]>> = Object.freeze({
  proposed: ['validated', 'denied', 'cancelled', 'expired'],
  validated: ['authorized', 'denied', 'cancelled', 'expired'],
  authorized: ['executed', 'cancelled', 'expired', 'failed'],
  executed: ['confirmed', 'failed'],
  confirmed: [],
  denied: [],
  cancelled: [],
  failed: [],
  expired: [],
});

export function isLegalTransition(from: ActionState, to: ActionState): boolean {
  return ACTION_TRANSITIONS[from].includes(to);
}

export type ConfirmationPolicy = 'explicit_user_tap' | 'explicit_user_tap_plus_reauth';

/** Draft capability ids; documenting them grants nothing. The Option B runtime exposes none of them. */
export const DRAFT_CAPABILITY_IDS = ['save_item_to_closet', 'add_to_watchlist', 'open_checkout'] as const;

export interface ActionProposalV1 {
  proposalId: string;
  contractVersion: typeof ACTION_PROPOSAL_CONTRACT_VERSION;
  capabilityId: string;
  /** Typed scalars only; no nested executable shapes. */
  arguments: Record<string, string | number | boolean>;
  /** Non-sensitive opaque references to authoritative records. */
  sourceRefs: readonly string[];
  confirmationPolicy: ConfirmationPolicy;
  expiresAt: string;
  status: 'proposed';
}

export type ProposalParseError =
  | 'not_object'
  | 'unknown_field'
  | 'bad_version'
  | 'bad_proposal_id'
  | 'unknown_capability'
  | 'bad_arguments'
  | 'forbidden_shape'
  | 'bad_confirmation_policy'
  | 'bad_expiry'
  | 'expired'
  | 'status_not_proposed'
  | 'executed_claim';

const KEYS: ReadonlySet<string> = new Set([
  'proposalId', 'contractVersion', 'capabilityId', 'arguments', 'sourceRefs',
  'confirmationPolicy', 'expiresAt', 'status',
]);
const PROPOSAL_ID_RE = /^[A-Za-z0-9_-]{16,80}$/;

/** Offline parser. Rejects anything that is not a fresh, inert, status:"proposed" record. */
export function parseActionProposalOffline(
  input: unknown,
  now: Date = new Date(),
): { ok: true; value: ActionProposalV1 } | { ok: false; errors: ProposalParseError[] } {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    return { ok: false, errors: ['not_object'] };
  }
  const rec = input as Record<string, unknown>;
  const errors = new Set<ProposalParseError>();
  for (const key of Object.keys(rec)) if (!KEYS.has(key)) errors.add('unknown_field');

  if (rec.contractVersion !== ACTION_PROPOSAL_CONTRACT_VERSION) errors.add('bad_version');
  if (typeof rec.proposalId !== 'string' || !PROPOSAL_ID_RE.test(rec.proposalId)) errors.add('bad_proposal_id');
  if (!(DRAFT_CAPABILITY_IDS as readonly string[]).includes(String(rec.capabilityId))) errors.add('unknown_capability');
  if (rec.status !== 'proposed') {
    errors.add(
      typeof rec.status === 'string' && ['executed', 'confirmed', 'authorized'].includes(rec.status)
        ? 'executed_claim'
        : 'status_not_proposed',
    );
  }
  if (!['explicit_user_tap', 'explicit_user_tap_plus_reauth'].includes(String(rec.confirmationPolicy))) {
    errors.add('bad_confirmation_policy');
  }

  const args = rec.arguments;
  if (args === null || typeof args !== 'object' || Array.isArray(args)) {
    errors.add('bad_arguments');
  } else {
    for (const value of Object.values(args as Record<string, unknown>)) {
      const t = typeof value;
      if (t !== 'string' && t !== 'number' && t !== 'boolean') errors.add('bad_arguments');
    }
    if (!rejectForbiddenModelShape(args).ok) errors.add('forbidden_shape');
  }
  if (!Array.isArray(rec.sourceRefs) || rec.sourceRefs.some((r) => typeof r !== 'string' || !r)) {
    errors.add('bad_arguments');
  }

  const expires = typeof rec.expiresAt === 'string' ? Date.parse(rec.expiresAt) : NaN;
  if (!Number.isFinite(expires)) errors.add('bad_expiry');
  else if (expires <= now.getTime()) errors.add('expired');

  return errors.size === 0
    ? { ok: true, value: rec as unknown as ActionProposalV1 }
    : { ok: false, errors: [...errors].sort() };
}
