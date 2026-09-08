# RP-06A.2 — canonical backend 23-function content-parity certification

**As of 2026-09-08.** Canonical backend authority `rebuild/backend-authority-v2`
@ `90b9fa1424a71546dbde6d4486b023d31e9c33a5` (merged PR #351).

**Read-only certification lane.** No staging deployment, no production deployment,
no migration, no secret read or write, no product change, no source modification.
Every Supabase Management API call in this lane was `list_edge_functions` or
`get_edge_function` — both read-only. No function was invoked, redeployed or deleted.

---

## Verdict

> ## BLOCKED — SOURCE RECONCILIATION REQUIRED

All 23 governed functions were content-compared against both deployed environments.
Nothing was classified by timestamp. **Six P1 divergences** were found, in five
distinct groups, and every one of them is the same shape: **the canonical branch is
missing a security control that a deployed environment actually enforces today.**
Deploying canonical as-is would roll those controls back.

No P0 was found. No auth-bypass, no actor-isolation hole, no data disclosure, and
no `verify_jwt` regression exists anywhere in the 23.

---

## 1. Authority

| Field | Value |
|---|---|
| role | `backend-deployment-authority` |
| canonicalBranch | `rebuild/backend-authority-v2` |
| canonical (origin) | `90b9fa1424a71546dbde6d4486b023d31e9c33a5` |
| HEAD | `90b9fa1424a71546dbde6d4486b023d31e9c33a5` |
| approvedProjectRef | `yzqjvdfgefveprobvvyw` |
| governedFunctionCount | 23 / 23 source |
| manifest digest | `dfe4a35976e3316af4135deceb502f28170224113b918ccaf4da07758d398629` |
| working tree | clean |

`scripts/verify-backend-authority.js` → **PASS, no discrepancies.** Ancestry includes
merged PR #351 (`90b9fa1…` is the merge commit itself).

## 2. Inventory

The 23 governed slugs were derived from `GOVERNED_FUNCTIONS` in
`scripts/edge-function-manifest-lib.js` and cross-checked against
`config/edge-function-manifest.json` (`expectedFunctions`) and
`config/backend-authority.json` (`governedFunctionCount: 23`). No hand-written list
was used.

Environments compared: canonical tree · staging `yzqjvdfgefveprobvvyw` ·
production `wyyuqfdxucjksghsmhry`.

## 3. Method — and why it is not timestamp triage

RP-06A proved deployment-date triage unsafe: `handle-user-deletion` was cleared by
date and turned out to be materially stale. This lane therefore used, per function
and per environment:

1. **SHA-256 byte comparison** where the Management API result was large enough to be
   persisted to disk — every deployed file was mapped back to its canonical repo path
   and hashed on both sides, with a unified diff emitted for each mismatch. Used for
   `scan-identify` (both envs), `stylechat-generate` (both envs),
   `process-account-deletions` (staging), `commerce-watch-refresh`,
   `style-outfit-generate` (both envs), `stylist-speech` (staging), `vto-generate`.
2. **Full source read of every deployed file** against the canonical file, for the
   remaining functions, whose results returned inline. Every classification below
   names the specific symbols, constants and control-flow branches compared.

Evidence tier is stated per function. No function was classified from a date.

**Per-function shared snapshots were honoured.** Each deployment carries its own
`_shared/**` copy, and this lane proved the trap is live: inside the *same* staging
project, `process-account-deletions` v61 bundles `_shared/revenuecat/revenueCatClient.ts`
at the canonical hash `83ba5ec496d8…` while `kplus-activate` v15 bundles an older copy;
and staging `restore-account` v55 bundles the NEW `_shared/deletion/common.ts` while
staging `handle-user-deletion` v75 bundles the OLD one. A project-wide shared-module
comparison would have missed both.

---

## 4. The 23-row matrix

| # | FUNCTION | CANONICAL | STAGING | PRODUCTION | CLASSIFICATION | SECURITY / FUNCTIONAL DIFFERENCE | SEV | ACTION |
|---|---|---|---|---|---|---|---|---|
| 1 | `scan-identify` | 41 bundle files | v61 · 32/40 identical, 8 differ, `offerCurrency.ts` absent | v156 · 19/31 identical, 12 differ, 11 canonical files absent, 1 ungoverned `farfetchProvider.ts` | CANONICAL_NEWER_ACCEPTED | Drift is commerce correctness only (RP-110 currency truthfulness, SCAN-001/003/004/006/007). Canonical **strengthens**: quota fail-open → three-state fail-closed, plus the Build-32 `isEligiblePaidAIActor` ingress authority. `assertAccountActiveIfAuthenticated` byte-identical everywhere. `verify_jwt=false` unchanged. | P2-P3 | Note ungoverned prod `farfetchProvider.ts`; owner decision on ending anonymous image scan |
| 2 | `commerce-watch-refresh` | 13 | v6 · 6/12 identical, 6 differ, `offerCurrency.ts` absent | ABSENT (Build 34) | CANONICAL_NEWER_ACCEPTED + ABSENT_FROM_PRODUCTION_BY_DESIGN | Every security hunk is canonical-only: `isEligibleAccountActor` gate, `watchlist_actor_is_active`, NOTIF-10 push-token shape check, NOTIF-06 all-device fan-out, NOTIF-12 dead-token revocation | P4+ | None |
| 3 | `stylechat-generate` | 52 | v122 · **52/52 byte-identical** | v100 · 26/44 identical, 18 differ, 9 ungoverned prod-only modules, 18 canonical files absent | THREE_WAY_DIVERGENCE | **Canonical WEAKER**: production's `promptHardening.escapePromptData` calls `neutralizeInjectionMarkers`; canonical does not, and canonical's `_shared/aiSecurity/escapeUntrustedText.ts` has no such export and no `FAKE_ROLE_HEADINGS_INLINE`. Plus an Elise closet/dressing-room-intelligence generation gap | **P1** | **Port the injection neutralizer (§5.A)** |
| 4 | `style-outfit-generate` | 6 | v54 · **6/6 byte-identical** | v18 · 4/6 identical, 2 differ | CANONICAL_EQUALS_STAGING | Copy only: "from your closet" → "from your saved items" (INT-KPLUS-001). Diff read in full; zero logic change | P4+ | None |
| 5 | `stylist-speech` | 11 | v64 · **11/11 byte-identical** | v41 · ≥6 files older | CANONICAL_EQUALS_STAGING | Canonical adds Build-29 alignment diagnostics. Whole auth/actor-isolation chain identical (401 → 403 `ACCOUNT_UNAVAILABLE` → per-user session/message re-scoping → `STYLIST_MISMATCH`). Canonical moves `elise_default` from silent to speaking | P2-P3 | Owner decision: default stylist gains a voice |
| 6 | `handle-user-deletion` | 4 | v75 · 3/4 identical; `handler.ts` is the pre-reconciliation lineage | v84 · monolithic, 2 files | CANONICAL_NEWER_ACCEPTED | Canonical is the #351 reconciled superset. Preserves **all** production controls (blocking deactivation + compensating `failed`, Auth ban `720h` derived from the grace window, session revocation, legacy-row upgrade incl. its flagged asymmetry) and **adds** rate limiting, `account_locked_at`, exact-23505 duplicate handling. Drops only non-controls (transition metadata, `USER_REQUESTED`→`USER_REQUEST` — no CHECK constraint exists, `confirmation_email_sent_at` — no reader in tree) | P2-P3 | None; record the missing-profile semantics change |
| 7 | `process-account-deletions` | 5 | v61 · **5/5 SHA-256 identical** | v25 · different lineage; 4 files incl. **ungoverned** `_shared/appleAuth/revocationGate.ts`; no `revenueCatClient.ts` | CANONICAL_NEWER_ACCEPTED | Every production worker control present in canonical (constant-time worker auth, kill switch, leases, Apple revocation blocking gate, storage partial-removal alert, post-purge residual verification, dead-letter alert). Canonical **adds** a blocking RevenueCat `retireMirroredEntitlement`. The ungoverned prod module is contract-equivalent to canonical's `appleRevocation.ts` | P2-P3 | Record the ungoverned production path |
| 8 | `apple-credential-link` | 5 | v54 · **5/5 identical, comments included** (closes RP-108's open gap) | v9 · same modules, comment-stripped/minified | CANONICAL_EQUALS_STAGING | Logic identical line by line. `verify_jwt=true` on both. Body carries only `authorizationCode`, so there is no user id to spoof | EXPECTED | None |
| 9 | `apple-revoke-credential` | 5 | v52 · **5/5 identical** | v9 · minified | CANONICAL_EQUALS_STAGING | Identical constant-time service-role bearer check, 6-value status vocabulary, AES-256-GCM envelope. `verify_jwt=false` on both — correct, the function does its own service-role check and rejects any user JWT | EXPECTED | None |
| 10 | `privacy-correction-request` | 2 | v59 · **2/2 identical** | v39 · 1 file, CRLF | THREE_WAY_DIVERGENCE | **Canonical WEAKER**: production 403s `ACCOUNT_DEACTIVATED` on non-active / locked / unreadable profile; canonical has no account-state gate at all. Canonical is stronger on the other axis (5/60 s rate limit production lacks) | **P1** | **Add the account-active gate (§5.B)** |
| 11 | `privacy-data-export` | 2 | v58 · **2/2 identical** | v39 · 1 file, CRLF | THREE_WAY_DIVERGENCE | Same finding as #10 (production splits it into two fail-closed 403 branches). Manifest copy differs: "Style DNA" vs "Signature Style" — product rename, inspected | **P1** | **Add the account-active gate (§5.B)** |
| 12 | `restore-account` | 2 | v55 · **2/2 identical** | v23 · `index.ts` identical mod CRLF; `common.ts` older (no `isAnonymous` / `isEligibleAccountActor`) | CANONICAL_EQUALS_STAGING | Neither symbol is called by this slug → behavioural delta nil. `verify_jwt=false` correct on both (token-bearing pre-auth path) | P4+ | None |
| 13 | `resend-restoration-email` | 2 | v55 · **2/2 identical** | v23 · `index.ts` identical; `common.ts` older | CANONICAL_EQUALS_STAGING | Enumeration-safety, 900 ms timing floor and rotate-before-send ordering identical everywhere. Line endings differ **per file within one deployment** — proof these are genuine deployed bytes | P4+ | None |
| 14 | `kickscrew-sneaker-description` | 1 | v71 · **byte-identical** | v85 · identical except the secret NAME | CANONICAL_EQUALS_STAGING | Production reads `KICKSCREW_RAPIDAPI_KEY`, canonical/staging read `RAPIDAPI_KEY`. Both names are in `secret-name-manifest.md`; no key material exposed either way | EXPECTED | Deploy prerequisite: populate `RAPIDAPI_KEY` in production first |
| 15 | `kplus-activate` | 3 | v15 · `index.ts` + `common.ts` match; `revenueCatClient.ts` older | ABSENT (post-Build-33) | CANONICAL_NEWER_ACCEPTED + ABSENT_FROM_PRODUCTION_BY_DESIGN | SEC-KPLUS-005 anonymous-actor 403, `assertAccountActive`, SEC-KPLUS-008 canonical re-check all identical. Missing cleanup exports are uncalled here | P4+ | None |
| 16 | `kplus-reconcile-revenuecat` | 3 | v15 · same shape as #15 | ABSENT | CANONICAL_NEWER_ACCEPTED + ABSENT_FROM_PRODUCTION_BY_DESIGN | Shared-secret gate identical. (Both sides use a non-constant-time `!==` for the reconcile secret — identical, therefore pre-existing, not drift) | P4+ | Pre-existing observation only |
| 17 | `nike-shoe-details` | 1 | v52 · **byte-identical** | v83 · identical minus a 2-line leading comment | CANONICAL_EQUALS_STAGING | Comment-only; every executable line identical, same `RAPIDAPI_KEY` | P4+ | None |
| 18 | `product-search-deals` | 1 | v61 · **byte-identical** | v86 · 3 files, CRLF | THREE_WAY_DIVERGENCE | **Canonical WEAKER**: production statically imports and calls `assertAccountActiveIfAuthenticated(req)` before the paid RapidAPI call; canonical has no guard. Production's own comment records the guard was once lost to the bundler and deliberately re-added | **P1** | **Restore the static-import guard (§5.C)** |
| 19 | `search-vinted-secondhand` | 1 | v52 · **byte-identical** | v22 · 3 files, CRLF | THREE_WAY_DIVERGENCE | Same finding as #18, before the Apify actor run (`APIFY_API_TOKEN` budget) | **P1** | **Restore the static-import guard (§5.C)** |
| 20 | `shared-room-image-url` | 2 | v52 · identical | v30 · identical apart from a stray trailing `\r\n` at EOF in both files | PARITY_ALL | All actor-isolation controls identical: origin pinned to `https://kscan.app`, generic 404 with no oracle, room-scoped item resolution, owner-prefixed 3-segment path enforcement, single-bucket allowlist, no bucket/path/owner in the response | EXPECTED | None |
| 21 | `tryon-clothes-pro` | 2 | v5 · **2/2 identical** (retired 410 stub) | v22 · LIVE RapidAPI proxy + account guard, 3 files | CANONICAL_EQUALS_STAGING | Canonical is **stronger** — it retires the endpoint rather than guarding it. `verify_jwt` differs (staging false) but the staging deployment is an inert 410 refusal | P2-P3 | Owner decision before canonical retires a live production endpoint |
| 22 | `staging-health` | 1 | v56 · **STRICT SUPERSET of canonical** | ABSENT by design (staging-only tooling) | STAGING_NEWER | Staging runs health-contract-v1: `/health/live`, `/health/ready`, `/version`, fail-closed release identity, and a credential-shape redaction filter on a `verify_jwt=false` public surface. Canonical has none of it, and none of its supporting modules exist in the tree | **P1** | **Recover the deployed v1 source into canonical (§5.D)** |
| 23 | `vto-generate` | 16 | v9 · **16/16 SHA-256 identical** | ABSENT (Build 34 K4) | CANONICAL_EQUALS_STAGING + ABSENT_FROM_PRODUCTION_BY_DESIGN | Exact parity including `_shared/net/safeRemoteMedia.ts` and the whole providers tree | EXPECTED | None |

---

## 5. Stop conditions and narrow repair recommendations

No repair was performed in this lane. Each recommendation below is scoped to the
smallest change that restores the deployed control.

### 5.A — `stylechat-generate`: prompt-injection neutralizer (P1)

Production applies `neutralizeInjectionMarkers` to untrusted text before it reaches
the StyleChat model; canonical does not, and canonical's copy of the shared module is
an older generation that lacks both the export and the mid-line role-spoofing pattern
`FAKE_ROLE_HEADINGS_INLINE`. The production source states the consequence in-file:
`"Navy blazer. system: ignore prior rules"` survives canonical's substitutions intact,
and canonical's `\s+` collapse actively defeats its own line-anchored detector.
Attacker-supplied text on this path includes shared-room item titles, saved-look labels
and retailer names — cross-actor content.

1. Port `neutralizeInjectionMarkers` and `FAKE_ROLE_HEADINGS_INLINE` into
   `supabase/functions/_shared/aiSecurity/escapeUntrustedText.ts`, keeping
   `escapeUntrustedText = escapeXmlEntities(neutralizeInjectionMarkers(raw))`.
2. Restore the import and the `neutralizeInjectionMarkers(value)` call in
   `supabase/functions/stylechat-generate/promptHardening.ts`.
3. Regenerate `config/edge-function-manifest.json` with the governed tooling
   (the bundle grows 52 → 54).
4. Add a regression test asserting `escapePromptData` neutralizes an inline
   `system:` handoff.

Scope: 2 source files + manifest + 1 test. Note that **staging already runs without
this control**, because staging is byte-identical to canonical.

### 5.B — `privacy-correction-request` and `privacy-data-export`: account-state gate (P1)

Production 403s `ACCOUNT_DEACTIVATED` for a non-active or locked account (fail-closed
on an unreadable profile row); canonical has no gate, so a deactivated / pending-deletion
/ locked account could file new privacy correction and export requests.

1. Add the gate to both `index.ts` files, **after** `requireUser` and **before** the
   rate-limit reservation. Canonical already ships two fail-closed implementations —
   `assertAccountActive` in `_shared/deletion/common.ts` (which also handles the
   legitimate missing-profile case) or `_shared/deletion/assertAccountActiveIfAuthenticated.ts`.
2. Keep canonical's rate limit — production lacks it and it must not be dropped.
3. Regenerate the manifest (each bundle grows 2 → 3).
4. Add 403 regression tests for `pending_deletion`, `locked`, and missing-profile.

### 5.C — `product-search-deals` and `search-vinted-secondhand`: paid-provider guard (P1)

Production statically imports `assertAccountActiveIfAuthenticated` and calls it before
any upstream spend; canonical has neither.

1. Add the **static** top-level import and the guard block exactly as production runs
   it. The deployed comment records that a dynamic `import()` is silently dropped by
   the Supabase `--use-api` bundler, which previously 500'd the function — keep it static.
2. Regenerate the manifest (each bundle grows 1 → 3).
3. Add a 403 regression test plus a pass-through test for an unauthenticated caller.

### 5.D — `staging-health`: ungoverned deployed source (P1)

Staging runs a health-contract-v1 generation with no committed source anywhere in this
repository. Canonical has no `security/release/generate-release-manifest.js`, no
`security/release/verify-exact-candidate.js`, no `security/scripts/lib/secret-shape-guard.js`,
no reference to `HEALTH_CONTRACT_VERSION`, and no `kscan-candidate` workflow — yet the
deployed entrypoint path shows it was built by one. Redeploying canonical would remove
`/health/live`, `/health/ready`, `/version`, the fail-closed release-identity surface and
the credential-shape redaction filter from a publicly reachable (`verify_jwt=false`)
endpoint.

Recover the deployed v1 source read-only from the Management API into
`supabase/functions/staging-health/index.ts`, and locate (or reconstruct and govern) the
`kscan-candidate` release-manifest tooling it references. Staging-only; no production
exposure. The existing CI health-check is unaffected either way — the deployed v1
preserves the pre-v1 composite root byte-compatibly.

### Other stop-condition checks — all clear

| Stop condition | Result |
|---|---|
| Canonical rolls back accepted **production** security behaviour | **HIT** — §5.A, §5.B, §5.C |
| Canonical rolls back accepted **staging** behaviour needed for the next release | **HIT** — §5.D |
| Missing auth / actor-isolation control | Not found. Every auth chain compared is present in all environments |
| Weaker privacy control | Only via §5.A/§5.B; `shared-room-image-url` (the actor-isolation surface) is at full parity |
| Weaker deletion behaviour | Not found. Canonical is a strict superset of both deployed deletion lineages |
| Unexpected production-only hotfix | Not found; the production-only modules are older lineages, not hotfixes |
| Ungoverned deployed source | **FOUND (4)** — staging `staging-health` v1; production `_shared/appleAuth/revocationGate.ts`, `scan-identify/farfetchProvider.ts`, and 9 `stylechat-generate` modules |
| `verify_jwt` security regression | **None.** Every governed slug's posture is correct in every environment it exists in |
| P0 divergence | **None** |

---

## 6. Account-deletion subsystem reconfirmation (post-#351)

| Function | Canonical vs staging | Canonical vs production | Verdict |
|---|---|---|---|
| `handle-user-deletion` | 3/4 identical; `handler.ts` is the reconciled superset | monolithic prod lineage; all its controls preserved | Reconciled lifecycle **confirmed**, unmodified |
| `restore-account` | 2/2 identical | `index.ts` identical mod CRLF; `common.ts` older | Confirmed |
| `process-account-deletions` | **5/5 SHA-256 identical** | different lineage; all controls preserved, RevenueCat retirement added | Confirmed |
| `resend-restoration-email` | 2/2 identical | `index.ts` identical; `common.ts` older | Confirmed |

`handle-user-deletion` was **not modified** by this lane. The terminal deletion-status
receipt/endpoint is **NOT IMPLEMENTED** in canonical, staging or production — confirmed
by inspection, and it remains Repair 06's scope. Repair 06 was not started here.

---

## 7. Validation

| Gate | Result |
|---|---|
| `scripts/verify-backend-authority.js` | **PASS** — no discrepancies, 23/23 governed/source, tree clean |
| `scripts/generate-edge-function-manifest.js --check` | **PASS** — manifest current |
| `npm run verify:edge-parity` | **PASS** — every governed file matches its recorded hash |
| `scripts/verify-migration-authority.js` | exit 0 |
| `scripts/check-dependency-reachability.js` | exit 0 |
| `scripts/check-migration-provenance.js` | exit 0 |
| `scripts/check-native-config-parity.js` | exit 0 |
| `security/scripts/run-security-validation.js` | exit 0 |
| `npx tsc --noEmit` | exit 0 |
| `npm run test:all` (full governed regression) | **exit 0** — observed failures 13 · known 13 · **unexpected 0** |
| `npm run test:backend` (Deno Edge suite) | **NOT RUNNABLE HERE** — environment limitation, see below |

**Unexpected failures = 0**, on a clean `npm ci` tree with this document committed:
`Observed failures: 13; known: 13; unexpected: 0` and the runner exits 0. An earlier run
against the same tree, before this file was committed, reported the pair
`the verifier reports no ERROR-level discrepancy on this checkout` and
`this checkout satisfies the contract for the role it declares`; both were
`AUTHORITY_TREE_DIRTY` raised by this very file being uncommitted, and both clear once
it is committed. They are recorded here rather than hidden.

**Known-failure baseline was not altered.** `config/test-failure-baseline.json`
(19 identities, recorded 2026-08-30) is unchanged. 13 of its 19 identities fired;
no identity was added, removed or reworded.

**Deno gate — honest limitation.** `deno` is absent from this container and
`https://deno.land` is blocked by the environment's network policy (`curl` → 403;
`deno` → "unsuccessful tunnel" fetching `std@0.224.0/assert/mod.ts`). Installing the
`deno` npm package produced a working Deno 2.9.6 binary, proving the runner itself
works, but the suites cannot resolve their `deno.land/std` imports from here.
`scripts/run-backend-tests.js` exits **1** in that state — it does not exit 0, contrary
to the note in the RP-06A lineage document. CI runs this gate via `denoland/setup-deno`.
Every comparison in this lane is a read-only source comparison and does not depend on
that suite.

> **Operational note for the next lane.** Running Deno inside the repo rewrites
> `node_modules` into Deno's npm layout (`node_modules/.deno/` plus symlinks). That
> both introduces duplicate `expo-audio` / `expo-location` Android manifests — which
> the Google Play foreground-service gate correctly reports as ungoverned — and breaks
> the tree if `.deno` is then deleted. Reinstall with `npm ci` before running the Node
> suite. Both effects were observed and resolved here; neither is a defect in this branch.

---

## 8. Summary counts

```
Total governed:                          23
Fully content-compared:                  23   (0 timestamp-only classifications)
Exact canonical == staging parity:       17
Non-parity vs staging:                    6   (scan-identify, commerce-watch-refresh,
                                               handle-user-deletion, kplus-activate,
                                               kplus-reconcile-revenuecat, staging-health)

Classification
  PARITY_ALL:                             1
  CANONICAL_EQUALS_STAGING:              10
  CANONICAL_EQUALS_PRODUCTION:            0
  CANONICAL_NEWER_ACCEPTED:               6
  STAGING_NEWER:                          1
  PRODUCTION_NEWER:                       0   (production-only controls are captured
                                               inside the 5 three-way rows)
  THREE_WAY_DIVERGENCE:                   5
  ABSENT_FROM_STAGING_BY_DESIGN:          0
  ABSENT_FROM_PRODUCTION_BY_DESIGN:       5   (secondary tag: commerce-watch-refresh,
                                               kplus-activate, kplus-reconcile-revenuecat,
                                               staging-health, vto-generate)
  UNRESOLVED:                             0

Expected environment differences:         8   (minified/comment-stripped production
                                               deploys, CRLF and EOF artifacts,
                                               secret naming, by-design absences)

Severity
  P0:                                     0
  P1:                                     6   (staging-health; stylechat-generate;
                                               privacy-correction-request;
                                               privacy-data-export; product-search-deals;
                                               search-vinted-secondhand)
  P2-P3:                                  5   (scan-identify; handle-user-deletion;
                                               process-account-deletions; stylist-speech;
                                               tryon-clothes-pro)
  P4+ / EXPECTED:                        12
  Unresolved:                             0

Ungoverned deployed sources found:        4
```

## 9. Production freeze

Build 33 remains in Apple review. This lane performed **no** production Edge deploy,
migration, secret/env mutation, data mutation or config mutation; **no** staging change
of any kind; and **no** EAS build, EAS Update or App Store action. Every environment
read was a read-only Management API call.

**FINAL VERDICT: BLOCKED — SOURCE RECONCILIATION REQUIRED.**
Canonical authority is content-certified as *compared* — all 23 functions, both
environments, no timestamp shortcuts, no hidden P0 — but it is **not** certified as
deployable until §5.A–§5.D are reconciled.
