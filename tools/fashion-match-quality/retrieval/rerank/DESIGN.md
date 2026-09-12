# FashionCLIP visual re-ranker — design decisions

R&D only. Nothing here is wired into any production path. See `../DESIGN.md`
for the decisions taken by the retrieval lab this builds on (PR #402).

---

## RR-01 — Why a re-ranker rather than a retriever

PR #402 built a **retriever**: it indexes a candidate universe and queries it
by embedding similarity. That answers "what should we surface?", which is the
question K Scan's existing L1 already answers.

This lane builds a **re-ranker**, which answers a strictly narrower question:
*given the candidates L1 already returned, what order should they be in?* The
distinction is load-bearing, not cosmetic:

| | Retriever | Re-ranker (this lane) |
|---|---|---|
| Candidate set | chooses it | receives it, unchanged |
| Failure if wrong | surfaces wrong products | surfaces right products in a worse order |
| Recall ceiling | its own | **bounded by L1's** |
| Production blast radius | replaces L1 | sits downstream of L1 |

`visualReranker.js#rerank` therefore enforces the permutation property
structurally — it verifies its output against the input's id multiset and
throws `RERANK_UNIVERSE_VIOLATION` rather than returning a shortened list.

## RR-02 — The control arm now runs the REAL production L1

PR #402 recorded the control arm as permanently `DENO_UNAVAILABLE`: `runL1.js`
shells out to Deno to execute the real Supabase Edge Function ranking module,
and `deno` was not on PATH.

Deno is distributed on npm as a platform binary package
(`@deno/linux-x64-glibc`), and `registry.npmjs.org` is reachable in this
environment. Installing it out-of-tree gives the control arm the genuine
production ranking path, unmodified.

This matters more than a convenience: it upgrades the control from "blocked,
all metrics null" to a real, production-identical baseline, which is what
makes the paired comparison in `rerankExperiment.js` meaningful at all. The
binary is installed outside the repository and is not vendored, committed, or
added to `package.json`.

## RR-03 — Tie-break on L1 rank, not on candidateId

`vectorIndex.js` (#402) breaks similarity ties by `candidateId` ascending — a
total order, which is all a retriever needs.

For a re-ranker that is wrong. On a tie the re-ranker has *no visual opinion*,
and falling back to alphabetical order actively destroys the information L1
has and FashionCLIP does not: brand, price tier, stock, retailer trust,
purchase path. So `rerank()` breaks ties by **original L1 rank** first, and
only then by `candidateId` for total-order determinism.

Net effect: the re-ranker moves a product only when it has positive visual
evidence to move it, and otherwise defers to K Scan's existing ranking. This is
proved by `visualReranker.test.js`'s tie-break anchor.

## RR-04 — Candidates with no usable image are ranked last, never dropped

Dropping them would shrink the challenger's candidate universe relative to the
control's and produce a flattering comparison for free (§8). Fabricating a
similarity score for them would be worse. They are ranked below every scored
candidate, holding their relative L1 order among themselves: absence of visual
evidence is not evidence of a bad product, but it is not a reason to promote.

## RR-05 — Universe fingerprinting is order-independent by design

`candidateUniverse.js` sorts candidates by id before hashing. If ordering
affected the hash, the two arms could never match and the check would be
useless — the arms are *supposed* to differ in order. The hash is instead
sensitive to membership and content: candidate ids, the sha256 of the image
bytes actually embedded, the five scored fashion attributes, and the two fields
FMQ hard-gates on (purchase path, availability).

`assertSameUniverse()` additionally compares the two returned orderings as
multisets, so a drop or an insertion is named explicitly rather than showing up
only as an opaque hash difference.

## RR-06 — The wrongColor = 1.0 defect was real, and its cause was field naming

**Cause: attribute normalization, in the evaluator.** FMQ ground truth stores
colour as `color_family`. Candidate products — which mirror the retailer-facing
product shape — store it as `color_normalized` / `color`, and carry no
`color_family` key at all. `componentScore` compared same-named keys, so
`candidate.color_family` was always `undefined`, which scores 0.

Every candidate ever scored therefore scored 0 on colour, including exact-SKU
matches with an identical colour. The repository's own committed baseline shows
it: `fashionComponentAverages` reads `1` for all twelve other components and
`0` for `color_family`, on a corpus whose top-1 is an exact SKU match every
time.

A constant 0 carries no information. Before the repair, `wrongColor` was `1.0`
for *any* ranking, so it could not distinguish a good ranking from a bad one in
either direction.

**Repair:** a versioned candidate-side field-alias table
(`rubric.js#CANDIDATE_FIELD_ALIASES`). No comparison rule, weight, threshold or
partial-credit rule changed. An executable audit in `wrongColorRepair.test.js`
asserts `color_family` is the *only* rubric component with no candidate-side
key, so the alias table cannot silently become incomplete.

**Why this is not evaluator tuning.** The repair lives in the shared scorer and
is blind to which arm produced the candidate; both arms are affected
identically. It raises colour scores only where the candidate's colour genuinely
equals ground truth and leaves wrong colours at 0 — verified against known-correct
and known-wrong cases. `RUBRIC_VERSION` is deliberately *not* bumped (no
component and no weight changed); a separate
`COMPONENT_FIELD_RESOLUTION_VERSION` is recorded in every artifact so a
pre-repair baseline is never silently compared against a post-repair run.

`COLOR_METRIC = REPAIRED_AND_DISCRIMINATIVE`.

## RR-07 — The cache's provider boundary

Distinct revision strings already stopped stub and real entries *colliding*
(#402). They do not stop a subtler failure: a caller passing a real resolved
revision while a stub embedder quietly services the call would write harness
bytes under a real-model cache identity, and every later run would read them
back as real.

`embeddingCache.js` now treats `provider` as load-bearing on both ends —
`putCached` refuses a non-model provider under an immutable revision (and the
mirror case), `getCached` reports a provider mismatch as a miss rather than
serving it, and `embedWithCache` rejects an embedder that returns a different
provider than the caller declared. Proved in `cacheProviderBoundary.test.js`,
including a test pinning the cache's non-model provider list to
`executionIdentity.js`'s so the two cannot drift.

## RR-08 — Real execution is five observations, not one boolean

Spec §6. `executionIdentity.js` derives `REAL_FASHIONCLIP_EXECUTED` as a
conjunction of `MODEL_WEIGHTS_LOADED`, `MODEL_EMBEDDINGS_PRODUCED`,
`EMBEDDINGS_USED_IN_RERANK`, `RUN_ARTIFACT_MODEL_REVISION` (immutable 40-hex
SHA, never a mutable ref) and `CACHE_REVISION_VALIDATED`. It is never
assignable. `assertRealModelEvidence()` throws on harness provenance; the
negative control in `executionIdentity.test.js` sets every optimistic flag to
`true` and asserts the guard still refuses.

`rerankReportSchema.js` carries the same invariant at the report layer: the two
conclusions that are *claims about the model* — `PROMISING_CONTINUE_R&D` and
`NO_USEFUL_SIGNAL` — are structurally unreachable without a real model run.
That constraint was recorded in `HYPOTHESIS.md` before any result existed and
is enforced in code rather than left to the report author's discipline.

## RR-09 — The attribute renderer and the labelled visual descriptor

The SHA-256 stub embedder (#402) is uncorrelated with what a candidate *is*, so
a re-ranker driven by it has never been shown to respond to image content at
all — every ranking it produces is a deterministic shuffle.

Two clearly-quarantined additions close that gap:

- `attributeImageSource.js` renders a fixture's own recorded attributes into a
  genuine decodable PNG (colour → RGB, silhouette → width profile, material →
  surface modulation, pattern → spatial modulation).
- `visualDescriptorProbe.js` decodes those pixels into a colour histogram +
  edge energy + width profile. It is **not a model**: zero learned parameters,
  no training, tagged `HARNESS_VISUAL_DESCRIPTOR_NOT_FASHIONCLIP`, listed in
  `NON_MODEL_PROVIDERS`, and barred from any real-model claim by RR-07/RR-08.

**Its numbers are worth nothing as fashion-quality evidence,** and the report
says so: the images encode exactly the attributes FMQ scores, so any metric over
them measures a closed loop. It is reported strictly as `MECHANISM_CHECK`.

A defect found and fixed here is worth recording: the descriptor originally
suppressed background by "is this pixel light?", which classified **white
garments** (242,242,238) as backdrop and erased them entirely — recovery fell to
0 on exactly those fixtures. Fixed by giving the renderer a chroma-key backdrop
outside the garment colour vocabulary and having the descriptor learn the
backdrop by corner sampling instead of presuming it. Guarded by a regression
test.

## RR-10 — Why the paired comparison could not show an improvement

The real production L1 control arm scores **perfectly** on every headline metric
over this corpus: `exactTop1 = 1.0`, `usefulTop1 = 1.0`, and `wrongColor`,
`wrongSilhouette`, `wrongMaterial`, `wrongPattern` all `0`.

There is no headroom. A re-ranker cannot improve on a perfect control; the
paired comparison can structurally only tie or regress, whatever model drives
it. Every metric ties.

This is a fact about the corpus, not about FashionCLIP, and the report states it
as a limitation rather than dressing a tie up as a finding.

## RR-11 — The degraded-order probe, and what it confirmed

To answer the remaining engineering question — does the layer respond to visual
evidence at all? — `runDegradedOrderProbe` feeds the re-ranker a deliberately
**reversed** L1 ordering and measures recovery. The reversed ordering is
synthetic and adversarial; no production L1 would emit it. It is reported under
`mechanismProbe` and never mixed into the control-vs-challenger metrics.

Result, 10/10 cases: the correct product moves from rank 5 to rank 3, and
`usefulTop1` flips `false → true`.

It never reaches rank 1 — and **why** is the most useful finding in this lane.
The `exact`, `cross-retailer-dup` and `no-purchase-path` candidates share every
scored visual attribute, so they are visually indistinguishable. The re-ranker
promotes whichever the degraded order happened to place highest, and in **10 of
10 cases that is `no-purchase-path`**, whose FMQ substitute level is `UNUSABLE`.

That is precisely the limitation `HYPOTHESIS.md` recorded in advance:

> FashionCLIP sees pixels only… a re-ranker driven purely by visual similarity
> will happily promote a visually-near item that is out of stock,
> unpurchasable, or from an untrusted retailer, above an exact-SKU match that L1
> ranked first for sound commercial reasons.

Confirmed, with evidence, on every case. It is an argument about *where the
blend belongs* — `STRATEGY_BLENDED` exists to make that measurable — not an
argument that FashionCLIP is useless.

## RR-12 — Corpus limitations that bound every number here

- **0 real / 0 sanitized-real / 10 synthetic.** No real-world efficacy claim is
  available at any sample size.
- **`pattern` takes one value (`solid`) corpus-wide.** `wrongPattern` cannot
  discriminate between two rankings, so the hypothesis's "pattern" expected
  strength is untestable here. Reported as `PATTERN_METRIC=NON_DISCRIMINATIVE`.
- **Candidates sharing scored attributes render byte-identically**, so any
  embedder — including a hash — returns similarity 1.0 between them. This corpus
  cannot distinguish a real model from a stub.
