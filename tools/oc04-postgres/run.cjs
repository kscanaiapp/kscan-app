const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const path = require("node:path");
const { createEnvironment, sleep } = require("./environment.cjs");
const { A, B, URL, REF } = require(
  "../../__tests__/helpers/oc03ExecutionWorld",
);
const ROOT = path.resolve(__dirname, "../..");
const request = () =>
  new Request("https://synthetic.invalid/oc04", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
const actor = (id) => ({ actorId: id, accountId: id, anonymous: false });
function deferred() {
  let resolve;
  const promise = new Promise((r) => resolve = r);
  return { promise, resolve };
}
function stats(values) {
  const v = [...values].sort((a, b) => a - b);
  return {
    n: v.length,
    medianMs: v.length ? v[Math.ceil(v.length * .5) - 1] : null,
    p95Ms: v.length ? v[Math.ceil(v.length * .95) - 1] : null,
    maxMs: v.length ? v.at(-1) : null,
  };
}
async function waitFor(check, label, ms = 3000) {
  const end = performance.now() + ms;
  while (performance.now() < end) {
    if (await check()) return;
    await sleep(5);
  }
  throw Error("Barrier not reached: " + label);
}
async function scoped(c, id, recordId = "record-1", ref = REF) {
  const { w, modules } = c;
  const current = actor(id);
  const repository = new modules.PostgresRepository(w.database);
  const authorization = modules.createAuthorizationService({
    enabled: () => true,
    repository,
    authenticate: async () => current,
    assertActive: async () => {
      assert.equal(
        (await w.database.transaction((sql) =>
          w.deps.lockAuthorization(sql, current)
        )).accountActive,
        true,
      );
    },
    authorize: () =>
      w.database.transaction((sql) => w.deps.lockAuthorization(sql, current)),
    resolveTarget: (_a, _intent, previous) =>
      w.database.transaction((sql) =>
        w.deps.lockProduct(sql, current, previous ?? { recordId })
      ).then((p) => p.target),
    verifyCustomerOperation: async () => {},
    verifyHandoffService: async () => {},
  });
  const executor = modules.createGovernedWatchExecutor({
    ...w.deps,
    authenticate: async () => current,
  });
  async function propose() {
    return await authorization.propose(request(), {
      version: "oc02-authorization-v1",
      capability: "save_watchlist",
      arguments: { targetRef: ref },
    }, crypto.randomUUID());
  }
  async function display(p) {
    return await executor.present(request(), {
      proposalId: p.snapshot.id,
      expectedRevision: p.revision,
      operationId: crypto.randomUUID(),
    });
  }
  async function decide(d) {
    return await executor.decide(request(), {
      proposalId: d.proposalId,
      expectedRevision: d.revision,
      snapshotHash: d.snapshotHash,
      operationId: crypto.randomUUID(),
      decision: "approve",
      confirmationToken: d.confirmationToken,
      executionHash: d.executionHash,
    });
  }
  async function command() {
    const p = await propose();
    const d = await display(p);
    const approval = await decide(d);
    const handoffId = crypto.randomUUID();
    const h = await authorization.handoff(request(), {
      proposalId: p.snapshot.id,
      expectedRevision: approval.proposal.revision,
      snapshotHash: p.snapshotHash,
      operationId: handoffId,
    });
    return {
      proposalId: p.snapshot.id,
      handoffId,
      proposalRevision: h.proposal.revision,
      snapshotHash: p.snapshotHash,
      bindingHash: d.executionHash,
      requestId: crypto.randomUUID(),
    };
  }
  return { authorization, executor, propose, display, decide, command };
}
async function main() {
  let env;
  const checks = [];
  let failure = null;
  async function test(name, fn) {
    const started = performance.now();
    try {
      const details = await fn();
      checks.push({
        name,
        status: "PASS",
        durationMs: performance.now() - started,
        ...details,
      });
      console.log("PASS " + name);
    } catch (e) {
      checks.push({
        name,
        status: "FAIL",
        durationMs: performance.now() - started,
        error: e.message,
        code: e.code ?? null,
      });
      console.log("FAIL " + name + ": " + e.message);
      failure ??= e;
    } finally {
      await env?.closeCases();
    }
  }
  try {
    env = await createEnvironment();
    await test("real physical connections, transaction ownership and rollback", async () => {
      const c = await env.createCase("driver");
      const pids = await Promise.all(
        Array.from({ length: 4 }, () =>
          c.driver.transaction(async (sql) => {
            const one = (await sql.query(
              "select pg_backend_pid() as pid,txid_current()::text as tx",
            )).rows[0];
            await sql.query("select pg_sleep(0.04)");
            const two = (await sql.query(
              "select pg_backend_pid() as pid,txid_current()::text as tx",
            )).rows[0];
            assert.deepEqual(two, one);
            return one.pid;
          })),
      );
      assert.ok(new Set(pids).size >= 2);
      const before = (await c.db.query(
        "select product_id from public.fixture_products where record_id='record-1'",
      )).rows[0].product_id;
      await assert.rejects(
        c.driver.transaction(async (sql) => {
          await sql.query(
            "update public.fixture_products set product_id='rollback-probe' where record_id='record-1'",
          );
          throw Error("rollback probe");
        }),
        /rollback probe/,
      );
      assert.equal(
        (await c.db.query(
          "select product_id from public.fixture_products where record_id='record-1'",
        )).rows[0].product_id,
        before,
      );
      assert.equal(c.pool.waitingCount, 0);
      return { physicalConnections: new Set(pids).size };
    });
    await test("concurrent duplicate execution and fresh request IDs have one durable effect", async () => {
      const c = await env.createCase("duplicates");
      const s = await scoped(c, A);
      const command = await s.command();
      const results = await Promise.all(
        Array.from({ length: 6 }, () =>
          s.executor.execute(request(), {
            ...command,
            requestId: crypto.randomUUID(),
          })),
      );
      assert.ok(results.every((r) => r.canClaimCompletion));
      assert.equal(await c.w.count(), 1);
      assert.equal(c.w.rpcCalls, 1);
      const other = await s.command();
      c.w.enabled(false);
      await assert.rejects(s.executor.reserve(request(), other));
      c.w.enabled(true);
      const storedRequestId = (await c.db.query(
        "select request_id from oc03_execution.ledger where proposal_id=$1",
        [command.proposalId],
      )).rows[0].request_id;
      await assert.rejects(
        s.executor.execute(request(), {
          ...other,
          requestId: storedRequestId,
        }),
        (e) => e.code === "conflict",
      );
      assert.equal(
        (await c.db.query("select count(*)::int n from oc03_execution.ledger"))
          .rows[0].n,
        1,
      );
      assert.equal(
        (await c.db.query(
          "select count(*)::int n from oc03_execution.audit where metadata->>'state'='completed'",
        )).rows[0].n,
        1,
      );
      return {
        physicalConnections: c.observations.pids.size,
        completed: results.length,
        effects: 1,
        duplicateRequestKeyRejected: true,
        disabledBeforeReservation: true,
      };
    });
    await test("approval and revocation contend atomically", async () => {
      const c = await env.createCase("approval");
      const s = await scoped(c, A);
      const p = await s.propose();
      const d = await s.display(p);
      const results = await Promise.allSettled([
        s.decide(d),
        s.authorization.revoke(request(), {
          proposalId: p.snapshot.id,
          expectedRevision: d.revision,
          operationId: crypto.randomUUID(),
        }),
      ]);
      assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
      const stored = (await c.db.query(
        "select document from oc02_authorization.proposals where id=$1",
        [p.snapshot.id],
      )).rows[0].document;
      assert.ok(["approved", "revoked"].includes(stored.state));
      assert.equal(await c.w.count(), 0);
      return { winnerState: stored.state };
    });
    await test("reserve/status opposing lock order does not deadlock", async () => {
      const c = await env.createCase("lock-order");
      const s = await scoped(c, A);
      const command = await s.command();
      await s.executor.reserve(request(), command);
      const held = deferred();
      const proceed = deferred();
      let executorPid = null;
      let trapped = false;
      c.hook(async (e) => {
        if (
          e.phase === "after" &&
          e.sql.startsWith("select * from oc03_execution.ledger") && !trapped
        ) {
          trapped = true;
          executorPid = e.pid;
          held.resolve();
          await proceed.promise;
        }
      });
      const reserve = s.executor.reserve(request(), command);
      void reserve.catch(() => {});
      await waitFor(() => trapped, "reserve ledger barrier");
      const status = s.executor.status(request(), command);
      // Baseline status takes profile before ledger; observe its real wait and then release reserve.
      await sleep(100);
      proceed.resolve();
      const r = await Promise.allSettled([reserve, status]);
      const deadlocks = c.observations.errors.filter((e) =>
        e.code === "40P01"
      ).length;
      assert.equal(
        deadlocks,
        0,
        "Real PostgreSQL detected reserve/status lock-order deadlock",
      );
      assert.ok(r.every((v) => v.status === "fulfilled"));
      c.hook(async () => {});
      return { deadlocks, executorBackend: executorPid };
    });
    await test("a later customer deletion is not undone by an older approved save", async () => {
      const c = await env.createCase("removed");
      await c.w.legacyWatch();
      const s = await scoped(c, A);
      const command = await s.command();
      const legacy = await c.connect();
      await legacy.query("begin");
      await legacy.query(
        "select public.delete_user_commerce_watch($1,id) from public.user_commerce_watches where user_id=$1 and deleted_at is null",
        [A],
      );
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await sleep(80);
      await legacy.query("commit");
      const result = await pending;
      assert.equal(
        result.canClaimCompletion,
        false,
        "Older save recreated a Watch deleted after approval",
      );
      assert.equal(await c.w.count(), 0);
      return { resultState: result.state, reason: result.reason };
    });
    await test("current account, consent, entitlement, permission and product changes deny effects", async () => {
      const c = await env.createCase("freshness");
      const s = await scoped(c, A);
      const command = await s.command();
      const cases = [];
      for (
        const [label, change, restore] of [
          [
            "consent",
            "update public.fixture_permissions set consent=false where user_id=$1",
            "update public.fixture_permissions set consent=true where user_id=$1",
          ],
          [
            "epoch",
            "update public.fixture_permissions set revision='epoch-2' where user_id=$1",
            "update public.fixture_permissions set revision='permission-1' where user_id=$1",
          ],
          [
            "permission_denied",
            "update public.fixture_permissions set allowed=false where user_id=$1",
            "update public.fixture_permissions set allowed=true where user_id=$1",
          ],
          [
            "entitlement",
            "update public.fixture_entitlements set granted=false where user_id=$1",
            "update public.fixture_entitlements set granted=true where user_id=$1",
          ],
          [
            "inactive",
            "update public.profiles set account_status='locked' where id=$1",
            "update public.profiles set account_status='active' where id=$1",
          ],
        ]
      ) {
        await c.db.query(change, [A]);
        let result;
        try {
          result = await s.executor.execute(request(), command);
        } catch (e) {
          result = { canClaimCompletion: false, code: e.code };
        }
        assert.equal(result.canClaimCompletion, false);
        await c.db.query(restore, [A]);
        cases.push(label);
      }
      await c.db.query(
        "update public.fixture_products set product_id='changed' where record_id='record-1'",
      );
      await assert.rejects(s.executor.execute(request(), command));
      await c.db.query(
        "update public.fixture_products set product_id='product-1',owner_id=$1 where record_id='record-1'",
        [B],
      );
      assert.equal(
        (await s.executor.execute(request(), command)).canClaimCompletion,
        false,
      );
      await c.db.query(
        "update public.fixture_products set owner_id=null,product_id='product-1',valid_until=clock_timestamp()-interval '1 second' where record_id='record-1'",
      );
      await assert.rejects(s.executor.execute(request(), command));
      assert.equal(await c.w.count(), 0);
      return {
        denials: [
          ...cases,
          "product_identity",
          "ownership",
          "eligibility_expiry",
        ],
      };
    });
    await test("committed consent withdrawal wins a real row-lock wait before execution", async () => {
      const c = await env.createCase("withdrawal");
      const s = await scoped(c, A);
      const command = await s.command();
      const writer = await c.connect();
      await writer.query("begin");
      await writer.query(
        "update public.fixture_permissions set consent=false where user_id=$1",
        [A],
      );
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await sleep(80);
      await writer.query("commit");
      await assert.rejects(pending);
      assert.equal(await c.w.count(), 0);
      return { effects: 0 };
    });
    await test("authorization expires while waiting on the legacy Watchlist lock", async () => {
      const c = await env.createCase("expires-lock");
      await c.db.query(
        "update public.fixture_products set valid_until=clock_timestamp()+interval '5 seconds' where record_id='record-1'",
      );
      const s = await scoped(c, A);
      const command = await s.command();
      const blocker = await c.connect();
      await blocker.query("begin");
      await blocker.query(
        "lock table public.user_commerce_watches in row exclusive mode",
      );
      const p = (await c.db.query(
        "select document from oc02_authorization.proposals where id=$1",
        [command.proposalId],
      )).rows[0].document;
      await sleep(Math.max(0, p.snapshot.expiresAt - Date.now() - 800));
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await sleep(Math.max(0, p.snapshot.expiresAt - Date.now() + 50));
      await blocker.query("commit");
      const result = await pending;
      assert.equal(result.canClaimCompletion, false);
      assert.equal(await c.w.count(), 0);
      return { state: result.state, reason: result.reason };
    });
    await test("legacy intent change commits before save without being overwritten", async () => {
      const c = await env.createCase("legacy-intent");
      await c.w.legacyWatch();
      const s = await scoped(c, A);
      const command = await s.command();
      const legacy = await c.connect();
      await legacy.query("begin");
      await legacy.query(
        "select * from public.create_user_commerce_watch($1,'farfetch',$2,null,'Fixture',null,120,'USD','buy_under',90)",
        [A, URL],
      );
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await sleep(80);
      await legacy.query("commit");
      const result = await pending;
      assert.equal(result.canClaimCompletion, false);
      assert.equal(
        (await c.db.query(
          "select watch_intent from public.user_commerce_watches where user_id=$1 and deleted_at is null",
          [A],
        )).rows[0].watch_intent,
        "buy_under",
      );
      return { reason: result.reason };
    });
    await test("actual PostgreSQL backend termination after RPC rolls back effect and permits reconciliation", async () => {
      const c = await env.createCase("backend-kill");
      const s = await scoped(c, A);
      const command = await s.command();
      const paused = deferred();
      const proceed = deferred();
      let pid;
      c.hook(async (e) => {
        if (
          e.phase === "after" &&
          e.sql.includes("public.create_user_commerce_watch(")
        ) {
          pid = e.pid;
          paused.resolve();
          await proceed.promise;
        }
      });
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await waitFor(
        () => pid !== undefined,
        "RPC completed before termination",
      );
      assert.equal(await c.w.count(), 0);
      const killer = await c.connect();
      assert.equal(
        (await killer.query("select pg_terminate_backend($1) killed", [pid]))
          .rows[0].killed,
        true,
      );
      proceed.resolve();
      const result = await pending;
      assert.equal(result.canClaimCompletion, false);
      assert.equal(await c.w.count(), 0);
      c.hook(async () => {});
      const recovered = await s.executor.reconcile(request(), command);
      assert.equal(recovered.canClaimCompletion, false);
      assert.equal(recovered.state, "reconciled");
      return { backendTerminated: true, state: recovered.state };
    });
    await test("real PostgreSQL COMMIT acknowledgement packet loss never replays mutation", async () => {
      const c = await env.createCase("commit-packet");
      const s = await scoped(c, A);
      const command = await s.command();
      let pid;
      c.hook(async (e) => {
        if (
          e.phase === "after" &&
          e.sql.includes("public.create_user_commerce_watch(")
        ) pid = e.pid;
        if (e.phase === "before" && e.sql === "COMMIT" && e.pid === pid) {
          c.proxy.arm(pid);
          pid = null;
        }
      });
      const result = await s.executor.execute(request(), command);
      assert.equal(c.proxy.drops, 1);
      assert.equal(await c.w.count(), 1);
      assert.equal(result.canClaimCompletion, true);
      assert.equal(
        c.observations.events.filter((e) =>
          e.phase === "commit" && e.outcome === "uncertain"
        ).length,
        1,
      );
      c.hook(async () => {});
      await s.executor.execute(request(), command);
      assert.equal(c.w.rpcCalls, 1);
      return {
        commitPacketsDropped: c.proxy.drops,
        mutationCalls: c.w.rpcCalls,
      };
    });
    await test("real pool deadlines discard timed-out connections and fence late SQL", async () => {
      const c = await env.createCase("deadlines", {
        poolMax: 1,
        transactionTimeoutMs: 100,
        acquireTimeoutMs: 50,
      });
      let pid;
      await assert.rejects(c.driver.transaction(async (sql) => {
        pid = (await sql.query("select pg_backend_pid() pid")).rows[0].pid;
        await sql.query("select pg_sleep(1)");
      }));
      await waitFor(async () =>
        !(await c.db.query("select 1 from pg_stat_activity where pid=$1", [
          pid,
        ])).rows.length, "timed out backend cleanup");
      assert.equal(
        (await c.driver.transaction((sql) =>
          sql.query("select 1 n")
        )).rows[0]
          .n,
        1,
      );
      assert.equal(c.pool.waitingCount, 0);
      return {
        poolMax: 1,
        wholeTransactionDeadlineMs: 100,
        backendCleaned: true,
      };
    });
    await test("pool acquisition deadline releases a late checkout without using it", async () => {
      const c = await env.createCase("pool-wait", {
        poolMax: 1,
        transactionTimeoutMs: 5000,
        acquireTimeoutMs: 500,
      });
      const held = deferred();
      const release = deferred();
      const first = c.driver.transaction(async () => {
        held.resolve();
        await release.promise;
      });
      void first.catch(() => {});
      await Promise.race([held.promise, first]);
      await assert.rejects(
        c.driver.transaction(async (sql) => sql.query("select 1")),
      );
      release.resolve();
      await first;
      await waitFor(() => c.pool.waitingCount === 0, "late checkout removed");
      assert.equal(
        (await c.driver.transaction((sql) => sql.query("select 1 n"))).rows[0]
          .n,
        1,
      );
      return { poolMax: 1, acquireDeadlineMs: 500, waitingAfter: 0 };
    });
    await test("row-first legacy transactions expose retained table-lock deadlock risk without false completion", async () => {
      const c = await env.createCase("row-first");
      await c.w.legacyWatch();
      const s = await scoped(c, A);
      const command = await s.command();
      const legacy = await c.connect();
      await legacy.query("begin");
      await legacy.query(
        "select id from public.user_commerce_watches where user_id=$1 for update",
        [A],
      );
      let fenced = false;
      c.hook(async (e) => {
        if (e.phase === "after" && e.sql.startsWith("lock table")) {
          fenced = true;
        }
      });
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await waitFor(() => fenced, "executor table fence");
      await sleep(20);
      let legacyDeadlock = false;
      try {
        await legacy.query(
          "update public.user_commerce_watches set watch_intent='buy_under',target_price_amount=90 where user_id=$1",
          [A],
        );
        await legacy.query("commit");
      } catch (e) {
        assert.equal(e.code, "40P01");
        legacyDeadlock = true;
        await legacy.query("rollback");
      }
      const result = await pending;
      const intent = (await c.db.query(
        "select watch_intent from public.user_commerce_watches where user_id=$1",
        [A],
      )).rows[0].watch_intent;
      if (result.canClaimCompletion) assert.equal(intent, "just_watching");
      else assert.equal(intent, "buy_under");
      const deadlocks = c.observations.errors.filter((e) =>
        e.code === "40P01"
      ).length + Number(legacyDeadlock);
      assert.equal(deadlocks, 1);
      return {
        expectedAdversarialDeadlocks: deadlocks,
        legacyAborted: legacyDeadlock,
        canClaimCompletion: result.canClaimCompletion,
        retainedRisk: true,
      };
    });
    await test("bounded multi-account workloads measure global-lock contention, no-ops and ledger growth", async () => {
      const batches = [];
      for (
        const mode of ["uncontended", "legacy-lock-150ms", "already-watched"]
      ) {
        const c = await env.createCase(mode);
        const seed = await c.connect();
        const jobs = [];
        for (let i = 0; i < 8; i++) {
          const id = i % 2 ? B : A;
          const record = `load-${i}`;
          const url = URL.replace("12345", String(12350 + i));
          await seed.query(
            "insert into public.fixture_products select $1,$2,revision,$3,null,valid_until,jsonb_set(listing,'{productUrl}',to_jsonb($4::text)) from public.fixture_products where record_id='record-1'",
            [record, `product-${i}`, `source-${i}`, url],
          );
          if (mode === "already-watched") {
            await seed.query(
              "select * from public.create_user_commerce_watch($1,'farfetch',$2,$3,'Synthetic',null,120,'USD','just_watching',null)",
              [id, url, `source-${i}`],
            );
          }
          const s = await scoped(c, id, record, `p_${crypto.randomUUID()}`);
          jobs.push({ s, command: await s.command() });
        }
        if (mode === "legacy-lock-150ms") {
          await seed.query("begin");
          await seed.query(
            "lock table public.user_commerce_watches in row exclusive mode",
          );
        }
        let firstFence = false;
        c.hook(async (e) => {
          if (e.phase === "before" && e.sql.startsWith("lock table")) {
            firstFence = true;
          }
        });
        const pending = jobs.map(async ({ s, command }) => {
          const start = performance.now();
          const result = await s.executor.execute(request(), command);
          return { elapsedMs: performance.now() - start, result };
        });
        const all = Promise.all(pending);
        void all.catch(() => {});
        if (mode === "legacy-lock-150ms") {
          await waitFor(() => firstFence, "workload reaches legacy fence");
          await sleep(150);
          await seed.query("commit");
        }
        const results = await all;
        assert.ok(results.every((r) => r.result.canClaimCompletion));
        const growth = (await c.db.query(
          "select (select count(*)::int from oc03_execution.ledger) ledger,(select count(*)::int from oc03_execution.audit) audit,(select count(*)::int from public.user_commerce_watches where deleted_at is null) watches",
        )).rows[0];
        assert.equal(growth.ledger, 8);
        assert.equal(growth.watches, 8);
        const before = growth.audit;
        for (let i = 0; i < 5; i++) {
          await jobs[0].s.executor.status(request(), jobs[0].command);
        }
        assert.equal(
          (await c.db.query("select count(*)::int n from oc03_execution.audit"))
            .rows[0].n,
          before,
        );
        await assert.rejects(
          c.driver.transaction((sql) =>
            sql.query("delete from oc03_execution.ledger")
          ),
          (e) => e.code === "42501",
        );
        batches.push({
          mode,
          submitted: 8,
          concurrentSuccessful: results.length,
          latency: stats(results.map((r) => r.elapsedMs)),
          sampledLockWait: stats([...c.observations.lockWaits.values()]),
          sampledWatchTableWait: stats([
            ...c.observations.tableLockWaits.values(),
          ]),
          lockStatementElapsedUpperBound: stats(
            c.observations.queries.filter((q) =>
              q.statement.startsWith("lock table")
            ).map((q) => q.elapsedMs),
          ),
          noOps: results.filter((r) =>
            r.result.effect === "already_watched"
          ).length,
          growth,
          statusPolls: 5,
          statusAuditGrowth: 0,
          errors: c.observations.errors.filter((e) =>
            ["40P01", "55P03", "57014"].includes(e.code)
          ),
          poolHighWater: Math.max(
            ...c.observations.poolSamples.map((s) => s.total),
          ),
          waitingHighWater: Math.max(
            ...c.observations.poolSamples.map((s) => s.waiting),
          ),
        });
        await seed.query("delete from auth.users");
        assert.equal(
          (await seed.query(
            "select count(*)::int n from oc03_execution.ledger",
          )).rows[0].n,
          0,
        );
        batches.at(-1).accountDeletionCascadedLedger = true;
        await c.close();
      }
      return { batches, samplingIntervalMs: 5 };
    });
    await test("actor advisory locks, absent-row locks and uniqueness cannot fence the unchanged legacy RPC", async () => {
      const c = await env.createCase("alternative-counterexample");
      const candidate = await c.connect(), legacy = await c.connect();
      await candidate.query("begin");
      await candidate.query(
        "select pg_advisory_xact_lock(hashtextextended($1,0))",
        [A],
      );
      assert.equal(
        (await candidate.query(
          "select id from public.user_commerce_watches where user_id=$1 and canonical_url=$2 for update",
          [A, URL],
        )).rows.length,
        0,
      );
      await legacy.query(
        "select * from public.create_user_commerce_watch($1,'farfetch',$2,null,'Synthetic',null,120,'USD','buy_under',90)",
        [A, URL],
      );
      await candidate.query(
        "select * from public.create_user_commerce_watch($1,'farfetch',$2,null,'Synthetic',null,120,'USD','just_watching',null)",
        [A, URL],
      );
      assert.equal(
        (await candidate.query(
          "select watch_intent from public.user_commerce_watches where user_id=$1",
          [A],
        )).rows[0].watch_intent,
        "just_watching",
      );
      await candidate.query("rollback");
      assert.equal(
        (await legacy.query(
          "select watch_intent from public.user_commerce_watches where user_id=$1",
          [A],
        )).rows[0].watch_intent,
        "buy_under",
      );
      return {
        candidateRejected: true,
        reason:
          "unchanged legacy writer ignores advisory lock; unique upsert changes intent; experimental overwrite rolled back",
      };
    });
    await test("legacy table-lock timeout refuses effect and retains recovery evidence", async () => {
      const c = await env.createCase("legacy-timeout");
      const s = await scoped(c, A);
      const command = await s.command();
      const legacy = await c.connect();
      await legacy.query("begin");
      await legacy.query(
        "lock table public.user_commerce_watches in row exclusive mode",
      );
      let waiting = false;
      c.hook(async (e) => {
        if (e.phase === "before" && e.sql.startsWith("lock table")) {
          waiting = true;
        }
      });
      const pending = s.executor.execute(request(), command);
      void pending.catch(() => {});
      await waitFor(() => waiting, "table-lock timeout begins");
      await sleep(1800);
      await legacy.query("commit");
      const result = await pending;
      assert.equal(result.canClaimCompletion, false);
      assert.equal(await c.w.count(), 0);
      assert.ok(c.observations.errors.some((e) => e.code === "55P03"));
      return {
        state: result.state,
        timeouts: c.observations.errors.filter((e) =>
          e.code === "55P03"
        ).length,
      };
    });
    await test("paused Watch and expired entitlement refuse stale completion", async () => {
      const c = await env.createCase("paused");
      await c.w.legacyWatch();
      const s = await scoped(c, A);
      const command = await s.command();
      const second = await s.command();
      const legacy = await c.connect();
      await legacy.query(
        "update public.user_commerce_watches set status='paused' where user_id=$1",
        [A],
      );
      assert.equal(
        (await s.executor.execute(request(), command)).canClaimCompletion,
        false,
      );
      await c.db.query(
        "update public.fixture_entitlements set valid_until=clock_timestamp()-interval '1 second' where user_id=$1",
        [A],
      );
      assert.equal(
        (await s.executor.execute(request(), second).catch((e) => {
          assert.equal(e.code, "authorization_invalid");
          return { canClaimCompletion: false };
        })).canClaimCompletion,
        false,
      );
      assert.equal(c.w.rpcCalls, 0);
      return { mutationCalls: 0 };
    });
    await test("failures before RPC and completion retain zero effects; interrupted reconciliation and polling cannot claim success", async () => {
      const results = [];
      for (const fault of ["before_rpc", "after_rpc", "before_completion"]) {
        const c = await env.createCase(`boundary-${fault}`);
        const s = await scoped(c, A);
        const command = await s.command();
        c.w.fault(fault);
        const result = await s.executor.execute(request(), command);
        assert.equal(result.canClaimCompletion, false);
        assert.equal(await c.w.count(), 0);
        c.w.fault(null);
        let killed = 0;
        const killer = await c.connect();
        c.hook(async (e) => {
          if (
            e.phase === "before" &&
            e.sql.startsWith("select * from oc03_execution.ledger")
          ) {
            killed++;
            await killer.query("select pg_terminate_backend($1)", [e.pid]);
          }
        });
        assert.equal(
          (await s.executor.reconcile(request(), command)).canClaimCompletion,
          false,
        );
        assert.equal(
          (await s.executor.status(request(), command)).canClaimCompletion,
          false,
        );
        assert.equal(killed, 2);
        c.hook(async () => {});
        assert.equal(
          (await s.executor.reconcile(request(), command)).canClaimCompletion,
          false,
        );
        results.push({
          fault,
          injectedCallbackFailure: true,
          interruptedDatabaseReads: killed,
          effects: 0,
        });
        await c.close();
      }
      return { boundaries: results };
    });
    await test("lost HTTP response after durable COMMIT returns prior evidence on retry", async () => {
      const http = require("node:http");
      const c = await env.createCase("response-loss");
      const s = await scoped(c, A);
      const command = await s.command();
      let completed;
      const server = http.createServer(async (_req, res) => {
        try {
          completed = await s.executor.execute(request(), command);
          res.destroy();
        } catch (e) {
          res.destroy(e);
        }
      });
      await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
      try {
        await assert.rejects(
          fetch(`http://127.0.0.1:${server.address().port}`),
        );
        assert.equal(completed.canClaimCompletion, true);
        const retry = await s.executor.execute(request(), {
          ...command,
          requestId: crypto.randomUUID(),
        });
        assert.equal(retry.canClaimCompletion, true);
        assert.equal(retry.watchId, completed.watchId);
        assert.equal(c.w.rpcCalls, 1);
      } finally {
        await new Promise((resolve) => server.close(resolve));
      }
      return { droppedHttpResponses: 1, mutationCalls: c.w.rpcCalls };
    });
    await test("PostgreSQL restart preserves reserved ledger and resumes exactly once", async () => {
      const c = await env.createCase("restart");
      const s = await scoped(c, A);
      const command = await s.command();
      await s.executor.reserve(request(), command);
      await env.restart();
      await c.reconnect();
      const result = await s.executor.execute(request(), command);
      assert.equal(result.canClaimCompletion, true);
      assert.equal(await c.w.count(), 1);
      return { postgresRestarted: true, state: result.state };
    });
  } catch (e) {
    failure ??= e;
    checks.push({ name: "environment", status: "FAIL", error: e.message });
  } finally {
    if (env) await env.close();
  }
  const report = {
    version: "oc04-pg-v1",
    generatedAt: new Date().toISOString(),
    checks,
    environment: env
      ? {
        ...env.report,
        physicalConnections: [...env.report.physicalConnections],
        lockSamples: [...env.report.lockSamples.values()],
      }
      : null,
    verdict: failure ? "FAIL" : "PASS",
  };
  const output = path.resolve(
    ROOT,
    "docs/build36/corporate-intelligence-v2/OC-04-POSTGRES-EVIDENCE.json",
  );
  await fs.writeFile(output, JSON.stringify(report, null, 2) + "\n");
  console.log(report.verdict + " report: " + output);
  process.exitCode = failure ? 1 : 0;
}
main().catch((e) => {
  console.error(e.message);
  process.exitCode = 1;
});
