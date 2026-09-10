# Decision Memos (section 16)

Format per section 16: QUESTION / EVIDENCE / OPTIONS / SAFE DEFAULT / RISK /
REVERSIBILITY / DECISION.

---

## DM-01 — Do we build a canonical `addOwnedItem` ownership service?

**QUESTION.** Section 41 permits a thin Closet-owned ownership service "if a truly common seam
exists". Does one?

**EVIDENCE.** `createClosetItem` (`services/closetLibrary.js:892`) is the only function that commits
an owned Closet item. Exhaustive grep over `app/`, `components/`, `hooks/`, `services/` finds
exactly three call sites: `useCloset.addFromUri` (direct intake), `closetPromotion.js:143` (Recent
Scan promotion), and `closetCandidatePromotion.js:443` (batch review). Nothing else writes
`kscan_closet.json` — `persistCloset` has 9 call sites, all inside `closetLibrary.js`, and none of
the other 8 creates ownership. `createClosetItem` already centralizes exactly the five things
section 41 lists: explicit-ownership requirement, idempotency (provenance + lineage, checked twice),
input normalization (the allowlist builder), actor binding (`resolveWriteAuthority`, re-validated
after async media work), and the write primitive itself.

**OPTIONS.**
- (a) Add `services/closet/addOwnedItem.ts` wrapping `createClosetItem` and re-point the three
  callers at it.
- (b) Declare `createClosetItem` the canonical ownership service, document it, and lock the
  invariant with a test.

**SAFE DEFAULT.** (b).

**RISK.** (a) touches all three intake paths — the highest-risk files in the program — to add a
layer that centralizes nothing not already central. Section 42 permits routing changes, but permission
is not a reason. Every such edit is a chance to change promotion or candidate-commit semantics by
accident, and section 37's legacy-safety gate would have to be re-proved for a refactor that buys
nothing. (b) risks only that a *future* fourth intake path bypasses the seam — which is a test's job,
not a wrapper's.

**REVERSIBILITY.** (b) is fully reversible: the wrapper can be added later if a fourth caller ever
needs behaviour the primitive should not have. (a) is not cheaply reversible once three call sites
have moved.

**DECISION.** (b). `createClosetItem` **is** the canonical ownership service. PR A2 adds
`__tests__/closetOwnershipSeam.test.js`, which fails if any new file reaches the Closet manifest
without going through it, and if the ownership-creating call-site set changes without the test being
updated deliberately. Section 40's rule — "do not refactor simply because they differ" — applies
here in its strongest form: they do not even differ.

---

## DM-02 — Does user-correction precedence need durable provenance now?

**QUESTION.** Section 45: explicit user correction must outrank inferred metadata. Does any
CURRENT background writer overwrite a corrected field? If not, section 45 says do **not** add a
schema migration for a hypothetical future inference engine.

**EVIDENCE.** Every writer that can touch a taxonomy field on an existing record:

| Writer | Can overwrite a corrected field? | Why |
| --- | --- | --- |
| `updateClosetItem` | n/a — it **is** the correction path | user-initiated |
| `repairClosetItemTaxonomy` | **NO** | skips any field where `isAbsentClosetTaxonomyValue` is false. A present value always wins; the source comment states this is deliberate ("a promotion retry is not a licence to overwrite what the user has"). |
| `createClosetItem` | **NO** | on a provenance/lineage hit it returns the existing item with `deduped: true` and writes nothing. |
| `applyRestoredClosetItemMedia` | **NO** | media fields only, and deliberately does not touch `updatedAt`. |
| `materializeRestoredClosetItem` | **NO** | creates a record that does not exist locally. |
| `applyRestoredClosetItemFacts` | **YES, mechanically** — `buildClosetRecord({...current, ...facts})` lets remote facts win. | **But it is unreachable for a dirty item:** `closetRestoreContract.classifyClosetRestoreAction` compares `localUpdatedAt !== entry.syncedLocalUpdatedAt` and returns `'dirty'`; a dirty local item with a newer remote row classifies as `conflict_remote_newer`, which records a conflict and **returns before** any apply. `updateClosetItem` always stamps a fresh `updatedAt`, so a correction always makes the item dirty. |

So: no current writer can overwrite a user correction. There is exactly one mechanically-capable
writer, and the conflict classifier gates it. That gate is load-bearing and was previously covered
only indirectly.

**OPTIONS.**
- (a) Add a `fieldProvenance` / `userCorrectedFields` column + local field now, propagate through
  sync, restore and historical migration, cover it in account deletion.
