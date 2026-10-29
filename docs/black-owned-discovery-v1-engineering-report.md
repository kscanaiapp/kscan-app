# Secondary Commerce V1 — engineering report and activation runbook

## Scope and authority

Backend branch: `codex/black-owned-discovery-v1`, based on freshly fetched
`rebuild/backend-authority-v2@3e94c06326af7726955b7197c786b7e94812b24d`.
The historical SHA in the brief was not used as a deployment pin. Client
preparation is separately based on `release/kscan-pre-freeze-v1@e97de30e` on
`codex/black-owned-commerce-client-v1`; its backend copy is not deployment authority.
No changes to issue #639, Gemini activation, existing production secrets, native
artifacts, payment processing, or external merchant accounts are included.
Business-deck review was waived by the owner during implementation.

Owner updates on 2026-10-29 supersede the initial OFF defaults: organic discovery
and verified ownership badges default **ON**; explicit `false` rolls either back.
Unknown non-boolean flag values fail closed. Sponsorship, sandbox and shadow
default **OFF**. No remote migration, deployment, seed, outreach or flag mutation
was performed by this workstream.

## Three connected, independent capabilities

1. **Organic discovery:** approved inventory from verified, publicly consenting
   Black-owned brands, ranked by fashion evidence. There is no partnership,
   campaign, popularity or payment join in the organic query. Tests retrieve a
   verified brand with zero partnership records.
2. **Partnership platform:** independent prospect intake and auditable commercial
   relationship records. Prospect creation requires no brand, feed, agreement or
   catalog. Ownership review and partnership approval remain different decisions.
3. **Future sponsored commerce:** separately approved campaigns, pure placement
   policy, staff sandbox demonstration and optional shadow instrumentation.
   `active=false` is enforced by a database constraint. The live selector returns
   no placements even if someone mistakenly sets its production flag true.

## Exact integration map

| Boundary | Implementation | Behavior |
| --- | --- | --- |
| Existing scan and primary commerce | `scan-identify` and `_shared/catalogRetrieval.ts` | Runtime source unchanged. No secondary import, extra model call, request, write, provider budget or ordering change. |
| Secondary public API | `functions/black-owned-discovery/index.ts` | Separate authenticated POST; sanitized attributes, market, primary product IDs/URLs only. No images or conversation text accepted. |
| Attribute matching | `black-owned-discovery/engine.ts` | Reuses `scoreProductAgreement`, normalizers, canonical URL identity and canonical product/offer grouping. |
| Administration | `black-owned-discovery/adminService.ts` | Server-only wrappers for service-only management RPCs and catalog synchronization. No public admin endpoint. |
| Authorized source | `catalog.ts`, `shopifyAdapter.ts` | Provider interface, validated normalized feed, and merchant-authorized Shopify Storefront adapter. |
| Staff demonstration | `functions/sponsorship-sandbox/index.ts` | Separate JWT-authenticated endpoint, protected staff lookup, both server flags, explicit approved non-production target. Every response is `sandbox:true`. |
| Shadow work | `sponsorshipShadow.ts` | Detached `EdgeRuntime.waitUntil`, 400 ms budget, aggregate events only; never attached to the response. |
| Optional client integration | Separate mobile branch | Versioned consumer, abortable request helper, optional identity/disclosure props, organic shelf and staff sandbox shelf. Neither shelf is mounted by this infrastructure change. |

The host client can invoke `requestBlackOwnedDiscovery` only after primary
commerce settles, passing an explicit `enabled:true` integration option. This
client option is not an authorization claim; all eligibility and flag decisions
are repeated server-side. Primary ownership metadata is returned in a separate
ID-keyed map; attach it to live card props without sorting or rewriting the
primary array. Do not persist verification metadata in saved scans.

## Database, governance and review policy

Migration `20261029125521_black_owned_discovery_v1.sql` was created with the
Supabase CLI. It is additive, declared as pending source in both environment
reconciliation sections, and applied only to disposable PGlite databases during
tests. The declaration does not certify the current live migration ledger or
authorize execution. Refresh live ledger evidence through the existing governed
release workflow before any application.

Tables cover reviewers, brands, evidence references, merchants, independent
prospects, partnerships, inactive campaigns, products/variants, synchronization
runs, append-only audit transitions, request quotas, catalog revision and a
DB-owner-controlled runtime guard. Every table has RLS; anonymous and ordinary
authenticated roles have no table, view or function privileges. All functions
are SECURITY INVOKER with pinned search paths and explicit EXECUTE revocation.
New endpoint manifests and privilege inventories are registered; automatic
staging deployment allowlists are deliberately not widened.

