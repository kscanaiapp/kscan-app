# Product Match Benchmark — governed offline scaffold

Measures **product-match accuracy** and **retrieval latency** against a frozen,
hand-labelled case set. Offline and deterministic: it replays recorded provider
responses through the real matching pipeline. It never calls a provider, never
reads the database, and never spends money.

## Why offline replay rather than live measurement

A live run measures the provider and the matcher at the same time, so a
regression in one is indistinguishable from a change in the other, and no two
runs are comparable because the retailers' inventory moves underneath them.
Replaying frozen fixtures isolates the part this phase actually owns: given
these provider responses, does the pipeline reach the right tier?

Latency is handled the same way. Fixture rows carry a recorded `delayMs`, so a
run reproduces the *shape* of a real request — which provider answered first,
which one was still outstanding at the deadline — without the variance of a
real network. That is enough to detect an orchestration regression. It is **not**
a production latency measurement, and this scaffold does not claim to be one.

## Governance

Three rules, enforced by `scripts/product-match-benchmark.js`:

1. **The case set is sealed.** `cases/manifest.json` carries a `sealHash` over
   every case file. A run whose recomputed hash differs is refused. Editing a
   case is allowed; editing a case *and* keeping the old seal is not.
2. **No network, ever.** The runner takes no provider credentials and imports no
   provider module. There is no code path from a benchmark run to an upstream
   request.
3. **Results are never fabricated.** A case with no `expectedTier` is reported
   as `unlabelled` and excluded from every accuracy figure. The runner reports
   what it measured and how many cases it could not score; it does not
   interpolate, and a run over zero labelled cases reports zero, not "pass".

## Current state — scaffold, not a baseline

`cases/` ships with a single worked example, and that example is **illustrative,
not a labelled ground truth**. No accuracy baseline exists for product match
yet, because building one requires hand-labelling real scans against real
retailer inventory — owner work, not something this phase can generate.

Anything reporting a product-match accuracy number today would be reporting the
scaffold's opinion of its own example. The runner is deliberately built so that
this is visible: run it now and it tells you it scored one case.

## Usage

```bash
node scripts/product-match-benchmark.js
```

```bash
node scripts/product-match-benchmark.js --json
```

Re-seal after deliberately editing cases:

```bash
node scripts/product-match-benchmark.js --reseal
```

## Case format

```jsonc
{
  "id": "af1-white-multi-retailer",
  "description": "Human-readable statement of what this case is testing.",
  "query": { "brand": "Nike", "canonicalCategory": "footwear", "color": "white" },
  "providers": [
    {
      "source": "farfetch",
      "delayMs": 420,
      "status": "completed",
      "products": [ /* raw provider rows, exactly as the provider returns them */ ]
    }
  ],
  "expectedTier": "LIKELY_EXACT",        // omit → case is unlabelled
  "expectedFamilyCount": 1,               // optional
  "expectedListingCount": 2               // optional
}
```

`products` holds **raw provider shapes**, not normalized rows. That is
deliberate: the benchmark must exercise the normalizer, because normalization
is where most accuracy is won or lost.
