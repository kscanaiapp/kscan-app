# VTO Phase 4.2 — Hostile Audit Defect Ledger

Adversarial verification of the Phase 4.2 candidate (PR #303).
Task §47. Every finding below was reproduced before it was repaired, and
every repair carries a negative control that fails if the repair is undone.

## Authority

| Item | Value |
|---|---|
| Audit base (candidate under audit) | `5259148cf4deb7f84f0496f7ab6591cc4195cc90` (PR #303 head) |
| Comparison base (integration) | `4365cebfccfd59843dd3f0a7418c07cb8e9ff843` |
| Audit branch | `audit/vto-phase4-2-hostile-20260905` |
| PR #303 state at audit start | **OPEN, DRAFT, NOT MERGED** — `mergeable: MERGEABLE`, `mergeStateStatus: CLEAN` |
| `PIPELINE_VERSION` | `0.1.0` (`manifestBuilder.ts:20`) |
| `ASSET_CONTRACT_VERSION` | `KSGARMENT_SCHEMA_VERSION = '1.0'` (`garmentContract.ts:15`) |

**§1 precondition.** `git merge-base --is-ancestor 5259148c` returned NOT
ANCESTOR for both `origin/integration/backend-kplus-complimentary-staging-v1`
and `origin/master`. The §1 precondition (Phase 4.2 on integration authority)
was therefore **NOT MET**, and `HOSTILE AUDIT PRECONDITION HOLD` was declared.
The project owner then explicitly directed the audit to proceed against the
PR #303 head directly, with integration as the comparison base. This is
recorded as an owner ruling, not a silent waiver. It is also the reading the
amendments assume: §48 offers a `READY FOR OWNER MERGE` verdict and A16
requires a MERGE SAFETY line, both of which presuppose a pre-merge audit.

---

## P42-A-001 — segmentation significance is measured only against the frame

| | |
|---|---|
| **SEVERITY** | P2 |
| **LOCATION** | `vto-phase4-pipeline/src/segmentation.ts:104`, `src/pipeline.ts:237` |
| **AMENDMENT** | A8 (amends §11/§12) |

**ATTACK.** Walk a second connected component across the
`SIGNIFICANT_COMPONENT_AREA_FRACTION = 0.01` boundary and measure the
segmentation confidence component and final eligibility at each step. Repeat
with a *detached garment part* (same colour as the garment, separated by a
background gap) — the realistic failure, since only the winner component is
written into the emitted mask.

**EXPECTED (A8).** "1 dominant component + 1 meaningful second component
(e.g. detached sleeve, detached strap) MUST still lose confidence or reject."
And: a ceiling such that `significantComponentCount === 1` can never become a
universal pass.

**ACTUAL.** Measured on synthetic fixtures at 600×600:

```
sleeve @ 0.28% frame   sig=1  segScore=0.5962  ELIGIBLE=true   324px dropped from a 48792px asset
sleeve @ 0.89% frame   sig=1  segScore=0.5962  ELIGIBLE=true  1024px dropped
sleeve @ 0.95% frame   sig=1  segScore=0.5962  ELIGIBLE=true  1089px dropped
sleeve @ 2.92% frame   sig=2  segScore=0.5664  ELIGIBLE=true  3364px dropped
+ 3000 background specks  comp=1196  sig=1  segScore=0.5945  ELIGIBLE=true
```

Below the 1%-of-frame cliff a detached garment part cost **exactly zero**
confidence while being silently removed from the emitted asset. No ceiling of
any kind existed: 1196 connected components still scored a full pass.

**ROOT CAUSE.** Significance was measured against the **frame** only. Two
consequences compounded:

1. `fillRatio` cannot compensate, contrary to the claim in the P42-001
   rationale comment ("fillRatio continues to penalize fragmented or sparse
   masks"). `fillRatio = winner.size / (bboxW * bboxH)` where the bbox is
   derived from `winner` alone (`segmentation.ts:56-61,95`), so foreground
   outside the winner's own bounding box cannot move it. Measured: a
   1196-component swing moved `fillRatio` by **0.0017**.
2. Only `winner` enters the mask (`segmentation.ts:73`), so the dropped
   component is dropped from the *product asset*, not merely from a metric.

P42-001 did not create the detached-part hole, but it removed the only signal
that a sub-significant second component existed at all.

**FIX.** `abfb087`. Significance is now measured against the **garment** as
well as the frame (`SIGNIFICANT_COMPONENT_GARMENT_FRACTION = 0.02`), and an
explicit A8 speck-**area** ceiling (`INSIGNIFICANT_FRAGMENT_CEILING = 0.5`)
means `significantComponentCount === 1` no longer implies "one clean thing".
`largestNonWinnerComponentRatio` and `insignificantFragmentRatio` are exported
into `segmentationEvidence`, so the condition is auditable from the manifest.

**Threshold calibration (§19/§26 — derived, not invented).** From the
committed 490-product evidence: EASY sources carry a median non-winner
foreground of **0.0002** (p90 0.019). Compression speckle sits ~1000× below
the garment-relative threshold (one 1px component on a 48,792px garment is
0.00002). The two populations are separated by three orders of magnitude, so
0.02 sits in a wide gap rather than on a knife edge. The ceiling of 0.5 is far
above every measured real value (worst observed speckle load 0.024) and is a
genuine backstop that fires on nothing in the corpus.

**A8's literal "100 specks → reject" was deliberately NOT implemented, and
this is a disclosed disagreement with the amendment.** The real corpus
contains images with 114 and 4487 components whose masks are near-perfect
(`largestComponentRatio` 0.9977). A count-based ceiling low enough to reject
100 specks would reject exactly the images P42-001 exists to rescue. The
mandate ("a ceiling such that significantCount == 1 can never be a universal
pass") is met by the area ceiling plus garment-relative significance; the
illustrative count is not, on measured evidence. Flagged for owner review.

**NEGATIVE CONTROL.** `A8 NEGATIVE CONTROL: P42-001 is preserved` — 1, 100,
1000 and 3000 specks all still yield `significantComponentCount === 1` with a
segmentation score within 0.01 of the clean fixture. If the repair re-broke
the defect it was auditing, this fails.

**TEST.** `vto-phase4-pipeline/__tests__/phase42AuditRepairs.test.ts` —
`A8 REPAIR`, `A8 NEGATIVE CONTROL`, `A8 CALIBRATION`, `A8 CEILING`.

**STATUS.** REPAIRED. **Residual, escalated:** a detached part is now
*counted and recorded* but a product carrying one is still `LIVE2D_ELIGIBLE`
(0.5962 → 0.5664 against a 0.5 threshold). Converting that to a hard rejection
would change the addressability measurement and risks regressing the three
previously-eligible MEDIUM assets, which cannot be re-run (see A6 below). That
is a product policy decision and is left to the owner, not taken unilaterally
by the auditor.

---

## P42-A-002 — the multi-object negative control did not control the repair

| | |
|---|---|
| **SEVERITY** | P3 |
| **LOCATION** | `__tests__/vtoPhase42Repairs.test.ts:133` |

**ATTACK.** Determine *why* the build's `NEGATIVE CONTROL: a genuine
multi-object scene is still penalized / rejected` passes.

**EXPECTED.** It should exercise the segmentation-confidence path that
P42-001 modified.

**ACTUAL.** The fixture is refused by the **shot classifier**, before
segmentation confidence is consulted:

```
rejection stage : classification
rejection code  : MULTIPLE_GARMENTS  ("too_many_disconnected_regions")
```

The test asserts only `eligibility.live2d === false`, so it would still pass
if the segmentation component were hardcoded to `1.0`.

**ROOT CAUSE.** The assertion is on the final verdict, not on the component
under repair, and the fixture never reaches the code in question.

**FIX.** `abfb087`. Added a control that pins the component itself, with an
explicit precondition asserting no stage gate fires (`rejection.stage ===
'none'`) so it cannot silently degrade into the same trap.

**NEGATIVE CONTROL.** The new test asserts the fixture's shot class is
unchanged from the clean fixture — if a future change causes the classifier
to divert it, the test fails loudly instead of passing vacuously.

**TEST.** `P42-A-002: a negative control that actually exercises the
segmentation confidence path`.

**STATUS.** REPAIRED. The original test is left in place; it is a valid
end-to-end assertion, it simply is not a control for P42-001.

---

## P42-A-003 — `EXTRACTION_UNRELIABLE` conflates policy refusal with extraction failure

| | |
|---|---|
| **SEVERITY** | P2 |
| **LOCATION** | `src/pipeline.ts:115` and `src/eligibility.ts:55` |
| **AMENDMENT** | A3 (upgrades §17 to "verify and repair") |

**ATTACK.** Trace every emission site of `EXTRACTION_UNRELIABLE` and
determine, mechanically, whether extraction ran.

**EXPECTED.** A HARD policy refusal (extraction never attempted) must not
present as an extraction-algorithm failure.

**ACTUAL.** Two structurally different paths emitted the same code:

1. `pipeline.ts:112-121` — `classifyExtractionGate` returned `null` for a
   HARD source with a non-uniform background and `skinRatio < 0.06`.
   Extraction **never ran**; `sourceAdequacy: UNKNOWN` is the expected result.
2. `eligibility.ts:53-55` — extraction ran and succeeded, but aggregate
   confidence fell below threshold.

The closeout reports 27 of 29 `EXTRACTION_UNRELIABLE` cases as HARD stage-gate
refusals, i.e. **93% of that bucket is path 1.**

**Concrete downstream cost, not merely cosmetic.**
`correctionTriage.ts:21` classified `EXTRACTION_UNRELIABLE` as
`POTENTIALLY_CORRECTABLE`. All 27 policy refusals were therefore labelled
economically correctable by "minor mask repair / crop adjustment" — work that
cannot fix a decision not to extract.

**ROOT CAUSE.** One code carrying two meanings.
`rejectionAttribution.ts:141` already separated them *internally*
(`STAGE_HARD_NON_UNIFORM_BACKGROUND`), which shows the distinction was known;
it simply never reached the emitted taxonomy.

**FIX.** `abfb087`. Added `EXTRACTION_REFUSED_BY_POLICY`. New runs emit it for
the policy path; `EXTRACTION_UNRELIABLE` now means only what its name says.
Triage moves the policy code to `NOT_ECONOMICALLY_CORRECTABLE`.

**Historical evidence is NOT rewritten**, per A3. The legacy mapping in
`rejectionAttribution` is retained with a comment explaining why, and the §20
breakdown in `addressableSliceCli` accepts both codes so replaying old
evidence and running new runs both work.

**MAPPING NOTE (A3 requirement).** In committed historical evidence
(`evidence/vto-phase4-gate-e/real-cohort-results.jsonl`, and the closeout's
29-case breakdown), `REJECTED:EXTRACTION_UNRELIABLE` covers **both** classes.
Expected split on replay: **27 → `EXTRACTION_REFUSED_BY_POLICY`** (HARD
policy refusals, 2 EASY / 0 MEDIUM / 27 HARD), **2 → `EXTRACTION_UNRELIABLE`**
(the genuine confidence-gate misses, closeout Cases 1 and 2).

**NEGATIVE CONTROL.** `A3 NEGATIVE CONTROL: the confidence-gate route still
reports EXTRACTION_UNRELIABLE` — an attempted extraction that misses
confidence must keep the original code, so the split cannot over-apply.
Verified the repair fixture genuinely hits the policy path: `shotClass=HARD`,
`code=EXTRACTION_REFUSED_BY_POLICY`, `stage=extraction`.

**TEST.** `A3 REPAIR`, `A3 NEGATIVE CONTROL`, `A3: a policy refusal is NOT
triaged as economically correctable`. Note: **no pre-existing test covered
the HARD non-uniform-background refusal path at all** — a coverage gap this
finding also closes.

**STATUS.** REPAIRED.

---

## P42-A-004 — the 490-product corpus is a single visual stratum, reported as a natural feed

| | |
|---|---|
| **SEVERITY** | P2 |
| **LOCATION** | `docs/vto-phase4-2-addressability.md` §4/§5, `src/catalogCharacterizationCli.ts:55` |
| **AMENDMENT** | A7 (amends §21), §20 |

**ATTACK.** Reconcile `strataQueried: 21` against the committed query log;
compute realized yield per stratum.

**EXPECTED.** A stratified corpus, or an explicit statement that it is not.

**ACTUAL.** From `catalog-characterization-query-log.json` (47 requests):

```
VISUAL STRATUM   REQUESTS   HTTP 200   HTTP 429   RECORDS
plain                  30         28          2       536
structured              4          0          4         0
logo                    3          0          3         0
patterned               3          0          3         0
softknit                3          0          3         0
dark                    2          0          2         0
light                   2          0          2         0
```

**Every successful request was a `plain` query.** The other 17 of 21 strata
returned only HTTP 429 and contributed **zero** products. All 490 products
came from four near-identical plain-tee queries. Confirmed independently by
`visualDistribution: { plain: 490 }`.

The doc nevertheless labelled this **"Natural Commerce distribution — what
K Scan actually receives … with no selection applied beyond the standard
stratified garment queries."** Selection *was* applied — by quota.

**Second, confounded claim.** The doc attributed the 4.5% → 10.0%
addressability rise to paging depth alone. Two variables moved together:

| | Phase 4.1 Gate E (220) | Phase 4.2 (490) |
|---|---|---|
| paging depth | 1 page/stratum | up to 12 pages |
| realized strata | **all 7** (plain 44, logo 33, patterned 33, structured 40, softknit 30, dark 20, light 20) | **`plain` only** |
| addressable | 4.5% | 10.0% |

Plain tees are the class most likely to be shot flat-lay/product-only —
exactly what inflates EASY/MEDIUM. Depth and composition cannot be separated
from this evidence. The runner's own comment ("Identical stratum list … so the
two corpora remain comparable") asserted a comparability that does not hold.

**ROOT CAUSE.** The rate limit truncated the run mid-stratum-sweep, and the
reporting layer described the *design* (21 strata) rather than the *realized*
draw (1 stratum).

**FIX.** `f61a575`. Added §5.1 with the per-stratum request/status/yield
table; corrected the "Natural Commerce distribution" label; reported
ENGINEERING-SAMPLED DISTRIBUTION (100% `plain`) and NATURAL FEED ESTIMATE
(**NOT DERIVABLE**) separately as A7 requires; qualified the 4.5% → 10.0%
comparison; corrected the same claim in the runner comment.

**NEGATIVE CONTROL.** The corrected numbers are re-derived from the committed
query log and reconcile exactly: 196 + 240 + 100 = 536 raw records =
`providerRawRecordsSeen`; 536 → 490 after dedup by `product_id`;
31 EASY + 18 MEDIUM = 49 = 10.0% of 490; 435 HARD = 88.8%. Arithmetic
verified independently, not restated.

**STATUS.** REPAIRED (reporting). The measurement itself is sound *for plain
tees*; it may not be used as a catalog or market ceiling.

---

## P42-A-005 — the denominator registry was not pinned before the run it claims to precede

| | |
|---|---|
| **SEVERITY** | P3 |
| **LOCATION** | `evidence/vto-phase4-2/repair-denominator-registry.json` |
| **AMENDMENT** | A2 |

**ATTACK.** `git log --follow` the registry; compare against the
characterization evidence commit.

**EXPECTED.** Committed before the 490-product characterization run.

**ACTUAL.**

```
6a2d298  13:57:19  catalog characterization + P42-001 repair   <- 490-product evidence
69237a2  15:37:24  resumable page cache, PINNED DENOMINATOR    <- the registry
```

The registry was committed **1h40m after** the run it claimed to precede. Its
stated purpose said "pinned HERE, before any closeout run"; the closeout said
"pinned before any run".

**ROOT CAUSE.** The claim was true of the closeout *classification* run
(`6230e77`, 15:46:20) but was written as though it were true of every run.
Criterion **PD-1** is worded in terms of the raw-vs-significant component
defect that P42-001 had **already diagnosed and repaired** — a retrospective
description of a known outcome, not a blind pre-registration.

**Default-vs-positive split (A2 requirement).** The four PIPELINE_DRIVEN cases
are classified by *positive* criteria, not by the ambiguous default: Cases 1
and 2 cite PD-1/PD-2 by elimination on recorded stage results; Cases 3 and 4
are SOURCE_DRIVEN (SD-6). **0 of 4 arise from `ambiguousDefaultsTo`.**

**Why this did not inflate anything.** No repair-rate success was claimed. The
numerator is reported NOT MEASURED (quota), and the closeout itself states the
denominator of 4 is far below the registered floor of 20. The defect is the
provenance *claim*, not a headline number.

**FIX.** `f61a575`. Corrected `purpose`; added a `pinningProvenance` block
stating what is and is not pre-registered.

**NEGATIVE CONTROL.** All 14 criteria and the `rules` block verified
**byte-identical** before and after (`criteria IDENTICAL: True`,
`rules IDENTICAL: True`; only `purpose` changed, only `pinningProvenance`
added). An earlier attempt corrupted three em-dashes to U+FFFD via a JSON
round-trip; it was reverted and redone byte-safely, and the equality check
above is what caught it.

**STATUS.** REPAIRED (provenance). Registry immutability *after* `69237a2`
holds: no later commit modifies any criterion.

---

## P42-A-006 — `writeCache` throws EPERM on Windows inside the quota-spending loop

| | |
|---|---|
| **SEVERITY** | P3 |
| **LOCATION** | `src/catalogCharacterizationCli.ts` `writeCache` |
| **AMENDMENT** | §23, A9 |

**ATTACK.** Exercise the exact write-then-rename sequence on win32: rename
over an existing file; rename while a reader holds the destination; two
processes racing 400 writes each.

**EXPECTED (§23).** No partial, valid-looking cache. No platform assumption
without evidence.

**ACTUAL (measured, win32 / node v24.14.0).**

```
rename over existing file            OK (atomic replace)
rename while dest open for READ      THREW EPERM          <- POSIX would succeed
leftover .tmp after simulated crash  present; main cache still valid JSON
A9 two writers x 400                 A: 373 ok / 27 fail   B: 376 ok / 24 fail
final cache                          valid JSON, schema intact, 0 leftover .tmp
```

**A9 passes**: at least one write succeeds, the cache stays valid, and a
torn/partial state readable as success was **never observed**. But 51 of 800
writes (6.4%) failed with EPERM under contention — on Windows, any open handle
(a concurrent reader, an editor, routinely an antivirus scanner touching the
file just written) makes `renameSync` throw.

**ROOT CAUSE.** `writeCache` is called after every funded page and was
unguarded, so an EPERM would abort a run and forfeit provider quota already
spent — precisely the outcome the write-then-rename was introduced to prevent.

**FIX.** `f61a575`. Bounded retry (5 attempts, escalating backoff) on
EPERM/EACCES/EBUSY only; any other error rethrows immediately, and the write
is never silently dropped.

**NEGATIVE CONTROL.** Non-transient errors are explicitly rethrown rather than
swallowed, so the retry cannot mask a real filesystem fault.

**STATUS.** REPAIRED.

---

## Findings documented, not repaired

### P42-A-007 — `variantAuthoritative` bypasses P42-004 entirely (P4, latent)

`variantConsistency.ts:127-137`: when `variantAuthoritative` is true,
`substitutionAllowed: true` is returned with **no colour check, no id
comparison, nothing**. It is a product-level boolean used to assert an
image-pair-level property.

Currently unreachable from real data — every real path hard-codes `false`
(`addressableSliceCli.ts:114`, `cli.ts:63`, `gateECohortCli.ts:144`,
`realFixtureCatalog.ts:13`); only the deliberate fixture
`p4-variant-authoritative-product` sets it true. **If a future Commerce
integration ever populates this flag from provider data, the bypass becomes
live with no image-level verification.** Out of scope for this lane; flagged.

### P42-A-008 — mean-colour variant matching has a false-negative mode (P5, documented)

`dominantGarmentColor` returns the **mean** colour of the largest component.
Two genuinely different colourways whose means coincide (a black/white
pattern versus solid mid-grey) would measure distance ≈ 0 and pass as
`CONSISTENT`. The guard is honestly scoped as a colour check and is a
*necessary*, not *sufficient*, condition; the calibration tests confirm a wide
gap between same-colourway nuisance variation (single digits) and different
colourways (tens to low hundreds). Recorded as a known limitation.

### P42-A-009 — CI nondeterminism in a release-gating security check (P2 severity, OUT OF REPAIR SCOPE)

Per A10, nondeterminism in a release-gating security check is P2 minimum. The
decisive evidence is already in the build's own disclosure: two parallel
`Security - Code and Dependencies` runs on the **same commit** `4c15dca5`
disagreed — one success, one failure.

Time-boxed root-cause attempts:

| Flake | Result |
|---|---|
| `deploy guard: a wrong project reference aborts before deployment` | **NOT reproduced** — 12/12 green locally in this audit. Failure mode involves `git init` in a temp dir plus a spawned node process; subprocess/filesystem timing. **Unexplained.** |
| `closetPromotionCoordinator` deadline test | Matches a known repository-wide real-clock racing pattern. **Pre-existing**, outside this branch. |
| `ZAP Baseline (staging)` | **Root-caused and benign** — see §43 below. |

**None of these tests is touched by this branch**, whose diff is confined to
`vto-phase4-pipeline/`, `docs/`, `evidence/vto-phase4-2/` and `.gitignore`.
Under the audit authority (P4–P6 may be fixed only if directly caused by
Phase 4/4.1/4.2) these are a pre-existing repository/CI condition, not a
Phase 4.2 defect. **Escalated to the owner with an explicit decision flag**
rather than silently added to the flaky baseline, which §41 forbids.

### §43 ZAP — operational failure verified fail-closed (no finding masked)

`security/scripts/evaluate-promotion-gate.js:777-781`: when failures exist and
the verdict would otherwise be `PASS`, it is downgraded to `OPERATIONAL
FAILURE` (zap/static-scanner operational flags) or `BLOCKED`. `missingReport`,
`scannerCrash` and `zapExit3` are all in `OPERATIONAL_KEYS`. A crashed spider
producing no report therefore **cannot** yield a pass. The reported ZAP
failures (spider 404 against a Supabase API host, which is not a website)
blocked promotion rather than passing it. **No security finding could have
been masked.**

---

## Claims verified and CONFIRMED (hostile checks the build passed)

- **A1 deductive attribution — all implications hold in code.** See the
  deduction table in the final report. `qa=ok ⟺ qa.passed` (pipeline.ts:194-207)
  → `productFidelity` exactly 1.0; EASY takes the branch at pipeline.ts:141-145
  that never assigns `appliedRotationDegrees` → `geometryValidity` exactly 1.0;
  `requiredAnchorsPresent` and `requiredAnchorAverage` operate on the **same
  four ids** at the **same 0.5 threshold**, so the mean cannot fall below 0.5.
  The closeout's own "consistent but not proven" bound on saturation-to-zero is
  correct and was not overclaimed.
- **A4 resolution confound — measurements are NOT resolution-conditional in
  the tested band.** Across native (394–960px) → 659 → 200px on all seven
  authorized fixtures: **0 shot-class shifts, 0 tractability shifts, 0
  eligibility shifts.** One near-miss recorded: `qa-fixture-footwear` crossed
  the `busyBackgroundUniformity: 34` threshold (35.94 → 31.40) without changing
  the verdict, so the mechanism is real but not decisive. Bounds one direction
  only — no higher-resolution originals exist to test upscaling.
- **P42-004 variant integrity — sound.** On refusal the **hero** is kept, never
  a third candidate (`imageSelection.ts`), which prevents a cascade through
  successive unsafe alternates. `UNMEASURABLE` fails closed. Null variant ids
  never imply same-variant: the colour check always runs on real data.
- **§25 / P42-007 empty cache — fails closed.** `addressableSliceCli.ts:55-60`
  explicitly refuses a zero-product cache rather than emitting a zero-filled
  summary.
- **§24 cache identity — correct.** `pageKey = visual|query|offset`
  (`catalogCharacterizationCli.ts:182-183`) includes the query string, so two
  different queries in the same visual stratum cannot collide. (The *query log*
  records only `stratum.visual` and is lossy relative to the key — that is what
  made the single-stratum truncation in P42-A-004 hard to see, and §5.1 now
  states it.)
- **§27 Windows contamination — contained.** Working tree clean; the
  `.gitignore` entries for the literal-path harness artifacts are correct.
- **§28 evidence hygiene — clean.** Zero URLs in committed Phase 4.2 evidence;
  `productRef` values are synthetic (`cat-00001`); no product titles, store
  names, raw bytes, base64, or credentials. Only a CDN hostname
  (`encrypted-tbn*.gstatic.com`) appears, which is derived and non-identifying.
- **§33/§34/A14 local model guard — NOT APPLICABLE, verified inert.** Zero
  model weight files in the repository; zero network calls in
  `localSegmentationModel.ts`. `MODEL RUNTIME NETWORK CALLS: 0` is a property
  of the code, as claimed.
- **§6/§7/A11 commerce inventory — claim correctly bounded, not
  overgeneralized.** `product-search-deals` (the 490-corpus path) is a
  pass-through to RapidAPI; the 4.2 tooling reads `product_photos: string[]`
  and preserves **every** candidate — the provider genuinely returned one image
  for all 490. Separately, `search-vinted-secondhand` **does** receive upstream
  arrays and K Scan's own edge normalization collapses them to a scalar
  (`imageUrl?: string`, `imageFrom()` at index.ts:141-155,185). The build did
  not generalize this into "all retail sources have one image."
- **§20 addressability arithmetic — reconciles exactly.** 490 unique from 536
  raw; 31 EASY + 18 MEDIUM = 49 = 10.0%; 435 HARD = 88.8%; multi-image rescue
  gain 0 is **structurally tautological** (0 products carry >1 image), which the
  doc states.
- **A6 P42-001 is monotonically safe.** `significantComponentCount ≤
  componentCount` always, so P42-001 could only raise a segmentation score.
  **It cannot have regressed a previously-eligible asset.**

---

## Regression

| Suite | Result |
|---|---|
| `vto-phase4-pipeline` (`npm test`) | **169 pass / 0 fail** (161 pre-existing + 8 new) |
| VTO surface, 21 root suites | **404 pass / 0 fail** |
| `vtoLiveIntegrationScope` | 10 pass / 0 fail |
| `dependencyReachabilityGate` | 14 pass / 0 fail |
| `edgeFunctionSourceParity` | 23 pass / 0 fail (12/12 green on repeat) |
| `migrationProvenanceGate` | 4 pass / 0 fail |
| `privacyPolicy` | 3 pass / 0 fail |
| Root + pipeline typecheck | clean |

**UNEXPECTED FAILURES: 0.** Three VTO suites initially reported failures from
`Cannot find module 'typescript'` — the root `node_modules` is absent in this
worktree. Proven environmental rather than asserted: with `typescript`
resolvable they pass 41/22/14. `scripts/run-all-tests.js` was deliberately
**not** used as a green signal, because it can exit 0 vacuously without
`node_modules`.
