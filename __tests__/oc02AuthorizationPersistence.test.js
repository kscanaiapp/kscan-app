// Runs the proposed schema and the real TypeScript transaction adapter in local PGlite.
// This verifies SQL behavior/recovery, not deployment or multi-connection PostgreSQL certification.
const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const vm = require("node:vm");
const fsSync = require("node:fs");
const ts = require("typescript");
const ROOT = path.resolve(__dirname, "..");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const ACCOUNT = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const OTHER = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const intent = {
  version: "oc02-authorization-v1",
  capability: "save_watchlist",
  arguments: { targetRef: "p_eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee" },
};
const http = () =>
  new Request("https://kscan.invalid/future-confirmation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
  });
async function modules() {
  // Match existing SQL-test helpers: transpile actual modules, never duplicate their implementation.
  // This also runs on Node 20 CI workers without native TypeScript stripping.
  const directory = path.join(
    ROOT,
    "supabase/functions/_shared/corporateIntelligence/customerAuthorization",
  );
  const cache = new Map();
  function load(filename) {
    assert.ok(
      ["contracts.ts", "repository.ts", "service.ts"].includes(
        path.basename(filename),
      ) && path.dirname(filename) === directory,
    );
    if (cache.has(filename)) return cache.get(filename);
    const compiled = ts.transpileModule(fsSync.readFileSync(filename, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const mod = { exports: {} };
    vm.runInThisContext(
      "(function(require,module,exports){" + compiled + "\n})",
      { filename },
    )(
      (id) => {
        assert.ok(id.startsWith("./") && id.endsWith(".ts"));
        return load(path.resolve(directory, id));
      },
      mod,
      mod.exports,
    );
    cache.set(filename, mod.exports);
    return mod.exports;
  }
  return {
    ...load(path.join(directory, "repository.ts")),
    ...load(path.join(directory, "service.ts")),
  };
}
async function database(location) {
  const { PGlite } = await import("@electric-sql/pglite");
  const db = await PGlite.create(location);
  await db.exec(
    "create role anon; create role authenticated; create role service_role",
  );
  const schema = await fs.readFile(
    path.join(
      ROOT,
      "docs/build36/corporate-intelligence-v2/20261104163311_oc02_customer_authorization_proposed.sql",
    ),
    "utf8",
  );
  await db.exec(schema);
  await db.exec("set role service_role");
  return db;
}
function driver(db, failAudit = () => false) {
  return {
    transaction: (body) =>
      db.transaction((tx) =>
        body({
          query: (sql, args) => {
            if (
              failAudit() &&
              sql.startsWith("insert into oc02_authorization.audit")
            ) throw Error("simulated_commit_interruption");
            return tx.query(sql, args);
          },
        })
      ),
  };
}
async function service(db, failAudit) {
  const { PostgresRepository, createAuthorizationService } = await modules();
  const repository = new PostgresRepository(driver(db, failAudit));
  return {
    repository,
    service: createAuthorizationService({
      enabled: () => true,
      repository,
      authenticate: async () => ({
        actorId: A,
        accountId: ACCOUNT,
        anonymous: false,
      }),
      assertActive: async () => {},
      authorize: async () => ({
        allowed: true,
        aiConsent: true,
        entitled: true,
        permissionRevision: "permission-1",
        capabilities: ["save_watchlist"],
      }),
      resolveTarget: async () => ({
        kind: "product",
        recordId: "server-record",
        productId: "server-product",
        accountId: null,
        revision: "r1",
        checkedAt: Date.now(),
        validUntil: Date.now() + 120000,
        provenance: { provider: "serper", sourceId: "fixture" },
      }),
      verifyCustomerOperation: async () => {},
      verifyHandoffService: async () => {},
    }),
  };
}
async function pending(s) {
  const p = await s.propose(http(), intent, crypto.randomUUID());
  const display = await s.present(http(), {
    proposalId: p.snapshot.id,
    expectedRevision: p.revision,
    operationId: crypto.randomUUID(),
  });
  return {
    p,
    body: {
      proposalId: p.snapshot.id,
      expectedRevision: display.revision,
      snapshotHash: display.snapshotHash,
      operationId: crypto.randomUUID(),
      decision: "approve",
      confirmationToken: display.confirmationToken,
    },
  };
}

test("OC-02 proposed SQL denies customer roles on every table and function; RLS forced, no definer RPC", async () => {
  const db = await database();
  try {
    const tables = (await db.query(
      "select tablename from pg_tables where schemaname='oc02_authorization' order by tablename",
    )).rows;
    assert.equal(tables.length, 4);
    const flags = (await db.query(
      "select relrowsecurity,relforcerowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='oc02_authorization' and c.relkind='r'",
    )).rows;
    assert.ok(flags.every((r) => r.relrowsecurity && r.relforcerowsecurity));
    assert.equal(
      (await db.query(
        "select count(*)::int as n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where n.nspname='oc02_authorization' and prosecdef",
      )).rows[0].n,
      0,
    );
    for (const role of ["anon", "authenticated"]) {
      await db.exec(`reset role; set role ${role}`);
      for (const { tablename } of tables) {
        for (
          const sql of [
            `select * from oc02_authorization.${tablename}`,
            `delete from oc02_authorization.${tablename}`,
            `insert into oc02_authorization.${tablename} default values`,
          ]
        ) await assert.rejects(db.exec(sql), (e) => e.code === "42501");
      }
      await assert.rejects(
        db.exec("select oc02_authorization.enforce_transition()"),
        (e) => e.code === "42501",
      );
    }
  } finally {
    await db.close();
  }
});
test("OC-02 actual PostgreSQL adapter commits lifecycle, rejects replay/CAS conflicts, and isolates actor/account", async () => {
  const db = await database();
  try {
    const { repository, service: s } = await service(db);
    const { body } = await pending(s);
    const results = await Promise.allSettled([
      s.decide(http(), body),
      s.decide(http(), { ...body, operationId: crypto.randomUUID() }),
    ]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    const p = await repository.get(
      { actorId: A, accountId: ACCOUNT },
      body.proposalId,
    );
    assert.equal(p.state, "approved");
    assert.equal(
      await repository.get({ actorId: B, accountId: ACCOUNT }, body.proposalId),
      null,
    );
    assert.equal(
      await repository.get({ actorId: A, accountId: OTHER }, body.proposalId),
      null,
    );
    const command = {
      proposalId: p.snapshot.id,
      expectedRevision: p.revision,
      snapshotHash: p.snapshotHash,
      operationId: crypto.randomUUID(),
    };
    const h = await s.handoff(http(), command);
    assert.equal(h.executed, false);
    assert.equal(h.proposal.state, "consumed");
    assert.equal((await s.handoff(http(), command)).handoffId, h.handoffId);
    assert.equal(
      (await db.query(
        "select count(*)::int as n from oc02_authorization.audit where metadata->>'to'='approved'",
      )).rows[0].n,
      1,
    );
  } finally {
    await db.close();
  }
});
test("OC-02 atomic rollback leaves neither state, receipt nor audit after injected storage failure; retry recovers", async () => {
  const db = await database();
  let fail = false;
  try {
    const { repository, service: s } = await service(db, () => fail);
    const { body } = await pending(s);
    fail = true;
    await assert.rejects(
      s.decide(http(), body),
      (e) => e.code === "storage_failure",
    );
    assert.equal(
      (await repository.get(
        { actorId: A, accountId: ACCOUNT },
        body.proposalId,
      )).state,
      "awaiting_customer_approval",
    );
    assert.equal(
      await repository.receipt(
        { actorId: A, accountId: ACCOUNT },
        body.operationId,
      ),
      null,
    );
    assert.equal(
      (await db.query(
        "select count(*)::int as n from oc02_authorization.audit where metadata->>'to'='approved'",
      )).rows[0].n,
      0,
    );
    fail = false;
    assert.equal((await s.decide(http(), body)).proposal.state, "approved");
  } finally {
    await db.close();
  }
});
test("OC-02 SQL trigger independently rejects argument mutation, illegal transitions and stale revisions", async () => {
  const db = await database();
  try {
    const { repository, service: s } = await service(db);
    const { body } = await pending(s);
    const p = await repository.get(
      { actorId: A, accountId: ACCOUNT },
      body.proposalId,
    );
    for (
      const mutate of [
        (q) => q.snapshot.arguments.targetRef = "forged",
        (q) => q.state = "consumed",
        (q) => q.revision = 0,
        (q) => q.snapshot.expiresAt = 0,
      ]
    ) {
      const q = structuredClone(p);
      q.revision++;
      mutate(q);
      await assert.rejects(
        db.query(
          "update oc02_authorization.proposals set document=$1::jsonb where id=$2",
          [JSON.stringify(q), p.snapshot.id],
        ),
      );
    }
    await assert.rejects(
      db.query(
        "insert into oc02_authorization.receipts values($1,$2,$3,$4,$5)",
        [B, ACCOUNT, crypto.randomUUID(), "a".repeat(64), p.snapshot.id],
      ),
      (e) => e.code === "23503",
    );
    const malformed = structuredClone(p);
    malformed.snapshot.id = crypto.randomUUID();
    malformed.state = null;
    malformed.revision = 0;
    malformed.challengeHash = null;
    await assert.rejects(
      db.query(
        "insert into oc02_authorization.proposals(id,actor_id,account_id,retain_until,document) values($1,$2,$3,$4,$5::jsonb)",
        [
          malformed.snapshot.id,
          A,
          ACCOUNT,
          malformed.snapshot.retainUntil,
          JSON.stringify(malformed),
        ],
      ),
    );
  } finally {
    await db.close();
  }
});
test("OC-02 database clock rejects approval once its immutable expiration window closes", async () => {
  const db = await database();
  try {
    const { PostgresRepository, createAuthorizationService } = await modules();
    const repository = new PostgresRepository(driver(db));
    const s = createAuthorizationService({
      enabled: () => true,
      repository,
      authenticate: async () => ({
        actorId: A,
        accountId: ACCOUNT,
        anonymous: false,
      }),
      assertActive: async () => {},
      authorize: async () => ({
        allowed: true,
        aiConsent: true,
        entitled: true,
        permissionRevision: "p1",
        capabilities: ["save_watchlist"],
      }),
      resolveTarget: async () => ({
        kind: "product",
        recordId: "r",
        productId: "p",
        accountId: null,
        revision: "r1",
        checkedAt: Date.now(),
        validUntil: Date.now() + 2000,
        provenance: { provider: "serper", sourceId: "fixture" },
      }),
      verifyCustomerOperation: async () => {},
    });
    const { body } = await pending(s);
    const p = await repository.get(
      { actorId: A, accountId: ACCOUNT },
      body.proposalId,
    );
    await new Promise((resolve) => setTimeout(resolve, 2100));
    const next = {
      ...p,
      state: "approved",
      revision: p.revision + 1,
      challengeHash: null,
      updatedAt: Date.now(),
    };
    await assert.rejects(
      db.query(
        "update oc02_authorization.proposals set document=$1::jsonb where id=$2",
        [JSON.stringify(next), p.snapshot.id],
      ),
      /oc02_expired/,
    );
    assert.equal(
      (await repository.get(
        { actorId: A, accountId: ACCOUNT },
        body.proposalId,
      )).state,
      "awaiting_customer_approval",
    );
  } finally {
    await db.close();
  }
});
test("OC-02 per-actor SQL rate limit spans accounts and never exceeds its hard bound", async () => {
  const db = await database();
  try {
    const { repository } = await service(db);
    for (let i = 0; i < 30; i++) {
      await repository.claim(
        { actorId: A, accountId: i % 2 ? ACCOUNT : OTHER },
        Date.now(),
      );
    }
    await assert.rejects(
      repository.claim({ actorId: A, accountId: OTHER }, Date.now()),
      (e) => e.code === "rate_limited",
    );
    assert.equal(
      (await db.query(
        "select count from oc02_authorization.limits where actor_id=$1",
        [A],
      )).rows[0].count,
      30,
    );
  } finally {
    await db.close();
  }
});
test("OC-02 on-disk proposals and receipts survive database close/reopen and a new service instance", async () => {
  const location = await fs.mkdtemp(path.join(os.tmpdir(), "kscan-oc02-"));
  let db;
  try {
    db = await database(location);
    const first = await service(db);
    const operation = crypto.randomUUID();
    const p = await first.service.propose(http(), intent, operation);
    await db.close();
    db = undefined;
    const { PGlite } = await import("@electric-sql/pglite");
    db = await PGlite.create(location);
    await db.exec("set role service_role");
    const second = await service(db);
    const loaded = await second.repository.get({
      actorId: A,
      accountId: ACCOUNT,
    }, p.snapshot.id);
    assert.equal(loaded.snapshotHash, p.snapshotHash);
    assert.equal(
      (await second.repository.receipt(
        { actorId: A, accountId: ACCOUNT },
        operation,
      )).proposalId,
      p.snapshot.id,
    );
    assert.equal(
      (await second.service.propose(http(), intent, operation)).snapshot.id,
      p.snapshot.id,
    );
  } finally {
    if (db) await db.close();
    const resolved = path.resolve(location);
    assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
    assert.ok(path.basename(resolved).startsWith("kscan-oc02-"));
    await fs.rm(resolved, { recursive: true, force: true });
  }
});
