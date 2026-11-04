const test = require("node:test");
const assert = require("node:assert/strict");
const { world, A, B, URL } = require("./helpers/oc03ExecutionWorld");
async function rejects(p, code) {
  await assert.rejects(p, (e) => e.code === code);
}

test("OC-04 an approved save cannot restore a removed Watch", async () => {
  const w = await world();
  try {
    await w.legacyWatch();
    const c = await w.approved();
    await w.db.query(
      "select public.delete_user_commerce_watch($1,id) from public.user_commerce_watches where user_id=$1 and deleted_at is null",
      [A],
    );
    const result = await w.executor.execute(w.request(), c);
    assert.equal(result.canClaimCompletion, false);
    assert.equal(result.reason, "existing_watch_change_requires_approval");
    assert.equal(await w.count(), 0);
    assert.equal(w.rpcCalls, 0);
  } finally {
    await w.close();
  }
});

test("OC-03 actual Watchlist save, authoritative completion, concurrent requests and replay create exactly one watch", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    const results = await Promise.all(
      Array.from({ length: 4 }, () =>
        w.executor.execute(w.request(), {
          ...c,
          requestId: crypto.randomUUID(),
        })),
    );
    assert.equal(await w.count(), 1);
    assert.equal(w.rpcCalls, 1);
    assert.ok(
      results.every((r) => r.state === "completed" && r.canClaimCompletion),
    );
    assert.equal(
      (await w.executor.execute(w.request(), c)).watchId,
      results[0].watchId,
    );
    assert.equal(w.rpcCalls, 1);
    assert.equal(
      (await w.db.query(
        "select count(*)::int n from oc03_execution.audit where metadata->>'state'='completed'",
      )).rows[0].n,
      1,
    );
    const locking = w.queries.findIndex((q) =>
      q.sql.startsWith("lock table public.user_commerce_watches")
    );
    const mutation = w.queries.findIndex((q) =>
      q.sql.includes("public.create_user_commerce_watch(")
    );
    assert.ok(locking >= 0 && locking < mutation);
  } finally {
    await w.close();
  }
});
test("OC-03 existing identical watch is a true no-op; changed intent and paused watches require separate approval", async () => {
  const w = await world();
  try {
    await w.legacyWatch();
    const before = (await w.db.query(
      "select * from public.user_commerce_watches where user_id=$1",
      [A],
    )).rows[0];
    const noop = await w.executor.execute(w.request(), await w.approved());
    assert.equal(noop.effect, "already_watched");
    assert.equal(noop.canClaimCompletion, true);
    assert.equal(w.rpcCalls, 0);
    assert.deepEqual(
      (await w.db.query(
        "select * from public.user_commerce_watches where id=$1",
        [before.id],
      )).rows[0],
      before,
    );
    await w.legacyWatch("buy_under", 90);
    const changed = (await w.db.query(
      "select * from public.user_commerce_watches where id=$1",
      [before.id],
    )).rows[0];
    const conflict = await w.executor.execute(w.request(), await w.approved());
    assert.equal(conflict.state, "failed_no_effect");
    assert.equal(conflict.reason, "existing_watch_change_requires_approval");
    assert.equal(conflict.canClaimCompletion, false);
    assert.deepEqual(
      (await w.db.query(
        "select * from public.user_commerce_watches where id=$1",
        [before.id],
      )).rows[0],
      changed,
    );
    assert.equal(w.rpcCalls, 0);
    await w.legacyWatch();
    await w.db.query(
      "update public.user_commerce_watches set status='paused' where id=$1",
      [before.id],
    );
    const paused = await w.executor.execute(w.request(), await w.approved());
    assert.equal(paused.reason, "existing_watch_change_requires_approval");
    assert.equal(w.rpcCalls, 0);
  } finally {
    await w.close();
  }
});
test("OC-03 crashes before/after RPC or before completion roll back watch effects, never blindly retry, and reconcile without invented success", async () => {
  const w = await world();
  try {
    for (const fault of ["before_rpc", "after_rpc", "before_completion"]) {
      const c = await w.approved();
      w.fault(fault);
      const outcome = await w.executor.execute(w.request(), c);
      assert.equal(outcome.state, "outcome_uncertain");
      assert.equal(outcome.canClaimCompletion, false);
      assert.equal(await w.count(), 0);
      const attempts = w.rpcCalls;
      await w.executor.execute(w.request(), c);
      assert.equal(w.rpcCalls, attempts);
      w.fault(null);
      const recovered = await w.executor.reconcile(w.request(), c);
      assert.equal(recovered.state, "reconciled");
      assert.equal(recovered.reason, "no_commit_evidence");
      assert.equal(recovered.canClaimCompletion, false);
      await w.executor.execute(w.request(), c);
      assert.equal(w.rpcCalls, attempts);
    }
  } finally {
    await w.close();
  }
});
test("OC-03 lost commit acknowledgment and isolate restart recover committed evidence without a duplicate or false failure", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    w.fault("lost_ack");
    const lost = await w.executor.execute(w.request(), c);
    assert.equal(lost.state, "outcome_uncertain");
    assert.equal(lost.canClaimCompletion, false);
    assert.equal(await w.count(), 1);
    assert.equal(
      (await w.db.query(
        "select state from oc03_execution.ledger where proposal_id=$1",
        [c.proposalId],
      )).rows[0].state,
      "completed",
    );
    w.connected(true);
    w.fault(null);
    w.restart();
    const recovered = await w.executor.status(w.request(), c);
    assert.equal(recovered.state, "completed");
    assert.equal(recovered.canClaimCompletion, true);
    await w.executor.execute(w.request(), {
      ...c,
      requestId: crypto.randomUUID(),
    });
    assert.equal(w.rpcCalls, 1);
    assert.equal(await w.count(), 1);
    await w.legacyWatch("buy_under", 80);
    const changed = await w.executor.status(w.request(), c);
    assert.equal(changed.canClaimCompletion, false);
    assert.equal(changed.reason, "watch_changed");
    assert.equal(
      (await w.executor.reconcile(w.request(), c)).state,
      "reconciled",
    );
    assert.equal(w.rpcCalls, 1);
  } finally {
    await w.close();
  }
});
test("OC-03 current consent, permission epoch, entitlement, account and product identity are revalidated before any effect", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    await w.db.query(
      "update public.fixture_permissions set consent=false where user_id=$1",
      [A],
    );
    await rejects(w.executor.execute(w.request(), c), "authorization_invalid");
    await w.db.query(
      "update public.fixture_permissions set consent=true,revision='changed' where user_id=$1",
      [A],
    );
    await rejects(w.executor.execute(w.request(), c), "authorization_invalid");
    await w.db.query(
      "update public.fixture_permissions set revision='permission-1',allowed=false where user_id=$1",
      [A],
    );
    await rejects(w.executor.execute(w.request(), c), "authorization_invalid");
    await w.db.query(
      "update public.fixture_permissions set allowed=true where user_id=$1",
      [A],
    );
    await w.db.query(
      "update public.fixture_entitlements set granted=false where user_id=$1",
      [A],
    );
    await rejects(w.executor.execute(w.request(), c), "authorization_invalid");
    await w.db.query(
      "update public.fixture_entitlements set granted=true where user_id=$1",
      [A],
    );
    await w.db.query(
      "update public.profiles set account_status='locked' where id=$1",
      [A],
    );
    await rejects(w.executor.execute(w.request(), c), "unauthorized");
    await w.db.query(
      "update public.profiles set account_status='active' where id=$1",
      [A],
    );
    await w.db.query(
      "update public.fixture_products set product_id='swapped' where record_id='record-1'",
    );
    await rejects(w.executor.execute(w.request(), c), "target_changed");
    assert.equal(w.rpcCalls, 0);
    assert.equal(await w.count(), 0);
  } finally {
    await w.close();
  }
});
test("OC-03 rejects generic OC-02 approvals, wrong execution binding, forged handoff, cross-account and missing principal", async () => {
  const w = await world();
  try {
    const legacy = await w.approved({ legacy: true });
    await rejects(
      w.executor.execute(w.request(), legacy),
      "confirmation_required",
    );
    const c = await w.approved();
    await rejects(
      w.executor.execute(w.request(), { ...c, bindingHash: "0".repeat(64) }),
      "confirmation_required",
    );
    await rejects(
      w.executor.execute(w.request(), { ...c, handoffId: crypto.randomUUID() }),
      "authorization_invalid",
    );
    w.actor({ actorId: B, accountId: B, anonymous: false });
    await rejects(w.executor.execute(w.request(), c), "authorization_invalid");
    w.actor({ actorId: A, accountId: B, anonymous: false });
    await rejects(w.executor.execute(w.request(), c), "unauthorized");
    w.actor({ actorId: A, accountId: A, anonymous: false });
    w.principal(false);
    await rejects(w.executor.execute(w.request(), c), "unauthorized");
    assert.equal(w.rpcCalls, 0);
    assert.equal(await w.count(), 0);
  } finally {
    await w.close();
  }
});
test("OC-03 kill switches make default paths zero-I/O, abort an in-flight save atomically, and retain status/recovery access", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    w.enabled(false);
    const before = w.queries.length;
    await rejects(w.executor.execute(w.request(), c), "disabled");
    assert.equal(w.queries.length, before);
    assert.equal(await w.count(), 0);
    w.enabled(true);
    w.authEnabled(false);
    await rejects(w.executor.execute(w.request(), c), "disabled");
    w.authEnabled(true);
    w.fault("kill_after_rpc");
    const result = await w.executor.execute(w.request(), c);
    assert.equal(result.state, "failed_no_effect");
    assert.equal(result.reason, "disabled");
    assert.equal(await w.count(), 0);
    assert.equal(
      (await w.executor.status(w.request(), c)).canClaimCompletion,
      false,
    );
  } finally {
    await w.close();
  }
});
test("OC-03 proposed schema denies customer roles, protects immutable evidence and refuses a partial executing commit", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    await w.executor.reserve(w.request(), c);
    await assert.rejects(
      w.db.transaction(async (tx) => {
        await tx.query(
          "update oc03_execution.ledger set state='executing',revision=revision+1 where proposal_id=$1",
          [c.proposalId],
        );
      }),
      /oc03_incomplete_execution/,
    );
    assert.equal(
      (await w.db.query(
        "select state from oc03_execution.ledger where proposal_id=$1",
        [c.proposalId],
      )).rows[0].state,
      "reserved",
    );
    await assert.rejects(
      w.db.query(
        "update oc03_execution.ledger set binding_hash=$1,revision=revision+1 where proposal_id=$2",
        ["0".repeat(64), c.proposalId],
      ),
      /oc03_immutable_execution/,
    );
    const fakeWatchId = crypto.randomUUID();
    await assert.rejects(
      w.db.transaction(async (tx) => {
        await tx.query(
          "update oc03_execution.ledger set state='executing',revision=revision+1 where proposal_id=$1",
          [c.proposalId],
        );
        const evidence = {
          watchId: fakeWatchId,
          userId: A,
          source: "farfetch",
          canonicalUrl: URL,
          intent: "just_watching",
          targetPrice: null,
          currency: "USD",
          rowVersion: 1,
          bindingHash: c.bindingHash,
          observedAt: Date.now(),
        };
        await tx.query(
          "update oc03_execution.ledger set state='completed',effect='created',watch_id=$1,evidence=$2::jsonb,evidence_hash=$3,revision=revision+1 where proposal_id=$4",
          [fakeWatchId, JSON.stringify(evidence), "a".repeat(64), c.proposalId],
        );
      }),
      /oc03_missing_mutation_evidence/,
    );
    assert.equal(
      (await w.executor.execute(w.request(), c)).canClaimCompletion,
      true,
    );
    await assert.rejects(
      w.db.query(
        "update oc03_execution.ledger set state='reconciled',evidence_hash=$1,revision=revision+1 where proposal_id=$2",
        ["0".repeat(64), c.proposalId],
      ),
      /oc03_evidence_immutable/,
    );
    for (const role of ["anon", "authenticated"]) {
      await w.db.exec(`reset role;set role ${role}`);
      for (const table of ["bindings", "ledger", "limits", "audit"]) {
        await assert.rejects(
          w.db.query(`select * from oc03_execution.${table}`),
          (e) => e.code === "42501",
        );
      }
      await assert.rejects(
        w.db.query(
          "select * from public.create_user_commerce_watch($1,'farfetch',$2,null,'fake',null,120,'USD','just_watching',null)",
          [A, URL],
        ),
        (e) => e.code === "42501",
      );
    }
  } finally {
    await w.close();
  }
});
test("OC-03 reserved execution survives database close/reopen before mutation and resumes once", async () => {
  let w = await world({ disk: true });
  let closed = false;
  try {
    const c = await w.approved();
    assert.equal((await w.executor.reserve(w.request(), c)).state, "reserved");
    const location = w.location;
    await w.close({ keep: true });
    closed = true;
    w = await world({ reopenPath: location });
    closed = false;
    const result = await w.executor.execute(w.request(), c);
    assert.equal(result.canClaimCompletion, true);
    assert.equal(await w.count(), 1);
    assert.equal(w.rpcCalls, 1);
  } finally {
    if (!closed) await w.close();
  }
});

