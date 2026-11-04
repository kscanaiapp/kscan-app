// Fake asynchronous ports intentionally mirror production Promise interfaces.
// deno-lint-ignore-file require-await
import assert from "node:assert/strict";
import {
  createAuthorizationService,
  type Dependencies,
  modelProposalSummary,
} from "./service.ts";
import { MemoryRepository } from "./repository.ts";
import {
  type Actor,
  AuthorizationError,
  type Capability,
  checkTransition,
  hash,
  parseIntent,
  POLICY,
  RATE_PER_MINUTE,
  RETENTION_MS,
  type Target,
  validateStoredProposal,
  VERSION,
} from "./contracts.ts";

const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const REF = "p_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
const intent = (capability: Capability = "save_watchlist") => ({
  version: VERSION,
  capability,
  arguments: {
    targetRef: capability === "update_saved_preference"
      ? REF.replace("p_", "saved_")
      : capability.endsWith("_watch")
      ? REF.replace("p_", "watch_")
      : REF,
    ...(capability === "update_saved_preference"
      ? { preference: "notify_price_drop" }
      : {}),
  },
});
const http = () =>
  new Request("https://kscan.invalid/future-confirmation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
function world(overrides: Partial<Dependencies> = {}) {
  let time = Date.now();
  let enabled = true;
  let active = true;
  let consent = true;
  let entitled = true;
  let allowed = true;
  let permissionRevision = "permission-1";
  let channel = true;
  let servicePrincipal = true;
  let currentActor: Actor = {
    actorId: A,
    accountId: ACCOUNT,
    anonymous: false,
  };
  let targetChange: Partial<Target> = {};
  let authCalls = 0;
  let resolves = 0;
  const repo = new MemoryRepository();
  const telemetry: unknown[] = [];
  const deps: Dependencies = {
    enabled: () => enabled,
    now: () => time,
    repository: repo,
    authenticate: async () => {
      authCalls++;
      return currentActor;
    },
    assertActive: async () => {
      if (!active) throw Error("inactive");
    },
    authorize: async () => ({
      allowed,
      aiConsent: consent,
      entitled,
      permissionRevision,
      capabilities: [
        "save_watchlist",
        "save_closet",
        "update_saved_preference",
        "pause_watch",
        "remove_watch",
      ],
    }),
    resolveTarget: async (a, i) => {
      resolves++;
      return {
        kind: i.capability === "update_saved_preference"
          ? "saved_product"
          : i.capability.endsWith("_watch")
          ? "watch"
          : "product",
        recordId: "server-record",
        productId: "server-product",
        accountId: i.capability.startsWith("save_") ? null : a.accountId,
        revision: "record-1",
        checkedAt: time,
        validUntil: time + 120_000,
        provenance: { provider: "serper", sourceId: "provider-source" },
        ...targetChange,
      };
    },
    verifyCustomerOperation: async () => {
      if (!channel) throw Error("not_customer_route");
    },
    verifyHandoffService: async () => {
      if (!servicePrincipal) throw Error("not_service");
    },
    emit: (event) => telemetry.push(event),
    ...overrides,
  };
  const service = createAuthorizationService(deps);
  return {
    repo,
    service,
    telemetry,
    scope: () => currentActor,
    now: () => time,
    advance: (ms: number) => time += ms,
    enabled: (v: boolean) => enabled = v,
    active: (v: boolean) => active = v,
    consent: (v: boolean) => consent = v,
    entitled: (v: boolean) => entitled = v,
    allowed: (v: boolean) => allowed = v,
    permissionRevision: (v: string) => permissionRevision = v,
    channel: (v: boolean) => channel = v,
    principal: (v: boolean) => servicePrincipal = v,
    actor: (a: Actor) => currentActor = a,
    target: (t: Partial<Target>) => targetChange = t,
    authCalls: () => authCalls,
    resolves: () => resolves,
  };
}
async function presented(
  w: ReturnType<typeof world>,
  capability: Capability = "save_watchlist",
) {
  const proposal = await w.service.propose(
    http(),
    intent(capability),
    crypto.randomUUID(),
  );
  const display = await w.service.present(http(), {
    proposalId: proposal.snapshot.id,
    expectedRevision: proposal.revision,
    operationId: crypto.randomUUID(),
  });
  const body = {
    proposalId: display.proposalId,
    expectedRevision: display.revision,
    snapshotHash: display.snapshotHash,
    operationId: crypto.randomUUID(),
    decision: "approve" as const,
    confirmationToken: display.confirmationToken,
  };
  return { proposal, display, body };
}
async function rejects(p: Promise<unknown>, code: string) {
  await assert.rejects(
    p,
    (e: unknown) => e instanceof AuthorizationError && e.code === code,
  );
}

for (
  const cap of [
    "save_watchlist",
    "save_closet",
    "update_saved_preference",
    "pause_watch",
    "remove_watch",
  ] as Capability[]
) {
  Deno.test(`successful lifecycle for ${cap} authorizes but never executes`, async () => {
    const w = world();
    const { proposal, body } = await presented(w, cap);
    assert.equal(proposal.state, "proposed");
    assert.equal(proposal.snapshot.policy, POLICY);
    const approved = await w.service.decide(http(), body);
    assert.equal(approved.proposal.state, "approved");
    assert.equal(approved.executed, false);
    const receipt = await w.service.handoff(http(), {
      proposalId: body.proposalId,
      expectedRevision: approved.proposal.revision,
      snapshotHash: body.snapshotHash,
      operationId: crypto.randomUUID(),
    });
    assert.equal(receipt.proposal.state, "consumed");
    assert.equal(receipt.executed, false);
    assert.deepEqual(w.repo.audits.map((a) => a.to), [
      "proposed",
      "awaiting_customer_approval",
      "approved",
      "consumed",
    ]);
  });
}
Deno.test("default OFF and rollback have zero authorization/storage work when disabled", async () => {
  const w = world({ enabled: undefined });
  await rejects(
    w.service.propose(http(), intent(), crypto.randomUUID()),
    "disabled",
  );
  assert.equal(w.authCalls(), 0);
  const x = world();
  const { body } = await presented(x);
  x.enabled(false);
  await rejects(x.service.decide(http(), body), "disabled");
});
for (
  const capability of [
    "purchase",
    "payment",
    "register_merchant",
    "send_external_message",
    "open_checkout",
    "constructor",
    "__proto__",
  ]
) {
  Deno.test(`forbidden/forged capability ${capability}`, () =>
    assert.throws(() => parseIntent({ ...intent(), capability })));
}
Deno.test("strict model contract rejects credentials, identities, URLs, approvals, product payloads and conversational instructions", () => {
  for (
    const v of [
      "yes",
      "do it",
      "go ahead",
      { ...intent(), actorId: B },
      { ...intent(), approved: true },
      { ...intent(), token: "model-token" },
      {
        ...intent(),
        arguments: { targetRef: REF, productUrl: "https://evil.com" },
      },
      { ...intent(), arguments: { targetRef: REF, permission: true } },
      { ...intent(), arguments: { targetRef: REF, product: { id: "fake" } } },
      { ...intent(), arguments: { targetRef: "https://evil.com" } },
      {
        ...intent(),
        arguments: { targetRef: "p_------------------------------------" },
      },
    ]
  ) assert.throws(() => parseIntent(v));
});
Deno.test("cross-actor AND cross-account proposal access fail closed", async () => {
  for (
    const changed of [{ actorId: B, accountId: ACCOUNT, anonymous: false }, {
      actorId: A,
      accountId: OTHER,
      anonymous: false,
    }]
  ) {
    const w = world();
    const { body } = await presented(w);
    w.actor(changed);
    await rejects(w.service.decide(http(), body), "not_found");
  }
});
Deno.test("anonymous actors, inactive accounts, consent, entitlement and denied capabilities cannot create proposals", async () => {
  for (
    const change of ["anonymous", "active", "consent", "entitled", "allowed"]
  ) {
    const w = world();
    if (change === "anonymous") {
      w.actor({ actorId: A, accountId: ACCOUNT, anonymous: true });
    } else w[change as "active" | "consent" | "entitled" | "allowed"](false);
    await rejects(
      w.service.propose(http(), intent(), crypto.randomUUID()),
      "unauthorized",
    );
  }
  const w = world();
  w.entitled(false);
  assert.equal(
    (await w.service.propose(
      http(),
      intent("save_closet"),
      crypto.randomUUID(),
    )).state,
    "proposed",
  );
});
Deno.test("permission withdrawal, account suspension and permission epoch changes revoke pending approvals", async () => {
  for (const change of ["consent", "allowed", "active", "permissionRevision"]) {
    const w = world();
    const { body } = await presented(w);
    if (change === "permissionRevision") w.permissionRevision("permission-2");
    else w[change as "consent" | "allowed" | "active"](false);
    await rejects(w.service.decide(http(), body), "unauthorized");
    // Suspension blocks before fresh checks; no approval can occur regardless of materialized revocation.
    assert.notEqual(
      (await w.repo.get(w.scope(), body.proposalId))?.state,
      "approved",
    );
  }
});
Deno.test("missing/stale/future/foreign target records and unapproved provenance fail closed", async () => {
  for (
    const change of [
      { validUntil: 0 },
      { checkedAt: 0 },
      { checkedAt: Date.now() + 1_000_000 },
      { accountId: OTHER },
      { productId: "" },
      { provenance: { provider: "model" as "serper", sourceId: "fake" } },
    ]
  ) {
    const w = world();
    w.target(change);
    await assert.rejects(
      w.service.propose(http(), intent(), crypto.randomUUID()),
    );
  }
});
Deno.test("changed product identity, resource revision or provenance revokes the proposal", async () => {
  for (
    const change of [{ productId: "swapped" }, { recordId: "another" }, {
      revision: "record-2",
    }, { provenance: { provider: "brave" as const, sourceId: "other" } }]
  ) {
    const w = world();
    const { body } = await presented(w);
    w.target(change);
    await rejects(w.service.decide(http(), body), "target_changed");
    assert.equal(
      (await w.repo.get(w.scope(), body.proposalId))?.state,
      "revoked",
    );
  }
});
Deno.test("token, snapshot, expected revision and explicit customer operation are all required", async () => {
  const w = world();
  const { body } = await presented(w);
  await rejects(
    w.service.decide(http(), {
      ...body,
      confirmationToken: `${crypto.randomUUID()}.${crypto.randomUUID()}`,
    }),
    "invalid_confirmation",
  );
  await rejects(
    w.service.decide(http(), { ...body, snapshotHash: "a".repeat(64) }),
    "conflict",
  );
  await rejects(
    w.service.decide(http(), { ...body, expectedRevision: 0 }),
    "conflict",
  );
  for (
    const bad of ["yes", "do it", "go ahead", { ...body, decision: "yes" }, {
      ...body,
      approved: true,
    }, { ...body, arguments: { targetRef: REF } }]
  ) await rejects(w.service.decide(http(), bad), "invalid_request");
  w.channel(false);
  await rejects(w.service.decide(http(), body), "invalid_confirmation");
  w.channel(true);
  await rejects(
    w.service.decide(new Request("https://kscan.invalid/chat"), body),
    "invalid_confirmation",
  );
});
Deno.test("concurrent approvals have one winner; same idempotency key is retry-safe without another authorization", async () => {
  const w = world();
  const { body } = await presented(w);
  const results = await Promise.allSettled([
    w.service.decide(http(), body),
    w.service.decide(http(), { ...body, operationId: crypto.randomUUID() }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(w.repo.audits.filter((a) => a.to === "approved").length, 1);
  const winner = results[0].status === "fulfilled" ? body : null;
  if (winner) {
    const retry = await w.service.decide(http(), winner);
    assert.equal(retry.replayed, true);
    assert.equal(retry.executed, false);
  }
});
Deno.test("idempotent proposal retries use one record; altered request reusing a key is rejected", async () => {
  const w = world();
  const key = crypto.randomUUID();
  const [p, q] = await Promise.all([
    w.service.propose(http(), intent(), key),
    w.service.propose(http(), intent(), key),
  ]);
  assert.equal(p.snapshot.id, q.snapshot.id);
  assert.equal(w.repo.audits.length, 1);
  await rejects(
    w.service.propose(http(), intent("save_closet"), key),
    "idempotency_conflict",
  );
});
Deno.test("customer rejection is terminal, including after consent withdrawal", async () => {
  const w = world();
  const { body } = await presented(w);
  w.consent(false);
  const rejected = await w.service.decide(http(), {
    ...body,
    decision: "reject",
  });
  assert.equal(rejected.proposal.state, "rejected");
  w.consent(true);
  await rejects(
    w.service.decide(http(), { ...body, operationId: crypto.randomUUID() }),
    "conflict",
  );
});
Deno.test("expired proposals materialize expiration and never approve", async () => {
  const w = world();
  const { body } = await presented(w);
  w.advance(120_001);
  await rejects(w.service.decide(http(), body), "expired");
  assert.equal(
    (await w.repo.get(w.scope(), body.proposalId))?.state,
    "expired",
  );
});
Deno.test("presentation recovery rotates confirmation token and rejects the previous token/revision", async () => {
  const w = world();
  const { body } = await presented(w);
  const next = await w.service.present(http(), {
    proposalId: body.proposalId,
    expectedRevision: body.expectedRevision,
    operationId: crypto.randomUUID(),
  });
  await rejects(
    w.service.decide(http(), { ...body, expectedRevision: next.revision }),
    "invalid_confirmation",
  );
  assert.equal(
    (await w.service.decide(http(), {
      ...body,
      expectedRevision: next.revision,
      confirmationToken: next.confirmationToken,
    })).proposal.state,
    "approved",
  );
});
Deno.test("returned proposal mutation cannot change immutable persisted arguments", async () => {
  const w = world();
  const p = await w.service.propose(http(), intent(), crypto.randomUUID());
  p.snapshot.arguments.targetRef = "forged";
  p.snapshot.target.productId = "swapped";
  const original = await w.repo.get(w.scope(), p.snapshot.id);
  assert.equal(original?.snapshot.arguments.targetRef, REF);
  assert.equal(original?.snapshot.target.productId, "server-product");
  const altered = structuredClone(original!);
  altered.snapshot.arguments.targetRef = "forged";
  altered.snapshotHash = await hash(altered.snapshot);
  altered.revision++;
  altered.state = "revoked";
  await rejects(
    w.repo.commit({
      scope: w.scope(),
      operationId: crypto.randomUUID(),
      requestHash: "a".repeat(64),
      expectedRevision: 0,
      next: altered,
      now: w.now(),
    }),
    "conflict",
  );
});
Deno.test("handoff has a separate service guard, rechecks permission/target, and cannot be replayed under a new operation", async () => {
  const w = world();
  const { body } = await presented(w);
  const approved = await w.service.decide(http(), body);
  const command = {
    proposalId: body.proposalId,
    expectedRevision: approved.proposal.revision,
    snapshotHash: body.snapshotHash,
    operationId: crypto.randomUUID(),
  };
  w.principal(false);
  await rejects(w.service.handoff(http(), command), "unauthorized");
  w.principal(true);
  const result = await w.service.handoff(http(), command);
  assert.equal(result.executed, false);
  assert.equal(
    (await w.service.handoff(http(), command)).handoffId,
    result.handoffId,
  );
  await rejects(
    w.service.handoff(http(), { ...command, operationId: crypto.randomUUID() }),
    "conflict",
  );
  await rejects(
    w.service.decide(http(), { ...body, operationId: crypto.randomUUID() }),
    "conflict",
  );
});
Deno.test("consent revocation between approval and handoff prevents handoff", async () => {
  const w = world();
  const { body } = await presented(w);
  const approved = await w.service.decide(http(), body);
  w.consent(false);
  await rejects(
    w.service.handoff(http(), {
      proposalId: body.proposalId,
      expectedRevision: approved.proposal.revision,
      snapshotHash: body.snapshotHash,
      operationId: crypto.randomUUID(),
    }),
    "unauthorized",
  );
  assert.equal(
    (await w.repo.get(w.scope(), body.proposalId))?.state,
    "revoked",
  );
});
Deno.test("rate limits apply per actor across accounts, count malformed attempts, and reset by minute", async () => {
  const w = world();
  for (let i = 0; i < RATE_PER_MINUTE; i++) {
    await rejects(
      w.service.propose(http(), "yes", crypto.randomUUID()),
      "invalid_request",
    );
  }
  w.actor({ actorId: A, accountId: OTHER, anonymous: false });
  await rejects(
    w.service.propose(http(), intent(), crypto.randomUUID()),
    "rate_limited",
  );
  w.advance(60_000);
  assert.equal(
    (await w.service.propose(http(), intent(), crypto.randomUUID())).state,
    "proposed",
  );
});
Deno.test("metadata audit has no actor, message, image, evidence or confirmation token", async () => {
  const w = world();
  const { body } = await presented(w);
  await w.service.decide(http(), body);
  for (const event of [...w.repo.audits, ...w.telemetry]) {
    assert.deepEqual(
      Object.keys(event as object).sort(),
      ["version", "capability", "from", "to", "revision"].sort(),
    );
    const text = JSON.stringify(event);
    for (
      const privateValue of [
        A,
        ACCOUNT,
        body.confirmationToken,
        "server-product",
        "provider-source",
      ]
    ) assert.ok(!text.includes(privateValue));
  }
});
Deno.test("retention purges proposal, operation receipts and old rate buckets together", async () => {
  const w = world();
  const op = crypto.randomUUID();
  const p = await w.service.propose(http(), intent(), op);
  w.advance(RETENTION_MS + 1);
  assert.equal(await w.repo.purge(w.now()), 1);
  assert.equal(await w.repo.get(w.scope(), p.snapshot.id), null);
  assert.equal(await w.repo.receipt(w.scope(), op), null);
});
Deno.test("illegal transitions and direct execution states fail closed", async () => {
  const w = world();
  const p = await w.service.propose(http(), intent(), crypto.randomUUID());
  for (const state of ["approved", "consumed", "executed", "confirmed"]) {
    assert.throws(() =>
      checkTransition(
        p,
        { ...p, state: state as "approved", revision: 1 },
        w.now(),
      )
    );
  }
  assert.equal("execute" in w.service, false);
  assert.equal("purchase" in w.service, false);
});

Deno.test("explicit customer revocation is idempotent and prevents later approval", async () => {
  const w = world();
  const { body } = await presented(w);
  const command = {
    proposalId: body.proposalId,
    expectedRevision: body.expectedRevision,
    operationId: crypto.randomUUID(),
  };
  assert.equal((await w.service.revoke(http(), command)).state, "revoked");
  assert.equal((await w.service.revoke(http(), command)).state, "revoked");
  await rejects(
    w.service.decide(http(), { ...body, operationId: crypto.randomUUID() }),
    "conflict",
  );
});
Deno.test("same approval operation retries return one receipt; altered reuse and fresh replay are rejected", async () => {
  const w = world();
  const { body } = await presented(w);
  const first = await w.service.decide(http(), body);
  const retry = await w.service.decide(http(), body);
  assert.equal(first.replayed, false);
  assert.equal(retry.replayed, true);
  assert.equal(retry.proposal.revision, first.proposal.revision);
  assert.equal(w.repo.audits.filter((a) => a.to === "approved").length, 1);
  await rejects(
    w.service.decide(http(), { ...body, decision: "reject" }),
    "idempotency_conflict",
  );
  await rejects(
    w.service.decide(http(), { ...body, operationId: crypto.randomUUID() }),
    "conflict",
  );
  w.consent(false);
  await rejects(w.service.decide(http(), body), "unauthorized");
});
Deno.test("simultaneous presentation refresh and approval cannot both commit", async () => {
  const w = world();
  const { body } = await presented(w);
  const outcomes = await Promise.allSettled([
    w.service.present(http(), {
      proposalId: body.proposalId,
      expectedRevision: body.expectedRevision,
      operationId: crypto.randomUUID(),
    }),
    w.service.decide(http(), body),
  ]);
  assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
});
Deno.test("consent withdrawal during target I/O is rechecked before approval", async () => {
  let withdraw = false;
  const w: ReturnType<typeof world> = world({
    resolveTarget: async () => {
      if (withdraw) w.consent(false);
      return {
        kind: "product",
        recordId: "r",
        productId: "p",
        accountId: null,
        revision: "r1",
        checkedAt: w.now(),
        validUntil: w.now() + 120000,
        provenance: { provider: "serper", sourceId: "s" },
      };
    },
  });
  const { body } = await presented(w);
  withdraw = true;
  await rejects(w.service.decide(http(), body), "unauthorized");
  assert.equal(
    (await w.repo.get(w.scope(), body.proposalId))?.state,
    "revoked",
  );
});
Deno.test("default missing handoff principal guard denies authorization consumption", async () => {
  const w = world({ verifyHandoffService: undefined });
  const { body } = await presented(w);
  const approved = await w.service.decide(http(), body);
  await rejects(
    w.service.handoff(http(), {
      proposalId: body.proposalId,
      expectedRevision: approved.proposal.revision,
      snapshotHash: body.snapshotHash,
      operationId: crypto.randomUUID(),
    }),
    "unauthorized",
  );
  assert.equal(
    (await w.repo.get(w.scope(), body.proposalId))?.state,
    "approved",
  );
});
Deno.test("persisted schema validation rejects validly rehashed but malformed snapshots", async () => {
  const w = world();
  const original = await w.service.propose(
    http(),
    intent(),
    crypto.randomUUID(),
  );
  type Corrupt = {
    snapshot: Record<string, unknown> & { target: { provenance: unknown } };
    snapshotHash: string;
  };
  const corruptions: ((p: Corrupt) => unknown)[] = [
    (p) => p.snapshot.expiresAt = NaN,
    (p) => p.snapshot.retainUntil = 0,
    (p) => p.snapshot.arguments = { targetRef: REF, url: "https://evil.com" },
    (p) =>
      p.snapshot.target.provenance = { provider: "model", sourceId: "fake" },
    (p) => p.snapshot.permissionRevision = "",
    (p) => p.snapshot.policy = "other-policy",
  ];
  for (const mutate of corruptions) {
    const p = structuredClone(original) as unknown as Corrupt;
    mutate(p);
    p.snapshotHash = await hash(p.snapshot);
    await assert.rejects(validateStoredProposal(p, w.now()));
  }
});
Deno.test("model summary never exposes account, target identity, digest or confirmation state", async () => {
  const w = world();
  const { proposal } = await presented(w);
  const summary = modelProposalSummary(proposal);
  assert.deepEqual(
    Object.keys(summary).sort(),
    [
      "version",
      "capability",
      "proposalStatus",
      "requiresCustomerConfirmation",
      "executed",
    ].sort(),
  );
  assert.equal(summary.executed, false);
  assert.ok(!JSON.stringify(summary).includes(ACCOUNT));
});

Deno.test("denial telemetry is a closed code and never leaks dependency errors", async () => {
  const events: unknown[] = [];
  const w = world({
    resolveTarget: async () => {
      throw Error("SECRET_CUSTOMER_TEXT");
    },
    emitDenied: (event) => events.push(event),
  });
  await rejects(
    w.service.propose(http(), intent(), crypto.randomUUID()),
    "storage_failure",
  );
  assert.deepEqual(events, [{
    version: "oc02-denial-v1",
    failure: "storage_failure",
  }]);
});

Deno.test("lost presentation response recovers through authenticated status and a fresh nonce operation", async () => {
  const w = world();
  const { body } = await presented(w);
  const status = await w.service.inspect(
    new Request("https://kscan.invalid/future-confirmation"),
    body.proposalId,
  );
  assert.equal(status.revision, body.expectedRevision);
  assert.equal(status.executed, false);
  assert.equal("challengeHash" in status, false);
  assert.equal("confirmationToken" in status, false);
  assert.equal("permissionRevision" in status, false);
  assert.equal("actorId" in status, false);
  const next = await w.service.present(http(), {
    proposalId: status.proposalId,
    expectedRevision: status.revision,
    operationId: crypto.randomUUID(),
  });
  assert.notEqual(next.confirmationToken, body.confirmationToken);
  w.actor({ actorId: B, accountId: ACCOUNT, anonymous: false });
  await rejects(
    w.service.inspect(
      new Request("https://kscan.invalid/future-confirmation"),
      body.proposalId,
    ),
    "not_found",
  );
});
