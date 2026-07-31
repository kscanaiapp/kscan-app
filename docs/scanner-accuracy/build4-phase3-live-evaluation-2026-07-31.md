# Build 4 Phase 3 — Live Evaluation Report (2026-07-31)

## Provenance

| | |
|---|---|
| Live-evaluation workspace | `C:\src\KScan-scanner-phase2a-v1-live-evaluation` |
| Live-evaluation branch | `evaluation/scanner-phase2a-v1-live` |
| Cut from (Phase 2C, production runtime) | `9a6ce53ac9191f66e7da7bca9e9391ebdf31fed5` |
| Evaluation-infrastructure source (unmodified reference) | `research/scanner-accuracy-v2-phase2b-preintegration` @ `4368067956b8f57ec2a7e28eeede93e52b48004a` |
| Execution engine (same-lineage worktree, unmodified content, detached) | `C:\src\KScan-scanner-accuracy-v2-phase2b-live-engine` @ `4368067` |
| Worktree cleanliness | Live-eval worktree clean except this report; Phase 2B/2C source worktrees untouched throughout |
| Commits on the live-eval branch | `--candidate-version` CLI fix; `count-tokens` Deno mode; `live-launcher.js` Node bridge |
| Pushes | None |

## What Was Discovered vs. Built

- The live-transport code (`adapter/deno/certifiedHarness.ts`'s `installLiveFetchInterceptor`, `lib/liveAdapter.js`, `lib/certifiedSnapshot.js`) already existed, built at commit `d251bb1` on `research/scanner-accuracy-v2-evals`, and was already an ancestor of the governed Phase 2B/2C lineage (verified via `git merge-base --is-ancestor` before writing anything). Nothing there needed to be rebuilt.
- Two real gaps were found and fixed, both narrow:
  1. `run-baseline.js` had no CLI route to ever select `phase2a-v1.0.0` — added `--candidate-version`, verified regression-free (514/515 tests, matching the true Phase 2B baseline exactly).
  2. No code anywhere actually called `main()` with a working `{executor, countTokens}` pair — `tools/scanner-evaluation/live-launcher.js` is that missing piece. It spawns `deno run certifiedHarness.ts` per case and translates its `--out` JSON into the shapes `lib/build4Funnel.js` already expects; no new scoring, validation, or cost logic was added.
- A `--provider count-tokens` mode was added to the Deno harness: it reuses the certified request-builder for byte-perfect fidelity, makes two real `:countTokens` calls (never `:generateContent`), and never persists the captured prompt/image — only SHA-256 identity hashes and integer token counts cross back into Node.
- The `--live-mock` path (synthetic counts, `deno --provider mock`, zero network) validated the complete orchestration — preflight, reservation, dispatch, outcome classification, schema validation, candidate post-validation, scoring, persistence — for both control and candidate identities before any real spend.

## Configuration (frozen for this pass)

| | |
|---|---|
| Provider | Google Gemini API |
| Primary / fallback model | `gemini-3.6-flash` / `gemini-3.5-flash-lite` (from certified `llmModelRouting.ts`, re-verified from source, not assumed) |
| Certified source | Immutable snapshot materialized from the git object store, commit `f5f4ed2eda4984db0658c3209fece223acd33188`, bundle hash `28737e0c96047fa014c526886b32b3e5191283a9ed7441641da4d3b0ce632589`, 39/39 files hash-verified — matches the long-established certified baseline recorded in prior Build 4 phases |
| Dataset | Tier-A v0.3.1 — `aggregateSha256 77e90edfe33d013285616ab1fa591112254b119be13620b606bfb57f37924883`, 40 cases / 56 images, 33 development / 7 holdout, all image hashes verified, 0 images in Git |
| Scoring contract | 0.3.0 |
| Taxonomy | 1.0.0 |
| Capture preparation | `certified_client_width_896`, sharp 0.35.3 / libvips 8.18.3, preparation-manifest hash `7308afab2a4bf5b381c060a79138edb7342402dc7404aad95e806f8f184fec35` |
| Control identity | `certified-v140` — no overlay |
| Candidate identity | `phase2a-v1.0.0` — instruction overlay `phase2a-fashion-specificity-v1`, instruction SHA-256 `93b67ad9de443dbb59b3d7aa502e4bb126fad7d8b8ed8e23560bb4802629e384`, artifact SHA-256 `6cc51fbaecaca28b270f4df853dd8004b7360b7d67044f8f74f667ebd8de3a33` — re-verified matching between the canonical evaluation JSON and the generated production TS module via the module's own governed check script |
| Credential | Owner-supplied, evaluation use; the credential pasted earlier in this session's chat transcript is a separate, distinct exposure the owner was advised to rotate — not the credential this evaluation exercised for report purposes |
| Cost ceiling / attempt ceiling | $10.00 / 200 attempts (owner-approved, on record) |

## Execution Record

Development split only. Holdout was **not opened** — see Decision below.

| Stage | Requester | Cases | Generation attempts | countTokens requests | Confirmed cost |
|---|---|---|---|---|---|
| Count-tokens smoke (control) | Owner, direct | 1 | 0 | 2 | $0 (countTokens; no confirmed generation cost) |
| Live smoke — control | Owner, direct | 1 | 1 | 2 | $0.003606 |
| Live smoke — candidate | Owner, direct | 1 | 1 | 2 | $0.0051765 |
| Full development — control | This session (background) | 33 | 33 | 66 | $0.118752 |
| Full development — candidate | This session (background) | 33 | 33 | 66 | $0.1625985 |
| Diagnostic rerun (`tiera-top-0b40a58dff`, candidate) — out-of-band, does not replace the recorded result | This session (background) | 1 | 1 | 0 (bypassed the preflight; direct `--provider live` call) | ~$0.0046 (estimated from 2698/68 tokens) |

**Totals:** 70 development-case executions (33 control + 33 candidate + 1 smoke each side + 1 diagnostic + 1 count-tokens-only), 69 generation attempts (0 fallbacks triggered anywhere), 136 countTokens requests, **confirmed + estimated cost ≈ $0.295** against the $10.00 ceiling. Zero retries beyond the certified route's own primary→fallback (which never fired). Zero client-controlled version selection; every run named its version explicitly via `--candidate-version`, validated fail-closed against `candidateRegistry.isKnown()`.

## Development Results

33/33 cases attempted on each side. **Only 17 of 33 cases have a valid result on both sides** (`comparableCaseCount: 17`, from the governed `compare-candidates.js --profile neutral` tool) — the primary reason is the schema-failure asymmetry below, which excludes any case invalid on either side from the paired comparison.

### Schema failures (`provider_output_invalid`, i.e. `model_json_unparseable`)

| | Control | Candidate | Delta |
|---|---|---|---|
| Invalid / 33 | 6 (18.2%) | 14 (42.4%) | **+8 cases, +24.2pp** |

Root cause confirmed directly, not inferred: a diagnostic rerun of one failing candidate case (`tiera-top-0b40a58dff`) showed `httpStatus: 200` (Gemini responded) immediately followed by the certified handler's own `model_json_unparseable` log line — the model's response was not valid JSON the certified parser could extract, not a transport or credential failure. This is the same failure class recorded for all 14 candidate `provider_output_invalid` cases (`observed: null`, `parseStatus: invalid`, `validation: null` — i.e. never reached schema validation because no V2 result existed to validate). Control's 6 were not individually re-diagnosed (to avoid additional spend) but show the identical signature.

### Paired comparison (17 comparable cases, `neutral` scoring profile)

- Total penalty: control 99.25, candidate 96.5 (lower is better — candidate slightly ahead on the comparable subset, but this subset is not guaranteed representative given the schema-failure asymmetry above).
- Field-level wins for the candidate: `subtype` +3/-0, `material` +2/-0, `pattern` +1/-0 — consistent with the candidate's design intent (fashion-specific vocabulary, evidence-gated specificity).
- Field-level regression: `primaryColor` +0/-3 — unexpected; the overlay does not target color, worth a closer look if this candidate proceeds.
- `category`: +1/-1, a wash.
- `pattern`/`brand`/`exactProduct`/abstention fields: unchanged or `not_measured` per the corpus's known structural limits (brand positive support is exploratory; pattern/silhouette are largely `unknown` in this corpus per Phase 1 governance findings — this evaluation did not change that).

### Candidate-specific post-validation findings (measurable independent of pairing)

Across the 19 candidate cases that did parse successfully:
- `unmapped_taxonomy_prediction`: 4 — the model named a subtype outside the certified ontology (e.g. `"traditional jacket"`).
- `taxonomy_contradiction`: 2 — item_type/subtype family mismatch, which is exactly what the candidate's own instruction 2 ("ITEM_TYPE AND SUBTYPE MUST AGREE") says must not happen.
- No brand hallucinations observed in either arm's successfully-parsed cases.

### Cost and latency

| | Control | Candidate | Delta |
|---|---|---|---|
| Total cost (33 cases) | $0.118752 | $0.1625985 | +37% |
| Mean latency | 8249 ms | 9167 ms | +11% |
| Median latency | 8069 ms | 9782 ms | +21% |

## Holdout Results

Not run. Per the governing rules, the holdout may not be opened while development evidence is incomplete or while unresolved asymmetry could change the decision — the 42% candidate schema-failure rate is exactly that kind of asymmetry, and it independently already crosses the "intrinsically serious" bar (inability to reliably produce valid output) regardless of the accuracy deltas on the comparable subset.

## Harness Corrections Log

| Defect | Root cause | Fix | Provider calls before fix? | Symmetric? |
|---|---|---|---|---|
| `--execute` had no candidate-selection route | CLI never threaded a value into `identity.candidateVersion`, though `candidateRegistry`/`build4Funnel`/`runIdentity` were already built to consume it | Added `--candidate-version`, validated `candidateRegistry.isKnown()` | No | N/A — control-path behavior unchanged, verified via test suite |
| Deno npm resolution (`npm:@supabase/supabase-js` unresolvable) | Raw `KSCAN_CERT_V140_ROOT` worktree has no `node_modules` | Materialized an immutable, hash-verified certified snapshot; symlinked `node_modules` at the snapshot's parent (Deno resolves by directory walk-up; `verifySnapshot` rejects any file inside the snapshot root that isn't part of the pinned 39-file closure, so this could not go inside the snapshot itself) | No | N/A |
| `countTokens` preflight always failed (`preflightReservation.exactRequestIdentity` requires `serializedRequestPayload`/`promptSha256`/etc., not just `inputTokens`) | Underspecified return shape in the new count-tokens bridge | Deno harness now computes and returns SHA-256 hashes of the captured request (never the raw text/image) | No | Yes, both arms use the identical mechanism |
| Deno `--out` write always failed (`adapter_internal_error` on every case) | Missing `--allow-write` | Scoped `--allow-write=<os.tmpdir()>` | No | Yes |
| Running Phase 2B's own test suite from a Phase-2C-lineage worktree spuriously failed 34/515 tests | Git-history-dependent boundary/tracking checks compare against a Phase-2B-specific base SHA that means nothing on Phase 2C's lineage | Created a second worktree detached at the exact Phase 2B SHA to run the patched harness from correct lineage; confirmed the *unmodified* Phase 2B worktree independently passes 514/515 | No | N/A — no real defect, just wrong lineage |

