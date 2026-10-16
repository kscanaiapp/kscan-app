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
- Branch / PR / SHA: `feat/vto-entry-point-taxonomy`; PR and SHA recorded on merge.
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

## Findings for the Elise lane (not repaired here)

None recorded yet.