test("OC-03 expired authorization, unavailable source and connection loss never create a watch or leak dependency content", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    w.resolverFailure(true);
    const unavailable = await w.executor.execute(w.request(), c);
    assert.equal(unavailable.canClaimCompletion, false);
    assert.ok(!JSON.stringify(unavailable).includes("SECRET"));
    assert.equal(w.rpcCalls, 0);
    w.resolverFailure(false);
    w.connected(false);
    const connection = await w.executor.execute(w.request(), c);
    assert.equal(connection.state, "outcome_uncertain");
    assert.equal(connection.canClaimCompletion, false);
    w.connected(true);
    await w.db.query(
      "update public.fixture_products set valid_until=clock_timestamp()+interval '4 seconds' where record_id='record-1'",
    );
    const expires = await w.approved();
    const p = (await w.db.query(
      "select document from oc02_authorization.proposals where id=$1",
      [expires.proposalId],
    )).rows[0].document;
    await new Promise((resolve) =>
      setTimeout(resolve, Math.max(0, p.snapshot.expiresAt - Date.now() + 100))
    );
    await rejects(
      w.executor.execute(w.request(), expires),
      "authorization_invalid",
    );
    assert.equal(w.rpcCalls, 0);
    assert.equal(await w.count(), 0);
  } finally {
    await w.close();
  }
});

