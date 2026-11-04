import {
  type Actor,
  canonical,
  hash,
  type Proposal,
  type Target,
  uuid,
} from "../customerAuthorization/contracts.ts";
import type { Database, Sql } from "../customerAuthorization/repository.ts";
import type { PolicyDecision } from "../customerAuthorization/service.ts";
import type { RecommendedProduct } from "../../../scan-identify/shoppingProvider.ts";

export const EXECUTION_VERSION = "oc03-watch-save-v1" as const;
export const EXECUTABLE_CAPABILITIES = Object.freeze(
  ["save_watchlist"] as const,
);
export const EXECUTION_RATE = 20;
export type State =
  | "reserved"
  | "executing"
  | "completed"
  | "failed_no_effect"
  | "outcome_uncertain"
  | "reconciled";
export type Effect = "none" | "created" | "already_watched";
export type Code =
  | "disabled"
  | "unauthorized"
  | "invalid_request"
  | "not_found"
  | "authorization_invalid"
  | "unsupported_capability"
  | "target_changed"
  | "unsupported_listing"
  | "confirmation_required"
  | "existing_watch_change_requires_approval"
  | "watch_limit"
  | "rate_limited"
  | "storage_unavailable"
  | "no_commit_evidence"
  | "watch_changed"
  | "mutation_unverified"
  | "conflict";
export class ExecutionError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
export function ensure(condition: unknown, code: Code): asserts condition {
  if (!condition) throw new ExecutionError(code);
}
export type VerifiedProduct = { target: Target; listing: RecommendedProduct };
export type WatchSpec = {
  version: typeof EXECUTION_VERSION;
  source: "farfetch" | "kickscrew";
  canonicalUrl: string;
  providerListingId: string;
  title: string;
  imageUrl: string | null;
  initialPrice: number;
  currency: string;
  watchIntent: "just_watching";
  targetPrice: null;
};
export type Binding = {
  proposal_id: string;
  actor_id: string;
  account_id: string;
  snapshot_hash: string;
  binding: WatchSpec;
  binding_hash: string;
  approved_revision: number | null;
  approval_operation_id: string | null;
};
export type Command = {
  proposalId: string;
  handoffId: string;
  proposalRevision: number;
  snapshotHash: string;
  bindingHash: string;
  requestId: string;
};
export type WatchRow = {
  id: string;
  user_id: string;
  source: string;
  canonical_url: string;
  watch_intent: string;
  target_price_amount: string | number | null;
  currency: string;
  status: string;
  deleted_at: string | null;
  row_version: string | number;
};
export type Evidence = {
  watchId: string;
  userId: string;
  source: string;
  canonicalUrl: string;
  intent: "just_watching";
  targetPrice: null;
  currency: string;
  rowVersion: number;
  bindingHash: string;
  observedAt: number;
};
export type Ledger = {
  proposal_id: string;
  actor_id: string;
  account_id: string;
  handoff_id: string;
  proposal_revision: number;
  snapshot_hash: string;
  binding_hash: string;
  request_id: string;
  state: State;
  effect: Effect;
  reason: Code | null;
  watch_id: string | null;
  evidence: Evidence | null;
  evidence_hash: string | null;
  revision: number;
};
export type Status = {
  version: typeof EXECUTION_VERSION;
  proposalId: string;
  state: State;
  effect: Effect;
  reason: Code | null;
  canClaimCompletion: boolean;
  watchId: string | null;
  observedAt: number;
};
export type Guards = {
  /** Must lock current account, consent, permission/entitlement source rows on THIS transaction connection. No REST/model/provider I/O. */
  lockAuthorization: (
    sql: Sql,
    actor: Actor,
  ) => Promise<PolicyDecision & { accountActive: boolean }>;
  /** Resolve the existing authoritative record by immutable target identity; lock its revision/eligibility source rows. */
  lockProduct: (
    sql: Sql,
    actor: Actor,
    target: Readonly<Target>,
  ) => Promise<VerifiedProduct>;
};
export type Dependencies = Guards & {
  database: Database;
  enabled?: () => boolean;
  authorizationEnabled?: () => boolean;
  authenticate: (request: Request) => Promise<Actor>;
  verifyExecutionPrincipal: (request: Request) => Promise<void>;
  verifyCustomerOperation: (request: Request) => Promise<void>;
  emit?: (
    event: {
      version: typeof EXECUTION_VERSION;
      state: State;
      effect: Effect;
      reason: Code | null;
    },
  ) => void;
};
export function parseCommand(value: unknown): Command {
  ensure(
    value && typeof value === "object" && !Array.isArray(value),
    "invalid_request",
  );
  const c = value as Record<string, unknown>;
  ensure(
    Object.keys(c).every((k) =>
      [
        "proposalId",
        "handoffId",
        "proposalRevision",
        "snapshotHash",
        "bindingHash",
        "requestId",
      ].includes(k)
    ),
    "invalid_request",
  );
  ensure(
    uuid(c.proposalId) && uuid(c.handoffId) && uuid(c.requestId) &&
      Number.isSafeInteger(c.proposalRevision) &&
      (c.proposalRevision as number) >= 3 &&
      typeof c.snapshotHash === "string" &&
      /^[a-f0-9]{64}$/.test(c.snapshotHash) &&
      typeof c.bindingHash === "string" && /^[a-f0-9]{64}$/.test(c.bindingHash),
    "invalid_request",
  );
  return structuredClone(c) as Command;
}
export function verifyCommand(ledger: Ledger, actor: Actor, c: Command) {
  ensure(
    ledger.actor_id === actor.actorId && ledger.account_id === actor.accountId,
    "unauthorized",
  );
  ensure(
    ledger.proposal_id === c.proposalId && ledger.handoff_id === c.handoffId &&
      ledger.proposal_revision === c.proposalRevision &&
      ledger.snapshot_hash === c.snapshotHash &&
      ledger.binding_hash === c.bindingHash,
    "conflict",
  );
}
export function sameIdentity(a: Target, b: Target): boolean {
  const project = (t: Target) => ({
    kind: t.kind,
    recordId: t.recordId,
    productId: t.productId,
    accountId: t.accountId,
    revision: t.revision,
    provenance: {
      provider: t.provenance.provider,
      sourceId: t.provenance.sourceId,
    },
  });
  return canonical(project(a)) === canonical(project(b));
}
export async function verifyEvidence(ledger: Ledger): Promise<boolean> {
  return ledger.evidence !== null &&
    ledger.evidence_hash === await hash(ledger.evidence) &&
    ledger.evidence.watchId === ledger.watch_id &&
    ledger.evidence.userId === ledger.actor_id &&
    ledger.evidence.bindingHash === ledger.binding_hash;
}
export function assertExecutable(p: Proposal, actor: Actor) {
  ensure(p.snapshot.capability === "save_watchlist", "unsupported_capability");
  ensure(
    p.snapshot.actorId === actor.actorId &&
      p.snapshot.accountId === actor.accountId,
    "unauthorized",
  );
  ensure(
    Object.keys(p.snapshot.arguments).length === 1 &&
      typeof p.snapshot.arguments.targetRef === "string",
    "authorization_invalid",
  );
}
