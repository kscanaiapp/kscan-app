# FashionCLIP Retrieval Lab — design authority (Workstream 03)

This document records the genuinely ambiguous decisions made while building
this package, in the same decision-memo format used by
`tools/real-fashion-corpus/docs/DESIGN.md` and `tools/fashion-ontology/NOTICE.md`.

---

## DM-01 — huggingface.co is network-policy-blocked in this build's session

**QUESTION.** Spec section 4 asks to "use the freely available model locally
for this R&D lane" and pin its exact revision. Can that literally happen in
this session?

**EVIDENCE.** `curl` to `huggingface.co`, `hf-mirror.com`, `cdn.jsdelivr.net`,
and `cdn-lfs.huggingface.co` all fail with `CONNECT tunnel failed, response
403`. The egress proxy's own status endpoint
(`http://127.0.0.1:$PORT/__agentproxy/status`) records the failure
explicitly: `"kind": "connect_rejected", "detail": "gateway answered 403 to
CONNECT (policy denial or upstream failure)", "host": "huggingface.co:443"`.
`pypi.org`/`files.pythonhosted.org` are directly reachable (no proxy
involved, per the proxy's own `noProxy` list) but no `torch`/`transformers`
install was attempted at scale, since it would not change the outcome: the
model itself still could not be downloaded. This is the same restriction
`tools/fashion-ontology/NOTICE.md` already recorded during Workstream 01 for
the identical set of hosts — a stable, pre-existing environment policy, not
a fluke of this session.

**OPTIONS.**
1. Fabricate a plausible-looking pinned revision and fake embedding output. —
   Directly forbidden by this program's own anti-fabrication culture
   (mission section 26 equivalents throughout `tools/real-fashion-corpus/`);
   would produce a report indistinguishable from real evidence to a reader
   who didn't dig into the code.
2. Refuse to build anything until network access is granted. — Leaves the
   entire harness (cache, index, evaluator, both negative controls, the
   report schema) unbuilt and unproven, for a blocker outside the model
   integration itself.
3. **Build the full harness for real, gate the actual FashionCLIP
   invocation honestly (mirroring `l1/runL1.js`'s existing
   `DENO_UNAVAILABLE` pattern), and make every report say so explicitly.**

**SAFE DEFAULT — option 3, confirmed with the user before implementation**
(this was surfaced as an `AskUserQuestion` rather than decided unilaterally,
given how central "run the real model" is to this workstream's stated
purpose). `fashionClipAdapter.js`/`.py` are genuine, correct inference code
that would run the real model unmodified the moment `huggingface.co` is
reachable and a local cache exists — `isFashionClipAvailable()`
synchronously checks three real preconditions (python3, torch+transformers,
a local HF cache directory) and none currently hold. `harnessStubEmbedder.js`
exists solely to exercise the surrounding machinery and is unmistakably
labeled `HARNESS_STUB_NOT_FASHIONCLIP` everywhere its output appears — cache
entries, index records, evaluation reports.

**RISK.** A reader who only skims a report's headline metrics could
mistake stub-embedder numbers for real FashionCLIP quality. Mitigated by:
`modelProvider` on every report, a `limitations` entry stating the actual
provider used in plain language, and `reportSchema.js` requiring both fields
to be present.

**REVERSIBILITY.** N/A by construction — nothing here needs reversing; the
real path activates automatically once the precondition is met.

---

## DM-02 — What the harness stub embedder is allowed to prove, and what it cannot

**QUESTION.** Given DM-01, what is honestly provable in this session, and
what must be reported as unproven?

**SAFE DEFAULT.** Split cleanly along a line already drawn by CLIP-family
models themselves: embedding-space **mechanics** (cache correctness, index
ranking correctness, stable tie-breaking, determinism, report assembly) are
provider-independent — any fixed-dimension vector generator exercises them
identically. Embedding-space **semantics** (does this image "look like"
that one; does "burgundy leather bomber jacket" retrieve burgundy leather
bomber jackets) require a trained joint embedding space, which the stub
categorically does not have (it is expanded SHA-256 hash output — see
`harnessStubEmbedder.js`'s header). So: every mechanical property in spec
sections 7/8/10/17/18 is proven for real in this session; every semantic
property in spec sections 11/14 (beyond "the query path runs without
throwing") is explicitly reported as unproven, never guessed at.

**RISK.** None distinct from DM-01 — this is a corollary of it.

**REVERSIBILITY.** N/A.

---

## DM-03 — Candidate universe: FMQ's synthetic fixtures, not Real Fashion Corpus V2

**QUESTION.** Spec section 7 asks to embed "the candidate-product universe
already available through the deterministic FMQ/Corpus replay fixtures."
Real Fashion Corpus V2 has 0 real cases (`tools/real-fashion-corpus/docs/DESIGN.md`
DM-12). What universe does this package actually index?

**SAFE DEFAULT.** `corpus/corpusLoader.js#loadFullCorpus()` — FMQ's own
committed synthetic fixtures (10 fixtures, 50 candidate products at the time
of writing), the "deterministic FMQ ... replay fixtures" the spec names
directly. Real Fashion Corpus V2 contributes 0 candidates (correctly — it
has none), but its manifest hash and ontology version are still bound into
every report, per spec section 12, so a later corpus population is a
detectable state change on the exact same report shape, not a schema
migration.

**RISK.** None of the headline metrics reflect real garment photography —
addressed directly in every report's `limitations` and
`realWorldEfficacyDecision: INSUFFICIENT_REAL_CORPUS`.

**REVERSIBILITY.** High — `buildIndex.js` would index real Real Fashion
Corpus V2 cases identically once they exist; no schema change needed.

---

## DM-04 — Synthetic placeholder images reuse Real Fashion Corpus's PNG generator

**QUESTION.** FMQ's fixtures carry only placeholder `imageUrl` strings, never
real bytes. To time and hash a genuine "image preprocessing" step (spec
section 16), some real, decodable image bytes are needed. Build a new
generator, or reuse one?

**SAFE DEFAULT.** Reuse `tools/real-fashion-corpus/testAssets/generate.js#makePng`
via `syntheticImageSource.js` — a zero-dependency, genuinely-decodable PNG
generator that lab already built and tested for the identical purpose
(procedurally generated bytes that exercise real pipeline mechanics without
claiming to be photographs). Writing a second PNG encoder in this monorepo
for the same job would be pure duplication. `lib/imageIntegrity.js#inspectImage`
(also reused, unmodified) then gives a real decode/hash/dimension check.

**RISK.** This is a cross-lane dependency in the opposite direction from the
existing precedent (Real Fashion Corpus already depends on FMQ; this has
FMQ's retrieval package depend on Real Fashion Corpus). Accepted: both are
sibling R&D labs under `tools/`, and reusing tested code beats forking it.

**REVERSIBILITY.** High — trivially replaceable with a local copy if the
dependency direction is ever considered a problem.

---

## DM-05 — Control arm reuses FMQ's L1 harness verbatim, and is equally blocked

**QUESTION.** Spec section 9 requires the control to be "the existing K Scan
production-identical ranking/retrieval path already exercised by Fashion
Match Quality," never reimplemented.

**SAFE DEFAULT.** `controlArm.js` calls `l1/runL1.js#runL1ForFixture`
directly, unmodified. That function already shells out to Deno to run the
real production ranking module (`supabase/functions/_shared/scanHelpers.ts`)
— see its own header for why. This sandbox's `deno` binary is not on PATH
(confirmed, the same condition behind FMQ's own `l1/runL1.test.js` "4 skip"
results), so the control arm is **equally** blocked here, not just the
challenger. Both blockers are reported side by side in every evaluation
report; neither is hidden to make the other look worse or better by
omission.

**RISK.** None — this is the honest, symmetric outcome of two independent,
pre-existing environment constraints.

**REVERSIBILITY.** N/A.

---

## DM-06 — Quality judged entirely by FMQ's existing scorers, never a new one

**QUESTION.** Spec section 6: "FashionCLIP supplies VISUAL SIMILARITY
EVIDENCE. It does not supply CANONICAL PRODUCT IDENTITY... Do not infer high
cosine similarity = same product." How is "quality" measured without
building a second scorer?

**SAFE DEFAULT.** `retrievalEvaluator.js` calls FMQ's own
`evaluator/identityAxis.js#scoreIdentity`,
`evaluator/substituteAxis.js#scoreFashionComponents`/`scoreSubstitute`, and
`duplicates/duplicateClassifier.js#summarizeDuplicatesAndRetailers` directly,
unmodified, on whichever ranked candidate list either arm produced.
`similarityScore` never appears in any quality computation — it is stored on
each ranked result purely as diagnostic evidence (spec section 10), exactly
as asked.

**RISK.** None — this is a direct, minimal-surface reuse.

**REVERSIBILITY.** N/A.

---

## DM-07 — wrongSubtypeRate is reported UNAVAILABLE, not guessed

**QUESTION.** Spec section 14 asks for a "wrong subtype" rate alongside
color/silhouette/material/pattern.

**EVIDENCE.** FMQ's fixture ground truth carries `category` only (e.g.
`"accessory"`, `"dress"`) — there is no finer `subtype` field, and these
candidates were never run through `tools/fashion-ontology`'s
`CanonicalFashionAttributesV1` canonicalization (they predate Workstream 01
and were not authored with an `ontology` block).

**SAFE DEFAULT.** Report `wrongSubtypeRate: {rate: null, n: 0, reason:
'UNAVAILABLE: ...'}` rather than inventing a category→subtype guess.
Matches spec section 14's own instruction: "If some metrics cannot be
truthfully produced from current fixture labels, report them as unavailable
rather than guessing."

**RISK.** None — this is the explicitly-requested honest behavior.

**REVERSIBILITY.** High — the moment a candidate universe carries real
ontology `subtype` values (e.g. Real Fashion Corpus V2 cases), this metric
becomes computable with no schema change.

---

## DM-08 — A pre-existing FMQ fixture quirk affects wrongColorRate for both arms equally

**QUESTION.** Running FMQ's own `scoreFashionComponents` directly against
its own "exact match" candidate in `synthetic-accessory-06.json` scores
`color_family: 0` — even for the intentionally-exact candidate. Is this a
bug this workstream introduced?

**EVIDENCE.** No. `FASHION_COMPONENTS` scoring (`evaluator/rubric.js` +
`evaluator/substituteAxis.js`) reads `candidate.color_family`, but FMQ's
real synthetic fixtures' `candidateProducts` carry `color`/`color_normalized`
only, never a `color_family` field (verified by grepping every fixture file
and by calling FMQ's unmodified `scoreFashionComponents()` directly against
its own fixture — see `runEvaluation.js`'s `limitations` builder). This
predates this workstream and is unrelated to it.

**SAFE DEFAULT.** Do not alter FMQ's fixtures or scorer (out of scope,
another lab's committed history, and "FMQ determines quality" — DM-06 —
means this package never patches FMQ to get a preferred number). Report the
number as computed, with an explicit `limitations` entry naming the cause
and noting it affects control and challenger identically, so it does not
bias the comparison even though the absolute rate should not be read as a
literal color-accuracy measurement against this particular fixture corpus.

**RISK.** A reader could misread `wrongColorRate: 1.0` as "FashionCLIP is
bad at color" without reading the limitations. Mitigated by stating the
cause explicitly and prominently in every report.

**REVERSIBILITY.** N/A — not this package's code to fix.

---

## DM-09 — Curiosity Gap integration: adopt conventions, do not inject into TTFAR

**QUESTION.** Spec section 16: "Feed the artifact into the existing
Curiosity Gap lab/report structure where appropriate."

**EVIDENCE.** `tools/curiosity-gap-performance/` is a heavily source-bound
structural model of TTFAR (Time To First Actionable Result) — its stages
are compression, digest, upload, and network calls read from real Scanner
source (`hooks/useKScan.js`, `supabase/functions/`). None of this package's
timings (embedding generation, index query) are part of that real pipeline
— spec section 21 requires **zero customer-path change**, and this is R&D
only.

**SAFE DEFAULT.** Adopt Curiosity Gap's *reporting conventions* — P50/P95/MAX
percentile summaries (`timing.js#summarize`), an explicit non-production
benchmark-status label, environment recording — without injecting these
timings as a new stage into its TTFAR structural model. Injecting them would
misrepresent TTFAR (implying they run on the customer's critical path) rather
than extend it.

**RISK.** "Where appropriate" is a judgment call; a reviewer could
reasonably want tighter integration. Documented here so that judgment is
visible and revisitable.

**REVERSIBILITY.** High — a future workstream could add a genuine Curiosity
Gap experiment stage for this once/if FashionCLIP retrieval is ever promoted
toward a real customer path.
