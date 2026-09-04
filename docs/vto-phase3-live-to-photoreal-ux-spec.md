# Live VTO Phase 3 — Live-to-Photoreal UX Spec (Integration Candidate)

Section 27 deliverable. **Integration-candidate only — no integration code
exists, and none is written by this program**, identical status to Phase
1-2's own `docs/vto-integration-candidate.md`. This document records the
UX shape the isolated `packages/photoreal-bridge` contract was built to
support, so a future, separately-authorized integration pass has a spec to
build against rather than having to reverse-engineer one from the types.

Final production copy is legal/product's call, exactly as Phase 1-2's own
integration candidate already states about its own candidate strings.
**Nothing in this document claims or implies fit accuracy** — every string
below was checked against that rule while drafting it.

## Expected user flow

```
TRY IT ON
   |
LIVE PREVIEW                          state: LIVE_LOCAL
   |
 [Photoreal] tap                       -> requestPhotorealCapture()
   |
privacy disclosure                     state: CAPTURE_CONSENT
   |
 [confirm] tap                         -> requestPhotorealCapture()
   |
explicit still capture                 state: STILL_CAPTURED
   |
 [use this photo] tap                  -> requestPhotorealCapture()
   |
handoff ready                          state: GENERATIVE_HANDOFF_READY
   |
existing AI Photo visualization flow   (VirtualTryOnSheet, unchanged)
```

Each `|` transition above is one explicit user tap, mapped 1:1 onto
`packages/photoreal-bridge`'s `PHOTOREAL_INTENT_TRANSITIONS`
(`photorealIntent.ts`) — there are exactly three transitions, and each
carries `requiresExplicitUserAction: true`. Section 21's own instruction —
"A background timer or tracking event must never trigger cloud upload" — is
why there is no fourth, automatic transition anywhere in this diagram.

## The two experiences, side by side

Candidate copy, drawn directly from `packages/photoreal-bridge/src/
privacyStateModel.ts`'s `PRIVACY_STAGE_COPY` (not invented fresh for this
document, so the doc and the contract cannot drift):

| | LIVE | PHOTOREAL |
|---|---|---|
| **Headline** | Camera processing: on device | Photoreal requested → Photoreal processing |
| **What it does** | Moves with you. Approximate visualization, rendered locally. | Creates a high-fidelity AI image from one captured photo. |
| **Where processing happens** | On this device. | Cloud, for the one still you explicitly chose. |
| **Privacy copy** | "Pose and Live Preview processing happen on this device. A photo is sent only if you choose AI Photo." (`CANDIDATE_PRIVACY_DISCLAIMER`, `@kscan-live-vto/contract`, unchanged from Phase 1-2) | "Cloud processing is active for the explicit still you captured. VISUALIZATION ONLY — NOT A FIT PREDICTION." |
| **Fit language** | None implied — Live is a preview, not a claim. | Explicitly disclaims fit, reusing the existing governed VTO's own disclaimer copy (`AI VISUALIZATION — NOT A PHOTO, AND NOT A FIT PREDICTION`, `components/vto/VirtualTryOnSheet.tsx`) rather than inventing new wording. |

The experience is meant to make the difference **obvious**, not to make one
mode sound better than the other — Live is immediate/private/approximate;
Photoreal is deliberate/cloud/high-fidelity. Neither claims to know how the
garment fits.

## Privacy disclosure — what it must say before capture

Shown at `CAPTURE_CONSENT`, before any still is captured:

> A still image will be sent for AI generation once you confirm the
> capture. Live camera processing remains on this device; only the photo
> you confirm is sent.

Matches `PRIVACY_STAGE_COPY.PHOTOREAL_REQUESTED` in `privacyStateModel.ts`.
Must **not** claim the AI Photo path is zero-knowledge — enforced in the
contract package by `assertNoZeroKnowledgeClaim`, which every candidate
string in that module is tested against
(`packages/photoreal-bridge/src/__tests__/privacyStateModel.test.ts`).

## Return to Live

However the Photoreal attempt ends — success, a failure code (see below),
or the user backing out — the UX returns to Live with its own
acknowledgement rather than silently resuming as if nothing happened:

> Back to Live Preview. Live camera processing remains local. Nothing
> further is sent unless you choose Photoreal again.

(`PRIVACY_STAGE_COPY.RETURN_TO_LIVE`.) `packages/photoreal-bridge/src/
failureModes.ts#handlePhotorealFailure` guarantees every one of the eight
defined failure codes resolves to this same state
(`resultingState: 'LIVE_LOCAL'`, `liveSessionRemainsUsable: true`) — the UX
never needs a per-failure-code recovery path, because the contract only
produces one recovery outcome.

## Failure-mode copy candidates

One line per `PHOTOREAL_FAILURE_CODES` entry (`packages/photoreal-bridge/src/
failureModes.ts`). Candidate only; none of this is wired to a UI string
table:

| Code | Candidate copy |
|---|---|
| `capture_cancelled` | (no message — cancellation is a silent return to Live, matching the existing AI Photo picker's own no-op-on-cancel convention) |
| `no_usable_still` | "That photo couldn't be used. Try capturing again." |
| `garment_not_eligible` | "Photoreal isn't available for this item yet." |
| `bridge_contract_mismatch` | "Something went wrong preparing your photo. Try again." |
| `feature_disabled` | "Photoreal isn't available right now." |
| `entitlement_missing` | routes to the existing K+ upgrade surface, same convention as `TryItOnEntry`'s own entitlement gate — no separate Photoreal-specific paywall copy. |
| `provider_unavailable` | "Photoreal is temporarily unavailable. Try again shortly." |
| `generation_failed` | "That generation didn't work. Try again." |

None of these mention fit, size, or accuracy — every one is about the
operation succeeding or not, never about the garment.

## What this spec deliberately does not do

- It does not add a person-input source. `VtoPersonInputSource` on the
  existing governed VTO remains the single-member union `'photo_library'`;
  a real Photoreal capture path would need exactly the "one addition, one
  producer" change Phase 1-2's own `docs/vto-integration-candidate.md` §3
  already scoped — not proposed or made here.
- It does not change `VirtualTryOnSheet` or any existing AI Photo screen.
  The bridge hands off a request in the existing shape (see
  `docs/vto-phase3-hybrid-contract.md`); the existing sheet renders the
  existing result, unmodified.
- It does not choose real button placement, animation, or visual design —
  those are product/design decisions for a future authorized pass.
