import {
  type Actor,
  AuthorizationError,
  checkTarget,
  hash,
  type Proposal,
  uuid,
} from "../customerAuthorization/contracts.ts";
import {
  PostgresRepository,
  type Sql,
} from "../customerAuthorization/repository.ts";
import { createAuthorizationService } from "../customerAuthorization/service.ts";
import { applyWatch, matchesWatch, watchSpec } from "./watchlist.ts";
import {
  assertExecutable,
  type Binding,
  type Command,
  type Dependencies,
  ensure,
  type Evidence,
  EXECUTION_VERSION,
  ExecutionError,
  type Ledger,
  parseCommand,
  sameIdentity,
  type Status,
  verifyCommand,
  verifyEvidence,
  type WatchRow,
  type WatchSpec,
} from "./contracts.ts";
import * as store from "./store.ts";

/** Immutable approval binding + durable executor. Never imported by deployed entrypoints. */
export function createGovernedWatchExecutor(deps: Dependencies) {
  async function protectedCall<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (error) {
      if (error instanceof ExecutionError) throw error;
      if (error instanceof AuthorizationError) {
        throw new ExecutionError(
          error.code === "disabled"
            ? "disabled"
            : error.code === "invalid_request"
            ? "invalid_request"
            : error.code === "not_found"
            ? "not_found"
            : "authorization_invalid",
        );
      }
      throw new ExecutionError("storage_unavailable");
    }
  }
  const gate = () =>
    ensure(
      deps.enabled?.() === true && deps.authorizationEnabled?.() === true,
      "disabled",
    );
  async function authenticate(
    request: Request,
    principal: boolean,
  ): Promise<Actor> {
    let a: Actor;
    try {
      a = await deps.authenticate(request);
      if (principal) await deps.verifyExecutionPrincipal(request);
    } catch {
      throw new ExecutionError("unauthorized");
    }
    // Current Watchlist is user-owned, not a separate multi-account resource model.
    ensure(
      a && a.anonymous === false && uuid(a.actorId) && uuid(a.accountId) &&
        a.actorId.toLowerCase() === a.accountId.toLowerCase(),
      "unauthorized",
    );
    return {
      actorId: a.actorId.toLowerCase(),
      accountId: a.accountId.toLowerCase(),
      anonymous: false,
    };
  }
  async function tx<T>(body: (sql: Sql) => Promise<T>): Promise<T> {
    return await deps.database.transaction(async (sql) => {
      await sql.query("set local lock_timeout='1500ms'");
      await sql.query("set local statement_timeout='2500ms'");
      return await body(sql);
    });
  }
  async function account(sql: Sql, a: Actor) {
    const policy = await deps.lockAuthorization(sql, a);
    ensure(policy.accountActive === true, "unauthorized");
    return policy;
  }
  async function current(sql: Sql, a: Actor, p: Proposal): Promise<WatchSpec> {
    assertExecutable(p, a);
    ensure(
      p.snapshot.expiresAt > await store.clock(sql),
      "authorization_invalid",
    );
    const policy = await account(sql, a);
    ensure(
      policy.allowed === true && policy.aiConsent === true &&
        policy.entitled === true &&
        policy.capabilities.includes("save_watchlist") &&
        policy.permissionRevision === p.snapshot.permissionRevision,
      "authorization_invalid",
    );
    const known = (await sql.query<
      { active: boolean; entitled: boolean; entitled_now: boolean }
    >(
      "select public.watchlist_actor_is_active($1) as active, public.kplus_has_active_entitlement($1,'k_plus') as entitled, (select has_access from public.kplus_effective_access_state($1,'k_plus',clock_timestamp())) as entitled_now",
      [a.actorId],
    )).rows[0];
    ensure(
      known?.active === true && known.entitled === true &&
        known.entitled_now === true,
      "authorization_invalid",
    );
    const product = await deps.lockProduct(
      sql,
      a,
      structuredClone(p.snapshot.target),
    );
    try {
      checkTarget(
        product.target,
        {
          version: p.snapshot.version,
          capability: p.snapshot.capability,
          arguments: p.snapshot.arguments,
        },
        a,
        await store.clock(sql),
      );
    } catch {
      throw new ExecutionError("target_changed");
    }
    ensure(sameIdentity(product.target, p.snapshot.target), "target_changed");
    const spec = watchSpec(product);
    const final = await account(sql, a);
    ensure(
      final.allowed === true && final.aiConsent === true &&
        final.entitled === true &&
        final.capabilities.includes("save_watchlist") &&
        final.permissionRevision === p.snapshot.permissionRevision &&
        p.snapshot.expiresAt > await store.clock(sql),
      "authorization_invalid",
    );
    return spec;
  }
  function authorization(sql: Sql, a: Actor) {
    const repository = new PostgresRepository({
      transaction: (body) => body(sql),
    });
    // The outer transaction already claimed and locked this actor once.
    return createAuthorizationService({
      enabled: () =>
        deps.enabled?.() === true && deps.authorizationEnabled?.() === true,
      authenticate: () => Promise.resolve(a),
      assertActive: async () => {
        await account(sql, a);
      },
      authorize: () => account(sql, a),
      resolveTarget: async (_actor, _intent, previous) => {
        ensure(previous, "authorization_invalid");
        return (await deps.lockProduct(sql, a, previous)).target;
      },
      verifyCustomerOperation: deps.verifyCustomerOperation,
      repository: {
        claim: () => Promise.resolve(),
        get: repository.get.bind(repository),
        receipt: repository.receipt.bind(repository),
        commit: repository.commit.bind(repository),
        purge: repository.purge.bind(repository),
      },
    });
  }
  async function authorizationProof(
    sql: Sql,
    a: Actor,
    c: Command,
  ): Promise<{ p: Proposal; b: Binding }> {
    const p = await store.proposal(sql, a, c.proposalId);
    assertExecutable(p, a);
    ensure(
      p.state === "consumed" && p.revision === c.proposalRevision &&
        p.snapshotHash === c.snapshotHash,
      "authorization_invalid",
    );
    const b = await store.binding(sql, a, c.proposalId);
    ensure(
      b.snapshot_hash === c.snapshotHash && b.binding_hash === c.bindingHash &&
        b.approved_revision === c.proposalRevision - 1 &&
        b.approval_operation_id !== null,
      "confirmation_required",
    );
    const receipt = (await sql.query<{ request_hash: string }>(
      "select request_hash from oc02_authorization.receipts where actor_id=$1 and account_id=$2 and operation_id=$3 and proposal_id=$4",
      [a.actorId, a.accountId, c.handoffId, c.proposalId],
    )).rows[0];
    ensure(
      receipt &&
        receipt.request_hash ===
          await hash({
            operation: "handoff",
            proposalId: c.proposalId,
            expectedRevision: c.proposalRevision - 1,
            snapshotHash: c.snapshotHash,
            operationId: c.handoffId,
          }),
      "authorization_invalid",
    );
    const approval = (await sql.query(
      "select operation_id from oc02_authorization.receipts where actor_id=$1 and account_id=$2 and operation_id=$3 and proposal_id=$4",
      [a.actorId, a.accountId, b.approval_operation_id, c.proposalId],
    )).rows;
    ensure(approval.length === 1, "confirmation_required");
    ensure(
      await hash(await current(sql, a, p)) === b.binding_hash,
      "target_changed",
    );
    return { p, b };
  }
  function unknown(id: string): Status {
    return {
      version: EXECUTION_VERSION,
      proposalId: id,
      state: "outcome_uncertain",
      effect: "none",
      reason: "storage_unavailable",
      canClaimCompletion: false,
      watchId: null,
      observedAt: Date.now(),
    };
  }
  async function statusFor(sql: Sql, a: Actor, l: Ledger): Promise<Status> {
    let canClaimCompletion = false;
    if (
      (l.state === "completed" || l.state === "reconciled") &&
      l.effect !== "none" && await verifyEvidence(l)
    ) {
      const evidence = l.evidence!;
      const watch = (await sql.query<WatchRow>(
        "select * from public.user_commerce_watches where id=$1 and user_id=$2 for share",
        [evidence.watchId, a.actorId],
      )).rows[0];
      const spec = {
        source: evidence.source,
        canonicalUrl: evidence.canonicalUrl,
        watchIntent: evidence.intent,
        targetPrice: null,
        currency: evidence.currency,
      } as WatchSpec;
      canClaimCompletion = Boolean(
        watch && matchesWatch(watch, spec, a.actorId) &&
          Number(watch.row_version) >= evidence.rowVersion,
      );
    }
    return {
      version: EXECUTION_VERSION,
      proposalId: l.proposal_id,
      state: l.state,
      effect: l.effect,
      reason: (!canClaimCompletion && l.effect !== "none")
        ? "watch_changed"
        : l.reason,
      canClaimCompletion,
      watchId: canClaimCompletion ? l.watch_id : null,
      observedAt: await store.clock(sql),
    };
  }
  async function reserve(a: Actor, c: Command): Promise<Ledger> {
    return await tx(async (sql) => {
      gate();
      await store.lockAuthorizationScope(sql, a);
      // Status/reconciliation lock policy before ledger. Preserve that order here
      // too: the actor lock alone does not serialize those read/recovery paths.
      await account(sql, a);
      // The OC-02 actor lock serializes reserve and mutation before either row lock.
      const existing = await store.ledger(sql, a, c.proposalId);
      if (existing) {
        verifyCommand(existing, a, c);
        return existing;
      }
      await authorizationProof(sql, a, c);
      ensure(
        (await sql.query(
          "select proposal_id from oc03_execution.ledger where actor_id=$1 and request_id=$2",
          [a.actorId, c.requestId],
        )).rows.length === 0,
        "conflict",
      );
      const l = (await sql.query<Ledger>(
        `insert into oc03_execution.ledger(proposal_id,actor_id,account_id,handoff_id,proposal_revision,snapshot_hash,binding_hash,request_id,state,effect,revision)
        values($1,$2,$3,$4,$5,$6,$7,$8,'reserved','none',0) returning *`,
        [
          c.proposalId,
          a.actorId,
          a.accountId,
          c.handoffId,
          c.proposalRevision,
          c.snapshotHash,
          c.bindingHash,
          c.requestId,
        ],
      )).rows[0];
      await store.audit(sql, c.proposalId, "reserved", "none", null);
      return l;
    });
  }
  async function settle(a: Actor, c: Command, error: unknown): Promise<Status> {
    try {
      return await tx(async (sql) => {
        const l = await store.ledger(sql, a, c.proposalId);
        if (!l) return unknown(c.proposalId);
        verifyCommand(l, a, c);
        if (
          l.state === "completed" || l.state === "reconciled" ||
          l.state === "failed_no_effect"
        ) return await statusFor(sql, a, l);
        const next = error instanceof ExecutionError
          ? await store.update(sql, l, "failed_no_effect", "none", error.code)
          : await store.update(
            sql,
            l,
            "outcome_uncertain",
            "none",
            "storage_unavailable",
          );
        return await statusFor(sql, a, next);
      });
    } catch {
      return unknown(c.proposalId);
    }
  }
  function emit(s: Status) {
    try {
      deps.emit?.({
        version: EXECUTION_VERSION,
        state: s.state,
        effect: s.effect,
        reason: s.reason,
      });
    } catch { /* telemetry cannot affect a committed mutation */ }
    return s;
  }
  return {
    /** Reuses OC-02 confirmation in the SAME transaction, adding exact immutable save semantics. */
    async present(
      request: Request,
      command: {
        proposalId: string;
        expectedRevision: number;
        operationId: string;
      },
    ) {
      return await protectedCall(async () => {
        gate();
        const a = await authenticate(request, false);
        await tx((sql) =>
          new PostgresRepository({ transaction: (work) => work(sql) }).claim(
            a,
            Date.now(),
          )
        );
        ensure(
          uuid(command.proposalId) && uuid(command.operationId) &&
            Number.isSafeInteger(command.expectedRevision),
          "invalid_request",
        );
        return await tx(async (sql) => {
          await store.lockAuthorizationScope(sql, a);
          const p = await store.proposal(sql, a, command.proposalId);
          assertExecutable(p, a);
          const spec = await current(sql, a, p);
          const bindingHash = await hash(spec);
          const existing = (await sql.query<Binding>(
            "select * from oc03_execution.bindings where proposal_id=$1 for update",
            [p.snapshot.id],
          )).rows[0];
          if (existing) {
            ensure(
              existing.binding_hash === bindingHash &&
                existing.snapshot_hash === p.snapshotHash,
              "target_changed",
            );
          } else {
            ensure(p.state === "proposed", "confirmation_required");
            await sql.query(
              "insert into oc03_execution.bindings(proposal_id,actor_id,account_id,snapshot_hash,binding,binding_hash) values($1,$2,$3,$4,$5::jsonb,$6)",
              [
                p.snapshot.id,
                a.actorId,
                a.accountId,
                p.snapshotHash,
                JSON.stringify(spec),
                bindingHash,
              ],
            );
          }
          const display = await authorization(sql, a).present(request, command);
          gate();
          return {
            ...display,
            executionVersion: EXECUTION_VERSION,
            executionHash: bindingHash,
            watch: structuredClone(spec),
          };
        });
      });
    },
    async decide(request: Request, body: unknown) {
      return await protectedCall(async () => {
        gate();
        const a = await authenticate(request, false);
        await tx((sql) =>
          new PostgresRepository({ transaction: (work) => work(sql) }).claim(
            a,
            Date.now(),
          )
        );
        ensure(
          body && typeof body === "object" && !Array.isArray(body),
          "invalid_request",
        );
        const c = body as Record<string, unknown>;
        ensure(
          Object.keys(c).every((k) =>
            [
              "proposalId",
              "expectedRevision",
              "snapshotHash",
              "operationId",
              "decision",
              "confirmationToken",
              "executionHash",
            ].includes(k)
          ) && uuid(c.proposalId) && typeof c.executionHash === "string",
          "invalid_request",
        );
        return await tx(async (sql) => {
          await store.lockAuthorizationScope(sql, a);
          const p = await store.proposal(sql, a, c.proposalId as string);
          const b = await store.binding(sql, a, p.snapshot.id);
          ensure(
            b.binding_hash === c.executionHash &&
              b.snapshot_hash === c.snapshotHash,
            "confirmation_required",
          );
          if (c.decision === "approve") {
            ensure(
              await hash(await current(sql, a, p)) === b.binding_hash,
              "target_changed",
            );
          }
          const { executionHash: _bindingHash, ...decision } = c;
          const outcome = await authorization(sql, a).decide(request, decision);
          if (c.decision === "approve") {
            if (b.approved_revision !== null) {
              ensure(
                b.approved_revision === outcome.proposal.revision &&
                  b.approval_operation_id === c.operationId,
                "conflict",
              );
            } else {await sql.query(
                "update oc03_execution.bindings set approved_revision=$1,approval_operation_id=$2 where proposal_id=$3",
                [outcome.proposal.revision, c.operationId, p.snapshot.id],
              );}
          }
          gate();
          return { ...outcome, executionHash: c.executionHash };
        });
      });
    },
    async reserve(request: Request, body: unknown): Promise<Status> {
      gate();
      const a = await authenticate(request, true);
      const c = parseCommand(body);
      try {
        await tx((sql) => store.claim(sql, a));
        const l = await reserve(a, c);
        return await tx((sql) => statusFor(sql, a, l));
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        return unknown(c.proposalId);
      }
    },
    async execute(request: Request, body: unknown): Promise<Status> {
      gate();
      const a = await authenticate(request, true);
      const c = parseCommand(body);
      let initial: Ledger;
      try {
        await tx((sql) => store.claim(sql, a));
        initial = await reserve(a, c);
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        return emit(unknown(c.proposalId));
      }
      if (initial.state !== "reserved") {
        try {
          return emit(await tx((sql) => statusFor(sql, a, initial)));
        } catch {
          return emit(unknown(c.proposalId));
        }
      }
      try {
        const result = await tx(async (sql) => {
          gate();
          await store.lockAuthorizationScope(sql, a);
          // Take the OC-02 proposal lock before the execution row on the mutation path.
          const proof = await authorizationProof(sql, a, c);
          let l = await store.ledger(sql, a, c.proposalId);
          ensure(l, "not_found");
          verifyCommand(l, a, c);
          if (l.state !== "reserved") return await statusFor(sql, a, l);
          // Legacy create can change existing intent and does not take our actor lock.
          // This bounded table write lock fences its INSERT/UPDATE races and the count ceiling.
          await sql.query(
            "lock table public.user_commerce_watches in share row exclusive mode",
          );
          ensure(
            await hash(await current(sql, a, proof.p)) === proof.b.binding_hash,
            "target_changed",
          );
          gate();
          l = await store.update(sql, l, "executing", "none", null);
          const applied = await applyWatch(sql, a.actorId, proof.b.binding);
          ensure(
            await hash(await current(sql, a, proof.p)) === proof.b.binding_hash,
            "target_changed",
          );
          gate();
          const rowVersion = Number(applied.watch.row_version);
          ensure(
            Number.isSafeInteger(rowVersion) && rowVersion > 0,
            "mutation_unverified",
          );
          const evidence: Evidence = {
            watchId: applied.watch.id,
            userId: a.actorId,
            source: proof.b.binding.source,
            canonicalUrl: proof.b.binding.canonicalUrl,
            intent: "just_watching",
            targetPrice: null,
            currency: proof.b.binding.currency,
            rowVersion,
            bindingHash: c.bindingHash,
            observedAt: await store.clock(sql),
          };
          l = await store.update(
            sql,
            l,
            "completed",
            applied.effect,
            null,
            applied.watch.id,
            evidence,
            await hash(evidence),
          );
          return await statusFor(sql, a, l);
        });
        return emit(result);
      } catch (error) {
        return emit(await settle(a, c, error));
      }
    },
    /** Recovery remains available with the execution kill switch OFF; it never writes a Watch. */
    async status(request: Request, body: unknown): Promise<Status> {
      const a = await authenticate(request, true);
      const c = parseCommand(body);
      try {
        await tx((sql) => store.claim(sql, a));
        return await tx(async (sql) => {
          await account(sql, a);
          const l = await store.ledger(sql, a, c.proposalId);
          ensure(l, "not_found");
          verifyCommand(l, a, c);
          return await statusFor(sql, a, l);
        });
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        return unknown(c.proposalId);
      }
    },
    async reconcile(request: Request, body: unknown): Promise<Status> {
      const a = await authenticate(request, true);
      const c = parseCommand(body);
      try {
        await tx((sql) => store.claim(sql, a));
        return emit(
          await tx(async (sql) => {
            await account(sql, a);
            let l = await store.ledger(sql, a, c.proposalId);
            ensure(l, "not_found");
            verifyCommand(l, a, c);
            const currentStatus = await statusFor(sql, a, l);
            if (
              l.state === "reconciled" ||
              (l.state === "completed" && currentStatus.canClaimCompletion)
            ) return currentStatus;
            if (l.state === "completed") {
              l = await store.update(
                sql,
                l,
                "reconciled",
                l.effect,
                "watch_changed",
              );
            } else {l = await store.update(
                sql,
                l,
                "reconciled",
                "none",
                "no_commit_evidence",
              );}
            return await statusFor(sql, a, l);
          }),
        );
      } catch (error) {
        if (error instanceof ExecutionError) throw error;
        return emit(unknown(c.proposalId));
      }
    },
  };
}
