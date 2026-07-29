# Phase 0B — Authoritative baseline execution environment

**Verdict: UNRESOLVED. No authoritative isolated environment exists today.**

Option B is the recommended path and is technically feasible, but it is not
built and one of its preconditions cannot currently be proven.

---

## Option A — Approved staging: **NOT AVAILABLE**

There is exactly one Supabase project in this repository.

| Evidence | Finding |
|---|---|
| `supabase/config.toml` | `project_id = "wyyuqfdxucjksghsmhry"` |
| `config/edge-function-manifest.json` | `"approvedProjectRef": "wyyuqfdxucjksghsmhry"` |
| `eas.json` (all three profiles) | `EXPO_PUBLIC_SUPABASE_URL = https://wyyuqfdxucjksghsmhry.supabase.co` |

That project is production. Every build profile — including development — points
at it. There is no second project, no staging ref, and nothing to promote a
bundle into.

Standing up a staging project would mean creating infrastructure, deploying
functions to it, and configuring model credentials. All three are owner
decisions and none is authorized by Phase 0B.

---

## Option B — Isolated exact-bundle runner: **FEASIBLE, NOT BUILT, ONE PRECONDITION UNPROVABLE OFFLINE**

### What already holds

**Runtime is present.** `deno 2.8.2` and `supabase CLI 2.109.1` are installed, so
the function bundle can be served locally without touching production.

**Repo-side bundle integrity is proven.** `scripts/check-edge-function-parity.js`
passes:

```
EDGE FUNCTION PARITY: PASS
  project ref        : wyyuqfdxucjksghsmhry
  scan-identify      : bundle 31 files  9d645f5eb5bb04f2…
  stylechat-generate : bundle 34 files  b09177cf7be1d469…
```

**The research branch has not drifted from the manifest source.** Tree hashes:

| Ref | `scan-identify` tree | `_shared` tree |
|---|---|---|
| `HEAD` (cf39d9ac) | `1e6ec21160ec3bc9…` | `ccba6e9625 25da0c…` |
| `01cc4fca` (manifest source) | `1e6ec21160ec3bc9…` | `ccba6e962525da0c…` |
| `ad4c559` (recorded rollback) | `7b33c4906bde15c4…` | `94a55c3424642361…` |

HEAD is byte-identical to the commit the manifest was generated from. Phase 0B
changed nothing under `supabase/`.

**Commerce is disabled by intent, in the source, not by a flag we would set.**
`fashionIdentificationV2.ts` routes commerce only for `identify_and_shop`;
`identify_for_style` and `identify_for_closet` both skip it and populate
`commerceSkippedReason` with a documented constant. Running the baseline under
`identify_for_style` disables commerce through production's own control path
rather than through a modification.

### What does not hold

**The deployed v140 bundle cannot be proven equal to this tree from offline
evidence.** There is no attestation in the repository binding a deployed
function *version number* to a bundle hash. The only deployment document,
`docs/edge-function-deployment.md`, still describes `scan-identify` **v139** and
predates the v140 deploy. The manifest proves the repo is internally consistent;
it does not prove what is running in production.

Closing this requires reading deployed function metadata from the production
project. That is a production API call. Phase 0B is scoped offline and
non-production, and self-authorizing a production read would breach the standing
owner-gate rule, so it was **not performed**. It is listed below as an
owner-authorized step.

**The runner does not exist.** Building it requires:

1. serving the `scan-identify` bundle under Deno locally;
2. supplying a Gemini API credential — a paid credential, currently unheld by
   this phase;
3. stubbing persistence and telemetry writers, and proving the stubs do not
   alter the identification path;
4. exercising the full prompt → model call → parse → route → normalize path.
   Calling `fashionIdentificationV2.ts` directly is explicitly **not**
   acceptable: `normalizeToV2` is the last step, and calling it alone would skip
   the prompt, the provider call and all routing — measuring nothing about the
   scanner.

---

## Option C — Production endpoint: **NOT AUTHORIZED, NOT RECOMMENDED**

Not used, and not recommended even with authorization. Documented side effects
if the owner were to consider it:

| Effect | Detail |
|---|---|
| Traffic | 95–200 real scan requests against the live function |
| Rate limit | `scan-identify` self-rate-limits by fingerprint on the anonymous path; a burst would consume real budget and could trip limits for real users |
| Persistence | The live path writes scan intelligence and outcome capture records; baseline runs would pollute production analytics |
| Telemetry | Quality-tune telemetry would record synthetic evaluation traffic as user behaviour |
| Commerce | Avoidable by using `identify_for_style`, but the request would still traverse production routing |
| Rollback | No rollback exists for emitted telemetry and persisted rows; they would need identifying and deleting after the fact |

Cost is not the objection — the run is a few dollars. The objection is
contaminating production analytics with synthetic traffic that later readers
would mistake for user behaviour.

---

## Recommendation

**Build Option B.** It is the only option that is both isolated and faithful, and
the runtime is already installed.

Ordered prerequisites, each an owner decision:

1. **Authorize a single production metadata read** (`get_edge_function` on
   `scan-identify`) purely to record the deployed version and bundle hash, and
   commit that attestation. This is a metadata read, not scan traffic — but it
   is still a production call and is not self-authorized.
2. **Provide a Gemini API credential** scoped to evaluation, so spend is
   separable from production spend.
3. **Confirm the model pins.** `gemini-3.6-flash` primary and
   `gemini-3.5-flash-lite` fallback, per
   `supabase/functions/_shared/llmModelRouting.ts`. If `SCAN_GEMINI_MODEL` is set
   as a production secret to something else, the local runner must match it or
   the baseline measures a different model than production serves. **Secret
   values were not read.**
4. **Approve the persistence and telemetry stubs** once written, with a diff
   showing they do not alter identification behaviour.

Until 1–4 are done, the correct status is:

**BUILD 4 PHASE 0B BLOCKED — AUTHORITATIVE BASELINE ENVIRONMENT UNRESOLVED**

---

## Minor observation

`fashionIdentificationV2.ts:367` rejects an unknown intent with the message
`"intent must be identify_and_shop or identify_for_style."` — which omits
`identify_for_closet`. The *validation* is correct (it tests membership of
`FASHION_IDENTIFICATION_INTENTS`, which contains all three); only the error
string is stale. Cosmetic, no functional effect, and in a path Phase 0B may not
modify. Recorded for the owner.
