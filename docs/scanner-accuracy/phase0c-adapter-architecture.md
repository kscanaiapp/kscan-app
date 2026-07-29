# Phase 0C Lane C — Certified v140 evaluation adapter

**Certified source: LOCATED and PROVEN.**
**Adapter: SPECIFIED, NOT BUILT — blocked on an evaluation credential.**

---

## 1. What Phase 0B got wrong

Phase 0B argued source equivalence from the research branch, on the grounds that
`check-edge-function-parity.js` passed and HEAD matched the commit its manifest
was generated from. Both facts were true and the conclusion was still wrong.

The research branch **descends from** the certification commit but has drifted
forward by two commits that added the `identify_for_closet` intent *after* v140
was certified:

```
9c5bb1b  feat(identify): add identify_for_closet classification-only intent
01cc4fc  test(backend): cover all identification intents
```

| | bundle hash | bundle files |
|---|---|---|
| Certified v140 | `28737e0c96047fa0…` | 31 |
| Research HEAD | `9d645f5eb5bb04f2…` | 31 |

A passing parity gate proves the repo is *internally consistent*. It does not
prove the repo is *what was certified*. An adapter built from HEAD would have
measured a contract that has one more intent than the deployed one.

This also corrects a Phase 0B "minor observation". The v140 error string
`"intent must be identify_and_shop or identify_for_style"` is not stale — it is
**correct** at v140, which has exactly those two intents.

---

## 2. Certified source — proven

Pinned in `tools/scanner-evaluation/adapter/certified-v140.json`. Every hash was
re-derived from the git object store; the committed manifest is cross-checked
against that re-derivation rather than trusted.

| Field | Value |
|---|---|
| Deployed version | **140** |
| iOS certified branch / SHA | `cert/ios-phase-2b4-cross-path-v2` / `f5f4ed2eda4984db0658c3209fece223acd33188` |
| Android certified branch / SHA | `cert/android-phase-2b4-cross-path-v2` / `b9b092683352e67982dd9b84fcb4ae559794bd47` |
| `scan-identify` tree hash | `4db44335f853482386d7edf14b857600cb221ac2` |
| **Bundle hash** | **`28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589`** |
| Bundle / tree file count | **31 / 39** |
| Entry | `supabase/functions/scan-identify/index.ts` |
| Remote specifiers | `npm:@supabase/supabase-js@2` |

Both cert branches carry an **identical** `scan-identify` tree, consistent with
the Phase 2B.4 "one identification core" certification. Their `_shared` trees
differ, but only in files outside the bundle closure — which is why the bundle
hash is identical.

Verify with:

```bash
node tools/scanner-evaluation/verify-certified-v140.js
```

Result: `mismatchCount: 0`, `missingCount: 0`, recomputed bundle hash equals the
certified hash.

## 3. Boundary properties, asserted against the certified text

| Check | Result |
|---|---|
| `commerce_gated_by_intent` | PASS — `shouldRunCommerce` is the single decision point and returns `{run: false, skippedReason: 'style_intent'}` for `identify_for_style` |
| `exact_product_null` | PASS — `exactProduct: null` at three sites; MC-1 holds at the certified source |
| `intents_are_v140` | PASS — exactly `identify_and_shop`, `identify_for_style` |
| `identify_for_closet_absent` | PASS — sending it would be rejected `invalid_intent` by deployed v140 |

---

## 4. The twelve required proofs — honest status

| # | Proof | Status |
|---|---|---|
| 1 | Exact certified source branch and SHA | **PROVEN** |
| 2 | Full bundle/file-closure identity | **PROVEN** — 31/39 files, hash re-derived |
| 3 | Complete identification prompt path | **SPECIFIED** — requires execution |
| 4 | Production model-routing logic | **SPECIFIED** — requires execution |
| 5 | Production parsing path | **SPECIFIED** — requires execution |
| 6 | Production quality routing | **SPECIFIED** — requires execution |
| 7 | Production normalization path | **SPECIFIED** — requires execution |
| 8 | Production fallback policy | **SPECIFIED** — requires execution |
| 9 | No commerce-provider construction | **PARTIALLY PROVEN** — the gate is proven statically; that no provider is *constructed* needs a runtime assertion |
| 10 | No Supabase persistence | **SPECIFIED** — stub not written |
| 11 | No production telemetry | **SPECIFIED** — stub not written |
| 12 | No production endpoint traffic | **PROVEN for dry run** — the runner ships no executor and no transport |

