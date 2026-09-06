# Fashion Match Quality Lab (V1)

Internal measurement authority for K Scan's Scanner-to-commerce matching
pipeline. This is a research/engineering lab, not a production feature -
nothing here is wired into the app, and nothing here makes network calls in
its default (contract/offline) modes.

Full background and design rationale: the build spec this lab was built
against is `research/fashion-match-quality-lab-v1`'s originating task. The
short version is in `authority/pipelineMap.json` and
`authority/platformCaptureProfiles.json` - read those first if you want to
know what K Scan's matching pipeline actually does today, in its own words
and file references rather than a paraphrase.

## Purpose

Answers, with evidence instead of vibes:

1. What matching pipeline does K Scan actually use today? (`authority/`)
2. What happens to an image before that pipeline sees it, on iOS vs Android? (`authority/`, `captureProfiles/`)
3. How should fashion-match quality be measured? (`evaluator/`)
4. Can exact-product identity and useful shopping substitutes be measured separately? (`evaluator/identityAxis.js`, `evaluator/substituteAxis.js`)
5. Where does ranking/retrieval perform well or poorly? (`metrics/`, `reports/`)
6. Are top results wasted by duplicates? (`duplicates/`)
7. Are retailer results concentrated or diverse? (`duplicates/summarizeDuplicatesAndRetailers`)
8. Can experimental ranking ideas be compared without touching production? (`experiments/`)
9. Can a later real-world corpus be inserted without redesigning the system? (`corpus/`, `schema/fixtureSchema.js`)
10. Can future improvements be distinguished from noise? (`statistics/`)

## What the numbers mean - and what they do NOT mean

- Every number this lab produces today comes from a **SYNTHETIC** corpus
  (`corpus.tier: SYNTHETIC` in every report). Synthetic fixtures are
  structured descriptors built by a deterministic generator
  (`fixtures/generator.js`), not photographs, and their ground truth is
  authoritative **only because the generator's own construction parameters
  define the fixture** (see "Ground-truth rules" below).
- **A synthetic result is not a K Scan production accuracy number.** It
  proves the *machinery* (schemas, scoring, ranking, dedup, statistics,
  reporting) is correct and reproducible. It says nothing about how K Scan
  performs against real garments, real photos, or real retailer inventory.
- Every report carries `benchmarkStatus: "INTERNAL ENGINEERING EVIDENCE
  ONLY"`. No number from this lab may be used in marketing, investor
  material, App/Play Store copy, press, or any competitive claim.
- Where L1 (offline pipeline mode) is available, the scoring/ranking you
  see is the **real, unmodified production code** from
  `supabase/functions/_shared/scanHelpers.ts` and
  `.../catalogRetrieval.ts`, run through a Deno subprocess
  (`l1/runL1.js` + `l1/runL1.deno.ts`) - not a reimplementation. Lab-only
  experiment variants (`experiments/variants/`) ARE reimplementations,
  clearly labeled as such, and are never wired into production.

## Modes (the evaluation target ladder)

| Mode | What it is | Status this build |
|---|---|---|
| **L0 Contract** | Fully offline: schema, privacy, determinism, baseline-immutability self-checks. Zero fixtures needed beyond the committed corpus. | `runner.js contract` - PASS |
| **L1 Offline pipeline** | Real production `normalizeIdentification` + `rankRecommendedProducts` + `mergeProductCandidates`/`adaptCatalogCandidate`, run via a local `deno` subprocess against fixture-supplied candidates. Zero network. | PASS where `deno` is on PATH; reports `BLOCKED` with a clear reason otherwise (see BLOCKER LEDGER in the final build report) |
| **L2 Replay** | Replays previously-captured, hand-sanitized request/response pairs from `replay/corpus/*.json`. No such corpus currently exists in this repository (see `replay/replaySchema.js` header) - the schema/runner are ready, `runReplay()` reports `READY_NO_CORPUS`. | READY_NO_CORPUS |
| **L3 Live** | Would call the real scan-identify pipeline for real. **Implemented as a governed interface only; never executed by this build.** `SPEND_ENVELOPE_USD = 0`, `LIVE_RUN_SCOPE = NONE`. | NOT AUTHORIZED |

Run all of contract + offline + replay + baseline-compare + experiments and
get one report:

```bash
node tools/fashion-match-quality/runner.js contract        # L0 only, fast
node tools/fashion-match-quality/runner.js report           # full pipeline, writes reports/generated/latest.json
node tools/fashion-match-quality/runner.js baseline:create --force   # (re)write the committed baseline
node tools/fashion-match-quality/validateReport.js tools/fashion-match-quality/reports/generated/latest.json
```

