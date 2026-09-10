# Real Fashion Match Corpus V1 — design authority

This document is the corpus design of record. It states what a case is, how
ground truth is graded, what may and may not enter the corpus, and the
decision memos behind every genuinely ambiguous choice.

The corpus measures **K Scan against real garments**. The measurement
machinery itself is *not* redesigned here — the Fashion Match Quality Lab
(`tools/fashion-match-quality/`, merged as PR #314) remains the scoring
authority. This lane supplies the corpus, the ground truth, and the
integrity controls around them.

---

## 1. The two questions, kept apart

| Axis | Question | Owned by |
|---|---|---|
| **Product identity** | Did K Scan find *the actual item*? | FMQL `evaluator/identityAxis.js` — levels `EXACT` / `PROBABLE_EXACT` / `UNKNOWN` / `WRONG_IDENTITY` |
| **Fashion substitute** | If not the actual item, is what came back a *commercially useful* alternative? | FMQL `evaluator/substituteAxis.js` — levels `STRONG_SUBSTITUTE` / `ACCEPTABLE_SUBSTITUTE` / `WEAK_SUBSTITUTE` / `UNUSABLE` |

These are never collapsed into one number. Both taxonomies are reused
verbatim from FMQL (mission section 33); this lane adds no competing
vocabulary.

## 2. Case definition (mission section 7) — CONFIRMED

> A **case** is one real captured fashion query plus its ground-truth record.
> A **garment** is one physical product identity.
> One garment may carry many cases. Cases are separate evaluation inputs.

This is enforced structurally, not by convention: garments and cases are
**separate record types in separate directories**.

```
corpus/garments/G001.json      product identity + ground truth + evidence chain
corpus/cases/C0001.json        one capture of G001 (iPhone)
corpus/cases/C0002.json        one capture of G001 (Android)   -> paired with C0001
corpus/cases/C0003.json        one capture of G001 (dim light)
```

Consequences that fall out of the split, all of them wanted:

- **Ground truth is stored once per garment.** Re-verifying a product cannot
  drift between three copies of the same fact (mission section 36).
- **Denominators cannot be silently inflated.** "3 cases" is never reported
  as "3 products". Every metric states both counts.
- **Paired-device analysis is a case-level relation** over one garment-level
  identity, which is exactly what mission section 15 asks to isolate.

## 3. Ground-truth grades (mission section 6)

Every **garment** carries exactly one grade. Cases inherit their garment's
grade; a case never has an independent grade.

| Grade | Means | Requires |
|---|---|---|
| `IDENTIFIER_GRADE` | Reliable manufacturer/product identifier chain | ≥1 non-model evidence record **and** ≥1 durable identifier (`styleCode` or `gtin`) **and** brand **and** productName |
| `PARTIAL` | Reliable brand/product attributes, no complete identifier chain | ≥1 non-model evidence record and a brand, but no durable identifier |
| `VISUAL_ONLY` | Human visual annotation, insufficient product-identifier evidence | anything less |

The grade is **derived, never declared.** `lib/groundTruth.js#deriveGrade()`
computes it from the evidence actually present. An operator may *assert* an
expected grade in the intake template; ingestion compares the asserted grade
against the derived grade and rejects the row on mismatch. This makes
grade inflation a validation error rather than a typo that silently survives.

### Identity eligibility — the denominator rule

Mission section 6: *"Never calculate an exact-product accuracy denominator
using fixtures incapable of establishing exact identity."*

```
identityEligible(garment) ==
      grade === 'IDENTIFIER_GRADE'
  &&  colorwayLevel === true            // colorwayName or colorwayCode present
  &&  hasDurableIdentifier(garment)     // styleCode or gtin
  &&  evidence chain is non-empty and contains zero model-derived records
```

`PARTIAL` and `VISUAL_ONLY` garments — and their cases — are **excluded from
the identity denominator entirely**. They still participate fully in
substitute-quality metrics, because "is this a useful thing to buy instead"
does not require knowing the exact SKU.

Every emitted metric carries `denominatorBasis` naming which rule produced
its N. Invariant test 42.3/42.4 proves an ineligible case cannot reach an
identity metric even when a caller tries to force it.

## 4. Absolute ground-truth rule (mission section 5)

Ground truth may **only** come from traceable non-model evidence:

```
MANUFACTURER_TAG          MANUFACTURER_PRODUCT_PAGE   RETAILER_PDP
GTIN_UPC_EAN              MANUFACTURER_STYLE_CODE     PURCHASE_RECORD
DIRECT_OWNER_KNOWLEDGE    OTHER_VERIFIABLE_PRODUCT_EVIDENCE
```

These are **forbidden** and rejected by the schema, by ingestion, and again
by the independent validator:

```
KSCAN_RESULT   GEMINI_OUTPUT   LLAMA_OUTPUT   LLM_GENERATED_SKU
LLM_INFERRED_BRAND            LLM_INFERRED_MODEL      MODEL_DERIVED_LABEL
SCANNER_OUTPUT                AI_GENERATED
```

The model being evaluated may never create its own truth. `UNKNOWN` is a
valid, honest answer; the schema has a first-class way to say it
(`VISUAL_ONLY` grade, absent identifiers) and nothing forces a value.

## 5. Corpus tiers and the synthetic firewall

| Tier | Meaning | May count toward corpus N |
|---|---|---|
| `REAL_CAPTURE` | A real photograph of a real garment | **yes** |
| `PIPELINE_TEST_ASSET` | Procedurally generated bytes, exists only to test the plumbing | **never** |

Mission section 26 is absolute. `PIPELINE_TEST_ASSET` records:

- live only under `testAssets/` and `tests/` paths;
- are rejected outright by the real-corpus validator (invariant 42.1);
- never enter `corpus/cases/` or `corpus/holdout/`;
- never appear in a real metric denominator.

FMQL's own tier vocabulary (`SYNTHETIC` / `APPROVED_REAL`) is preserved on
compilation: a real case compiles to an `APPROVED_REAL` FMQL fixture; a
pipeline-test asset never compiles at all.

---

# Decision memos

## DM-01 — Real asset storage model

**QUESTION.** Where do real phone-resolution garment photographs live, given
mission section 18's warning not to let the first 100 images become a
permanent repository-weight decision by accident?

**EVIDENCE.**
- `git lfs version` → `git-lfs/3.7.1` is *installed on the machine*.
- `git lfs ls-files` → **empty**. `.gitattributes` contains no `filter=lfs`
  entry; it only sets `eol` and `binary` attributes. **LFS is therefore not
  governed in this repository** — it has never stored a single object here.
- `.gitignore` already ignores root-level `/*.png` and `/*.jpg`, and already
  contains a precedent for exactly this problem at
  `vto-phase4-pipeline/.corpus-cache/` — *"transient Commerce corpus cache —
  holds real image URLs, never committed"*.
- The repository is **public** (recorded in a prior session's launch security
  audit). Real captures may show a collector's home interior.

**OPTIONS.**
1. Commit images directly to git history. — Permanent, unbounded repo growth
   on a public repo; irreversible without history rewriting.
2. Adopt Git LFS. — Introduces a repo-wide, hard-to-reverse infrastructure
   dependency that no one has authorized, on a repo that has never used it.
   Mission section 18 permits LFS only "if already governed"; it is not.
3. Provision new cloud storage. — Explicitly forbidden without authorization.
4. **Metadata + hashes in git; image bytes in an owner-mounted external
   corpus directory, validated by manifest hash.**

**SAFE DEFAULT — option 4.** This is the fallback mission section 18 names
verbatim: *"support locally mounted assets validated by manifest hash."*

- Version-controlled: every case record, its `asset.sha256`, `asset.byteSize`,
  container format, captured/processed/uploaded dimensions, and the
  EXIF-sanitization attestation.
- **Not** version-controlled: the image bytes.
- The mount root is resolved from `KSCAN_RFC_ASSET_ROOT`, falling back to
  `corpus/assets-mount/` inside this directory, which `.gitignore` blocks.
- `lib/assetStore.js` verifies each present asset against its recorded
  `sha256`. A missing mount is `ASSETS_NOT_MOUNTED` — a legible state, not a
  crash, so metadata-only work (validation, queue, gap list, power map)
  works on any checkout with no assets at all.
- A committed-bytes guard test fails if any real image file is ever staged
  under the corpus tree.

**RISK.** Bytes live outside version control, so an unmounted checkout cannot
re-verify pixels — only the recorded hash. Accepted: the hash is the
integrity claim, and losing the mount is loud (`ASSETS_NOT_MOUNTED`), not
silent.

**REVERSIBILITY.** High. If an owner later authorizes LFS or approved fixture
storage, the manifest already carries every hash needed to relocate bytes and
re-verify them. Nothing about the case schema changes.

---

## DM-02 — Where compiled real fixtures live (avoiding silent tier mixing)

**QUESTION.** FMQL's `corpus/corpusLoader.js#loadFullCorpus()` already merges
`tools/fashion-match-quality/corpus/real/*.json` into the corpus that
`runner.js report` evaluates. Should this lane write compiled real fixtures
into that directory?

**EVIDENCE.** `loadFullCorpus()` is `[...loadSyntheticCorpus(), ...loadApprovedRealCorpus()]`
with no tier gate. The FMQL README documents the drop-in seam as intended:
*"To add a real fixture later: drop a validated JSON file under
`corpus/real/*.json` … No code changes are required."* But the committed
FMQL baseline (`baseline/committed/synthetic-v1.baseline.json`) binds a
`fixtureManifestHash` over the synthetic corpus, and mission invariant 42.14
requires that *synthetic and real evidence cannot be mixed silently*.

**OPTIONS.**
1. Write compiled real fixtures into `fashion-match-quality/corpus/real/`. —
   Uses the intended seam, but the very next `runner.js report` would blend
   real and synthetic into one distribution with no tier declaration at the
   metric level, and would invalidate the committed synthetic baseline.
2. Fork the evaluator. — Forbidden by mission section 28.
3. **Keep compiled fixtures in this lane's tree, partitioned on disk, and
   drive them through FMQL's own `evaluateCorpus` / `aggregateMetrics` /
   rubric.**

**SAFE DEFAULT — option 3.** Real cases compile to FMQL-schema-valid
`APPROVED_REAL` fixtures written under
`corpus/compiled/{development,holdout}/`. Evaluation calls straight into
FMQL's `evaluator/evaluate.js` and `metrics/aggregate.js`. There is exactly
one scoring system; this lane supplies inputs to it and never re-implements
it. FMQL's `corpus/real/` stays empty, so the synthetic default report and
its committed baseline remain exactly what they were.

Additionally — and additively, touching no FMQL file — the independent
validator **fails any report whose `countByTier` contains both `SYNTHETIC`
and `APPROVED_REAL` without an explicit `mixedTierDeclaration`**. That closes
the pre-existing silent-blend seam for reports produced by anyone, which is
what invariant 42.14 actually asks for.

**RISK.** Two corpus directories exist (`fashion-match-quality/corpus/real/`,
empty and inherited; `real-fashion-corpus/corpus/compiled/`, live). Mitigated
by a test asserting the FMQL directory stays empty *and* by documenting the
seam here and in the README.

**REVERSIBILITY.** High — compiled fixtures are FMQL-schema-valid on disk, so
adopting option 1 later is a file move plus a baseline rebuild.

---

## DM-03 — How the holdout is mechanically sealed

**QUESTION.** Mission section 21 requires holdout results to be unavailable to
default development evaluation, CI, and routine sweeps, with every invocation
recorded. FMQL's `splitDevelopmentHoldout()` is a deterministic *hash split*
of one in-memory array — the holdout fixtures are still returned to the
caller. What is "mechanically sealed"?

**EVIDENCE.** A hash split prevents *accidental reassignment*; it does not
prevent *accidental reading*. Any caller holding the array can score the
holdout partition and learn from it. Mission section 21's threat model is
explicitly "a routine test run must not leak holdout failures into everyday
engineering knowledge."

**OPTIONS.**
1. Rely on the hash split alone. — Fails the stated requirement.
2. Encrypt the holdout. — Key management with no owner-provided key; also
   defeats the goal that the holdout stays reviewable by a human collector.
3. **Physical partition on disk + a deliberately awkward, audited unseal.**

**SAFE DEFAULT — option 3.** Three independent conditions, all required:

1. **Physical separation.** Holdout cases live in `corpus/holdout/`. The
   default loader reads `corpus/cases/` and never touches `corpus/holdout/`.
   There is no code path in which an ordinary load returns a holdout case.
2. **Explicit invocation.** `lib/holdout.js#openHoldout()` throws
   `HOLDOUT_SEALED` unless the caller passes a non-empty `reason` and
   `invokedBy`, **and** the environment carries
   `KSCAN_RFC_HOLDOUT_UNSEAL=I_UNDERSTAND_THIS_IS_RECORDED`. The env var is
   never set by any test, script, or CI job in this repository.
3. **Recorded invocation.** Every successful unseal appends a JSONL audit
   record (`unsealedAt`, `reason`, `invokedBy`, `caseCount`, `corpusVersion`)
   to `corpus/HOLDOUT_INVOCATION_LOG.jsonl`. Failing to write the audit record
   aborts the unseal — the log is a precondition of access, not a side effect.

Holdout assignment itself stays deterministic and pair-aware, reusing FMQL's
approach (SHA-256 of the *garment* id, so **all cases of one garment land in
the same partition** — a paired iOS/Android capture can never be split, and
neither can two captures of the same physical product, which would otherwise
leak the holdout answer through its development-partition twin).

**RISK.** An operator who genuinely needs holdout results must do three
deliberate things. That is the point. Documented in the README.

**REVERSIBILITY.** High — partition membership is a recorded field, recomputable.

---

## DM-04 — What "readable" and "corrupt" mean without an image-decode dependency

**QUESTION.** Mission section 27 requires QC to make it impossible to silently
accept an unreadable or corrupt asset. Full pixel decode would mean adding an
image library to a repository that has not authorized one.

**EVIDENCE.** The QC obligation is *integrity of the corpus*, not image
quality assessment. The failure modes that actually matter — truncated
upload, zero-byte file, wrong extension, HTML error page saved as `.jpg`,
silently re-encoded file — are all detectable from container structure and
the recorded hash.

**OPTIONS.**
1. Add an image-decoding dependency. — Unauthorized, and heavier than needed.
2. Check the file extension only. — Detects essentially nothing.
3. **Validate container structure in pure Node, and treat the recorded
   SHA-256 as the byte-level integrity claim.**

**SAFE DEFAULT — option 3.** `lib/imageIntegrity.js` parses, with zero
dependencies:

- **JPEG** — `SOI` marker, a walk of every segment header to a terminating
  `EOI`, rejecting truncation and unknown-marker garbage; extracts real
  pixel dimensions from the `SOFn` frame header.
- **PNG** — the 8-byte signature, a full chunk walk with **per-chunk CRC-32
  verification**, a required `IHDR` first and `IEND` last; extracts real
  dimensions from `IHDR`.

A CRC-32 failure on a PNG chunk is genuine bit-rot detection, not a guess.
Combined with the recorded `sha256`, this catches every failure mode listed
above. What it deliberately does **not** do is judge whether a photograph is
blurry, badly lit, or of the wrong garment — that is a human QC judgment
recorded by the collector, and the corpus says so rather than pretending.

**RISK.** A structurally valid file containing meaningless pixels would pass
structural QC. Mitigated: a human collector must attest capture quality, and
that attestation is a recorded, auditable field.

**REVERSIBILITY.** High — a decode step can be added behind the same
`inspectImage()` interface later.

---

## DM-05 — Collection template format

**QUESTION.** Mission section 23 requires a fillable metadata template usable
by a non-engineer, with row-level validation and no source-code edits to add
a garment.

**OPTIONS.** CSV / TSV / YAML / JSON / a bespoke form.

**SAFE DEFAULT — CSV.** It opens in Excel, Numbers, and Google Sheets, which
is where a non-engineer collecting garments in a store actually is; it is
row-oriented, so "row 7, column `gtin`" is a natural error address; and it
diffs legibly in git. JSON and YAML both fail the phone/spreadsheet test and
turn a missing comma into a whole-file parse failure rather than one bad row.

The parser is written here (`lib/intakeCsv.js`) rather than pulled in: it
handles RFC-4180 quoting, embedded commas/newlines, **and a UTF-8 BOM**,
which Excel writes by default on Windows and which would otherwise corrupt
the first column header. It also tolerates CRLF, which is what a Windows
collector's spreadsheet will produce — a prior lane in this repository was
bitten by exactly this CRLF-vs-manifest trap.

Errors are row-scoped and actionable: every error carries a 1-based sheet row
number, the column name, the offending value, and what was expected.

**RISK.** CSV has no types; everything arrives as a string. Mitigated by an
explicit coercion + validation layer with per-column expectations.

**REVERSIBILITY.** High — the intake parser is one module behind
`parseIntake()`; a second format can be added beside it.

---

## DM-06 — Canonical Product Identity compatibility without importing that lane

**QUESTION.** Mission section 30 requires ground-truth semantics conceptually
compatible with `STYLE → VARIANT → RETAIL OFFER`, while forbidding any
dependency on the unmerged Canonical Product Identity research branch.

**EVIDENCE.** `research/canonical-product-identity-lab-v1` is a live sibling
lane under this lane's firewall. Nothing from it may enter this history, and
requiring canonical IDs from an unmerged lane would make this corpus
un-loadable until that lane merges.

**SAFE DEFAULT.** Shape-align, do not depend. The garment record separates the
three levels the canonical model uses, under this lane's own field names:

| Canonical level | This corpus | Fields |
|---|---|---|
| **STYLE** | `groundTruth.identity.style` | `brand`, `productName`, `styleCode` |
| **VARIANT** | `groundTruth.identity.variant` | `colorwayName`, `colorwayCode`, `gtin`, `size` |
| **RETAIL OFFER** | `groundTruth.evidence[]` | `retailer`, `urlPointer`, `verifiedOn`, `observedFacts` |

A future join is then a field mapping, not a schema rewrite. `canonicalJoin`
is reserved as an **optional, never-required** field so an owner can later
stamp canonical IDs in without a migration. No import, no branch reference,
no canonical ID is required for a case to be valid today.

**RISK.** The eventual canonical model may split these differently. Mitigated
by keeping the three levels separated rather than flattened — merging levels
later is easy, splitting a flattened record is not.

**REVERSIBILITY.** High.

---

## DM-07 — Corpus version, and what an evaluation artifact binds to

**QUESTION.** Mission section 37 requires every real-corpus evaluation artifact
to bind seven identifiers with no silent overwrite. Section 36 requires
ground truth to be correctable without silently rewriting history.

**SAFE DEFAULT.** `corpus/corpus.json` carries `corpusVersion` (semver) and
the four policy versions. Every evaluation artifact binds:

| Bound field | Source |
|---|---|
| `sourceSha` | `git rev-parse HEAD` |
| `corpusVersion` | `corpus/corpus.json` |
| `corpusHash` | canonical hash over every garment + case record |
| `evaluatorVersion` | FMQL `RUBRIC_VERSION` + `fixtureSchema.SCHEMA_VERSION` |
| `holdoutStatus` | `SEALED` / `UNSEALED_EXPLICIT` |
| `groundTruthGradeRules` | `groundTruth.js` `GRADE_RULES_VERSION` |
| `captureProfileVersion` | FMQL capture-profile ids |

Corrections are **append-only**: a garment carries a `revisions[]` array, each
entry recording `revisedOn`, `reason`, `changedFields`, and the superseded
values. A dead retailer URL alone never invalidates an identifier-grade
garment (mission sections 19/36) — the URL is supplementary; the recorded
`observedFacts` are the evidence. No arbitrary expiry window is invented.

**RISK.** Corpus hash changes on every correction, so old artifacts do not
compare to new ones. That is correct behaviour, and `assertComparable()`
refuses the comparison loudly rather than producing a misleading delta.

**REVERSIBILITY.** N/A — append-only by construction.

---

## DM-08 — One intake sheet or two

**QUESTION.** Cases outnumber garments (mission section 7's whole point is that
one garment yields several captures). Should the collection template be one
wide sheet with garment columns repeated on every capture row, or two sheets?

**EVIDENCE.** A single sheet means the same brand / style code / colourway is
typed three times for a garment with three captures. Three copies of a fact is
three chances to disagree, and the disagreement is silent — whichever row was
read last wins.

**OPTIONS.**
1. One wide sheet, garment columns repeated per row. — Invites contradiction.
2. One sheet with garment columns blank after the first row for a garment. —
   Fragile: a sort or a filter in Excel destroys the row ordering the
   inheritance depends on, silently.
3. **Two sheets: `collection-template-garments.csv` and
   `collection-template-cases.csv`.**

**SAFE DEFAULT — option 3.** It mirrors the record split exactly, so ground
truth is typed once per product; each sheet is narrower and therefore easier
to fill on a laptop in a shop; and there is no ordering dependency for a
spreadsheet sort to break.

Both templates are **generated from the column definitions in
`lib/intake.js`** and a test asserts the checked-in files still match. A
template that has drifted from its validator is worse than no template: it
teaches a collector to fill in a column that will be rejected.

**RISK.** A collector must keep two files. Mitigated by the collection guide
walking both, and by ingestion reporting an unmatched `garment_id` as a
row-level error naming the missing garment.

**REVERSIBILITY.** High — a combined-sheet reader could be added beside
`parseIntake()` without touching the record schemas.

---

---

# V2 addendum (Build 35 Workstream 02 — Real Fashion Match Corpus V2)

This section documents the design decisions made when upgrading the V1 corpus
above to carry ontology-backed ground truth, garment-level spatial
annotations, and an explicit failure/match-truth vocabulary, in preparation
for future FashionCLIP and segmentation experiments (neither of which is
begun here — see `tests/segmentationReadiness.test.js`'s own no-provider-call
proof). Everything in sections 1-6 above stays true; nothing here supersedes
it.

## DM-09 — Ontology integration point

**QUESTION.** How does `tools/fashion-ontology/`'s accepted
`CanonicalFashionAttributesV1` contract (Build 35 Workstream 01, PR #399)
enter this corpus without this lane forking or re-implementing it?

**SAFE DEFAULT.** One new, narrow module, `lib/ontology.js`, is the *only*
place this lane touches the ontology package. It derives a garment's
`ontology` block from fields the corpus already collects
(`category`, `attributes.*`) — a collector enters nothing new to get ontology
coverage. The block is the ontology package's own record shape verbatim
(`{value, raw}`, `{value, family, raw}` for colors), so raw evidence
(`"high-top sneaker"`) and the canonical, coarser value (`"sneaker"`) are both
preserved, never one discarding the other. `garment.ontology` is a **required**
field (auto-computed, zero collector burden); it is validated both for shape
(the ontology package's own validator) and for taxonomy membership
(`isKnownCanonicalValue`/`isKnownCanonicalColor` in `lib/ontology.js`, which
exist specifically so a corrupted-but-shaped-correctly value cannot pass —
see the ontology negative control below).

## DM-10 — Three questions, still kept apart, now four

Section 1 above already separates **product identity** from **fashion
substitute**. V2 adds two more axes that must not collapse into either:

| Axis | Question | Owned by |
|---|---|---|
| **Fashion truth** (ontology) | What canonical category/subtype/color/material/pattern/silhouette *is this garment*? | `tools/fashion-ontology/` via `lib/ontology.js` |
| **Product identity truth** | Did K Scan find *the actual item*? | FMQL `identityAxis.js` (unchanged) |
| **Fashion substitute** | Is a non-exact result a *useful* alternative? | FMQL `substituteAxis.js` (unchanged) |
| **Match truth** (new) | A single closed-vocabulary summary of a scored pair, for reporting | `lib/matchTruth.js` |

`lib/matchTruth.js`'s `MATCH_TRUTH_LEVELS` (`EXACT_PRODUCT` /
`EXACT_VARIANT` / `SAME_STYLE_DIFFERENT_VARIANT` / `USEFUL_SUBSTITUTE` /
`WEAK_SUBSTITUTE` / `INCORRECT`) is a **derived, reporting-layer** vocabulary,
computed deterministically from the two FMQL axes
(`classifyMatchTruth({identityLevel, substituteLevel})`). It is not a third
scorer: `lib/evaluate.js` calls FMQL's evaluator for both axes exactly as
before and only *afterward* folds the pair into one match-truth bucket for
`metrics.matchTruth`. FMQ remains the sole scoring authority (mission section
28); this lane still supplies inputs and now also a summary view over FMQL's
own outputs, never a competing judgment.

## DM-11 — Provenance vocabulary: extend, do not fork

**QUESTION.** Should image/data provenance use a new
`SYNTHETIC`/`INTERNAL_RIGHTS_CLEARED`/`LICENSED_PUBLIC` vocabulary?

**EVIDENCE.** That vocabulary does not exist anywhere in this codebase.
This corpus already has an established, tested provenance model: the
`ASSET_TIER_REAL`/`ASSET_TIER_PIPELINE_TEST` firewall (section 5 above),
`GROUND_TRUTH_GRADES` (`IDENTIFIER_GRADE`/`PARTIAL`/`VISUAL_ONLY`), and the
closed `ALLOWED_EVIDENCE_TYPES`/`FORBIDDEN_EVIDENCE_TYPES` lists (section 4).
Introducing a second, unrelated provenance vocabulary alongside an existing,
mutation-tested one would give two ways to answer "where did this come from"
that could silently disagree.

**SAFE DEFAULT.** V2 introduces no new provenance vocabulary. Every V2
addition (`ontology`, spatial annotations, `failureTaxonomy`, `matchTruth`)
is additional *structure* layered on records that still carry the existing
tier/grade/evidence-type provenance model unchanged.

## DM-12 — Initial V2 corpus population

**QUESTION.** Populate the V2 corpus with real cases now, targeting the
spec's "≥100 cases, only if realistic"?

**EVIDENCE.** `corpus/garments/` and `corpus/cases/` hold zero records (by
design — see `corpus.json`'s `corpusStatus:
"INFRASTRUCTURE_COMPLETE_COLLECTION_IN_PROGRESS"` and `currentCounts:
{validRealCases: 0, garments: 0}`, both true before this workstream and
unchanged by it). No real photography or approved real assets exist on this
checkout to compile into cases. Fabricating cases to hit a number is
forbidden absolutely (mission section 26; `BIAS_AND_LIMITATIONS.md`).

**DECISION.** Report the honest count: **0 real V2 cases**, matching the
corpus's own pre-existing honest state. All V2 machinery (ontology
attachment, spatial annotations, failure taxonomy, match truth, the
distribution report, on-disk validation) is instead proven with the same
kind of schema/fixture-based tests already used throughout
`tests/invariants.test.js` — exercising real production code paths
(`buildGarmentOntology`, `validateCorpusOnDisk`, `compileCase`,
`runEvaluation`) against constructed records, never against invented
"real-looking" corpus entries. `docs/POWER_CLAIM_MAP.md`'s existing
"0 today" evidence line already covers this; V2 adds no new claim about N.

**RISK.** None of the distribution-report imbalance flagging or FMQ
ingestion has been exercised against real-world data distribution — only
against synthetic fixtures. Accepted: the alternative is fabricating the
distribution it would report on, which is the one thing this lab exists to
refuse.

**REVERSIBILITY.** N/A — population is additive; nothing here blocks real
collection from starting on this schema at any time.

## 7. Directory map

```
tools/real-fashion-corpus/
  README.md                  operator guide + workflow
  cli.js                     the operator CLI (validate/ingest/qc/queue/gaps/evaluate/...)
  docs/
    BASELINE.md              pristine-base evidence (mission section 2)
    DESIGN.md                this file
    POWER_CLAIM_MAP.md       what N supports which claim (mission section 8)
    COLLECTION_GUIDE.md      step-by-step human workflow (sections 23/43)
    ANNOTATION_GUIDE.md      subjective-label guidance (section 34)
    BIAS_AND_LIMITATIONS.md  corpus bias + internal-only clause (sections 11/39)
  corpus/
    corpus.json              corpus version + policy versions
    garments/                garment records (product identity + ground truth)
    cases/                   DEVELOPMENT partition case records
    holdout/                 SEALED holdout case records
    compiled/                FMQL-shaped fixtures, partitioned
    HOLDOUT_INVOCATION_LOG.jsonl
    assets-mount/            gitignored; local mount point for real image bytes
  intake/
    collection-template.csv  the fillable template
    inbox/                   operator drops filled CSVs here
  lib/                       schemas, grading, EXIF, QC, ingest, holdout, validator, ...
  lib/ontology.js            V2: the sole integration point with tools/fashion-ontology/
  lib/matchTruth.js          V2: derived EXACT_PRODUCT..INCORRECT reporting vocabulary
  lib/distributionReport.js  V2: deterministic quality/imbalance report
  testAssets/                PIPELINE_TEST_ASSET generator (never real corpus)
  tests/                     the mission section 42 invariant suite
```
