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
| N-02 | Multi-item result: the parent passes a different garment while the sheet is open; must not swap garment, Shop or Watch | visual_search, product_card, closet, elise (shared host) | NEW (`vtoLaunchIdentityPin`). Root cause and fix: the shared host now pins garment, title, Shop, Watch, size guide and loader at open, keyed by identity (product ref + source) |
| N-03 | Several eligible attachments, no explicit focus: no offer; focus on an ineligible item promotes nothing | elise | EXISTS (`vtoEliseContextualOffer` P0-05..07, NC-ELVTO-04) |
| N-04 | Stale binding: candidate deleted, expired, bytes changed, category changed, classification version changed | elise | EXISTS (P0-10..14, P1-15) |
| N-05 | Invalid media: Closet item with no synced garment photo opens no generation surface | closet | EXISTS (`build35OwnedVtoScreen`) |
| N-06 | Invalid media: scan result with no stable product reference offers no try-on | visual_search | EXISTS (`vtoShippedSurfaceReach`) |
| N-07 | Invalid media: malformed base64, wrong type, hash mismatch, oversize garment | elise | EXISTS (P0-17..19, NC-ELVTO-08) |
| N-08 | Unauthorized owned item: another account's Closet item id | closet | EXISTS. Client: `vtoClosetForeignItemRoute` (a foreign id never reaches the resolver or a generation surface; the route loads only the current actor's Closet; malformed ids resolve nothing; mutating the route to load another account's Closet turns 3 of 4 red). Backend: `vtoOwnedGarment.test.ts` (foreign actor, foreign item and foreign storage path refused before signing, with no provider spend or quota). A live Staging negative control is not written and needs synthetic users. |
| N-09 | Account switch mid-resolution (A to B) must not mount A's garment for B | all | EXISTS. Shared request store is actor-epoch scoped: `a result that lands after an actor change cannot attach to the new actor`, the failure variant (`vtoRequestLifecycle`), and `C19: the actor boundary still clears VTO media` (`vtoMediaLifecycle`); Closet route (`build35OwnedVtoScreen`) and Elise (`vtoEliseContextualOffer` P0-09) have route-level tests; the Studio resets per actor (`vtoTryOnStudio`). |
| N-10 | Stale async result after close and reopen | all | PARTIAL: closing releases the pin and the next open uses the garment then shown (NEW, `vtoLaunchIdentityPin`); stale PERSON-photo and request results are handled by the existing request-store token (`vtoRequestLifecycle`, EXISTS) |
| N-11 | Free or unknown K+ never reaches generation; resolving is never Free | all | EXISTS (`vtoCustomerActivation` J2, J5) |
| N-12 | Operator OFF or remote unavailable leaves no actionable control | all | EXISTS (J9, P0-21) |
| N-13 | `entry_point` is bounded, derived only from known labels, adds no media or identifiers | all | NEW (`vtoEntryPointTaxonomy`) |
| N-14 | Dressing Room resume of a deleted or foreign look | dressing_room | N/A (resume not built) |
| N-15 | Studio never opens a generation request without a garment | home_studio | NEW (`vtoTryOnStudio`: no Studio file imports the request store, client, sheet, launcher, camera, picker, storage or network; every action only navigates) |

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
| S5 | Active, has saved looks | NOT BUILT (owner decision needed). A saved try-on is stored as an ordinary Dressing Room `inspiration_item`; the `vto_try_on` variant only changes modal copy and nothing VTO-specific persists, so Recent Looks could only show unrelated Dressing Room records or need a second store. Returning members get a Dressing Rooms navigation action instead | Dressing Rooms, scan, Closet, Elise | Transient images, fabricated entries, unrelated Dressing Room records, a second image store |
| S6 | A minimized, resumable session exists | NOT BUILT. A minimized try-on belongs to the entry that launched it (`VtoLaunchHost` state is per entry by design), so the Studio cannot restore another screen's sheet; a Resume button would do nothing | n/a | A control that does nothing |
| S7 | Live capability router says supported | Live and AI Photo difference, both selectable at launch | as above | Live "coming soon" shown as ready |
| S8 | Live unsupported or native module absent | AI Photo only; no Live line | as above | A simulated or harness Live |
| S9 | Account switch | State recomputed for the new actor; nothing carried over | n/a | Prior account's looks or session |
| S10 | Closet has no eligible item | BUILT AS: the Closet action always navigates to the Closet, where eligible items carry their own Try It On; the Studio does not read the Closet | Scan, Closet, Elise | A fake affordance |

Copy rule: nothing claims fit, size or quality accuracy.

Built in the Studio PR: S0-S4, S7-S9 (`vtoTryOnStudio.test.js` covers every row, plus a 4,608-input invariant grid). S5, S6 and S10 differ from the plan above for the reasons shown in their rows.