`report` requires `deno` on PATH for L1 to run (the repository's own CI
already depends on `deno` for Edge Function tests - see
`scripts/phase2b4-mutation-battery.js`). Without it, the report still
generates, but `offlinePipelineMode` is `BLOCKED` and every fixture's
evaluation records that as a per-fixture blocker rather than a fabricated
result.

## Fixture creation and ground-truth rules

A fixture (see `schema/fixtureSchema.js` for the full contract) is a JSON
descriptor, never raw image bytes. Every fixture must declare:

- `corpusTier`: `SYNTHETIC` or `APPROVED_REAL`.
- `groundTruth.source`: where the ground truth came from. `SYNTHETIC`
  fixtures MUST use `synthetic_generator_construction` (the generator's own
  parameters ARE the ground truth by construction - there is no circularity
  because nothing scored it). `APPROVED_REAL` fixtures must use a
  traceable, non-model source: `retailer_pdp`, `manufacturer_specification`,
  `known_sku_metadata`, or `owner_annotation`. A model-generated guess may
  only be recorded as `exploratory_non_authoritative`, and such fixtures are
  automatically excluded from headline metrics (see
  `evaluateFixture().excludedFromHeadlineMetrics`).
- `groundTruth.confidence`: `authoritative` or `exploratory_non_authoritative`.
- `captureProfile`: `ios-current-v1`, `android-current-v1`, or
  `profile-neutral`.
- `garmentIdentification`: shaped exactly like the real production
  `NormalizedIdentification` input (see `scanHelpers.ts`).
- `candidateProducts`: an array of candidate product objects (catalog- or
  retailer-shaped - both are accepted, matching production's own
  field-aliasing).

To regenerate the committed synthetic corpus after changing the generator:

```bash
node tools/fashion-match-quality/fixtures/buildSyntheticCorpus.js
```

This overwrites `fixtures/synthetic/*.json` and `_manifest.json`. It fails
loudly (non-zero exit) if the regenerated corpus does not validate.

To add a real fixture later: drop a validated JSON file under
`corpus/real/*.json` (create the directory - it does not exist until an
owner supplies one). No code changes are required; `corpusLoader.js`
already merges `corpus/real/` into the full corpus and the schema already
accepts `APPROVED_REAL` tier fixtures.

## Capture profiles

`captureProfiles/profiles.js` encodes the REAL resize/compression constants
K Scan's client uses today (`services/privacyImageUpload.ts`,
`hooks/useKScan.js`): 1024px/quality-0.82 privacy pass, then 896px/
quality-0.75 for analysis. `authority/platformCaptureProfiles.json` proves,
from source, that iOS and Android currently share these constants
byte-for-byte via Expo's cross-platform APIs (no `Platform.OS` branch was
found in the traced capture path). This is **not** a native image emulator
- it does not manipulate real pixels. It exists so:

- every fixture and evaluation carries a capture-profile identifier;
- metrics can be stratified by capture profile (`metrics.captureProfileStratification`);
- a fixture can be paired across profiles (`pairedFixtureId`) so a future
  real paired iOS/Android photo corpus can be dropped in without any code
  change.

## Baseline creation and replacement

A baseline (`baseline/baselineStore.js`) is immutable once written: it
records `sourceSha`, `fixtureManifestHash`, `corpusTier`, `rubricVersion`,
`schemaVersion`, `capturePolicy`, `evaluationMode`, and `generatedAt`, plus
a `contentHash` computed over everything except `generatedAt`.

- `writeBaseline(path, baseline)` refuses to overwrite a *different*
  existing baseline at the same path (throws `BASELINE_OVERWRITE_REFUSED`).
- Writing back the *same* content is always a safe no-op.
- Pass `{ force: true }` (or `--force` on the CLI) to explicitly replace an
  existing baseline - this is a deliberate, visible action, never implicit.
- `assertBaselinesComparable(a, b)` throws if fixture manifest, rubric
  version, schema version, or corpus-tier set differ between two baselines
  - comparisons across incompatible baselines are refused outright rather
    than producing a misleading delta.

The committed baseline lives at
`baseline/committed/synthetic-v1.baseline.json`.

## Comparison and statistics