test("OC-03 enforces existing Watchlist ceiling, request-key conflicts and durable per-actor execution attempt limits", async () => {
  const w = await world();
  try {
    await w.legacyWatch();
    await w.db.query(
      "select * from public.create_user_commerce_watch($1,'farfetch',$2,null,'Fixture second',null,120,'USD','just_watching',null)",
      [A, "https://www.farfetch.com/shopping/men/second-item-54321.aspx"],
    );
    const listing = {
      ...w.listing,
      productUrl: "https://www.farfetch.com/shopping/men/third-item-77777.aspx",
    };
    await w.db.query(
      "update public.fixture_products set listing=$1::jsonb where record_id='record-1'",
      [JSON.stringify(listing)],
    );
    const c = await w.approved();
    const limited = await w.executor.execute(w.request(), c);
    assert.equal(limited.reason, "watch_limit");
    assert.equal(limited.state, "failed_no_effect");
    assert.equal(w.rpcCalls, 0);
    assert.equal(await w.count(), 2);
    const other = await w.approved();
    await rejects(
      w.executor.execute(w.request(), { ...other, requestId: c.requestId }),
      "conflict",
    );
    let denied = false;
    for (let i = 0; i < 45; i++) {
      try {
        await w.executor.execute(w.request(), c);
      } catch (error) {
        if (error.code !== "rate_limited") throw error;
        denied = true;
        break;
      }
    }
    assert.equal(denied, true);
    assert.equal(w.rpcCalls, 0);
    assert.equal(
      (await w.db.query(
        "select count from oc03_execution.limits where actor_id=$1",
        [A],
      )).rows[0].count,
      20,
    );
  } finally {
    await w.close();
  }
});

