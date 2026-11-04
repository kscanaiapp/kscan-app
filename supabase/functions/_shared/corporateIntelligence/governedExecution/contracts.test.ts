// Fake asynchronous ports deliberately match the real transaction/guard contracts.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import { createGovernedWatchExecutor } from "./coordinator.ts";
import {
  type Dependencies,
  EXECUTABLE_CAPABILITIES,
  ExecutionError,
  type Ledger,
  parseCommand,
  verifyCommand,
  verifyEvidence,
} from "./contracts.ts";
import { hash } from "../customerAuthorization/contracts.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const command = () => ({
  proposalId: crypto.randomUUID(),
  handoffId: crypto.randomUUID(),
  proposalRevision: 3,
  snapshotHash: "a".repeat(64),
  bindingHash: "b".repeat(64),
  requestId: crypto.randomUUID(),
});

Deno.test("OC-03 closed allowlist exposes only save_watchlist and strict proof arguments", () => {
  assert.deepEqual(EXECUTABLE_CAPABILITIES, ["save_watchlist"]);
  assert.ok(Object.isFrozen(EXECUTABLE_CAPABILITIES));
  assert.deepEqual(parseCommand(command()).proposalRevision, 3);
  for (
    const extra of [
      { actorId: A },
      { capability: "purchase" },
      { capability: "save_closet" },
      { url: "https://evil.com" },
      { approved: true },
      { watchIntent: "buy_under" },
      { token: "model-token" },
      { sql: "select 1" },
    ]
  ) assert.throws(() => parseCommand({ ...command(), ...extra }));
  for (
    const c of ["yes", "do it", "go ahead", null, {}, {
      ...command(),
      snapshotHash: "forged",
    }, { ...command(), proposalRevision: 2 }]
  ) assert.throws(() => parseCommand(c));
});
Deno.test("OC-03 mutation paths default OFF before authentication, storage or guards", async () => {
  let calls = 0;
  const unavailable = async () => {
    calls++;
    throw Error("should not run");
  };
  const deps: Dependencies = {
    database: { transaction: unavailable },
    authenticate: unavailable,
    lockAuthorization: unavailable,
    lockProduct: unavailable,
    verifyCustomerOperation: unavailable,
    verifyExecutionPrincipal: unavailable,
  };
  const service = createGovernedWatchExecutor(deps);
  const r = new Request("https://synthetic.invalid");
  for (
    const action of [
      () => service.execute(r, command()),
      () => service.reserve(r, command()),
      () =>
        service.present(r, {
          proposalId: A,
          expectedRevision: 0,
          operationId: A,
        }),
      () => service.decide(r, "yes"),
    ]
  ) {
    await assert.rejects(
      action(),
      (e) => e instanceof ExecutionError && e.code === "disabled",
    );
  }
  assert.equal(calls, 0);
});
Deno.test("OC-03 independent authorization gate cannot be bypassed by execution gate", async () => {
  let calls = 0;
  const unavailable = async () => {
    calls++;
    throw Error("should not run");
  };
  const service = createGovernedWatchExecutor({
    enabled: () => true,
    authorizationEnabled: () => false,
    database: { transaction: unavailable },
    authenticate: unavailable,
    lockAuthorization: unavailable,
    lockProduct: unavailable,
    verifyCustomerOperation: unavailable,
    verifyExecutionPrincipal: unavailable,
  });
  await assert.rejects(
    service.execute(new Request("https://synthetic.invalid"), command()),
    (e) => e instanceof ExecutionError && e.code === "disabled",
  );
  assert.equal(calls, 0);
});
Deno.test("OC-03 forged actor/account and missing execution principal cannot reach SQL", async () => {
  let calls = 0;
  const unavailable = async () => {
    calls++;
    throw Error("should not run");
  };
  const base: Dependencies = {
    enabled: () => true,
    authorizationEnabled: () => true,
    database: { transaction: unavailable },
    authenticate: async () => ({ actorId: A, accountId: A, anonymous: false }),
    lockAuthorization: unavailable,
    lockProduct: unavailable,
    verifyCustomerOperation: unavailable,
    verifyExecutionPrincipal: async () => {
      throw Error("not server");
    },
  };
  await assert.rejects(
    createGovernedWatchExecutor(base).execute(
      new Request("https://synthetic.invalid"),
      command(),
    ),
    (e) => e instanceof ExecutionError && e.code === "unauthorized",
  );
  await assert.rejects(
    createGovernedWatchExecutor({
      ...base,
      authenticate: async () => ({
        actorId: A,
        accountId: crypto.randomUUID(),
        anonymous: false,
      }),
    }).execute(new Request("https://synthetic.invalid"), command()),
    (e) => e instanceof ExecutionError && e.code === "unauthorized",
  );
  assert.equal(calls, 0);
});
Deno.test("OC-03 command replay is bound to actor, proposal, handoff, revision and both immutable digests", () => {
  const c = command();
  const ledger = {
    proposal_id: c.proposalId,
    actor_id: A,
    account_id: A,
    handoff_id: c.handoffId,
    proposal_revision: c.proposalRevision,
    snapshot_hash: c.snapshotHash,
    binding_hash: c.bindingHash,
  } as Ledger;
  verifyCommand(ledger, { actorId: A, accountId: A, anonymous: false }, c);
  for (
    const change of [
      { proposalId: crypto.randomUUID() },
      { handoffId: crypto.randomUUID() },
      { proposalRevision: 4 },
      { snapshotHash: "c".repeat(64) },
      { bindingHash: "d".repeat(64) },
    ]
  ) {
    assert.throws(() =>
      verifyCommand(ledger, { actorId: A, accountId: A, anonymous: false }, {
        ...c,
        ...change,
      })
    );
  }
  assert.throws(() =>
    verifyCommand(ledger, {
      actorId: crypto.randomUUID(),
      accountId: A,
      anonymous: false,
    }, c)
  );
});
Deno.test("OC-03 consumed state or fabricated ledger evidence alone cannot authorize a completion claim", async () => {
  const evidence = {
    watchId: crypto.randomUUID(),
    userId: A,
    source: "farfetch",
    canonicalUrl:
      "https://www.farfetch.com/shopping/men/fixture-item-12345.aspx",
    intent: "just_watching" as const,
    targetPrice: null,
    currency: "USD",
    rowVersion: 1,
    bindingHash: "b".repeat(64),
    observedAt: Date.now(),
  };
  const ledger = {
    watch_id: evidence.watchId,
    actor_id: A,
    binding_hash: evidence.bindingHash,
    evidence,
    evidence_hash: await hash(evidence),
  } as Ledger;
  assert.equal(await verifyEvidence(ledger), true);
  assert.equal(
    await verifyEvidence({ ...ledger, evidence_hash: "0".repeat(64) }),
    false,
  );
  assert.equal(
    await verifyEvidence({ ...ledger, actor_id: crypto.randomUUID() }),
    false,
  );
  assert.equal(await verifyEvidence({ ...ledger, evidence: null }), false);
});
