# Future Requirements and Findings (not this lane's work)

Everything here is **documented only**. Nothing below is implemented, imported or
promoted by PRs A1, A2 or B.

---

## FR-1 — If durable correction provenance is ever needed, it must survive restore

DM-02 decided not to add a provenance column, because no current writer can
overwrite a user correction. If a future inference engine changes that, the
requirement is not "add a field":

- Client-only provenance is **insufficient**. A restore from another device
  would not carry it, so the correction would be re-inferred away on the second
  device — the exact failure the field was added to prevent.
- It must be additive, nullable, actor-scoped, backward-compatible, and
  tolerated by sync, restore and historical migration.
- It must be covered by account deletion (section 73).
- Staging only. Production is NO-TOUCH.

### The one honest limitation this leaves today

A user who **clears** a field to absent is indistinguishable from a field that
was never set, so `repairClosetItemTaxonomy` will backfill it on a later
promotion retry. This is asserted as a known property, not hidden:
`__tests__/closetCorrectionAuthority.test.js` →
*"PRECEDENCE: a repair still fills a field the user CLEARED to absent"*.

Fixing it is precisely what durable provenance would buy, and it is the trigger
condition for revisiting DM-02.

---

## FR-2 — Duplicate detection needs a stable product identity that does not exist yet

`findDuplicateCandidates` returns nothing and reports
`unavailable_no_stable_identifier`. That is section 61's own rule, not a gap in
the implementation: a committed Closet record carries **no product id, no SKU and
no GTIN/UPC/EAN**. Its only stable identifiers are internal provenance
(`sourceCandidateId`, `sourceLineageId`), which are dropped by the read
projection and are already unique by construction.

Where a real canonical identity could eventually feed in (section 63,
**documentation only** — PR #318's resolver is experimental and must not be
imported or promoted):

| Join point | What it would enable |
| --- | --- |
| Intake (`createClosetItem`) | Record a canonical product id at commit time, so identity exists before any comparison is attempted. |
| `findDuplicateCandidates` | Exact-identity pairing on that id. Still exact — never similarity. |
| Cross-retailer identity | Recognise the same garment recorded from two different retail sources. |

Until a canonical id is **persisted on the record**, V1's answer stays: no
identifier, no candidate.

---

## FR-3 — Recent Scan promotion drops the scan's taxonomy (upstream metadata finding)

`services/closetPromotion.js#mapScanToClosetDraft` reads exactly one attribute off
the scan — `attributes.category` — and sets `title` to that bare category string.
A scan that identified a brand, a colour, a material and a subtype loses all of
them at the Closet boundary.

This is the single biggest reason the coverage audit's structural ceiling for six
of eight taxonomy fields is "1 of 3 intake paths". It is **not** repaired in this
lane: Scanner behaviour is diff-fenced (section 77), and carrying the full
attribute set across is a Scanner/Closet contract change that needs its own
review.

PR A2 does the half that is inside the Closet boundary: every taxonomy field is
now user-correctable, so a user can supply what the pipeline did not.

---

## FR-4 — Direct intake collects almost nothing

`components/closet/ClosetIntakeModal.tsx` offers two optional text inputs (Name,
Category). A user photographing a garment cannot record its brand, colour or size
at the moment they add it — only afterwards, through the A2 edit sheet.

Adding structured inputs to intake is a straightforward follow-up and would lift
several fields toward the 70% filter floor.

---

## FR-5 — The Elise/Concierge evaluation fixtures model a wardrobe the Closet cannot produce

Found by the section 20 bridge and now **failing CI if it grows**
(`__tests__/closetContractBridge.test.js`).

`tools/elise-concierge-eval/fixtures/closets/closets.json` describes items with:

| Fixture field | Real Closet |
| --- | --- |
| `subcategory` | renamed — the Closet stores `subtype` |
| `colors` | reshaped — the Closet stores `primaryColor` + `secondaryColors` |
| `colorFamilies` | **not stored** — eval-only enrichment |
| `materials` | renamed — the Closet stores `material` (singular) |
| `formality` | **not stored** |
| `layeringRole` | **not stored** — derived server-side by `eliseClosetCensus.inferLayeringRole(category, subtype)` |
| `seasons` | **not stored** |

Three of these are cosmetic renames. Four are facts a Closet **cannot supply at
all**, which means any Elise/Concierge evaluation that depends on them is scoring
against a wardrobe richer than the product can produce.

This lane deliberately does **not** change Elise behaviour or the fixtures
(section 20 says validate the instrument, not the system). The drift is now
declared in the bridge test as a bounded, named set: a *new* divergent field
fails CI, while the known seven are documented with their real-Closet
counterparts. Reconciling them is an owner/product decision, because it changes
what the evaluation measures.

---

## FR-6 — Dark code in the free-tier wardrobe utility

`components/free-tier/ClosetFilterBar.tsx`, `components/free-tier/EmptyClosetUtilityState.tsx`,
`hooks/useClosetFilters.ts` and `services/free-tier/closetFilters.ts` are imported
by nothing. They operate on `NormalizedItem`, not `ClosetItemProjection`, so they
were not a usable base for A1. Left in place — deleting them is out of this
lane's scope.

---

## FR-7 — The base commit's CI is already red (BLOCKER, not caused by this lane)

`.github/workflows/security-code.yml` runs `node scripts/run-all-tests.js`
absolutely at every enforcement level, and that runner exits 1 on unexpected
failures. At the accepted authority `219f27aa`, **4 tests already fail
unexpectedly** — all in the Curiosity Gap Performance Lab (PR #315 lane), whose
`source-bindings.json` pins content hashes for 10 Scanner/commerce files that have
since moved on.

Consequence: **no PR branched from `219f27aa` can show green CI**, including these
three. This lane cannot fix it — those 10 files are outside its diff fence, and
widening the shared `config/test-failure-baseline.json` for another lane's stale
ledger is a governance change affecting every lane, which is an owner decision
(and would mask a real signal).

The fix belongs to the owning lane: regenerate
`tools/curiosity-gap-performance/authority/source-bindings.json` against current
source, or record the four identities in the failure baseline deliberately.
