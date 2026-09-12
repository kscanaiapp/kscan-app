# FashionCLIP visual re-ranking — recorded hypothesis

**Recorded BEFORE any control-vs-challenger result existed in this lane.**
Commit order is the evidence: this file lands in its own commit, before
`rerankExperiment.js` produces a single number. Spec section 15 asks for
exactly this and no more — it is a guard against post-hoc storytelling, not a
statistical preregistration ceremony.

## Architecture under test

K Scan's existing L1 candidate generation is **not** replaced. FashionCLIP is
a downstream re-ordering layer over the candidates L1 already returned:

```
SCAN / IDENTIFICATION
  -> EXISTING K SCAN L1            (unchanged, produces the candidate set)
  -> RETAILER CANDIDATES           (the exact set, nothing added or removed)
  -> FASHIONCLIP VISUAL RE-RANKING (reorders that set only)
  -> IMPROVED PRODUCT ORDER
```

## HYPOTHESIS

FashionCLIP visual re-ranking should most improve cases where L1 finds the
correct garment *category* but orders visually dissimilar products too highly
— i.e. where the right answer is already inside the candidate set but buried
below a metadata-plausible, visually-wrong competitor.

Corollary, and the reason this is a re-ranker and not a retriever: **the
re-ranker can only ever fix ordering.** If the correct product is absent from
L1's candidate set, no re-ranking can recover it. The ceiling of this entire
approach is bounded by L1 recall, and every result below must be read against
that ceiling.

## EXPECTED_STRENGTHS

- **silhouette** — shape is carried strongly by image structure and weakly by
  retailer text metadata.
- **pattern** — solid vs striped vs floral is visually obvious and frequently
  absent or wrong in retailer attribute feeds.
- **visual construction** — drape, closure, panelling.
- **overall visual resemblance** — the holistic "is this the same garment"
  judgment a shopper makes at a glance.

## EXPECTED_LIMITATION

FashionCLIP sees **pixels only**. It has no access to the retailer/business
information L1's metadata ranking legitimately knows and correctly weights:
brand identity, SKU equality, price tier, stock state, retailer trust,
purchase-path availability.

The concrete predicted failure mode: a re-ranker driven purely by visual
similarity will happily promote a visually-near item that is out of stock,
unpurchasable, or from an untrusted retailer, above an exact-SKU match that
L1 ranked first for sound commercial reasons. **A pure visual re-rank is
therefore expected to be able to make FMQ substitute quality worse even while
making visual attributes better**, because FMQ's substitute axis hard-gates on
purchase path and caps on category mismatch.

If that shows up in the results, it is a predicted architectural property of
re-ranking on visual signal alone — evidence about *where the blend belongs*,
not evidence that FashionCLIP is useless.

## What would count as each conclusion

| Conclusion | Meaning in this lane |
|---|---|
| `PROMISING_CONTINUE_R&D` | Real FashionCLIP ran, and re-ranking moved enough correct products upward to justify another iteration. |
| `NO_USEFUL_SIGNAL` | Real FashionCLIP ran correctly and showed no meaningful directional advantage. |
| `INSUFFICIENT_EVIDENCE` | The build works, but corpus/evaluator quality is too weak to infer quality. |
| `ENVIRONMENT_BLOCKED` | The real model could not be executed in the authorized environment. |

A run that did not execute real FashionCLIP weights **cannot** produce
`PROMISING_CONTINUE_R&D` or `NO_USEFUL_SIGNAL`. Those two verdicts are claims
about the model; only `ENVIRONMENT_BLOCKED` or `INSUFFICIENT_EVIDENCE` are
available without it. This constraint is enforced in code
(`rerankReportSchema.js`), not left to the report author's discipline.
