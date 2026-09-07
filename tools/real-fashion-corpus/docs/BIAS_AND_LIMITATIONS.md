# Corpus bias and limitations

Mission sections 11 and 39. This document is meant to be read **before** any
number from this corpus is quoted, and it is deliberately placed where a reader
looking for results will hit it.

---

## The headline

> **This corpus is an engineering benchmark. It does not represent K Scan's
> production traffic, and it never will.**

It is built to answer "does K Scan identify real garments, and where does it
struggle" under conditions engineers choose. It is not a sample of what users
actually scan, because nobody drew it from what users actually scan.

---

## Internal-only clause (mission section 39)

All results from this corpus are **INTERNAL ENGINEERING EVIDENCE ONLY**.

They are **not**:

- production-traffic accuracy
- population-representative accuracy
- a customer-satisfaction measure
- a marketing claim
- an App Store or Play Store claim
- an investor claim

And specifically: **no comparison against any incumbent or competitor may be
drawn from this corpus.** Not Google Lens, Amazon, Phia, Daydream, Style DNA,
Alta, Acloset, Syte, Visenze, or any other. The corpus was not designed to
support such a comparison, contains no competitor measurements, and could not
support one even if it did — the garments were chosen by us.

Every artifact this lane produces carries `benchmarkStatus: "INTERNAL
ENGINEERING EVIDENCE ONLY"`, and the independent validator **fails any report
that omits or alters it**. That is a mechanical control, not a convention.

---

## Known biases, by dimension

Mission section 11 asks for an explicit evaluation across specific dimensions.
Each is assessed below. Because **the corpus currently holds zero real cases**,
these are the *designed-in* biases the collection plan already implies — they
will be re-measured from the actual corpus as it fills, via `cli.js queue`.

### Category

**Biased by design.** V1 covers five categories (`outerwear`, `top`,
`footwear`, `dress`, `bag`) and deliberately excludes `pants` and `accessory`
(see `POWER_CLAIM_MAP.md` §3). This is depth-over-breadth: spreading ~96 cases
across seven categories would leave every one below the inference bar.

*No claim about trousers or accessories may be made from this corpus.*
`cli.js gaps` reports uncovered categories explicitly.

### Brand tier and price tier

**Likely biased toward mid and premium.** Identifier-grade truth requires a
legible style code, and cheaper fast-fashion garments frequently have tags with
no durable code at all. So the *identity-eligible subset* — the denominator for
the headline identity metric — will skew toward brands that label well.

This is a real distortion and it points the wrong way: it makes identity look
easier than it is in the wild. It is recorded in `attr_price_tier` so the skew
is at least measurable, and the collection plan explicitly asks for `value`-tier
garments even though many will only reach `PARTIAL`.

### Gender presentation

**Skewed by whoever collects.** A single collector contributes one wardrobe.
Recorded per garment in `attr_gender_presentation` — which describes the
garment's *cut*, never a person.

### Style and taste

**Strongly skewed.** People own clothes they like. A corpus drawn from personal
wardrobes inherits that taste, and taste correlates with brand, colour and
silhouette all at once. Authorized in-store capture is the designed mitigation,
because a shop rail is not curated by the collector's preferences.

### Material, colour and pattern

**Actively counter-biased.** Left alone, a wardrobe corpus over-represents
easy garments. The difficulty strata exist to push against that, and the gap
list flags a shortfall in dark, unpatterned, logo-free cases as a P2 with the
explicit reason *"Without them the corpus is an easy-product benchmark."*

Whether the counter-bias worked is measurable from the strata distribution, and
should be checked rather than assumed.

### Capture environment

**Biased toward good conditions.** People photograph carefully when they know
it is for a dataset. Real users scan in dressing rooms, in bad light, at odd
angles, one-handed. `capture_environment` records the condition, and `LOW_LIGHT`
and `RETAIL_FLOOR` are explicitly requested, but a deliberate photograph is
still a deliberate photograph.

*Results from this corpus are likely optimistic relative to real usage.*

### Collector

**Currently the single largest limitation.** With one collector, wardrobe, home
lighting, taste and capture technique are all confounded — you cannot tell which
of them a result is about. `cli.js queue` reports `COLLECTOR COUNT` and the gap
list raises a second collector as a P2 before scaling past the pilot.

### Geography and season

**Unmeasured and unmitigated.** Garment availability, brand mix and even what
counts as "outerwear" vary by market and season. The corpus records no
geography (deliberately — see privacy below) and does not stratify by season.

*A result from this corpus is a result about one place, at one time of year.*

---

## Structural limitations, not just biases

### Zero real cases today

The infrastructure is complete and proved end to end; the collection has not
started. `REAL PILOT: READY_NO_CAPTURES`. Every claim in the power map is
currently `INSUFFICIENT_N` and every metric is suppressed. **No number about
K Scan's accuracy exists in this lane.**

### No Scanner results

`AUTHORIZED_LIVE_EVALUATION_SPEND_USD: 0`. The Scanner has never been run
against this corpus, so every compiled fixture carries an empty candidate list
and scores as `UNKNOWN` / insufficient evidence. `REAL MODEL EXECUTION:
BLOCKED_PROVIDER_AUTHORIZATION`. That is a governance state, not a corpus
failure — and the replay seam exists so that when a live run is eventually
authorized, it can be captured once and scored offline repeatedly.

### The identity denominator is a subset, and a non-random one

Identity metrics are computed only over identity-eligible cases. That is
correct — scoring a case that *cannot* be got right as one that was got wrong
would be worse — but it means the identity rate describes **well-labelled
garments**, not all garments. The report states this in every metric's
`denominatorBasis` rather than leaving it to be inferred.

### Structural QC is not photographic QC

The corpus verifies that a file is a structurally valid image with an intact
hash. It does **not** judge whether a photograph is blurry, badly framed, or of
the wrong garment (design DM-04). That is a human judgment, recorded as one.

### n=30 is not precision

`DECISION_GRADE` means "large enough that a big difference would be visible".
At n=30 a proportion near 0.5 carries roughly a ±18-point 95% interval. Any rate
quoted from this corpus must be quoted with its N.

---

## Privacy posture

- Real image bytes are **never committed**. Metadata and SHA-256 hashes are
  version controlled; the bytes live in a locally mounted asset root. The
  repository is public and a garment photograph can show a collector's home.
- **GPS, XMP location and IPTC city/country data are rejected**, not stripped
  silently. Three carriers are checked, because stripping only the obvious one
  is how location survives sanitization in practice.
- Garment-only captures are preferred. A capture with a person requires
  recorded explicit consent, no unrelated people, and is refused otherwise.
- **No biometric annotation is ever created and no sensitive attribute is ever
  inferred.** The schema refuses those fields outright rather than trusting
  that nobody will add one.
- No geography is recorded. Retailer/location provenance is kept only at the
  non-sensitive level where it is genuinely needed.

---

## How to quote a result from this corpus, if one ever exists

Always together, never separately:

1. the number
2. its **N**
3. its **denominator basis** (which cases it was computed over)
4. its **corpus tier** (`APPROVED_REAL`) and **partition** (development or holdout)
5. its **claim classification** from the power map
6. the sentence: *"Internal engineering evidence only; not production accuracy."*

If any of 1–5 is unavailable, the number is not quotable. `lib/evaluate.js`
attaches all of them to every metric it emits, so this is a matter of not
stripping them out rather than of remembering to add them.
