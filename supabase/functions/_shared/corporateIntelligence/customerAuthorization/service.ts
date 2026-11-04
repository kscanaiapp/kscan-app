import {
  type Actor,
  AuthorizationError,
  canonical,
  type Capability,
  checkTarget,
  type Code,
  hash,
  type Intent,
  MAX_PROPOSAL_MS,
  object,
  parseIntent,
  POLICY,
  type Proposal,
  REGISTRY,
  requireValue,
  RETENTION_MS,
  type Scope,
  type State,
  type Target,
  targetIdentity,
  uuid,
  validateStoredProposal,
  VERSION,
} from "./contracts.ts";
import type { Audit, Repository } from "./repository.ts";

export type PolicyDecision = {
  allowed: boolean;
  permissionRevision: string;
  aiConsent: boolean;
  entitled: boolean;
  capabilities: readonly Capability[];
};
export type Dependencies = {
  /** Omitted/malformed gates are OFF. No environment reader or customer activation is introduced. */
  enabled?: () => boolean;
  authenticate: (request: Request) => Promise<Actor>;
  assertActive: (actor: Actor) => Promise<void>;
  /** Must check current consent, capability-specific permissions and required entitlements from server records. */
  authorize: (actor: Actor, capability: Capability) => Promise<PolicyDecision>;
  resolveTarget: (
    actor: Actor,
    intent: Intent,
    previous?: Readonly<Target>,
  ) => Promise<Target>;
  /** Future authenticated confirmation route verifies native/CSRF/channel requirements; never a model/tool route. */
  verifyCustomerOperation: (request: Request) => Promise<void>;
  /** Separate future OC-03 service principal guard. Omitted means no handoff can occur. */
  verifyHandoffService?: (request: Request) => Promise<void>;
  repository: Repository;
  now?: () => number;
  emit?: (event: Audit) => void;
  emitDenied?: (event: { version: "oc02-denial-v1"; failure: Code }) => void;
};
export type Confirmation = {
  proposalId: string;
  expectedRevision: number;
  snapshotHash: string;
  operationId: string;
  decision: "approve" | "reject";
  confirmationToken: string;
};
function parseConfirmation(value: unknown): Confirmation {
  const v = object(value, [
    "proposalId",
    "expectedRevision",
    "snapshotHash",
    "operationId",
    "decision",
    "confirmationToken",
  ]);
  requireValue(
    uuid(v.proposalId) && uuid(v.operationId) &&
      Number.isSafeInteger(v.expectedRevision) &&
      (v.expectedRevision as number) >= 0 &&
      typeof v.snapshotHash === "string" &&
      /^[a-f0-9]{64}$/.test(v.snapshotHash) &&
      ["approve", "reject"].includes(v.decision as string) &&
      typeof v.confirmationToken === "string" &&
      /^[a-f0-9-]{36}\.[a-f0-9-]{36}$/.test(v.confirmationToken),
    "invalid_request",
  );
  return structuredClone(v) as Confirmation;
}
async function runProtected<T>(
  work: () => Promise<T>,
  denied: (code: Code) => void,
): Promise<T> {
  try {
    return await work();
  } catch (e) {
    const error = e instanceof AuthorizationError
      ? e
      : new AuthorizationError("storage_failure");
    try {
      denied(error.code);
    } catch { /* denied operations remain denied if telemetry fails */ }
    throw error;
  }
}
/** Creates proposals/authorization records ONLY. There is no account mutation or executor dependency. */
export function createAuthorizationService(deps: Dependencies) {
  const protectedCall = <T>(work: () => Promise<T>) =>
    runProtected(
      work,
      (code) => deps.emitDenied?.({ version: "oc02-denial-v1", failure: code }),
    );
  const repo = deps.repository;
  const now = deps.now ?? Date.now;
  const gate = () => requireValue(deps.enabled?.() === true, "disabled");
  async function actor(request: Request): Promise<Actor> {
    gate();
    let a: Actor;
    try {
      a = await deps.authenticate(request);
    } catch {
      throw new AuthorizationError("unauthorized");
    }
    requireValue(
      a && a.anonymous === false && uuid(a.actorId) && uuid(a.accountId),
      "unauthorized",
    );
    const trusted: Actor = {
      actorId: a.actorId.toLowerCase(),
      accountId: a.accountId.toLowerCase(),
      anonymous: false,
    };
    await repo.claim(trusted, now());
    return trusted;
  }
  async function active(a: Actor) {
    try {
      await deps.assertActive(a);
    } catch {
      throw new AuthorizationError("unauthorized");
    }
  }
  async function permission(a: Actor, capability: Capability) {
    const decision = await deps.authorize(a, capability);
    requireValue(
      decision?.allowed === true && decision.aiConsent === true &&
        (!REGISTRY[capability].entitlement || decision.entitled === true) &&
        Array.isArray(decision.capabilities) &&
        decision.capabilities.includes(capability) &&
        typeof decision.permissionRevision === "string" &&
        /^[A-Za-z0-9_.:-]{1,160}$/.test(decision.permissionRevision),
      "unauthorized",
    );
    return decision.permissionRevision;
  }
  async function load(a: Scope, id: string) {
    requireValue(uuid(id), "invalid_request");
    const stored = await repo.get(a, id);
    requireValue(stored, "not_found");
    const p = await validateStoredProposal(stored, now());
    requireValue(
      p.snapshot.actorId === a.actorId &&
        p.snapshot.accountId === a.accountId &&
        p.snapshotHash === await hash(p.snapshot),
      "conflict",
    );
    return p;
  }
  async function transition(
    a: Actor,
    p: Proposal,
    state: State,
    operationId: string,
    requestHash: string,
    challengeHash: string | null = null,
  ) {
    gate();
    requireValue(uuid(operationId), "invalid_request");
    const next: Proposal = {
      ...structuredClone(p),
      state,
      revision: p.revision + 1,
      challengeHash,
      updatedAt: now(),
    };
    const result = await repo.commit({
      scope: a,
      operationId,
      requestHash,
      expectedRevision: p.revision,
      next,
      now: now(),
    });
    try {
      deps.emit?.({
        version: "oc02-audit-v1",
        capability: p.snapshot.capability,
        from: p.state,
        to: state,
        revision: result.revision,
      });
    } catch {
      /* audit storage is already atomic; optional telemetry cannot change results */
    }
    return result;
  }
  async function invalidate(a: Actor, p: Proposal, code: Code): Promise<never> {
    const state = code === "expired" ? "expired" : "revoked";
    if (
      ["proposed", "awaiting_customer_approval", "approved"].includes(p.state)
    ) {
      try {
        await transition(
          a,
          p,
          state,
          crypto.randomUUID(),
          await hash({ id: p.snapshot.id, code, revision: p.revision }),
        );
      } catch {
        /* fail closed even if a concurrent transition won or storage failed */
      }
    }
    throw new AuthorizationError(code);
  }
  async function fresh(a: Actor, p: Proposal) {
    if (p.snapshot.expiresAt <= now()) return await invalidate(a, p, "expired");
    if (p.snapshot.policy !== POLICY) {
      return await invalidate(a, p, "policy_changed");
    }
    try {
      await active(a);
      const revision = await permission(a, p.snapshot.capability);
      if (revision !== p.snapshot.permissionRevision) {
        return await invalidate(a, p, "unauthorized");
      }
    } catch {
      return await invalidate(a, p, "unauthorized");
    }
    const intent: Intent = {
      version: VERSION,
      capability: p.snapshot.capability,
      arguments: p.snapshot.arguments,
    };
    let target: Target;
    try {
      target = await deps.resolveTarget(
        a,
        intent,
        structuredClone(p.snapshot.target),
      );
      checkTarget(target, intent, a, now());
    } catch {
      return await invalidate(a, p, "stale_target");
    }
    if (
      canonical(targetIdentity(target)) !==
        canonical(targetIdentity(p.snapshot.target))
    ) return await invalidate(a, p, "target_changed");
    // Resolver I/O may have overlapped a consent/permission withdrawal.
    try {
      await active(a);
      requireValue(
        await permission(a, p.snapshot.capability) ===
          p.snapshot.permissionRevision,
        "unauthorized",
      );
    } catch {
      return await invalidate(a, p, "unauthorized");
    }
  }
  async function prior(
    a: Actor,
    operationId: string,
    requestHash: string,
  ): Promise<Proposal | null> {
    const r = await repo.receipt(a, operationId);
    if (!r) return null;
    requireValue(r.requestHash === requestHash, "idempotency_conflict");
    return await load(a, r.proposalId);
  }
  const revisionMatches = (
    p: Proposal,
    revision: number,
    snapshotHash: string,
  ) =>
    requireValue(
      p.revision === revision && p.snapshotHash === snapshotHash,
      "conflict",
    );
  async function customer(request: Request) {
    requireValue(
      request.method === "POST" &&
        request.headers.get("content-type")?.split(";")[0].trim()
            .toLowerCase() === "application/json",
      "invalid_confirmation",
    );
    try {
      await deps.verifyCustomerOperation(request);
    } catch {
      throw new AuthorizationError("invalid_confirmation");
    }
  }
  return {
    /** Authenticated app polling/recovery only; no approval token or permission evidence is returned. */
    inspect(request: Request, proposalId: string) {
      return protectedCall(async () => {
        const a = await actor(request);
        await active(a);
        requireValue(request.method === "GET", "invalid_request");
        try {
          await deps.verifyCustomerOperation(request);
        } catch {
          throw new AuthorizationError("invalid_confirmation");
        }
        let p = await load(a, proposalId);
        if (
          p.snapshot.expiresAt <= now() &&
          ["proposed", "awaiting_customer_approval", "approved"].includes(
            p.state,
          )
        ) {
          p = await transition(
            a,
            p,
            "expired",
            crypto.randomUUID(),
            await hash({
              operation: "inspect_expiration",
              proposalId,
              revision: p.revision,
            }),
          );
        }
        return {
          version: VERSION,
          proposalId: p.snapshot.id,
          state: p.state,
          revision: p.revision,
          snapshotHash: p.snapshotHash,
          capability: p.snapshot.capability,
          arguments: structuredClone(p.snapshot.arguments),
          expiresAt: p.snapshot.expiresAt,
          executed: false as const,
        };
      });
    },
    propose(request: Request, modelIntent: unknown, serverOperationId: string) {
      return protectedCall(async () => {
        const a = await actor(request);
        await active(a);
        requireValue(uuid(serverOperationId), "invalid_request");
        const intent = parseIntent(modelIntent);
        const permissionRevision = await permission(a, intent.capability);
        const requestHash = await hash({ operation: "propose", intent });
        const previous = await prior(a, serverOperationId, requestHash);
        if (previous) {
          await fresh(a, previous);
          return previous;
        }
        const resolved = await deps.resolveTarget(a, intent);
        checkTarget(resolved, intent, a, now());
        const target: Target = {
          ...targetIdentity(resolved),
          checkedAt: resolved.checkedAt,
          validUntil: resolved.validUntil,
        };
        const createdAt = now();
        const snapshot = {
          version: VERSION,
          policy: POLICY,
          id: crypto.randomUUID(),
          actorId: a.actorId,
          accountId: a.accountId,
          capability: intent.capability,
          arguments: structuredClone(intent.arguments),
          target,
          permissionRevision,
          createdAt,
          expiresAt: Math.min(createdAt + MAX_PROPOSAL_MS, target.validUntil),
          retainUntil: createdAt + RETENTION_MS,
        };
        const next: Proposal = {
          snapshot,
          snapshotHash: await hash(snapshot),
          state: "proposed",
          revision: 0,
          challengeHash: null,
          updatedAt: createdAt,
        };
        gate();
        return await repo.commit({
          scope: a,
          operationId: serverOperationId,
          requestHash,
          expectedRevision: null,
          next,
          now: now(),
        });
      });
    },
    /** Authenticated app route only. Never return its token to Gemini or store it in logs. */
    present(
      request: Request,
      command: {
        proposalId: string;
        expectedRevision: number;
        operationId: string;
      },
    ) {
      return protectedCall(async () => {
        const a = await actor(request);
        await customer(request);
        const c = object(command, [
          "proposalId",
          "expectedRevision",
          "operationId",
        ]);
        requireValue(
          uuid(c.operationId) && Number.isSafeInteger(c.expectedRevision),
          "invalid_request",
        );
        const p = await load(a, c.proposalId as string);
        await fresh(a, p);
        requireValue(p.revision === c.expectedRevision, "conflict");
        requireValue(
          ["proposed", "awaiting_customer_approval"].includes(p.state),
          "illegal_transition",
        );
        // A lost presentation response is recovered by a NEW operation/revision, rotating the old nonce.
        requireValue(!await repo.receipt(a, c.operationId), "conflict");
        const token = `${crypto.randomUUID()}.${crypto.randomUUID()}`;
        const next = await transition(
          a,
          p,
          "awaiting_customer_approval",
          c.operationId,
          await hash({ operation: "present", ...c }),
          await hash(token),
        );
        return {
          version: VERSION,
          proposalId: next.snapshot.id,
          capability: next.snapshot.capability,
          arguments: structuredClone(next.snapshot.arguments),
          target: targetIdentity(next.snapshot.target),
          policy: next.snapshot.policy,
          snapshotHash: next.snapshotHash,
          revision: next.revision,
          expiresAt: next.snapshot.expiresAt,
          confirmationToken: token,
          executed: false as const,
        };
      });
    },
    decide(request: Request, body: unknown) {
      return protectedCall(async () => {
        const a = await actor(request);
        await customer(request);
        const c = parseConfirmation(body);
        const requestHash = await hash({ operation: "decision", ...c });
        const previous = await prior(a, c.operationId, requestHash);
        if (previous) {
          requireValue(
            previous.snapshot.id === c.proposalId &&
              previous.state ===
                (c.decision === "approve" ? "approved" : "rejected"),
            "conflict",
          );
          if (c.decision === "approve") await fresh(a, previous);
          else await active(a);
          return {
            proposal: previous,
            replayed: true,
            executed: false as const,
          };
        }
        const p = await load(a, c.proposalId);
        if (p.snapshot.expiresAt <= now()) {
          return await invalidate(a, p, "expired");
        }
        if (c.decision === "reject") await active(a);
        revisionMatches(p, c.expectedRevision, c.snapshotHash);
        requireValue(
          p.state === "awaiting_customer_approval",
          "illegal_transition",
        );
        requireValue(
          p.challengeHash === await hash(c.confirmationToken),
          "invalid_confirmation",
        );
        if (c.decision === "approve") await fresh(a, p);
        const next = await transition(
          a,
          p,
          c.decision === "approve" ? "approved" : "rejected",
          c.operationId,
          requestHash,
        );
        return { proposal: next, replayed: false, executed: false as const };
      });
    },
    revoke(
      request: Request,
      command: {
        proposalId: string;
        expectedRevision: number;
        operationId: string;
      },
    ) {
      return protectedCall(async () => {
        const a = await actor(request);
        await customer(request);
        await active(a);
        const c = object(command, [
          "proposalId",
          "expectedRevision",
          "operationId",
        ]);
        requireValue(uuid(c.operationId), "invalid_request");
        const requestHash = await hash({ operation: "revoke", ...c });
        const previous = await prior(a, c.operationId, requestHash);
        if (previous) {
          requireValue(previous.state === "revoked", "conflict");
          return previous;
        }
        const p = await load(a, c.proposalId as string);
        requireValue(p.revision === c.expectedRevision, "conflict");
        return await transition(a, p, "revoked", c.operationId, requestHash);
      });
    },
    /** Reserves one immutable authorization for OC-03. It performs NO action and creates no completion claim. */
    handoff(
      request: Request,
      command: {
        proposalId: string;
        expectedRevision: number;
        snapshotHash: string;
        operationId: string;
      },
    ) {
      return protectedCall(async () => {
        const a = await actor(request);
        requireValue(deps.verifyHandoffService, "unauthorized");
        try {
          await deps.verifyHandoffService(request);
        } catch {
          throw new AuthorizationError("unauthorized");
        }
        const c = object(command, [
          "proposalId",
          "expectedRevision",
          "snapshotHash",
          "operationId",
        ]);
        requireValue(uuid(c.operationId), "invalid_request");
        const requestHash = await hash({ operation: "handoff", ...c });
        const previous = await prior(a, c.operationId, requestHash);
        if (previous) {
          requireValue(
            previous.state === "consumed" &&
              previous.snapshot.id === c.proposalId,
            "conflict",
          );
          await fresh(a, previous);
          return {
            proposal: previous,
            handoffId: c.operationId,
            executed: false as const,
          };
        }
        const p = await load(a, c.proposalId as string);
        await fresh(a, p);
        revisionMatches(
          p,
          c.expectedRevision as number,
          c.snapshotHash as string,
        );
        requireValue(p.state === "approved", "illegal_transition");
        const next = await transition(
          a,
          p,
          "consumed",
          c.operationId,
          requestHash,
        );
        return {
          proposal: next,
          handoffId: c.operationId,
          executed: false as const,
        };
      });
    },
  };
}

/** Only this closed summary belongs in a model turn. The full server record contains private authorization state. */
export function modelProposalSummary(proposal: Proposal) {
  return {
    version: VERSION,
    capability: proposal.snapshot.capability,
    proposalStatus: proposal.state,
    requiresCustomerConfirmation: true as const,
    executed: false as const,
  };
}