- (b) Preserve precedence at the current mutation boundaries, lock the invariant with direct tests
  including a hostile one against `applyRestoredClosetItemFacts`, and document the future requirement.

**SAFE DEFAULT.** (b).

**RISK.** (a) means a Staging migration, a new nullable actor-scoped field that must survive sync,
restore and historical migration, plus new account-deletion coverage — a new durable data class
(section 73) bought for a writer that does not exist. It also risks the classic half-migration: a
client-only provenance field would be **insufficient** by section 45's own rule, because a restore
from another device would not carry it. (b) risks that a future inference engine is added without
its author noticing the precedence rule — which the tests in (b) are designed to catch at that
moment, since they will be the thing that turns red.

**REVERSIBILITY.** (b) is additive-later. (a) is a schema change and is not.

**DECISION.** (b). PR A2 does **not** add a provenance column. It adds
`__tests__/closetCorrectionPrecedence.test.js`, which drives the real store on an in-memory
filesystem and proves: a corrected field survives a promotion retry, survives a taxonomy repair,
and — the hostile case — that a restore pass classifies a corrected item as a conflict rather than
applying remote facts over it. The future requirement (if durable provenance is ever needed, it
must survive sync **and** restore, not be client-only) is recorded in
`docs/closet-productization/05-future-requirements.md`.

---

## DM-03 — Can the review queue remember "dismissed without fixing"?

**QUESTION.** Section 49: derived state cannot remember a dismissal. Do we add durable dismissal?

**EVIDENCE.** Section 48 requires the review queue to begin as *derived* state — no new table, no
task system, no queue backend. A dismissal that survives an app restart is by definition durable,
per-item, per-actor state, and would need: a local store, actor partitioning, account-deletion
coverage, and a sync/restore story (a dismissal that does not travel between devices would re-nag on
the second device, which is the exact failure dismissal exists to prevent). No existing store in the
Closet has a natural place for it — the sync sidecar is keyed to cloud state and is explicitly not a
general per-item metadata store.

**OPTIONS.**
- (a) Ship a Dismiss button backed by new durable state.
- (b) Ship no Dismiss button. Resolution is editing the item; the condition then disappears on its own.

**SAFE DEFAULT.** (b) — section 49 names it as the safe V1 default.

**RISK.** (a) creates a new undeletable-by-default data class for a convenience, and a
device-local-only version would actively misbehave across devices. (b) risks a user who does not
want to fill in a brand seeing that item listed as reviewable indefinitely. Section 50's volume
guard is what keeps that from becoming nagging: the Closet Home shows **one** coalesced line, never
a per-item pile.

**REVERSIBILITY.** (b) is fully reversible.

**DECISION.** (b). No Dismiss button in V1. The review list is derived, the count is truthful, and
Closet Home coalesces. Users resolve an item or leave it.

---

## DM-04 — Which fields does PR A2 make correctable?

**QUESTION.** Section 44: expose only real supported fields. `updateClosetItem` accepts
`title`/`category`/`notes`. Do we widen it?

**EVIDENCE.** The record stores 8 taxonomy fields (`CLOSET_ITEM_TAXONOMY_FIELDS`) and `notes`. Six
of the eight are writable **only** by `repairClosetItemTaxonomy`, which fills absent fields and
refuses to change a present one. The coverage audit (doc 02) shows two of the three intake paths
populate none of those six. Net effect today: a Recent-Scan-promoted item can never acquire a brand,
and a mis-classified colour can never be corrected.

**OPTIONS.**
- (a) Leave `updateClosetItem` alone; add correction later.
- (b) Widen `updateClosetItem` to the full committed taxonomy plus `notes`, through the **existing**
  `normalizeClosetTaxonomyValue` normalizer and the existing allowlist.

**SAFE DEFAULT.** (b), scoped to fields the record already stores.

**RISK.** (b) is a genuine write-path change and is the highest-risk item in PR A2. It is bounded
by: reusing the existing per-field normalizer (so bounds cannot drift from the builder's), touching
no identity/ownership/media/provenance field, and running under the existing serialized mutation
queue and actor authority. (a) leaves the product unable to correct its own classifier — which
makes the Closet a worse wardrobe truth layer, the exact opposite of the program's purpose
(section 88).

**REVERSIBILITY.** Fully reversible: it widens an allowlist, it does not migrate data. No stored
record changes shape.

**DECISION.** (b). `updateClosetItem` accepts the 8 taxonomy fields plus `title` and `notes`.
Identity, ownership, media, provenance, lineage, timestamps and `origin` remain unreachable through
it. A field the record does not store remains unsettable — no speculative fields (section 44).
