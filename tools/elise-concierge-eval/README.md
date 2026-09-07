# Elise & Wardrobe Concierge Evaluation Authority — V1

```
EVIDENCE FRAMING:
INSTRUMENT VALIDATION

NO SYNTHETIC-RESPONSE METRIC CHARACTERIZES
PRODUCTION ELISE OR WARDROBE CONCIERGE QUALITY.

NO SYNTHETIC METRIC IS USER-SATISFACTION EVIDENCE.

NO GROUNDING/SAFETY METRIC IS A SAFETY-ASSURANCE CLAIM.
```

This is a **research/instrument-validation lane** (Build 35). It builds a rigorous evaluation
harness that can *later* measure Elise and Wardrobe Concierge quality — it does **not** measure
that quality today. Every number this lane produces on synthetic text validates the instrument's
own detection quality, not production behavior. Synthetic response results validate the
evaluation instrument only. They are not measurements of production Elise behavior, production
Wardrobe Concierge behavior, user satisfaction, recommendation quality, or safety assurance.

No production file under `supabase/functions/` (or anywhere else) was modified to build this.
`ELISE PRODUCTION CHANGE: NO`, `CONCIERGE PRODUCTION CHANGE: NO`, `LIVE MODEL CALLS: 0`,
`PROVIDER SPEND: $0`. See the PR description for the full zero-behavior-gate assertion list.

## What this actually found (source authority)

Wardrobe Concierge is **not a separate system** from Elise. It is an additive, flag-gated
(`conciergeV1`) capability layer inside the same `supabase/functions/stylechat-generate` pipeline.
See `authority/*.json` for the full, source-cited map (PROVEN / NOT_FOUND / UNKNOWN throughout —
never inferred from a feature name). Context assembly is **structured** (a typed, trust-separated
prompt envelope), which is why this harness could build a real (non-network) execution seam into
production's own context-assembly and prose-safety code — see "L1.5" below.

## Directory map

| Path | What it is |
|---|---|
| `authority/` | Source-cited maps: Elise, Concierge, context assembly, safety policy, entitlement. |
| `model/` | Versioned contracts: defect taxonomy, precedence contract, task taxonomy, claim schema, shared alias/vocabulary tables, canonical JSON + seeded RNG utilities. |
| `schema/` | Fixture validators + the recursive privacy guard. |
| `fixtures/` | Closets (12), Signature Style profiles (8), scenarios (20), multi-turn traces (5), a deterministic synthetic commerce catalog (60 products). |
| `synthesis/` | The deterministic RESPONSE SYNTHESIZER (`responseSynthesizer.js`) + phrasing-variation bank + harness-owned candidate selection (NOT a reimplementation of production ranking). |
| `defects/` | The D01–D16 defect-injection scripts. |
| `extraction/` | `claimExtractor.js` — the primary instrument under test — plus the tolerance operating-curve sweep. |
| `grounding/` | The verdict-aggregating evaluator, the D07 style-conflict and D06 soft-constraint bounded proxies, cross-system consistency logic, multi-turn continuity evaluation. |
| `constraints/` | Hard/soft constraint checking against fixture ground truth. |
| `context-assembly/` | **L1.5**: imports and executes real, unmodified production pure functions (see below). |
| `safety/` | Safety-policy-map completeness check + the body/appearance language stratifier (labels every result `POLICY_GAP` — no policy is invented). |
| `metrics/` | Corpus builder, verdict-reproduction scorer, coverage matrix, coverage-suppression logic. |
| `human-review/` | Markdown human-review packet builder (max 50 cases, never pre-scored) + rubric. |
| `replay/` | Owner-captured transcript importer (ready; no transcripts supplied in this dispatch). |
| `baseline/` | Immutable baseline record (versions + hashes), overwrite-proof, incompatible-comparison-proof. |
| `reports/` | `generateReport.js` (the aggregator) + `evidenceFraming.js` (the canonical banner/clause) + generated output. |
| `runner.js` | CLI entry point (see Modes below). |
| `validateReport.js` | The **independent** validator — a separate program from the report generator (spec section 54). |
| `__tests__/` | node:test files. Run with `node --test tools/elise-concierge-eval/__tests__/*.test.js`. NOT picked up by the repo's root `npm run test:all` (which only walks the root `__tests__/` directory), so this lane never changes that gate's output. |

## Modes (`node tools/elise-concierge-eval/runner.js <MODE> ...`)

- `CONTRACT` — print every versioned contract (defect taxonomy, precedence contract, extraction
  rules, synthesizer, task taxonomy, rubric, fixture schema).
- `CORPUS [--out file.json]` — build the full synthetic corpus and print/save it.
- `SYNTHESIZE <scenarioId> <ELISE|CONCIERGE> <CLEAN|AMBIGUITY|D01..D16>` — synthesize one response.
- `EVALUATE <scenarioId> <ELISE|CONCIERGE> <script>` — synthesize and evaluate one case, printing
  expected vs. actual verdict.
- `REPORT [--out file.json] [--human-review]` — generate the full report (and optionally the
  human-review packet).
- `VALIDATE <report.json> [--human-review packet.md] [--baseline baseline.json]` — run the
  independent validator.
- `L1_5_CONTEXT` — run the L1.5 suite standalone.
- `OWNER_REPLAY [transcripts.json]` — import owner-captured transcripts, or report
  `READY_NO_CORPUS` if none are supplied.

There is **no live-model mode**, ever.

## Evidence classes (what a result here does and doesn't mean)

