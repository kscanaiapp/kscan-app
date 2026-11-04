# OC-01 — isolated read-only tool broker

Status: implemented for offline review; **not wired, deployed, enabled, or production certified**.

Starting authority: `rebuild/backend-authority-v2` at
`ffba005d018052a3e43e7fdf32bc426068640dff`, fetched before creating the isolated
`C:/oc01` worktree and `oc/oc-01-read-only-tool-broker` branch. No existing runtime
entrypoint, migration, environment configuration, release candidate, or CI-01–CI-06
contract is changed.

## Interface and ownership

All new modules live under
`supabase/functions/_shared/corporateIntelligence/readOnlyTools/`:

| Module | Export / responsibility |
| --- | --- |
| `request.ts` | `TOOL_VERSION`, frozen `TOOL_REGISTRY`, `parseToolRequest`, `ToolRequest`, closed `Failure` codes |
| `broker.ts` | `createReadOnlyBroker`, `Dependencies`, `LIMITS`, `Result`, metadata-only `Metadata` |
| `adapters.ts` | `createExistingAdapters`, `Adapters`, `Batch`; existing shopping and discovery bindings |
| `products.ts` | Closed product projection, provider/source provenance, URL validation, eligibility horizons, exact declared-currency price filtering |
| `modelProjection.ts` | `renderToolResultForModel`; escaped `commerce_context` using the existing untrusted-external envelope |
| `broker.test.ts` | Offline adversarial and service-adapter tests; no network permission or billed calls |

The registry is distinct from the non-executable CI-05 proposal contract. Never
insert these tools into Option B's empty capability arrays or import the CI-05
proposal/execution modules into this broker.

The integration owner creates **one broker per isolate**, with server-owned
dependencies. `openSession(authenticatedRequest)` creates an in-memory session for
one verified actor and conversation. Keep that session object server-side and
destroy it on conversation termination/sign-out. Never deserialize it, its record
map, provider batches, or authorization inputs from client/model JSON. The initial
session authentication belongs inside the existing handler's request deadline.

`session.executeTurn(modelRequests)` accepts only structured tool requests. It
authenticates again and asserts account-active for every turn, checks that identity
still matches the session, and calls the required `permitTurn(actorId)` guard.
That guard must verify **current AI-processing consent, quota, applicable
entitlements, and turn authorization** using the existing server guards. Model
permissions, role claims, actor IDs, products, URLs, SQL/RPC names, credentials,
ownership assertions, unknown arguments and unknown capability IDs are rejected.
Text is bounded search data; the injection screen is defense in depth, not the
authorization mechanism.

## Requests and results

```ts
{
  version: 'oc-read-only-v1',
  capability: 'discover_products',
  arguments: {
    garment: {
      item_type: 'outerwear', subtype: 'bomber',
      primary_color: 'black', material_estimate: 'leather', silhouette: 'cropped'
    },
    market: 'US', maxPrice: 150, currency: 'USD'
  }
}
```

Permitted capabilities:

- `discover_products`: approved existing Scanner shopping service; deterministic
  existing relevance scoring. Market is an explicit query constraint, **not proof
  of shipping, stock, or local availability**. Merchant/brand prose is not ownership
  evidence.
- `refine_products`: same search schema plus 1–8 `previousRefs` and optional
  `excludePreviousMerchants`. References must come from this session before this
  turn. Color, subtype, material appearance and silhouette filters require literal
  provider-title evidence; unsupported synonyms may therefore return empty.
  Price filtering requires an unambiguous existing en-US price rendering and an
  explicitly declared matching currency. Missing/ambiguous prices are excluded.
- `discover_black_owned`: the existing discovery engine, with organic discovery
  and verified badges requested, sponsored placements disabled. Its dependencies
  must be the existing authorized revision/candidate/ownership services, with
  existing database eligibility predicates intact. Do not supply a general-purpose
  query or unrestricted service-role client. The adapter captures authoritative row
  expiration/eligibility horizons for subsequent session references.
- `compare_products`: 2–8 references already returned in a previous turn of this
  session. Returns a structured table of those supported product fields, with no
  provider/model call and no invented comparison conclusions. Missing attributes
  remain absent. Caller-facing comparison prose still passes the existing output
  validator.

`Result` contains version, `ready | empty | denied | error`, a closed reason code
or null, and up to eight products. Provider exceptions never escape. Successful
empty catalog responses are authoritative empties, with no generated substitutes.
Malformed batches fail closed with no partially trusted result collection.

Each internal product has an opaque session reference, title, merchant display
label, validated HTTPS destination, optional image/listed price/declared currency,
and provenance (approved source, source ID, observation/expiration times, trust
classification). Only eligible catalog products can carry the closed ownership
identity. Other provider ownership/availability/material fields are dropped.
Provenance proves the source of a record, not independent verification of merchant
authored claims or current stock. Source ID and canonical URL duplicates are removed.

Use `renderToolResultForModel` for provider display text. It omits destinations,
internal source IDs, evidence and ownership claims, bounds the projection, and
escapes it inside the existing untrusted-external commerce envelope. Never append
raw results as system instructions. Existing CI trusted-context assembly and
output finalization continue to own any ownership prose. No new Gemini call or
automatic tool-response-generation loop is implemented here.

## Bounds, caching and instrumentation

