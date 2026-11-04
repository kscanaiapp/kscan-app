// Synthetic local database only. Uses the actual Watchlist migrations and OC-02/OC-03 modules.
const assert = require("node:assert/strict");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");
const os = require("node:os");
const vm = require("node:vm");
const ts = require("typescript");
const ROOT = path.resolve(__dirname, "../..");
const A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
const REF = "p_cccccccc-cccc-4ccc-8ccc-cccccccccccc";
const URL =
  "https://www.farfetch.com/shopping/men/synthetic-jacket-item-12345.aspx";
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), "utf8");
function loadModules() {
  const base = path.join(ROOT, "supabase/functions");
  const cache = new Map();
  function load(file) {
    file = path.resolve(file);
    assert.ok(file.startsWith(base + path.sep) && file.endsWith(".ts"));
    if (cache.has(file)) return cache.get(file);
    const compiled = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
      },
    }).outputText;
    const m = { exports: {} };
    cache.set(file, m.exports);
    vm.runInThisContext(
      "(function(require,module,exports){" + compiled + "\n})",
      { filename: file },
    )(
      (id) => {
        assert.ok(
          id.startsWith(".") && id.endsWith(".ts"),
          "Unexpected execution dependency " + id,
        );
        return load(path.resolve(path.dirname(file), id));
      },
      m,
      m.exports,
    );
    return m.exports;
  }
  return {
    ...load(
      path.join(
        base,
        "_shared/corporateIntelligence/governedExecution/transactionDriver.ts",
      ),
    ),
    ...load(
      path.join(
        base,
        "_shared/corporateIntelligence/customerAuthorization/repository.ts",
      ),
    ),
    ...load(
      path.join(
        base,
        "_shared/corporateIntelligence/customerAuthorization/service.ts",
      ),
    ),
    ...load(
      path.join(
        base,
        "_shared/corporateIntelligence/governedExecution/coordinator.ts",
      ),
    ),
  };
}
async function world(
  { disk = false, reopenPath, databaseFactory, environment = {} } = {},
) {
  const location = reopenPath ??
    (disk
      ? await fsp.mkdtemp(path.join(os.tmpdir(), "kscan-oc03-"))
      : undefined);
  const db = databaseFactory
    ? await databaseFactory()
    : await (await import("@electric-sql/pglite")).PGlite.create(location);
  let currentActor = { actorId: A, accountId: A, anonymous: false };
  let principal = true;
  let channel = true;
  let enabled = true;
  let authEnabled = true;
  let connected = true;
  let fault = null;
  let rpcCalls = 0;
  let queries = [];
  let mutationAttempts = 0;
  let resolverFailure = false;
  const previousDeno = global.Deno;
  global.Deno = {
    env: {
      get: (key) => ({
        FARFETCH3_ENABLED: "true",
        KICKSCREW_ENABLED: "true",
        WATCHLIST_MAX_ACTIVE_WATCHES_PER_ACTOR: "2",
        ...environment,
      }[key]),
    },
  };
  const listing = {
    id: "server-listing",
    title: "Synthetic black bomber jacket",
    source: "Farfetch",
    type: "retail",
    productUrl: URL,
    imageUrl: "https://images.fixture-fashion.com/jacket.jpg",
    price: "$120.00",
    currency: "USD",
  };
  if (!reopenPath) {
    await db.exec(
      `create role anon; create role authenticated; create role service_role bypassrls;
      create schema auth; create table auth.users(id uuid primary key);
      create function auth.uid() returns uuid language sql stable as $$select nullif(current_setting('request.jwt.claim.sub',true),'')::uuid$$;
      insert into auth.users values('${A}'),('${B}');
      create table public.profiles(id uuid primary key,account_status text not null,account_locked_at timestamptz);
      insert into profiles values('${A}','active',null),('${B}','active',null);
      create table public.deletion_requests(id uuid primary key,user_id uuid,status text,requested_at timestamptz);
      -- Synthetic source behind the existing canonical entitlement function signature.
      create table public.fixture_entitlements(user_id uuid primary key,granted boolean not null,valid_until timestamptz not null default 'infinity');
      insert into fixture_entitlements values('${A}',true),('${B}',true);
      create function public.kplus_has_active_entitlement(p_user_id uuid,p_entitlement_key text default 'k_plus') returns boolean language sql stable security definer as $$
        select coalesce((select granted and valid_until>now() from public.fixture_entitlements where user_id=p_user_id),false)$$;
      create function public.kplus_effective_access_state(p_user_id uuid,p_entitlement_key text,p_at timestamptz) returns table(has_access boolean,is_open_ended boolean,effective_expires_at timestamptz) language sql stable security definer as $$
        select granted and valid_until>p_at,valid_until='infinity',valid_until from public.fixture_entitlements where user_id=p_user_id$$;
      create table public.fixture_permissions(user_id uuid primary key,consent boolean,allowed boolean,revision text);
      insert into fixture_permissions values('${A}',true,true,'permission-1'),('${B}',true,true,'permission-1');
      create table public.fixture_products(record_id text primary key,product_id text,revision text,source_id text,owner_id uuid,valid_until timestamptz,listing jsonb);
      grant select,update on public.profiles,public.fixture_entitlements,public.fixture_permissions,public.fixture_products to service_role;`,
    );
    await db.query(
      "insert into public.fixture_products values($1,$2,$3,$4,null,clock_timestamp()+interval '1 hour',$5::jsonb)",
      [
        "record-1",
        "product-1",
        "revision-1",
        "source-1",
        JSON.stringify(listing),
      ],
    );
    await db.exec(
      read("supabase/migrations/20260830150000_user_commerce_watches.sql"),
    );
    await db.exec(
      read(
        "supabase/migrations/20260830151500_user_commerce_watch_events_and_rpcs.sql",
      ),
    );
    await db.exec(
      read(
        "supabase/migrations/20260830190500_watchlist_create_honours_changed_intent.sql",
      ),
    );
    const actorSql = read(
      "supabase/migrations/20260902120000_watchlist_device_route_and_account_state.sql",
    );
    const begin = actorSql.indexOf(
      "create or replace function public.watchlist_actor_is_active",
    );
    const end = actorSql.indexOf("$fn$;", begin) + "$fn$;".length;
    assert.ok(begin >= 0 && end > begin);
    await db.exec(actorSql.slice(begin, end));
    await db.exec(
      "revoke all on function public.watchlist_actor_is_active(uuid) from public,anon,authenticated; grant execute on function public.watchlist_actor_is_active(uuid) to service_role",
    );
    await db.exec(
      read(
        "docs/build36/corporate-intelligence-v2/20261104163311_oc02_customer_authorization_proposed.sql",
      ),
    );
    await db.exec(
      read(
        "docs/build36/corporate-intelligence-v2/20261104171120_oc03_governed_watch_execution_proposed.sql",
      ),
    );
  }
  await db.exec("set role service_role");
  const modules = loadModules();
  const database = {
    transaction: async (body) => {
      if (!connected) throw Error("SYNTHETIC_CONNECTION_LOST");
      let mutated = false;
      const result = await db.transaction(async (tx) =>
        body({
          query: async (sql, args) => {
            if (!connected) throw Error("SYNTHETIC_CONNECTION_LOST");
            queries.push({ sql, args });
            if (sql.includes("public.create_user_commerce_watch(")) {
              rpcCalls++;
              mutationAttempts++;
              if (fault === "before_rpc") {
                throw Error("synthetic_crash_before_mutation");
              }
              const response = await tx.query(sql, args);
              mutated = true;
              if (fault === "after_rpc") {
                throw Error("synthetic_crash_after_mutation");
              }
              if (fault === "kill_after_rpc") enabled = false;
              if (fault === "entitlement_expiry_after_rpc") {
                await tx.query(
                  "update public.fixture_entitlements set valid_until=clock_timestamp()+interval '40 milliseconds' where user_id=$1",
                  [A],
                );
                await new Promise((resolve) => setTimeout(resolve, 65));
              }
              return response;
            }
            if (
              sql.startsWith("update oc03_execution.ledger") &&
              args?.[0] === "completed" && fault === "before_completion"
            ) throw Error("synthetic_crash_before_evidence");
            return tx.query(sql, args);
          },
        })
      );
      if (mutated && fault === "lost_ack") {
        connected = false;
        throw Error("synthetic_commit_ack_lost");
      }
      return result;
    },
  };
  async function lockAuthorization(sql, a) {
    const profile =
      (await sql.query("select * from public.profiles where id=$1 for update", [
        a.actorId,
      ])).rows[0];
    const policy = (await sql.query(
      "select * from public.fixture_permissions where user_id=$1 for update",
      [a.actorId],
    )).rows[0];
    const entitlement = (await sql.query(
      "select * from public.fixture_entitlements where user_id=$1 for update",
      [a.actorId],
    )).rows[0];
    return {
      accountActive: profile?.account_status === "active" &&
        profile.account_locked_at === null,
      allowed: policy?.allowed === true,
      aiConsent: policy?.consent === true,
      permissionRevision: policy?.revision ?? "",
      entitled: entitlement?.granted === true,
      capabilities: ["save_watchlist"],
    };
  }
  async function lockProduct(sql, a, target) {
    if (resolverFailure) throw Error("SECRET_PROVIDER_ERROR");
    const p = (await sql.query(
      "select *,floor(extract(epoch from clock_timestamp())*1000)::float8 as observed_ms from public.fixture_products where record_id=$1 and (owner_id is null or owner_id=$2) for update",
      [target.recordId, a.actorId],
    )).rows[0];
    if (!p) throw Error("product_not_found");
    return {
      target: {
        kind: "product",
        recordId: p.record_id,
        productId: p.product_id,
        accountId: p.owner_id,
        revision: p.revision,
        checkedAt: Math.min(Date.now(), Number(p.observed_ms)),
        validUntil: Date.parse(p.valid_until),
        provenance: { provider: "serper", sourceId: p.source_id },
      },
      listing: p.listing,
    };
  }
  const authenticate = async () => currentActor;
  const verifyCustomerOperation = async () => {
    if (!channel) throw Error("not_customer_route");
  };
  const verifyExecutionPrincipal = async () => {
    if (!principal) throw Error("not_execution_principal");
  };
  const authorization = modules.createAuthorizationService({
    enabled: () => authEnabled,
    database,
    repository: new modules.PostgresRepository(database),
    authenticate,
    assertActive: async (a) => {
      const p = await database.transaction((sql) => lockAuthorization(sql, a));
      if (!p.accountActive) throw Error("inactive");
    },
    authorize: (a) => database.transaction((sql) => lockAuthorization(sql, a)),
    resolveTarget: (a, _intent, previous) =>
      database.transaction((sql) =>
        lockProduct(sql, a, previous ?? { recordId: "record-1" })
      ).then((p) => p.target),
    verifyCustomerOperation,
    verifyHandoffService: verifyExecutionPrincipal,
  });
  const deps = {
    database,
    enabled: () => enabled,
    authorizationEnabled: () => authEnabled,
    authenticate,
    verifyCustomerOperation,
    verifyExecutionPrincipal,
    lockAuthorization,
    lockProduct,
  };
  let executor = modules.createGovernedWatchExecutor(deps);
  const request = () =>
    new Request("https://synthetic.invalid/oc03", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
    });
  async function approved({ legacy = false } = {}) {
    const p = await authorization.propose(request(), {
      version: "oc02-authorization-v1",
      capability: "save_watchlist",
      arguments: { targetRef: REF },
    }, crypto.randomUUID());
    const display = legacy
      ? await authorization.present(request(), {
        proposalId: p.snapshot.id,
        expectedRevision: 0,
        operationId: crypto.randomUUID(),
      })
      : await executor.present(request(), {
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
    const approval = legacy
      ? await authorization.decide(request(), body)
      : await executor.decide(request(), {
        ...body,
        executionHash: display.executionHash,
      });
    const handoffId = crypto.randomUUID();
    const handoff = await authorization.handoff(request(), {
      proposalId: p.snapshot.id,
      expectedRevision: approval.proposal.revision,
      snapshotHash: p.snapshotHash,
      operationId: handoffId,
    });
    return {
      proposalId: p.snapshot.id,
      handoffId,
      proposalRevision: handoff.proposal.revision,
      snapshotHash: p.snapshotHash,
      bindingHash: display.executionHash ?? "a".repeat(64),
      requestId: crypto.randomUUID(),
    };
  }
  return {
    db,
    database,
    deps,
    authorization,
    get executor() {
      return executor;
    },
    request,
    approved,
    location,
    listing,
    restart: () => executor = modules.createGovernedWatchExecutor(deps),
    get rpcCalls() {
      return rpcCalls;
    },
    get mutationAttempts() {
      return mutationAttempts;
    },
    get queries() {
      return queries;
    },
    fault: (v) => fault = v,
    connected: (v) => connected = v,
    enabled: (v) => enabled = v,
    authEnabled: (v) => authEnabled = v,
    principal: (v) => principal = v,
    channel: (v) => channel = v,
    actor: (v) => currentActor = v,
    resolverFailure: (v) => resolverFailure = v,
    count: async () =>
      (await db.query(
        "select count(*)::int as n from public.user_commerce_watches where user_id=$1 and deleted_at is null",
        [A],
      )).rows[0].n,
    legacyWatch: async (intent = "just_watching", target = null) =>
      db.query(
        "select * from public.create_user_commerce_watch($1,$2,$3,$4,$5,null,$6,$7,$8,$9)",
        [
          A,
          "farfetch",
          URL,
          "source-1",
          "Synthetic watch",
          120,
          "USD",
          intent,
          target,
        ],
      ),
    async close({ keep = false } = {}) {
      global.Deno = previousDeno;
      await db.close();
      if (location && !keep) {
        const resolved = path.resolve(location);
        assert.equal(path.dirname(resolved), path.resolve(os.tmpdir()));
        assert.ok(path.basename(resolved).startsWith("kscan-oc03-"));
        await fsp.rm(resolved, { recursive: true, force: true });
      }
    },
  };
}
module.exports = { world, loadModules, A, B, URL, REF };
