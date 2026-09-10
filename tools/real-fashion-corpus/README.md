# Real Fashion Match Corpus (V1)

The real-world evaluation corpus for measuring K Scan AI's fashion
identification and match quality against **real garments, real captures, and
independently traceable ground truth**.

This is an R&D/evaluation lane. It changes no production behaviour, makes no
network call, deploys nothing, and spends nothing.

> **CORPUS INFRASTRUCTURE: COMPLETE — REAL COLLECTION: NOT STARTED.**
> **CURRENT VALID REAL CASES: 0.** No camera or physical garments were
> available in the environment this was built in, so `REAL PILOT:
> READY_NO_CAPTURES`. The mechanics are proved end to end with clearly-labelled
> `PIPELINE_TEST_ASSET`s, which the real-corpus validator rejects as real cases
> by design. Zero cases were fabricated to reach a target.

---

## Read this first

- **[docs/BIAS_AND_LIMITATIONS.md](docs/BIAS_AND_LIMITATIONS.md)** — before
  quoting any number from this corpus. All results are INTERNAL ENGINEERING
  EVIDENCE ONLY, and no incumbent/competitor comparison may be drawn from them.
- **[docs/COLLECTION_GUIDE.md](docs/COLLECTION_GUIDE.md)** — if you are here to
  photograph garments. You never edit code to add one.
- **[docs/DESIGN.md](docs/DESIGN.md)** — the design of record and eight decision
  memos.
- **[docs/POWER_CLAIM_MAP.md](docs/POWER_CLAIM_MAP.md)** — what N supports which
  claim, and how the collection target was derived rather than picked.
- **[docs/ANNOTATION_GUIDE.md](docs/ANNOTATION_GUIDE.md)** — objective versus
  subjective labels, and how disagreement is recorded rather than resolved.
- **[docs/BASELINE.md](docs/BASELINE.md)** — the pristine-base evidence captured
  before this lane wrote any code.

---

## The two questions, kept apart

| Axis | Question |
|---|---|
| **Product identity** | Did K Scan find *the actual item*? `EXACT` / `PROBABLE_EXACT` / `UNKNOWN` / `WRONG_IDENTITY` |
| **Fashion substitute** | Is what came back a *commercially useful* alternative? `STRONG` / `ACCEPTABLE` / `WEAK` / `UNUSABLE` |