- Maximum two requests per `executeTurn`, no same-turn reference chaining.
- One outstanding retrieval per broker/isolate; contention fails with `busy`.
- 2,500 ms retrieval deadline (provider/catalog work). Per-turn re-authorization runs first under its own 1,000 ms bound (Build 35 integration, live evidence: ~0.9 s of re-authorization inside the deadline starved the primary shopping provider). No broker retry.
- Eight returned shopping candidates and eight products per tool; the existing
  catalog engine retains its 160-row candidate ceiling.
- At most 32 cached records per session, retained at most 2 minutes (owner decision 2026-11-04, raised from 30 seconds; persisted server-side by the integration, migration 20261104220528). Catalog
  records expire sooner at inventory, synchronization, ownership or eligibility
  horizons. References are isolated even between two sessions for the same actor.
- Comparison uses that bounded snapshot, not a live availability guarantee.
  Revocations occurring inside the snapshot window require a fresh discovery
  request; integration must not use a cached comparison as purchase authorization.
- Existing shopping cache reuse is retained. It is a public-product query cache,
  not a conversation/actor cache. Its existing one-hour TTL is unchanged;
  `observedAt` means the broker received the service result, not that a provider
  was freshly contacted. It cannot support live stock claims.
- Catalog retrieval creates a request-local instance of the existing discovery
  service to retain exact row eligibility horizons without modifying the engine.
  It performs the existing revision read and bounded candidate lookup; no extra
  ownership lookup is needed with an empty primary-product list. Cross-request
  catalog caching is deliberately not added here.
- The legacy shopping service has fixed Serper → Brave fallback and its own
  timeout controls, but no outer AbortSignal input. The adapter gives the
  primary provider the remaining turn budget less `PRIMARY_MARGIN_MS` (150 ms);
  halving it left Serper ~1 s and it timed out in the Build 35 Staging probe,
  while the web-search fallback's page results did not survive relevance. A
  fallback attempt can therefore end at the broker deadline (`deadline`). On broker
  timeout, the response ends but its concurrency slot stays occupied until that
  underlying service settles. No further shopping work can accumulate in that
  broker. Catalog dependency transports must honor their AbortSignal, as the
  existing runtime `rest` transport does.
- Maximum four external shopping attempts per two-request turn (often fewer or
  zero due to existing cache); comparison and catalog require no external paid
  provider. No new provider, credentials, model calls, or default-path cost.

`Metadata` is separate from CI-06's closed schema; do not add its fields to CI-06
records. It contains only version, closed tool/failure codes, permission outcome,
duration, service invocation count, external provider-attempt **ceiling**, candidate
and result counts, cache-hit boolean/null, and nullable cost. Shopping cache hits
and actual provider call counts are not exposed by the existing service: cache is
reported unknown and calls as a ceiling, never an invented exact count. Cost is
unknown/null. Comparison reports a cache hit; catalog uses no cross-request cache.
No prompt, user ID, image, merchant evidence, or exception text is logged.

## Runtime integration handoff — integration owner only

1. Reconcile this draft against the latest authority immediately before review;
   do not automatically pull into the worktree or merge during active integration.
2. After the active activation pass, add the independent orchestration hook in
   `stylechat-generate/corporateIntelligenceV2.ts`, behind a **new explicit,
   default-OFF server rollout gate** supplied to `Dependencies.enabled`. No flag
   or environment reader is introduced by this implementation. Existing default
   Scanner/Elise paths must remain byte-equivalent when the gate is OFF.
3. Bind existing verified-user and account-active helpers, current consent/quota
   guards, approved markets, and the authorized catalog transports. Respect the
   independent discovery kill switch before exposing `discover_black_owned`.
   A broker flag alone must not override that lane's rollout policy.
4. Keep model intent parsing separate from execution. Submit one bounded batch
   per authorized turn; do not allow the model to open sessions or repeat turns
   to bypass the request count. Bound the number/lifetime of server sessions.
5. Bind the structured product collection and untrusted prose to the existing
   finalization/ownership validation paths; do not equate retrieval with saving,
   purchasing, account updates, or merchant contact.
6. Validate the deployed opt-in hook with real auth, consent withdrawal, inactive
   accounts, cancellation, provider credentials, discovery revocation, and feature
   rollback before any customer activation. Offline tests do not certify those.

Required environment configuration: **none added**. Existing service configuration
is read only by the existing shopping service; catalog transports and authorization
are injected. No secrets are copied or logged. Database changes/migrations: **none**.
Rollback: leave the new gate OFF or remove the import/hook. Existing Option B and
customer paths have no dependency on the broker in this PR.

## Verification evidence

Offline tests run without network permission and with synthetic services only.
The focused suite covers the four capabilities, schema/authority injection,
unknown/mutating/transaction tools, forged products, strict refinements, provider
failure/deadline, concurrency, malformed data, duplicate offers, session isolation,
comparison freshness, empty/stale/withdrawn catalog inventory, metadata privacy,
and prompt-envelope escaping. Existing CI-01–CI-06 suites independently retain
the non-executable Option B and default-path tripwires.

Commands and final counts are recorded in the draft PR. An initial governance run
reported the expected dirty-worktree authority failures during implementation;
it must be rerun after the implementation is committed, without relaxing guards.

TestSprite CLI 0.5.0 and authentication preflight succeeded. No local linked project
configuration or project environment variable was found; project discovery found
the existing K Scan staging backend project. This isolated implementation has no
reachable deployed hook, and no TestSprite MCP is available. Per the repository
verification instructions it is **unverified-because-undeployed** for TestSprite;
testing an older deployment would not verify this change. Deployment/activation
remain exclusively with the integration owner.