`discovery_manage(actor, action, data)` supports `prospect`, `register_brand`,
`submit_evidence`, `request_review`, `review_ownership`, `brand_visibility`,
`merchant`, `partnership`, `campaign` and `withdraw_product`. The actor must be
enabled in protected `discovery_reviewers`; non-review operations additionally
require administrator authority. Caller-editable Auth user metadata is unused.
Actor IDs in this server-only API are not accepted as authority by a public API.
Management records are full replacement inputs for the action's editable
fields; callers should read the current private record before editing it.

Draft policy `kscan-ownership-review-v1-draft` requires authorized submission,
reviewable provenance, either independently verifiable certification or
self-attestation plus a corroboration reference, and an authorized reviewer
different from the submitting staff actor. Submission alone never verifies.
Only `pending_review` can advance to verified/rejected; expired, suspended and
revoked states are supported. Review expiry is bounded to the evidence expiry
and a maximum proposed 365-day review interval. These are **proposed K Scan
operational rules for legal/product approval, not a statement of legal ownership
thresholds**. No racial classification by image, name, logo or model inference
exists. Policy approval and the substantive ownership standard must be resolved
before a real brand is publicly verified.

Public identity requires active brand status, unexpired verification, and an
explicit public permission reference/opt-in. Merchant identity and source access
must also be current. Unknown brands receive no ownership classification.
Provenance, evidence references, reviewer IDs, contacts and contract terms never
enter public responses. Evidence is stored as opaque references, not uploaded
documents; the actual restricted evidence repository, access policy and removal
workflow must be selected by the operator. Staff authority snapshots are retained
as audit references without restrictive Auth foreign keys that could block
account deletion. Reviewer grants and customer rate-limit rows cascade on Auth
deletion.

`discovery_cleanup` removes evidence references at their explicit retention
deadline, expires claims, deletes inventory and sync records older than 30 days,
clears obsolete request windows, and clears contact/notes for prospects ended
over a year ago. Schedule it only through separately approved internal tooling.
An external document-store deletion process and the retention policy for minimal
staff audit records still need operational/legal approval.

## Catalog and matching

The JSON adapter seam accepts authorized inventory already supplied by an
internal feed worker. The real Shopify adapter requires a granted private
Storefront token, an exact reviewed `*.myshopify.com` API host and approved
storefront/image hosts. It pins API version 2026-10, requests a merchant-approved
country context, and requires explicit product-ID-to-fashion-attribute mappings.
Unmapped products are withheld. There is no scraping, model enrichment, cart
mutation, tracking redirect, merchant image upload or inferred checkout support.
Credentials are resolved by the trusted worker; only opaque credential
references belong in merchant records. No token or real merchant feed was supplied.

Synchronization reads merchant authority, reserves a transactionally locked
quota before source access, validates the whole batch before writing, and applies
an atomic upsert. Maximum 500 variants per snapshot, 5 new sync keys per merchant
per hour, 3 attempts per key and a minimum one-minute retry interval. Successful
replays do not refetch a source. Incomplete or failed snapshots never withdraw
existing products; a successful complete snapshot withdraws absent products.
Source/variant identity and nonempty SKU uniqueness are enforced. A worker has
a 15-second abort signal; provider failures record only safe enum codes.

Destinations must be HTTPS on exact reviewed public hosts, with no credentials,
custom ports, private addresses or known redirect parameters/routes. Shopify
redirect following is disabled. Prices must be positive finite amounts; absent
currency remains absent. Stock must be explicitly `in_stock` to render. Inventory
expires after 24 hours. Merchant pause, source expiry, ownership revocation,
visibility opt-out and product withdrawal all suppress retrieval.

Matching requires same category and declared same subtype, structured visual
agreement, and the existing strong agreement threshold of 75. Titles displayed
are official titles; scoring uses structured catalog evidence to resist keyword
stuffing. No ownership or partnership bonus exists. Results are alternatives,
never exact originals. Primary URLs/IDs, duplicate offers, and source-product
variants are deduplicated. Up to 160 candidates produce at most 8 results.
Unknown/weak matches produce an empty collection. The conservative exact-subtype
rule may withhold reasonable adjacent styles; that is intentional V1 precision.

The independent service deadline is 1,200 ms. Cache TTL is 30 seconds, limited to
64 keys. Every cache hit checks the catalog revision; rows also carry the minimum
verification/source/merchant/inventory eligibility deadline to prevent expiry
leaking through cache. Errors and timeouts return `unavailable`, never a primary
commerce failure. Endpoint body size is limited to 16 KiB and per-account quota
is 30 requests/minute. Both discovery and badge rollback switches OFF result in
zero endpoint auth/catalog/write work.

## API and card contracts

Organic response version: `black-owned-discovery-v1`; status
`ready | empty | unavailable`; products, canonical product/offer grouping,
`primaryOwnership` and `generatedAt`. Optional ownership metadata is emitted only
with its independent badge flag. No raw numeric match score is sent to customers.
The primary response shape is untouched because this is a separate endpoint.

