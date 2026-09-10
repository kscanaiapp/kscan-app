# Metadata Coverage Gate (sections 21, 22)

## Why this audit is structural, not empirical

Staging (`yzqjvdfgefveprobvvyw`) was queried read-only at dispatch:

```sql
select count(*) as total_rows, count(distinct user_id) as distinct_actors
from public.user_closet_items;
```

Result: **`total_rows = 0`, `distinct_actors = 0`.**

There is no real Closet population anywhere to measure. Cloud Closet is K+ gated and nobody has
synced a row. Reporting "0% populated" from an empty table would be a measurement of nothing.

So coverage is measured **structurally** instead: for each intake path that can create an owned
item, which taxonomy fields can that path *ever* populate? A field no shipping intake path writes
has a hard 0% ceiling regardless of how many rows exist, and that is a stronger, falsifiable claim
than a sample.

## The three intake paths and what each can populate

All four EAS profiles set `CLOSET_SEPARATION_V1`, `CLOSET_DIRECT_INTAKE_V1`,
`CLOSET_CANDIDATE_STAGING_V1` and `CLOSET_BATCH_REVIEW_V2` to `"true"`, so all three paths ship.

| Field | 1. Direct intake (`ClosetIntakeModal`) | 2. Recent Scan promotion (`mapScanToClosetDraft`) | 3. Candidate promotion (`closetCandidatePromotion`) |
| --- | --- | --- | --- |
| `title` | user-typed, optional | = `category`, else "Closet item" | classifier |
| `category` | user-typed, optional | `scan.attributes.category` | classifier |
| `clothingType` | **never** | **never** | classifier |
| `subtype` | **never** | **never** | classifier |
| `brand` | **never** | **never** | classifier |
| `primaryColor` | **never** | **never** | classifier |
| `secondaryColors` | **never** | **never** | classifier |
| `material` | **never** | **never** | classifier |
| `size` | **never** | **never** | classifier |
| `notes` | **never** (not in the modal) | always `null` | — |
| `imageUri` | always | always | always |
| `origin` | `direct_intake` | `recent_scan` | `direct_intake` |

Sources: `components/closet/ClosetIntakeModal.tsx` (two inputs only: "Name (optional)",
"Category (optional)"); `services/closetPromotion.js:91` `mapScanToClosetDraft` (builds a draft
with `title`, `category`, `notes: null`, `origin` and four internal ids — **no other taxonomy
field is even referenced**); `services/closetCandidatePromotion.js` (verifies full taxonomy
read-back after commit).

## Findings

**F-COV-1 — Recent Scan promotion is a taxonomy funnel with one hole.**
`mapScanToClosetDraft` reads exactly one attribute off the scan: `attributes.category`. A scan that
identified a brand, a colour and a subtype loses all of them at the Closet boundary, and `title`
becomes the bare category string. This is an **upstream metadata pipeline finding** (section 22),
not something PR A1 may paper over with a filter.

**F-COV-2 — Direct intake collects no structured taxonomy beyond category.**
Two optional text inputs. A user who photographs a garment cannot record its brand, colour or size
at intake.

**F-COV-3 — Only candidate promotion produces a full-taxonomy item.**
It is the one path that can populate all 8 fields, and it does verify them on read-back.

**F-COV-4 — `notes` is unreachable.** `updateClosetItem` accepts a `notes` patch and the record
stores it, but no shipping UI writes it: it is absent from both `ClosetIntakeModal` and
`ClosetItemEditModal`.

## Coverage-gate decision (section 22)

Rule: a field needs **>= 70% populated** to earn a primary filter, unless it is structurally
mandatory and proven reliable.

| Field | Structural ceiling | Primary filter in A1? | Why |
| --- | --- | --- | --- |
| `category` | written by all 3 paths | **YES** | The only taxonomy field every intake path can write. Also the field `Uncategorized` is defined against. |
| `title` | always present (defaulted) | **YES — search only** | Structurally mandatory (`'Closet item'` default), so filtering on it is meaningless, but searching it is not. |
| `origin` | always present, closed 2-value enum | **YES** | Structurally mandatory and server-validated by a CHECK constraint. |
| `createdAt` | always present | **YES — sort only** | Structurally mandatory. Labelled "Added", never "Purchased". |
| `brand` | 1 of 3 paths | **NO** | Below floor by construction. Searchable, and reported by Intelligence as a coverage number — never featured as a primary filter or a "favourite brand". |
| `primaryColor` | 1 of 3 paths | **NO** | Same. |
| `clothingType`, `subtype`, `secondaryColors`, `material`, `size` | 1 of 3 paths | **NO** | Same. |

**A1 therefore ships: search (title + the taxonomy text the item actually has), one primary filter
dimension (category, including `Uncategorized`), an origin filter, and four sorts.** Below-floor
fields remain visible on the item and searchable, but are never presented as a polished filter over
data that mostly does not exist.

## What would move a field above the floor

Not this lane's work, recorded for the program:

1. Carry the scan's full attribute set through `mapScanToClosetDraft` instead of just `category`.
   (Scanner behaviour is diff-fenced in this lane; this is a Scanner/Closet contract change.)
2. Add structured taxonomy inputs to `ClosetIntakeModal`.

PR A2 does the half of this that is inside the Closet boundary: it makes every taxonomy field
**user-correctable**, so a user can supply what the pipeline did not.