`statistics/bootstrap.js` implements paired per-fixture deltas, a seeded
bootstrap confidence interval (deterministic for a fixed seed), and a
noise-floor estimate from repeated-run data (none exists yet - see BLOCKER
LEDGER in the build report; the estimator honestly returns `null`, not a
fabricated zero, when no repeated runs are available).

A comparison is classified as one of:

- `DECISION_GRADE` - CI excludes zero, effect exceeds the measured noise
  floor, and `n >= 30` (a fixed minimum this lab treats as decision-grade;
  see `MIN_N_FOR_DECISION_GRADE`).
- `NOT_DECISION_GRADE` - `n < 30`, regardless of effect size.
- `NOT_SIGNIFICANT` - CI crosses zero.
- `WITHIN_NOISE` - effect size is within the measured run-to-run noise
  floor.

**The lab never auto-declares a winner.** With only 10 synthetic fixtures
today, every comparison this build produces is `NOT_DECISION_GRADE` by
construction - that is the correct, honest outcome, not a bug.

## Holdout

`corpus/corpusLoader.js#splitDevelopmentHoldout` deterministically (SHA-256
of fixtureId, not `Math.random`) splits the corpus 70% development / 30%
holdout by default. Paired fixtures (`pairedFixtureId`) always land in the
same partition as their pair. `runner.js report` evaluates only the
development partition; holdout fixtures are loaded and split but not
scored - wire in a holdout-evaluation command once a real corpus makes that
meaningful (evaluating a 3-fixture holdout partition today would not be
decision-grade under any methodology).

## Privacy constraints

`schema/privacyGuard.js` recursively rejects any fixture, baseline, replay
record, or report that carries a prohibited key (user/device/customer IDs,
tokens, emails, phone numbers, etc.) or a prohibited value shape (JWT-shaped
strings, base64 media data URIs, precise GPS pairs). It **fails closed** -
it never silently strips a field and continues. This guard runs inside
`validateFixture`, `createBaseline`, and `generateReport`, so an unsafe
artifact cannot be produced by the normal code paths, only bypassed by
calling internal functions directly (which the test suite checks against).

## Report validation

`validateReport.js` is **independent of `runner.js`/`generateReport.js`** -
it re-derives its checks from the shared schema/rubric definitions rather
than trusting the report's own "PASS" claims, and re-runs the privacy scan
itself. Run it against any report file:

```bash
node tools/fashion-match-quality/validateReport.js path/to/report.json [path/to/baseline.json]
```

Non-zero exit on: malformed/empty/missing report, a stale rubric version
claim, any `FAIL` control inside the report, a missing required metric
dimension, an out-of-range value, or a privacy violation.

## Experiment workflow (lab-only)

`experiments/variants/*.js` define ranking/filtering variants that are
**never wired into production**. Each is run via
`experiments/runExperiments.js` against the real L1 production ranking as
its baseline, using only development-partition, authoritative-ground-truth
fixtures. Every experiment record states hypothesis, why, variant, baseline,
corpus, result (with sample count + CI + statistical status), confidence,
tradeoff, and a status of `PROMISING` / `REJECTED` / `INCONCLUSIVE` /
`NOT_DECISION_GRADE` - **never `PROMOTABLE`** from synthetic-only evidence
(spec section 28). To add a new experiment: write a variant module exposing
either `rank(products, normalized)` or `suppressDuplicates(rankedProducts)`,
add it to `experiments/runExperiments.js`'s `REGISTRY`, and re-run
`runner.js report`.

## Directory map

```
tools/fashion-match-quality/
  authority/          M0 pipeline + platform-capture mapping (JSON, from source)
  schema/              fixture/report schemas + privacy guard
  fixtures/            deterministic synthetic generator + committed corpus + repo asset inventory
  corpus/               loader, dev/holdout split, corpus/real/ (empty, ready)
  captureProfiles/     iOS/Android capture-profile constants + descriptor-level transform
  contract/            L0 offline self-checks + network-safety checks
  l1/                  Deno subprocess wrapper around the REAL production ranker
  evaluator/           identity axis, substitute axis, fashion-component rubric
  metrics/             corpus-level aggregation/stratification
  duplicates/           conservative duplicate/retailer-neutrality classifier
  statistics/           bootstrap CI, noise floor, comparison classification
  baseline/            immutable baseline read/write/compare + committed/
  replay/               L2 schema + runner (no corpus yet)
  experiments/          lab-only ranking/filter variants + runner
  reports/              report assembly + generated/ output
  runner.js             CLI entry point
  validateReport.js     independent report validator
```