- **DETERMINISTIC** findings (e.g. D01 hallucinated ownership, D16 leakage) are machine-checkable
  against exact fixture ground truth. A mismatch is unambiguous.
- **RUBRIC** findings (D06 soft-constraint-ignored, D07 style-conflict) are, in the real product,
  human-judgment dimensions. This harness ships *bounded, deterministic proxies* for them
  (see `grounding/styleConflictHeuristic.js`, `grounding/groundingEvaluator.js
  detectSoftConstraintIgnored`) — explicitly documented as proxies for the instrument's own
  plumbing, never as a general coherence/preference classifier.
- **HUMAN** dimensions (usefulness, style coherence, personalization, specificity, trust) are
  never scored by code. `human-review/packetBuilder.js` renders them as blank rubric lines for a
  person to fill in; `validateReport.js` actively rejects a packet with a pre-filled score.

## The corpus result (synthetic, instrument-only)

On the pinned base (`a9fb82e9020fce268b9840b39cb7fc9a92e5747e`), the full scenario × systemProfile
× script grid produces 522 applicable cases (198 honestly-skipped not-applicable cells — see
`corpus.skippedSample` in a generated report for why each one was skipped). After excluding the
one documented `INSUFFICIENT_COVERAGE` cell (see below):

- **VERDICT_REPRODUCTION_RATE**: 100% on every covered cell (every one of the 16 defect types the
  instrument actually has detector coverage for).
- **EVALUATOR_FALSE_POSITIVE_RATE**: 0% (the CLEAN negative control never misfires).
- **UNDECIDABLE_ACCURACY**: 100% (every AMBIGUITY case correctly resolves to `UNDECIDABLE`).
- Unsuppressed (the full, un-excluded corpus, kept for transparency, never the headline): 93.64%.

**The one documented gap**: D06 (SOFT_CONSTRAINT_IGNORED) is deliberately conservative. Its
detector only checks an *explicit* `scenario.softConstraints` signal, not the Signature Style
preference fallback the defect injector uses when no explicit constraint exists — checking the
fallback would false-positive most CLEAN responses (nearly every fixture has *some* preference).
Cases built from that fallback are marked `INSUFFICIENT_COVERAGE` and excluded from the headline
rate (`metrics/coverageSuppression.js`), never averaged in as a silent failure or a silent pass.

Run `node tools/elise-concierge-eval/runner.js REPORT` to regenerate this yourself. Two
consecutive runs produce byte-identical canonical hashes (`reportContentHash`) — see
`__tests__/determinism.test.js`.

## L1.5 — real production code, not a live call

`context-assembly/l15ContextAssembly.js` imports and *executes* several real, unmodified
production TypeScript modules (`_shared/aiSecurity/styleChatPromptAssembly.ts`,
`stylechat-generate/eliseAdvicePrompt.ts`, `eliseOwnershipProseSafety.ts`, `contextMessages.ts`)
directly, using Node's native TypeScript type-stripping (unflagged on Node ≥23.6; this repo's
pinned worktree runs Node v24.14.0). This works because those modules use only erasable TS syntax
and have zero Deno-specific or network dependencies. Feeding them synthetic Closet/Signature-Style
inputs captures the *exact* payload that would reach the model provider — without ever calling it.

This lane used that seam to run the **real production ownership-prose guard** against a planted
false-ownership sentence and confirmed it strips the claim, end to end — a genuine proof, not a
simulation of one. If a future Node version or CI sandbox removes unflagged type-stripping, every
L1.5 function degrades to `available: false` (`L1.5: BLOCKED_SEAM`) rather than crashing.

## Adding fixtures

Add a new closet/Signature-Style/scenario/multi-turn-trace entry to the corresponding JSON file
under `fixtures/`, following the existing shape. `fixtures/index.js` validates and privacy-scans
every fixture at load time and enforces closet/style cross-reference integrity — a malformed or
unsafe addition fails loudly instead of being silently accepted.

## Adding owner transcripts

Supply an array of objects shaped like `replay/ownerTranscriptImporter.js`'s `OwnerTranscript`
type (`sourceTier: 'OWNER_CAPTURED'`, `capturedBy: 'OWNER'`, `system`, `captureDate`,
`contextKnown`, `text`, optional `knownContext`) and run
`node tools/elise-concierge-eval/runner.js OWNER_REPLAY <file.json>`. Transcripts must already be
manually sanitized — the importer runs the privacy guard and **rejects** (never silently redacts)
anything that still looks like real PII/secrets. Owner-captured results must always be labeled
"OWNER-CAPTURED ENGINEERING EVIDENCE" and never generalized into a broader quality claim.

## Interpreting instrument vs. system evidence

- A synthetic-corpus metric answers: *"Does the instrument correctly detect a known, planted
  defect, and correctly leave a clean response alone?"* It says nothing about how often production
  Elise/Concierge actually produces such a defect.
- An L1.5 result labeled **"PROVEN AGAINST PRODUCTION CONTEXT-ASSEMBLY CODE"** is a real execution
  of real production source and is the strongest evidence class this lane produces — but it is
  still about *context assembly*, not about model output quality, and still involves zero live
  model calls.
- An owner-captured result (none exist yet) would be **"OWNER-CAPTURED ENGINEERING EVIDENCE"** —
  real signal, but scoped to the specific transcripts reviewed, never generalized, and never
  usable in marketing/App-Store/investor/press/competitive material.

## Running the tests

```
node --test tools/elise-concierge-eval/__tests__/*.test.js
```

This is intentionally **not** wired into `npm run test:all` (root `package.json` was not
modified) — the lane's tests are additive and self-contained.
