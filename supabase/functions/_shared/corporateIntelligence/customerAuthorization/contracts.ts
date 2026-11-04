import type { Product } from "../readOnlyTools/products.ts";

export const VERSION = "oc02-authorization-v1" as const;
export const POLICY = "oc02-policy-v1" as const;
export const MAX_PROPOSAL_MS = 120_000;
export const RETENTION_MS = 7 * 86_400_000;
export const RATE_PER_MINUTE = 30;
const definition = (kind: Target["kind"], entitlement: boolean) =>
  Object.freeze({
    kind,
    entitlement,
    consent: "current_ai_processing",
    account: "active",
    confirmation: "authenticated_customer_operation",
    maxAgeMs: 30_000,
    idempotency: "actor_account_operation",
    execution: false,
  });
export const REGISTRY = Object.freeze({
  save_watchlist: definition("product", true),
  save_closet: definition("product", false),
  update_saved_preference: definition("saved_product", false),
  pause_watch: definition("watch", true),
  remove_watch: definition("watch", false),
});
export type Capability = keyof typeof REGISTRY;
export type State =
  | "proposed"
  | "awaiting_customer_approval"
  | "approved"
  | "rejected"
  | "expired"
  | "revoked"
  | "consumed";
export const EDGES: Readonly<Record<State, readonly State[]>> = Object.freeze({
  proposed: Object.freeze(
    ["awaiting_customer_approval", "expired", "revoked"] as State[],
  ),
  awaiting_customer_approval: Object.freeze(
    [
      "awaiting_customer_approval",
      "approved",
      "rejected",
      "expired",
      "revoked",
    ] as State[],
  ),
  approved: Object.freeze(["consumed", "expired", "revoked"] as State[]),
  rejected: Object.freeze([]),
  expired: Object.freeze([]),
  revoked: Object.freeze([]),
  consumed: Object.freeze([]),
});
export type Scope = { actorId: string; accountId: string };
export type Actor = Scope & { anonymous: boolean };
export type Intent = {
  version: typeof VERSION;
  capability: Capability;
  arguments: {
    targetRef: string;
    preference?: "notify_price_drop" | "notify_restock" | "none";
  };
};
/** Resolver must rehydrate OC-01 refs to authorized durable records; provider cards alone are insufficient. */
export type Target = {
  kind: "product" | "saved_product" | "watch";
  recordId: string;
  productId: string;
  accountId: string | null;
  revision: string;
  checkedAt: number;
  validUntil: number;
  provenance: Pick<Product["provenance"], "provider" | "sourceId">;
};
export type Snapshot = {
  version: typeof VERSION;
  policy: typeof POLICY;
  id: string;
  actorId: string;
  accountId: string;
  capability: Capability;
  arguments: Intent["arguments"];
  target: Target;
  permissionRevision: string;
  createdAt: number;
  expiresAt: number;
  retainUntil: number;
};
export type Proposal = {
  snapshot: Snapshot;
  snapshotHash: string;
  state: State;
  revision: number;
  challengeHash: string | null;
  updatedAt: number;
};
export type Code =
  | "disabled"
  | "invalid_request"
  | "unknown_capability"
  | "unauthorized"
  | "not_found"
  | "stale_target"
  | "target_changed"
  | "policy_changed"
  | "expired"
  | "conflict"
  | "illegal_transition"
  | "idempotency_conflict"
  | "rate_limited"
  | "invalid_confirmation"
  | "storage_failure";