test("OC-03 requires an explicit execution-binding approval even when OC-02 itself has approved and handed off", async () => {
  const w = await world();
  try {
    const p = await w.authorization.propose(w.request(), {
      version: "oc02-authorization-v1",
      capability: "save_watchlist",
      arguments: { targetRef: "p_cccccccc-cccc-4ccc-8ccc-cccccccccccc" },
    }, crypto.randomUUID());
    const display = await w.executor.present(w.request(), {
      proposalId: p.snapshot.id,
      expectedRevision: 0,
      operationId: crypto.randomUUID(),
    });
    const body = {
      proposalId: p.snapshot.id,
      expectedRevision: display.revision,
      snapshotHash: p.snapshotHash,
      operationId: crypto.randomUUID(),
      decision: "approve",
      confirmationToken: display.confirmationToken,
    };
    await rejects(
      w.executor.decide(w.request(), {
        ...body,
        executionHash: "0".repeat(64),
      }),
      "confirmation_required",
    );
    assert.equal(
      (await w.db.query(
        "select document from oc02_authorization.proposals where id=$1",
        [p.snapshot.id],
      )).rows[0].document.state,
      "awaiting_customer_approval",
    );
    const oldApproval = await w.authorization.decide(w.request(), body);
    const handoffId = crypto.randomUUID();
    const receipt = await w.authorization.handoff(w.request(), {
      proposalId: p.snapshot.id,
      expectedRevision: oldApproval.proposal.revision,
      snapshotHash: p.snapshotHash,
      operationId: handoffId,
    });
    await rejects(
      w.executor.execute(w.request(), {
        proposalId: p.snapshot.id,
        handoffId,
        proposalRevision: receipt.proposal.revision,
        snapshotHash: p.snapshotHash,
        bindingHash: display.executionHash,
        requestId: crypto.randomUUID(),
      }),
      "confirmation_required",
    );
    assert.equal(w.rpcCalls, 0);
    assert.equal(await w.count(), 0);
  } finally {
    await w.close();
  }
});

test("OC-03 entitlement expiry during the transaction rolls back the save before durable completion", async () => {
  const w = await world();
  try {
    const c = await w.approved();
    w.fault("entitlement_expiry_after_rpc");
    const result = await w.executor.execute(w.request(), c);
    assert.equal(result.state, "failed_no_effect");
    assert.equal(result.reason, "authorization_invalid");
    assert.equal(result.canClaimCompletion, false);
    assert.equal(await w.count(), 0);
  } finally {
    await w.close();
  }
});
