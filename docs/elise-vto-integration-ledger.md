# Elise to VTO to Elise integration change ledger

Maintained by the VTO lane for the dedicated Elise engineering lane and the
Build 35 integration manager. Records every change that touches the Elise,
VTO, Elise customer journey. The VTO lane does not modify Elise Speech, avatar
animation, memory, conversation orchestration or message rendering beyond the
authorized VTO offer boundary. Defects found in those systems are recorded
here as P4-P6 findings and are not repaired in this lane.

## Standing contract (as audited, unchanged)

- Offer component: `components/style-chat/EliseVtoOffer.tsx`, launch via the
  shared `VtoLaunchHost` with `origin="elise"`.
- Garment-context handoff: an opaque binding id is carried in the synced
  `ui_block`; the garment candidate itself stays on device, bound to the send
  snapshot; the tap revalidates the fingerprint (deleted, expired, bytes,
  category and classification version all make the action unavailable).
- Authorization: K+ resolved through the shared entitlement path; Free opens
  the one shared K+ gate; unknown never grants; third-party consent required
  before any image is read.
- Model output cannot create or alter the offer.

## Entries

### E-001 entry-point attribution for Elise offer events
- Branch / PR / SHA: `feat/vto-entry-point-taxonomy`; PR #608; merged `75384a6`.
- Files: `services/vto/vtoTelemetry.ts` (sink adds `entry_point`),
  `services/vto/vtoOrigins.ts` (new), and test expectations in
  `__tests__/vtoEliseContextualOffer.test.js`.
- Contract: every `elise_vto_offer_*` event and every sheet event launched from
  Elise now carries `entry_point: "elise"`, derived from `origin: "elise"`.
- Customer-facing behavior: none.
- Authorization: unchanged.
- Speech / animation interaction: none; no Speech, avatar, memory,
  orchestration or rendering file touched.
- Regression tests: `vtoEliseContextualOffer` 77/77 after expectation updates
  (5 exact-payload assertions gained `entry_point`; the allowed-key pin gained
  `entry_point`); `vtoEntryPointTaxonomy` covers the Elise mapping.
- Outstanding defects: none.

### E-002 Studio navigation to Elise, and a route-inventory test update
- Branch / PR / SHA: `feat/vto-try-on-studio`; PR #610; merged `c413daa`.
- Files: `app/try-on-studio.tsx` (navigation only) and `__tests__/vtoEliseContextualOffer.test.js` (test only).
- Contract: the Try-On Studio's "Ask Elise for styling help" action calls `router.push('/style-chat')`, the same route Home already uses. It passes no garment, no context and no params. It opens a normal conversation; it creates no offer, binding or message.
- Test change: the route-inventory guard in `vtoEliseContextualOffer.test.js` asserted "no standalone VTO destination" by file-name pattern, which the new Studio route trips. It now excludes exactly `app/try-on-studio.tsx`. Its other assertions are untouched and still prove the sheet is mounted in exactly one place and that the Studio is not a launch-host user. A second VTO-named route still fails it (negative control run).
- Customer-facing behavior: a new way to open the existing Elise conversation list. The Elise offer, its garment-context handoff and its return behavior are unchanged.
- Authorization: unchanged. The Studio is reachable by any signed-in customer when VTO UI is on; try-on itself still requires K+, consent and the operator switch.
- Speech / animation interaction: none. No Speech, avatar, memory, orchestration or rendering file touched.
- Regression tests: `vtoEliseContextualOffer` 77/77; `vtoTryOnStudio` 30/30.
- Outstanding defects: none.

### E-003 shared launch host pins the tapped garment
- Branch / PR / SHA: `feat/vto-launch-identity-pin`; PR #611; SHA recorded on merge.
- Files: `components/vto/VtoLaunchHost.tsx` and `__tests__/vtoLaunchIdentityPin.test.js`.
- Contract: `EliseVtoOffer` launches through `VtoLaunchHost` with `origin="elise"`. The host now captures the garment, title, Shop, Watch, size guide and inline-garment loader when the sheet opens, keyed by identity (product reference plus source: Closet item id or supplied-garment content hash). If the parent later passes a different identity while the sheet is open, the captured values stay until the sheet closes. An unchanged identity passes through.
- Garment-context handoff: unchanged. Elise resolves and revalidates the garment at tap time (fingerprint, binding, actor) and hands the host one fixed garment; the pin only prevents a later in-place swap of that garment. Elise's inline loader is pinned together with its garment, so a supplied garment's bytes can never be read for a different garment's launch.
- Return-to-conversation behavior: unchanged. Closing the sheet releases the pin.
- Customer-facing behavior: none in normal use.
- Authorization: unchanged (K+, consent, operator switch and quota are not touched).
- Speech / animation interaction: none. No Speech, avatar, memory, orchestration or rendering file touched.
- Regression tests: `vtoEliseContextualOffer` 77/77 and the full VTO set (805 tests, 1 pre-existing environmental failure identical on the untouched tip); `vtoLaunchIdentityPin` 8/8.
- Outstanding defects: none.

## Findings for the Elise lane (not repaired here)

None recorded yet.