Sandbox version: `sponsorship-sandbox-v1`, `sandbox:true`, `previewOnly:true` on
products, `placementType:'sponsored'` and mandatory `disclosure:'Sponsored'`.
The disclosure template is defined in code now:

> **Sponsored** — Paid placement. Selected for relevance to your scan.

The client sandbox shelf additionally requires a verified staff presentation
context, always displays Sandbox + Sponsored, and provides no Save, purchase or
checkout action for fixtures. Rendering tests execute the real components with
React DOM and native view stubs. Customer cards render as before without new
optional props. Device layout, accessibility and image-loading behavior still
require iOS/Android review when a host surface is integrated.

## Activation Runbook

### Organic service deployment and rollback

1. Review/merge the backend PR into `rebuild/backend-authority-v2` through normal
   governance; this workstream does not merge it. Run required security and source
   parity checks against the exact release commit.
2. Reconcile current staging and production migration ledgers. Apply only
   `20261029125521` through the existing controlled migration workflow, staging
   first; inspect RLS, grants, indexes, constraints and function definitions.
3. Deploy only `black-owned-discovery` with `verify_jwt=true` through the controlled
   staging workflow. Demonstrate empty catalog resilience and valid/revoked brand
   behavior before requesting the protected production migration/deploy approvals.
   There is no reason to redeploy scan-identify or change Gemini settings.
4. In the **intended Supabase project**, use Edge Function Secrets or the CLI:

   ```sh
   supabase secrets set --project-ref <approved-project-ref> BLACK_OWNED_DISCOVERY_V1_ENABLED=true VERIFIED_OWNERSHIP_BADGE_V1_ENABLED=true
   ```

   Code defaults are already ON; explicit values document operating intent. The
   owner reported setting the discovery flag in Production; that statement is
   not a readback performed by this workstream. Set either flag to `false` for
   its independent rollback. Neither affects primary commerce.
5. Keep `SPONSORED_PLACEMENTS_V1_ENABLED` unset/false and
   `SPONSORSHIP_SANDBOX_MODE` unset/false in production. No campaign is seeded.
6. Authorize real merchants only after the intake/policy approvals below. No
   authorized inventory means a correct, empty secondary shelf. Integrate the
   optional mobile request/shelf separately after primary commerce settles; no
   EAS build or production route activation was performed here.

### Staff sandbox demonstration

1. Use the approved staging project or a disposable local test database, never
   the production project. Apply the migration there. A DB owner must explicitly
   set `discovery_runtime_guard.environment` to `staging` (or `test` locally).
   It defaults to production and service credentials cannot change it.
2. Register two existing internal Auth accounts in `discovery_reviewers` using
   separately authorized privileged tooling: one administrator and a different
   reviewer. Do not grant staff access through user metadata or a public form.
3. Set **only in that non-production environment**:
   `KSCAN_ENVIRONMENT=staging`, `SPONSORED_PLACEMENTS_V1_ENABLED=true` and
   `SPONSORSHIP_SANDBOX_MODE=true`. Deploy `sponsorship-sandbox` with JWT required.
4. `node scripts/discovery-sandbox-fixtures.mjs` prints a no-write plan. To install
   explicit fixtures, supply server-only `SUPABASE_URL`,
   `SUPABASE_SERVICE_ROLE_KEY`, `DISCOVERY_SANDBOX_ADMIN_ID`, and
   `DISCOVERY_SANDBOX_REVIEWER_ID`, then use `--apply` from authorized internal
   tooling. It rejects production/unknown hosts and the default production DB
   guard. It never creates Auth accounts or sends outreach.
5. POST the normal sanitized attribute request to `sponsorship-sandbox` using an
   authorized staff session. Example garment: outerwear / bomber / black / leather
   / cropped; market US; empty primaryProducts. Render only the returned sandbox
   contract in `SponsorshipSandboxShelf`, with visible Sandbox and Sponsored copy.
   The synthetic image host deliberately contains no live customer asset: for a
   polished demonstration supply a reviewed non-production image asset. The
   card has its existing image-error fallback and performs no purchase action.
6. Missing flags, non-staff identity, production target or invalid disclosure
   produce no placements. Sandbox fixtures carry immutable sandbox-only inventory
   identity and are excluded from public organic queries and shadow queries.
   Production rejects fixture merchant/product/campaign writes at the DB trigger.
7. End the demo by setting both sponsorship sandbox controls false in staging,
   pausing the fixture merchant/campaign, or removing the disposable database.
   Fixture records expire after seven days; inventory itself expires in 24 hours.

### Shadow evaluation and aggregates

`SPONSORSHIP_SHADOW_MODE=true` optionally enables independently timed policy
evaluation after secondary requests. It is independent of the live sponsorship
flag. It runs through `EdgeRuntime.waitUntil`; without a background runtime it
does nothing. No new background work is added to scan-identify.