Proofs 3–8 and 10–11 cannot be discharged without running the bundle, which
requires a Gemini credential this phase does not hold. They are specified below
so that building them is mechanical once the credential exists.

---

## 5. Adapter architecture

```
evaluation runner (tools/scanner-evaluation/run-baseline.js)
        │  injected executor
        ▼
certified-v140 adapter                     ← built from tree 4db44335, NEVER HEAD
        │
        ├── serves supabase/functions/scan-identify/index.ts under Deno
        │      full path: prompt → model call → parse → quality route → normalizeToV2
        │
        ├── BOUNDARY: model invocation      → evaluation Gemini credential
        ├── BOUNDARY: commerce              → disabled by intent, NOT by patch
        ├── BOUNDARY: persistence           → stubbed Supabase client
        ├── BOUNDARY: telemetry             → local sink
        └── BOUNDARY: output                → runner result files
```

### Boundary rules

**Commerce.** Disabled by sending `intent: 'identify_for_style'`, which
`shouldRunCommerce` already routes to `{run: false}`. This is production's own
control path. No `skipCommerce`, no `evaluationMode`, no invented intent — the
adapter uses only values present in the certified contract.

**Persistence.** The bundle constructs a Supabase client for scan-intelligence
and commerce-outcome capture. The adapter injects a client whose write methods
throw, so a persistence attempt fails the run loudly rather than silently
writing. It must NOT be a no-op stub: a silent no-op would hide a real write
path from the proof.

**Telemetry.** Quality-tune telemetry is captured to a local sink and included in
the run output, so telemetry behaviour is observed rather than suppressed.

**Model routing.** `llmModelRouting.ts` is inside the closure and used unmodified:
primary `gemini-3.6-flash`, fallback `gemini-3.5-flash-lite`. If a production
`SCAN_GEMINI_MODEL` override is set, the adapter must be given the same value or
it measures a different model than users receive. **Secret values were not read.**

### Fallback policy

Fallback stays production-equivalent and is **not** disabled. Invocation is
recorded, and both metric blocks are reported — primary-only and full-pipeline
including fallback. This is already implemented and tested in
`lib/fallbackTracking.js`.

### Multi-image policy

Certified v140 accepts one evidence item on the identification path. Each image
runs as its own call; results are grouped under one governed same-item case and
reconciled **offline**. No unsupported multi-image request is ever sent, and
offline consolidation is never presented as production behaviour. Implemented
and tested in `lib/multiImage.js`.

---

## 6. Remaining work to make the adapter authoritative

1. Owner provides an evaluation-scoped Gemini credential.
2. Confirm or supply the production `SCAN_GEMINI_MODEL` / `SCAN_GEMINI_FALLBACK_MODEL` values.
3. Write the Deno harness that serves the certified tree — checked out to a
   temporary path from tree `4db44335`, never from a working branch.
4. Write the throwing persistence client and the local telemetry sink, with a
   diff showing identification behaviour is unchanged.
5. Add runtime assertions for proofs 3–8: that the prompt sent matches the
   certified template, that routing selected the certified model, and that
   `normalizeToV2` produced the returned object.
6. Re-run `verify-certified-v140.js` immediately before the paid run and record
   the output in the run manifest.

Until 1–5 are done, the correct status remains:

**BUILD 4 PHASE 0C BLOCKED — OWNER DECISION OR CERTIFIED SOURCE REQUIRED**

with the certified-source half of that condition now **resolved**.
