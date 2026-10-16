# VTO discovery and integration: matrices

Working record for the Build 35 VTO discovery lane. Written before the code it
governs. Status words are literal: **EXISTS** (a test in the tree already proves
it), **NEW** (added by the PR that carries this file), **GAP** (not yet covered;
scheduled), **N/A** (surface not built yet).

## 1. Entry-point taxonomy

`services/vto/vtoOrigins.ts` is the single documented mapping. The telemetry
sink carries a written-out mirror (it must stay import-free) and
`__tests__/vtoEntryPointTaxonomy.test.js` fails on any difference across every
origin x surface combination.

| entry_point | Launch `origin` | Awareness `surface` |
|---|---|---|
| `home_studio` | (none: Home has no product) | `home` |
| `elise` | `elise` | (none) |
| `visual_search` | `scan_result`, or `commerce_product` + surface `scan_result` | `scan_result` |
| `closet` | `closet_item` | (none) |
| `product_card` | `commerce_product` | `product`, `commerce` |

Unattributed (no `entry_point` emitted, never guessed): `dressing_room`,
`dev_harness`, `coachmark`, `kplus_step6`. `watch_notification` is not in the
taxonomy because no real authorized entry point exists for it.

Change in this PR: the scan-result panel launches with `origin="scan_result"`
(an existing, previously unused origin) instead of `commerce_product`, so every
step after the tap, not only the awareness events, attributes to Visual Search.
The server treats `origin` as a label and consults only `closet_item`.

Open owner decision: a Dressing Room *resume* launch is currently unattributed.
Add a sixth value only if its conversion must be measured separately.

## 2. Launch-contract negative test matrix

Hard gate: a garment selected in Visual Search, Elise or Closet never silently
becomes a different garment when VTO opens.

| ID | Negative case | Entry | Status |
|---|---|---|---|
| N-01 | Launched garment differs from the row the customer tapped | visual_search, product_card | EXISTS (`vtoShippedSurfaceReach`: each row carries the garment for its own product); host-level equality assertion GAP |
| N-02 | Multi-item result: selection changes while the sheet is opening or resolving; must not swap garment | visual_search | GAP |
| N-03 | Several eligible attachments, no explicit focus: no offer; focus on an ineligible item promotes nothing | elise | EXISTS (`vtoEliseContextualOffer` P0-05..07, NC-ELVTO-04) |
| N-04 | Stale binding: candidate deleted, expired, bytes changed, category changed, classification version changed | elise | EXISTS (P0-10..14, P1-15) |
| N-05 | Invalid media: Closet item with no synced garment photo opens no generation surface | closet | EXISTS (`build35OwnedVtoScreen`) |
| N-06 | Invalid media: scan result with no stable product reference offers no try-on | visual_search | EXISTS (`vtoShippedSurfaceReach`) |
| N-07 | Invalid media: malformed base64, wrong type, hash mismatch, oversize garment | elise | EXISTS (P0-17..19, NC-ELVTO-08) |
| N-08 | Unauthorized owned item: another account's Closet item id | closet | PARTIAL: client actor scope EXISTS; explicit foreign-id route test GAP; backend negative control against Staging GAP |
| N-09 | Account switch mid-resolution (A to B) must not mount A's garment for B | closet EXISTS, elise EXISTS (P0-09), visual_search GAP, home_studio N/A | PARTIAL |
| N-10 | Stale async result after close and reopen | all | GAP |
| N-11 | Free or unknown K+ never reaches generation; resolving is never Free | all | EXISTS (`vtoCustomerActivation` J2, J5) |
| N-12 | Operator OFF or remote unavailable leaves no actionable control | all | EXISTS (J9, P0-21) |
| N-13 | `entry_point` is bounded, derived only from known labels, adds no media or identifiers | all | NEW (`vtoEntryPointTaxonomy`) |
| N-14 | Dressing Room resume of a deleted or foreign look | dressing_room | N/A (resume not built) |
| N-15 | Studio never opens a generation request without a garment | home_studio | N/A (Studio not built) |

## 3. Try-On Studio state matrix

Permanent Home entry, no new bottom tab. Small and functional. Reuses
`useVtoAvailability`, `resolveVtoActorKPlusState`, the awareness record and the
existing shared launcher. It never starts a generation by itself: every action
navigates to a place where a real garment is chosen.

| # | Inputs | Studio shows | Actions | Never |
|---|---|---|---|---|
| S0 | Build flag `VTO_UI_ENABLED` off | Nothing | none | A teaser |
| S1 | Operator OFF, or remote config unreadable | Plain "not available right now" | none that imply try-on works | Photo shown as available |
| S2 | K+ or availability still resolving | Neutral placeholder | none | A K+ marker (resolving is not Free) |
| S3 | Free, Photo available | AI Photo explainer, K+ marker before any tap | Scan a garment, Closet, Ask Elise (ordinary navigation) | A new paywall, free allowance or price |
| S4 | Active or complimentary, no saved looks | AI Photo explainer | Scan, choose from Closet, Ask Elise | Live unless the capability router allows it |
| S5 | Active, has saved looks | Small Recent Looks from the existing authorized saved-look store, plus actions | Open look, scan, Closet, Elise | Transient images, fabricated entries, unrelated Dressing Room records, a second image store |
| S6 | A minimized, resumable session exists | Resume row | Resume (existing pill/restore) | Resuming another account's session |
| S7 | Live capability router says supported | Live and AI Photo difference, both selectable at launch | as above | Live "coming soon" shown as ready |
| S8 | Live unsupported or native module absent | AI Photo only; no Live line | as above | A simulated or harness Live |
| S9 | Account switch | State recomputed for the new actor; nothing carried over | n/a | Prior account's looks or session |
| S10 | Closet has no eligible item | "Choose from Closet" omitted or explained | Scan, Elise | A dead end |

Copy rule: nothing claims fit, size or quality accuracy.
