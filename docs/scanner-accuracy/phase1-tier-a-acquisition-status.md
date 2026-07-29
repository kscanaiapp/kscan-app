# Phase 1 — Tier A licensed-web-image acquisition: status

**Pipeline: BUILT AND PROVEN. Corpus: NOT FIT FOR USE YET.**

The governed acquisition machinery works end to end. The images it selected do
not yet constitute a usable benchmark, because keyword search returns
topically-related but subject-wrong photographs. That is a selection problem, not
a licensing or plumbing problem, and it needs per-image visual curation.

---

## What this corpus is, and is not

**It is** a licensed-web-image benchmark. It can support garment category and
subtype accuracy, colour/material/silhouette recognition, visible-brand evidence,
insufficient-evidence handling, non-fashion rejection, and scene robustness.

**It is not** a real-world smart-glasses capture benchmark. It cannot represent
the smart-glasses point of view, wearer motion blur, partial framing inside the
five-second curiosity window, repeated views of the exact same physical garment,
or authentic retail-floor lighting and distance. Tier B real capture covers those
and is deferred to Phase 3. No report may describe Tier A as a complete
real-world benchmark.

## Storage

| Field | Value |
|---|---|
| Location | `C:\Users\jsmit\KScan-eval-storage-private\tier-a` — outside every Git worktree, verified not inside a repository |
| Option used | **Temporary encrypted-volume option** |
| Object storage | **NOT provisioned** — `GOVERNED_STORAGE_DECISION` was never recorded, so the preferred private object storage was not stood up |
| Object names | Opaque: `tiera-{category}-{sanitizedSha10}/primary.jpg`. Never a source filename, never an author name |
| Logical reference | `storage://build4-scanner-evals/tier-a/{caseId}/{viewId}` |
| Images in Git | **zero** |

The temporary option carries the limitation already documented: a single
workstation, no access logging, and it cannot support two independent reviewers —
which the holdout requires. Migration to object storage is still required.

## Licence policy — and why Commons only

Accepted: CC0, public domain, CC BY 2.0/2.5/3.0/4.0, CC BY-SA 2.0/2.5/3.0/4.0.

Rejected: anything NonCommercial (this is a commercial product's evaluation),
anything NoDerivatives (a sanitised EXIF-stripped copy is a derivative), non-free
or fair-use, GFDL-only, and **anything unrecognised — an unknown licence string
is a rejection, never a default-accept**.

Of the four named repositories, only **Wikimedia Commons** was used. The stated
rejection rule is "reject any image whose licence, author, source page or
permitted reuse cannot be proven". Commons exposes, per file and queryably, a
versioned standard licence, the author string and a stable file page. Unsplash,
Pexels and Pixabay each publish a single site-wide licence whose stance on
ML/AI-evaluation use is not stated per asset, so permitted reuse cannot be proven
to the same standard. That is recorded as a decision, not assumed away — the
owner may overrule it, but it should be an explicit choice.

### The rejection logic did real work

| Reason | Count |
|---|---|
| HTTP 429 rate-limited *(my defect — see below)* | 15 |
| File carries `personality` restrictions | 2 |
| Unrecognised licence: `No restrictions` | 2 |
| Unrecognised licence: `GODL-India` | 2 |
| Unrecognised licence: `Copyrighted free use` | 1 |
| Unrecognised licence: `Attribution` (unversioned) | 1 |

The personality-rights and unrecognised-licence rejections are exactly the cases
a human skim would have waved through.

## Defect found and fixed: no rate limiting

The first real run hammered `upload.wikimedia.org` with no delay and took **15
HTTP 429s**. Those 429s silently truncated coverage — the last three specs (store
display, mirror, non-fashion) returned **zero images purely because they ran
last**, not because nothing qualified.

Fixed: a 1200 ms politeness interval plus exponential backoff on 429, and
rate-limit failures are now classified `transport_rate_limited` so a truncated run
can never be mistaken for a licence rejection. Rate limiting is not optional
against a donated public archive.

## Acquired

22 images, all sanitised (every JPEG APPn and COM segment stripped: EXIF, XMP,
Photoshop IRB, comments), original and sanitised SHA-256 both recorded, 22
distinct content hashes, 77 MB.

| Category / scene | Acquired | Target |
|---|---:|---:|
| top / product | 3 | ~10 |
| pants / product | 3 | ~9 |
| dress / product | 3 | ~7 |
| outerwear / product | 3 | ~10 |
| footwear / product | 3 | ~10 |
| bag / product | 3 | ~8 |
| accessory / eyewear | 2 | ~5 |
| accessory / jewelry | 2 | ~4 |
| **store display** | **0** | 3 |
| **mirror** | **0** | 5 |
| **non-fashion negatives** | **0** | 6 |
| **screenshots / product pages** | **0** | 5 |
| **low-light / blur / occlusion** | **0** | 8 |

## Why the corpus is not usable yet

**Keyword search selects on topic, not subject.** Verified by opening the files:

- `T-shirt printer at Rapanui Clothing` — labelled `top / product`, is actually a
  **screen-printing factory floor with no garment in frame**. Opened and
  confirmed visually.
- `Women washing clothes 4.jpg` — labelled `dress / product`, is a washing scene.
- `Handbag (drawing).jpg` — labelled `bag / product`, is a **drawing**, not a
  photograph.
- `Purse (AM 13345-9)`, `Neolithic talc necklace`, `Traditional clothes Mosul
  Heritage Museum` — museum and archaeological artifacts, not contemporary
  garments a scanner would meet.

At minimum 6 of 22 are subject-wrong. A benchmark containing a printing machine
labelled `top` would produce accuracy numbers that describe the search query, not
the model. **These must not be labelled and frozen as-is.**

**Screenshots are structurally unobtainable here.** A screenshot of a retailer
product page contains that retailer's copyrighted imagery, so it cannot carry a
provable free licence. That stratum cannot come from Commons at all and needs a
separate owner decision.

## Required before Tier A can be frozen

1. **Per-image visual curation** — every candidate opened and confirmed to show
   the labelled garment as its subject. This is the step that cannot be skipped,
   and keyword search cannot substitute for it.
2. **Better retrieval** — prefer Commons *categories* (e.g. `Category:Sneakers`)
   over free-text search, which is far more precise than keyword matching.
3. **Re-run the missing strata** now that rate limiting exists.
4. **Decide the screenshot stratum** — either drop it from Tier A and defer to
   Tier B, or accept the licensing exposure with legal review.
5. **Storage decision** — the temporary volume blocks two-reviewer holdout work.
6. **Reviewer staffing** — still unresolved.

## Honest count

Real governed cases fit for labelling today: **at most 16 of 22**, and none has
been labelled or reviewed.

Against the thresholds: 75 is the full baseline, 50–74 is a pilot requiring
separate approval, and **under 50 means no paid accuracy baseline may run**. At 16
usable and unlabelled, Tier A is **below the pilot floor**.