Read structured Edge Function logs for event `sponsorship_shadow_evaluated` and
aggregate by category, reason and eligible boolean. The event contains **only**
those fields; no merchant/campaign/user identifiers, price, scan attributes,
images, evidence or conversation text are logged. Reason values include
`no_campaign`, `unapproved`, `invalid_agreement`, `inactive_period`,
`market_mismatch`, `category_mismatch`, `missing_disclosure`, `invalid_offer`,
`relevance_failed`, `eligible`, `timeout`, `unavailable`.
With no candidate campaigns the truthful result is `no_campaign`; these counts
measure request opportunities, not conversion lift or sponsorship revenue.
Disable with `SPONSORSHIP_SHADOW_MODE=false` without changing response contracts.
Mobile aggregate events use an allowlisted sink bridged to the existing PostHog
client; an external click is never recorded as a purchase.

### Beta partner intake checklist and future live campaign sequence

1. Create a private prospect through `manageDiscovery(actor,'prospect',data)` with
   name, optional website/contact reference/channel, outreach notes, contact and
   follow-up dates, and intake checklist. Initial status must be `prospect`.
   Move through contacted → evaluating → onboarding. This is record-keeping only.
2. Record brand relationship, identity/ownership review route (authorized
   attestation plus corroboration or independent certification), correction
   process and verification/reverification dates. **Human legal/product sign-off:**
   ownership standard, acceptable evidence, retention and public designation
   consent. Organic eligibility never requires a signed commercial agreement.
3. Choose API versus authorized manual JSON feed. **Human merchant approval:**
   catalog usage rights, exact official/storefront/image domains, authorized
   geographic markets, inventory refresh policy and server credential custody.
   Test stock, removals, malformed URLs, variants and stale-feed suppression.
4. Record attribution configuration and conversion evidence permissions. **Human
   privacy/commercial sign-off:** tracking disclosures, agreement terms and
   confirmed-conversion evidence. Do not equate link clicks with transactions.
5. Show the staff-only sandbox demonstration and disclosure template. Record
   disclosure acknowledgment, proposed category/market/product restrictions,
   dates, budget/terms references and contract review in the prospect checklist.
6. Establish a separate partnership, follow its prospect/contact/evaluate/onboard
   lifecycle, and activate the relationship only with a signed, effective
   agreement. Prospect `active` means pipeline completion, not campaign activation.
   Pause/end either lifecycle independently of organic discovery.
7. Draft a campaign with explicit approved products/categories/markets and dates.
   **Human legal/compliance sign-off:** disclosure text and placement, agreement,
   budget authority and promotional terms. Review/approve the campaign; approval
   alone does not activate it. The same ordinary relevance threshold must pass.
8. **Separate future production release approval is mandatory.** This V1 purposely
   enforces `active=false` and has no live sponsored renderer/selector. A later
   reviewed migration/code release must explicitly authorize activation, maintain
   the disclosure contract and isolate sponsored slots from primary ranking.
   Staging readback, staff/sandbox certification, privacy/security checks and
   protected production approval precede any production flag change.
9. Only after that separately approved release, agreement and campaign readiness
   should the owner set `SPONSORED_PLACEMENTS_V1_ENABLED=true` in production.
   Never copy fixture records into production. Setting the flag on V1 alone
   cannot create live sponsored placements.

## Validation, performance and remaining external dependencies

Focused Deno tests cover deterministic relevance, original-primary deduplication,
timeouts, aborts, cache invalidation, flag independence, source normalization,
Shopify boundaries, staff sandbox denial, disclosure, shadow scheduling and
aggregate privacy. PGlite executes the actual migration, grants/RLS, administration,
catalog ingestion, organic retrieval/response and sandbox campaign decision path.
The primary baseline test pins eleven original runtime modules to the fetched
authority snapshot. Existing CI discovers the new suites automatically.

Local CPU benchmark, synthetic 160-candidate catalog, 100 measured iterations:
p50 2.42 ms, p95 4.40 ms, max 4.73 ms, zero network calls. This is a workstation
fixture benchmark, not production network/database latency or a load-test claim.
Cold-start and concurrent PostgREST performance still require deployment testing.

No live TestSprite run is claimed: the changed service has not been deployed;
running the existing linked project's tests would exercise old source. The owner
authorized skipping TestSprite when unavailable/without credits. No credits were
spent here. Required checks and PR status are reported in the final delivery.

Remaining release dependencies: current live-ledger reconciliation; protected
migration/function deployment approval; actual authorized merchant feeds/tokens;
human ownership/privacy/disclosure policy approvals; internal reviewer bootstrap;
scheduled sync/cleanup operations; mobile host integration and device review;
and staging/live performance and TestSprite verification against the deployed
new source. Empty inventory and zero active sponsorships are intentional.