Both taxonomies come from the **Fashion Match Quality Lab**
(`tools/fashion-match-quality/`, merged as PR #314), which remains the scoring
authority. This lane supplies the corpus and the integrity controls; it does not
implement a second scoring system.

---

## Garments and cases

A **garment** is one physical product identity. A **case** is one capture of it.
They are separate record types in separate directories, so ground truth is
stored once per product and a case count can never be misreported as a product
count.

```
corpus/garments/G001.json    the product: identity, ground truth, evidence chain
corpus/cases/C0001.json      an iPhone capture of G001
corpus/cases/C0002.json      an Android capture of G001   <- paired with C0001
corpus/holdout/              SEALED. Not read by any default code path.
```

---

## Ground-truth grades

| Grade | Requires | Identity-eligible |
|---|---|---|
| `IDENTIFIER_GRADE` | non-model evidence + a durable identifier (style code or GTIN) + brand + product name | **yes**, if colourway-level truth is also present |
| `PARTIAL` | non-model evidence + a brand, no durable identifier | no |
| `VISUAL_ONLY` | human visual annotation, insufficient identifier evidence | no |

**The grade is derived, never declared.** A collector's `asserted_grade` is a
claim, checked against the evidence actually recorded; a mismatch in either
direction is a validation error, so grade inflation cannot survive as a typo.

**Identity metrics use only identity-eligible cases.** Counting a case that
*cannot* be got right as one that was got wrong would make the denominator a
lie, so ineligible cases are reported as suppressed rather than folded in.

### The absolute ground-truth rule

The model being evaluated may never create its own truth. K Scan results,
Gemini/Llama output, LLM-generated SKUs and model-inferred brands are refused
by the schema, by ingestion, and again by the independent validator — three
independent refusals, because one check is one point of failure.

`UNKNOWN` is a valid, first-class answer. Nothing forces a value.

---

## The workflow

```
CAPTURE -> ENTER METADATA -> VALIDATE -> INGEST -> QC -> READY
```

```bash
node tools/real-fashion-corpus/cli.js template          # blank templates
node tools/real-fashion-corpus/cli.js inspect-asset F   # readable? location data?
node tools/real-fashion-corpus/cli.js sanitize-asset F  # strip location, keep orientation
node tools/real-fashion-corpus/cli.js validate --garments F --cases F
node tools/real-fashion-corpus/cli.js ingest   --garments F --cases F
node tools/real-fashion-corpus/cli.js qc
node tools/real-fashion-corpus/cli.js queue             # state + gap list
node tools/real-fashion-corpus/cli.js distribution-report  # V2 quality/imbalance report, as JSON
```

The guide is **tested**: `cli.js dry-run` walks every stage above and fails if
an instruction has stopped working (mission section 43).

---

## Evaluation

```bash
node tools/real-fashion-corpus/cli.js compile           # cases -> FMQL fixtures
node tools/real-fashion-corpus/cli.js evaluate --mode REAL_DEVELOPMENT
node tools/real-fashion-corpus/cli.js evaluate --mode PAIRED_DEVICE
node tools/real-fashion-corpus/cli.js validate-corpus --report reports/<file>.json
```

Modes: `SYNTHETIC` (FMQL's own `runner.js report` — not this lane),
`REAL_DEVELOPMENT`, `REAL_HOLDOUT`, `PAIRED_DEVICE`.

Every evaluation artifact binds seven identifiers, so no artifact can be
compared against a corpus that has moved: `sourceSha`, `corpusVersion`,
`corpusHash`, `evaluatorVersion`, `holdoutStatus`, `groundTruthGradeRules`,
`captureProfileVersion`. Filenames carry the content hash, so a report never
silently overwrites another.

### Live execution

`AUTHORIZED_LIVE_EVALUATION_SPEND_USD: 0`. No paid provider call is made.
`REAL MODEL EXECUTION: BLOCKED_PROVIDER_AUTHORIZATION` — a governance state, not
a corpus failure. The replay seam (`corpus/replay/`) exists so that a future
authorized live run can be captured once and scored offline repeatedly.

---

## The holdout is sealed

Three independent conditions, **all** required:

1. **Physical separation** — holdout cases live in `corpus/holdout/`; the
   default loader reads `corpus/cases/` and no code path reaches the other.
2. **Explicit invocation** — a `reason`, an `invokedBy`, and
   `KSCAN_RFC_HOLDOUT_UNSEAL=I_UNDERSTAND_THIS_IS_RECORDED`. Nothing in this
   repository sets that variable, and a test asserts it.
3. **Recorded invocation** — written to `corpus/HOLDOUT_INVOCATION_LOG.jsonl`
   *before* the cases are returned. A failed audit write aborts the unseal: the
   log is a precondition of access, not a side effect of it.

```bash
node tools/real-fashion-corpus/cli.js holdout-status
```

Partition is anchored on the **garment**, not the case, so every capture of one
product lands on the same side. Otherwise a development twin would leak its
holdout sibling's answer, since both resolve to one ground-truth record.

This is a **DEVELOPMENT / HOLDOUT EVALUATION SET**. It is not a training set and
no model training is authorized.

---

## Asset storage

Metadata and SHA-256 hashes are version controlled. **Image bytes are not.**

Git LFS is installed on the machine but not governed in this repository
(`git lfs ls-files` is empty, `.gitattributes` has no `filter=lfs` entry), so
adopting it here would be an unauthorized, hard-to-reverse repository-weight
decision on a public repo. Bytes therefore live in a locally mounted asset root:

```bash
export KSCAN_RFC_ASSET_ROOT=/path/to/corpus-photos
# or drop files in corpus/assets-mount/  (git-ignored)
```

A missing mount is `ASSETS_NOT_MOUNTED` — a legible state, not a crash. Every
metadata-only operation works on a checkout with no bytes at all, which is the
state most readers are in. See design DM-01.

---

## Privacy

Location metadata is **rejected, not silently stripped** — quietly rewriting a
collector's capture behind their back is not something the corpus should do.
Three carriers are checked, because stripping only the obvious one is how
location survives sanitization in practice: the EXIF GPS IFD, XMP
(`exif:GPSLatitude`, `photoshop:City`), and IPTC-IIM city/country.

`sanitize-asset` rebuilds a clean file rather than editing in place — a rebuilt
block cannot smuggle a field we failed to notice — and deliberately preserves
the orientation flag so a portrait photo does not come back sideways.

The corpus never creates biometric annotations and never infers sensitive
attributes. Those fields are refused by the schema.

---

## Tests

```bash
node tools/real-fashion-corpus/run-tests.js
```

Five suites. The invariant suite names each of mission section 42's fifteen
required invariants by number, and every important control is **mutation
tested** — deliberately defeated, with the suite asserting something downstream
catches it. A control nobody has tried to break is a control nobody knows works.

The Fashion Match Quality Lab's own suite must stay green and unmodified:

```bash
node --test $(find tools/fashion-match-quality -name '*.test.js' | sort)
```

---

## What this corpus is not

It is an engineering benchmark, not a sample of production traffic. Results are
**INTERNAL ENGINEERING EVIDENCE ONLY** — not production accuracy, not
population-representative, not a marketing, App Store or investor claim, and
never a comparison against any incumbent or competitor. The independent
validator fails any report that alters that status line.