None of these corrections touched dataset content, labels, taxonomy, scoring rules, or the sealed holdout. All were discovered and fixed before any live provider dispatch except the countTokens/write-permission fixes, which were caught by dry runs and a single owner-run smoke call before the 33-case development runs — no case result was ever produced by a broken configuration and then reused.

## Known Limitations

- Only 17/33 cases are validly paired; the accuracy comparison on that subset should be read as suggestive, not conclusive, given the schema-failure asymmetry could plausibly correlate with case difficulty in either direction.
- Control's 6 invalid cases were not individually re-diagnosed (cost discipline); assumed same failure class as the confirmed candidate case based on identical signature (`httpStatus 200`, `observed: null`).
- No interleaving: control and candidate ran as two separate batched invocations roughly 8 minutes apart, not case-by-case alternating (the governed runner only supports version-batched execution). Time-of-run provider drift cannot be ruled out as a partial contributor to either arm's numbers.
- Holdout not run; no holdout metrics exist for this pass.

## Decision

**REVISE_CANDIDATE**

The candidate shows genuine, real evidence of its intended benefit — subtype (+3/-0), material (+2/-0), and pattern (+1/-0) specificity wins on the comparable subset, with no brand hallucinations. But it also introduces a schema-reliability regression serious enough to block advancement as-is: a 42.4% unparseable-response rate versus control's 18.2% (root-caused directly, not inferred) is an "inability to reliably produce valid output" — one of the categories the governing rules treat as intrinsically serious regardless of accuracy gains elsewhere. Advancing a candidate that fails to produce a usable response on 2 in 5 requests would not be a net product improvement no matter how good the other 3 look.