export class AuthorizationError extends Error {
  readonly code: Code;
  constructor(code: Code) {
    super(code);
    this.code = code;
  }
}
export function requireValue(
  condition: unknown,
  code: Code,
): asserts condition {
  if (!condition) throw new AuthorizationError(code);
}
export const uuid = (v: unknown): v is string =>
  typeof v === "string" &&
  /^[a-f0-9]{8}-[a-f0-9]{4}-4[a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i.test(
    v,
  );
export function object(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> {
  requireValue(
    value && typeof value === "object" && !Array.isArray(value) &&
      Object.getPrototypeOf(value) === Object.prototype,
    "invalid_request",
  );
  const v = value as Record<string, unknown>;
  requireValue(
    Object.keys(v).every((k) => keys.includes(k)),
    "invalid_request",
  );
  return v;
}
export function parseIntent(value: unknown): Intent {
  const v = object(value, ["version", "capability", "arguments"]);
  requireValue(v.version === VERSION, "invalid_request");
  requireValue(
    typeof v.capability === "string" && Object.hasOwn(REGISTRY, v.capability),
    "unknown_capability",
  );
  const a = object(v.arguments, [
    "targetRef",
    ...(v.capability === "update_saved_preference" ? ["preference"] : []),
  ]);
  requireValue(
    typeof a.targetRef === "string" &&
      /^(p|saved|watch)_[a-f0-9-]{36}$/.test(a.targetRef),
    "invalid_request",
  );
  const prefix = REGISTRY[v.capability as Capability].kind === "product"
    ? "p_"
    : REGISTRY[v.capability as Capability].kind === "watch"
    ? "watch_"
    : "saved_";
  requireValue(a.targetRef.startsWith(prefix), "invalid_request");
  requireValue(uuid(a.targetRef.slice(prefix.length)), "invalid_request");
  if (v.capability === "update_saved_preference") {
    requireValue(
      ["notify_price_drop", "notify_restock", "none"].includes(
        a.preference as string,
      ),
      "invalid_request",
    );
  }
  return structuredClone(v) as Intent;
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${
      Object.entries(value).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map((
        [k, v],
      ) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")
    }}`;
  }
  return JSON.stringify(value);
}
export async function hash(value: unknown): Promise<string> {
  const bytes = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(canonical(value)),
  );
  return Array.from(
    new Uint8Array(bytes),
    (b) => b.toString(16).padStart(2, "0"),
  ).join("");
}
export function checkTarget(
  target: Target,
  intent: Intent,
  scope: Scope,
  now: number,
) {
  const def = REGISTRY[intent.capability];
  requireValue(
    target && target.kind === def.kind && typeof target.recordId === "string" &&
      target.recordId.length > 0 && target.recordId.length <= 160 &&
      typeof target.productId === "string" && target.productId.length > 0 &&
      target.productId.length <= 160 &&
      typeof target.revision === "string" && target.revision.length > 0 &&
      target.revision.length <= 160,
    "stale_target",
  );
  requireValue(
    target.accountId === null
      ? target.kind === "product"
      : target.accountId === scope.accountId,
    "unauthorized",
  );
  requireValue(
    Number.isFinite(target.checkedAt) && target.checkedAt <= now &&
      now - target.checkedAt <= def.maxAgeMs &&
      Number.isFinite(target.validUntil) && target.validUntil > now,
    "stale_target",
  );
  requireValue(
    ["serper", "brave", "eligible_catalog"].includes(
      target.provenance?.provider,
    ) && typeof target.provenance?.sourceId === "string" &&
      target.provenance.sourceId.length > 0 &&
      target.provenance.sourceId.length <= 160,
    "stale_target",
  );
}
export function targetIdentity(target: Target) {
  return {
    kind: target.kind,
    recordId: target.recordId,
    productId: target.productId,
    accountId: target.accountId,
    revision: target.revision,
    provenance: {
      provider: target.provenance.provider,
      sourceId: target.provenance.sourceId,
    },
  };
}
export function checkTransition(
  current: Proposal | null,
  next: Proposal,
  now: number,
) {
  requireValue(
    next.snapshotHash.length === 64 && next.snapshot.policy === POLICY &&
      next.snapshot.version === VERSION,
    "invalid_request",
  );
  if (!current) {
    requireValue(
      next.state === "proposed" && next.revision === 0 &&
        next.challengeHash === null,
      "illegal_transition",
    );
    requireValue(
      next.snapshot.expiresAt > now &&
        next.snapshot.expiresAt <= next.snapshot.createdAt + MAX_PROPOSAL_MS &&
        next.snapshot.retainUntil === next.snapshot.createdAt + RETENTION_MS,
      "expired",
    );
  } else {
    requireValue(
      canonical(current.snapshot) === canonical(next.snapshot) &&
        current.snapshotHash === next.snapshotHash,
      "conflict",
    );
    requireValue(next.revision === current.revision + 1, "conflict");
    requireValue(
      EDGES[current.state].includes(next.state),
      "illegal_transition",
    );
    if (current.state === next.state) {
      requireValue(
        current.challengeHash !== next.challengeHash,
        "invalid_confirmation",
      );
    }
    if (!["expired", "revoked"].includes(next.state)) {
      requireValue(current.snapshot.expiresAt > now, "expired");
    }
  }
  requireValue(
    next.state === "awaiting_customer_approval"
      ? typeof next.challengeHash === "string" &&
        /^[a-f0-9]{64}$/.test(next.challengeHash)
      : next.challengeHash === null,
    "invalid_confirmation",
  );
}

/** Independently validate persisted state before any customer operation; a digest alone is not a schema. */
export async function validateStoredProposal(
  value: unknown,
  now: number,
): Promise<Proposal> {
  const p = object(value, [
    "snapshot",
    "snapshotHash",
    "state",
    "revision",
    "challengeHash",
    "updatedAt",
  ]);
  const s = object(p.snapshot, [
    "version",
    "policy",
    "id",
    "actorId",
    "accountId",
    "capability",
    "arguments",
    "target",
    "permissionRevision",
    "createdAt",
    "expiresAt",
    "retainUntil",
  ]);
  requireValue(s.version === VERSION && s.policy === POLICY, "policy_changed");
  requireValue(
    uuid(s.id) && uuid(s.actorId) && uuid(s.accountId),
    "invalid_request",
  );
  const intent = parseIntent({
    version: s.version,
    capability: s.capability,
    arguments: s.arguments,
  });
  requireValue(
    [s.createdAt, s.expiresAt, s.retainUntil, p.updatedAt].every((t) =>
      typeof t === "number" && Number.isSafeInteger(t)
    ),
    "invalid_request",
  );
  const created = s.createdAt as number;
  requireValue(
    created <= now && (s.expiresAt as number) > created &&
      (s.expiresAt as number) <= created + MAX_PROPOSAL_MS &&
      s.retainUntil === created + RETENTION_MS &&
      (p.updatedAt as number) >= created && (p.updatedAt as number) <= now,
    "invalid_request",
  );
  const target = object(s.target, [
    "kind",
    "recordId",
    "productId",
    "accountId",
    "revision",
    "checkedAt",
    "validUntil",
    "provenance",
  ]);
  object(target.provenance, ["provider", "sourceId"]);
  checkTarget(target as Target, intent, {
    actorId: s.actorId,
    accountId: s.accountId,
  }, created);
  requireValue(
    (target.validUntil as number) >= (s.expiresAt as number),
    "stale_target",
  );
  requireValue(
    typeof s.permissionRevision === "string" &&
      /^[A-Za-z0-9_.:-]{1,160}$/.test(s.permissionRevision),
    "invalid_request",
  );
  requireValue(
    typeof p.state === "string" && Object.hasOwn(EDGES, p.state) &&
      Number.isSafeInteger(p.revision) && (p.revision as number) >= 0,
    "invalid_request",
  );
  requireValue(
    p.state === "awaiting_customer_approval"
      ? typeof p.challengeHash === "string" &&
        /^[a-f0-9]{64}$/.test(p.challengeHash)
      : p.challengeHash === null,
    "invalid_confirmation",
  );
  requireValue(
    typeof p.snapshotHash === "string" && p.snapshotHash === await hash(s),
    "conflict",
  );
  return structuredClone(p) as Proposal;
}