This looks like a narrow, coherent, prompt-level defect, not an architectural one — consistent with the "one authorized revision" criteria.

**Exact failing cases (candidate, `provider_output_invalid`):** `set-balschoen-van-wit-satijn-met-strikken-op`, `set-dr-kt-nordiska-museet-nm-0053061d`, `set-dr-kt-nordiska-museet-nm-0057203c`, `set-fishskin-jacket`, `set-vignon-dinner-dress-met-c-i-69-14-12`, `tiera-accessory-396b72f77b`, `tiera-accessory-521e3b1022`, `tiera-accessory-a53e61e148`, `tiera-bag-1610b00ea6`, `tiera-bag-cdf287c82d`, `tiera-top-0b40a58dff`, `tiera-top-485911abee`, `tiera-top-97c77cbd99`, `tiera-top-c9ade2205d`.

**Observed behavior:** Gemini returns HTTP 200, but the response is not valid JSON the certified parser can extract (`model_json_unparseable`), directly confirmed via a live diagnostic rerun of `tiera-top-0b40a58dff`.

**Proposed instruction delta (for owner review, not applied):** Section 7 ("STRICT STRUCTURED OUTPUT") already tells the model not to add commentary, but it sits *last*, after six sections of increasingly demanding specificity instructions (fashion vocabulary, evidence discipline, brand caution, uncertainty representations). A plausible mechanism: the longer, more demanding instruction set increases the chance the model hedges or explains itself despite the rule, and by the time it reaches instruction 7 the pattern is already set. Two candidate fixes, in order of how narrow they are: (a) move the strict-output requirement to the *top* of the overlay, immediately after the "everything above still applies" line, so it is the first thing reinforced rather than the last; (b) add a single explicit negative example (e.g., "Do not begin your response with an explanation of your reasoning") since the certified prompt likely doesn't need this reminder without the overlay's extra specificity pressure.

**Predicted benefit:** if the reordering/reinforcement closes even half the gap (42.4% → ~30%), the candidate would still need further tightening before ADVANCE, but each revision pass is cheap (~$0.30 for a full paired dev run) and fast (~10 minutes) with the infrastructure now built.

**Regression risk of the proposed delta:** low — reordering existing instructions doesn't change what's asked for, and a negative example is additive. The `subtype`/`material`/`pattern` specificity wins should be unaffected since instructions 1–6 are untouched.

## Next Action

Owner decides whether to authorize the proposed instruction-overlay revision (a new immutable candidate identity, e.g. `phase2a-v1.1.0`, with new hashes, original artifact preserved) for a second and final development pass, or to reject the candidate as-is. This session will not modify candidate instructions without that explicit decision.
