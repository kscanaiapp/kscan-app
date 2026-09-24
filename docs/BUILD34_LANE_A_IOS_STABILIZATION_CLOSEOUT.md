# K SCAN AI — BUILD 34 — LANE A — iOS STABILIZATION CLOSEOUT

Release train: Build 33 / iOS 1.0.1 is public. iOS 1.0.2 is the **internal**
stabilization baseline this lane closes out. Build 34 / iOS 1.1.0 is the next
public release and adds paid K+ in its own lane. This lane is not a public 1.0.2
release, adds no purchase code, and does not change the marketing version.

This document records the client-side repairs, what proves each, and what still
needs a device. Backend and store-configuration findings that need an owner
decision are tracked outside this repository, in the lane report delivered with
the pull request.

## 0. Authority

| | |
|---|---|
| Source branch | `release/kscan-pre-freeze-v1` |
| Source SHA (start of lane) | `60b158a59164126b91818b84ef839cd5d0589d0f` (merge of PR #467) |
| Repair branch | `repair/build34-ios-stabilization-closeout-v1` |
| Authority moved forward | twice, by fast-forwards while the lane was open: to `813c95a25117446cfb4a254bdc21c4f25c8d7acc` (merge of PR #468) and then to `a15dfbb4b98504c5e6b044c616d68d3675b42581` (merge of PR #469); both are Android-lane fixes |
| Handling | inspected each time: the start SHA is an ancestor (no divergence); four files overlap Lane A (`app.js`, `app/library.tsx`, `components/vto/VirtualTryOnSheet.tsx`, `__tests__/vtoPrivacyAndWiring.test.js`) and merge without conflict; the branch was rebased onto the new tip and everything below was re-validated there |
| Version | `expo.ios.version` and `store.config.json` `apple.version` are still `1.0.2` |
| Build number | `eas.json` `appVersionSource: remote`, `autoIncrement: true`; the local `ios.buildNumber` is ignored |
| Build 35 code imported | none |
| Purchase code added | none (no RevenueCat client, no StoreKit, no paywall) |
| Backend / `eas.json` / `app.json` changed | none |

Every repair below has a regression test that fails on the previous source for
the right reason, and at least one mutation-style negative control that must
fail.

## 1. Repairs

### A. VTO third-party AI consent

Root cause: Virtual Try-On sends a photo the customer chose of themselves (which
may show their face or body) through K Scan's server to an external AI service.
Nothing asked for permission at that moment. The only in-sheet text was one
passive sentence that disappeared once a photo was chosen and claimed the photo
was "not kept afterwards", which the repository evidence does not support.

Repair: an inline consent step in the try-on sheet (provider, purpose, "sent",
Privacy Policy link, Continue / Cancel), a per-account, versioned, fail-closed
device-local consent record (`services/thirdPartyAiConsent.ts`, deliberately not
a VTO path so "a try-on persists nothing" stays true of the VTO surfaces), and a
store-level default-deny: `startVtoGeneration` and `retryVtoGeneration` refuse
the real transport, before any state change, unless the caller passes a consent
proof. Cancel sends nothing and counts nothing against the daily limit. The
unsupported retention claim is removed. The step is rendered inside the sheet and
never as a second `<Modal>`: iOS can silently drop a modal shown over another one.

The consent wording is neutral and factual and is marked
`VTO_CONSENT_COPY_LEGAL_REVIEW_REQUIRED=YES`: the mechanism ships now, the final
wording is counsel / owner review. Any change to the wording, the provider
disclosures or the version is pinned by a digest and must bump
`VTO_CONSENT_VERSION` (so every customer who accepted the old wording is asked
again).

Proof: `__tests__/vtoThirdPartyConsent.test.js` (47 tests, 8 negative controls).

Not settled here: the consent record is device-local (no server audit trail, no
withdrawal UI, terminal account deletion does not clear it); the Privacy Policy,
Terms, App Store privacy answers and the photo-library purpose string still need
their own owner-reviewed updates (the purpose string lives in `app.json`, which
the VTO scope guard forbids in a PR that touches VTO-owned paths); the disclosed
provider is a client constant, so a server-side provider change needs an app
release and a version bump. Live VTO is dark in every profile and has a latent
copy defect ("Processed on this device." beside a cloud upload) that must be
fixed, together with a pre-capture consent step, before Live is ever enabled.

### B. Scanner commerce-state truth

Root cause: the shopping shelf inferred its state from emptiness. An item with no
card was drawn as "No strong shopping match found." whether nothing had searched
for it, its request was still on the way, or its request had failed. When
multi-item detection is on and the deferred-commerce funnel is off (the funnel's
default) the backend skips commerce for detected items and the client correctly
dispatches nothing, so every detected item stated a no-match for a search that
never ran. The same collapse also produced the sentence on the first committed
frame after a deferral, for a thrown fetch, for an ineligible garment, on a
reopened saved scan, and for provider failures stored as "empty".

Repair (client only): `services/commerceShelfState.ts` defines the six states
NOT_STARTED, DEFERRED, IN_PROGRESS, RESULTS, COMPLETED_EMPTY and ERROR. The
no-match sentences exist only in its COMPLETED_EMPTY entry, and COMPLETED_EMPTY
is reachable only from a card a producer classified as a completed empty search:
`errorType === 'no_results'`, which a healthy commerce answer always carries.
Anything that names no cause is unknown, and unknown is an error, never a
no-match. A rejected per-candidate request gets its own error card instead of
vanishing. NOT_STARTED points at the real next step ("Select this item, then tap
Find Matches to see where to buy."); on the shelf surfaces (a reopened scan, the
default empty shelf) it says only that shopping matches "aren't shown here", because a
saved single-item scan does not record whether its inline search ran. `hooks/useKScan.js`,
stored shapes and the backend are unchanged.

Proof: `__tests__/scanCommerceStateTruth.test.js` drives literal backend bodies
for every multi-item / funnel combination through the real normalizer, mapper,
hook and services into the section (25 of its 29 tests fail on the previous
source), and an AST scan fails if a no-match sentence appears outside the
COMPLETED_EMPTY entry.

Enabling the deferred-commerce funnel is what makes per-item offers appear on the
detection screen. That is a server-side owner decision and is not required for
the client to be truthful.

### C. Add to Dressing Room from a scan result (WP-SCAN-05)

Root cause: `ScanResultV2` and `AnalysisCard` each render inside a native `Modal`, and
the Add Scan to Dressing Room sheet was mounted as a **sibling** Modal (`app.js`,
`app/library.tsx`). On iOS a Modal is presented from the view controller that
contains its host view, and React Native keeps no stack of Modals, so a sibling
resolves to the controller that is already presenting the result. UIKit refuses to
present from it and React Native is never told, so the button looked dead. `app.js`
also never reset its visible flag, so after one refused presentation every later tap
was a no-op as well. Android stacks dialogs and was unaffected.

Repair: `components/scan-results/ResultSurfaceModal.tsx` wraps the result Modal and
renders an `overlay` prop as its last child, so the sheet is a descendant of the
Modal it must appear over. Both result surfaces forward `overlay`; `app.js` and
`app/library.tsx` pass the sheet through it. `app.js` keeps one top-level mount only
for the preview, non-fashion and error buttons, where no result Modal is up, gated so
exactly one instance exists, and the visible flag is reset when a scan starts or the
result is dismissed. Two small hardenings in the sheet itself: a room list or save
result that resolves after an actor switch is dropped, and a create-then-add failure
keeps the created room so a retry adds to it instead of creating a second one.
Duplicate prevention stays flag-gated dark and is untouched.

Proof: `__tests__/iosScanResultSheetNesting.test.js` executes the real result surfaces
under a small component renderer and checks the `app.js` / `library.tsx` topology in
the syntax tree, with a negative control for each mutation; the loader refuses a
mutation that changes nothing. `__tests__/addScanToDressingRoomModalFlow.test.js`
executes the sheet through the existing-room, new-room, cancel, stale-room,
invalid-scan, repeated-tap, navigation and actor-switch paths.

Not settled by source: UIKit's refusal cannot be observed from Node. The sheet must
be confirmed presenting on a real iPhone, from both a live result and a reopened
Recent Scan (see section 3).

### D. Scan Results report control (WP-SCAN-04-IOS)

Two independent defects sat behind "the report interface does not open from a Scan
Result".

1. Reachability, on both platforms. Scan Results V2 is what every governed build
   renders for a live scan, but the AI-output Report control lived only on
   `AnalysisCard`, which is reached from a reopened Recent Scan alone, so a live
   result had no way to report its model-authored prose. `app.js` also passed only
   the QA fixture name as the scan identity, which is null for every real scan, and
   the reporting service refuses a request with no target.
2. Presentation, iOS only. The report sheet is a Modal owned by the provider mounted
   at the app root; opened from inside a result Modal it is a sibling, the same
   mechanism as section C.

Repair: `StyleAnalysisSection` gets the Report control and `ScanResultV2` forwards the
scan identity to it. `app.js` passes the persisted scan id: the single-item save's id,
else the persisted multi-item scan id (the confirmation step skips the single-item
save yet renders model prose), else the QA fixture name, else null, which hides the
control rather than filing a report the server cannot resolve. `ResultSurfaceModal`
nests an `AiOutputReportProvider` inside the result Modal, so the sheet is a
descendant of the Modal it must appear over; `AnalysisCard`'s button moves into a
component of its own so its hook resolves inside the Modal too. The sheet is capped
at the shared modal width so it does not span an iPad, and on iOS the outcome is
announced to VoiceOver because `accessibilityLiveRegion` is Android-only. The
reporting service is unchanged.

Proof: `__tests__/scanResultReportReachability.test.js` binds the chain link by link
(the governed flag, the branch `app.js` renders, the identity it passes, the
forwarding, the control, the real provider and the real reporting service against a
stub client, ending in a report row keyed by the scan id) with negative controls that
mutate the real source; `iosScanResultSheetNesting` gains the nested-provider checks.

Not settled by source: the report sheet presenting over a result on a real iPhone,
with VoiceOver announcing the outcome (see section 3).

### E. Elise chat keyboard offset (WP-ELISE-07)

Root cause: the chat screen passed `insets.top` as the `KeyboardAvoidingView`
`keyboardVerticalOffset`. The avoider's parent is the screen root at y = 0 and the
in-flow header already spends the top inset, so the inset was counted twice and the
composer floated above the keyboard by that amount. The offset is now 0. This is a
misplacement, not occlusion.

Proof: `__tests__/iosEliseChatKeyboardOffset.test.js` evaluates the screen's offset
and asserts the layout premises that make 0 correct, so a changed premise forces
re-derivation instead of a number edit.

Not settled by source: how the composer looks with the keyboard up on a physical
device (see section 3).

### F. Dressing Room reaction buttons and VoiceOver

Root cause: on iOS the room `ItemTile` wrapped the whole card, footer included, in
one accessible `Pressable`. An accessible view is a single VoiceOver element and
hides its subviews, so Love / Like / Looking / Not it were not swipe stops, had no
custom action, and their counts and selected state were never announced. #467 gave
the tile actions for View Detail and Remove only.

Repair (`components/StyleObjectCards.tsx`, iOS only): the `Pressable` wraps the
image and body inside a plain card `View`; the reaction row, the visual `SELECTED`
badge and Remove are siblings. The tile keeps its #467 name, selected state and
actions. The badge is hidden from VoiceOver and touch-transparent. Android and the
no-`onPress` tree are unchanged. One deliberate behaviour change: on iOS a tap on
the reaction row's blank padding no longer toggles the tile's selection (image and
body taps do).

Proof: `__tests__/iosDressingRoomReactionVoiceOver.test.js` models iOS VoiceOver (an
accessibility element hides its subviews) and asserts that no button is silently
unreachable.

### G. Complimentary K+ advertising truth

Root cause: the activation offer filtered its four capabilities by build flags
only. The certification binary compiles all four in, so the screen promised
capabilities whose server side was not enabled at the last audit. An advertised
capability is now compiled in **and** server-served
(`KPLUS_CAPABILITY_SERVER_ENABLEMENT`, a closed record; every entry carries its
evidence and date). The sub-headline is derived from what is advertised
(byte-identical to the approved sentence when all four are), and the early-access
sheet builds its benefit list from the same catalog.

The record is a deliberate snapshot: there is no client-readable signal for the
dark capabilities, so it can only under-advertise. Enabling a capability later is
a one-line flip plus evidence, and the snapshot test must be edited in the same
change. `eas.json` (the owner-ratified certification matrix) is not touched, and
the Home "Pack for a trip" tile and Packing route (entry points, not the
activation presentation) are left as an owner decision.

Proof: `__tests__/kplusCapabilityAdvertisingTruth.test.js` (the rule over every
combination of build flags, enablement statuses and live signal values, the
fail-closed live capability, a snapshot of the audited posture, and mutation
negative controls).

## 2. Shared code and Android

Builds for both platforms are cut from this line, so JavaScript changes here reach
Android builds too. iOS-only (behind `Platform` checks): the reaction VoiceOver
structure and the keyboard offset's effect. Shared JavaScript: the VTO consent
step and store guard (Android builds that carry the VTO UI), the K+ advertising
catalog, the scanner commerce states, and the scan-result modal nesting (nested
modals are safe on Android, whose dialogs stack). Android release work is paused
until iOS clears review; Android should review these shared changes when it
resumes.

Visible Android differences to review, none verified on an Android device:

- A live Scan Results V2 result now offers a "Report Response" control (it had none).
- The AI-output report sheet is capped at the shared modal width on wide windows
  (tablets, foldables); phones are unchanged.
- The Add to Dressing Room and report sheets are now dialogs opened from inside the
  result's dialog rather than beside it. Stacking should look the same and Back
  should still reach the top-most dialog first.
- The actor-switch guards, created-room reuse and visible-flag reset in the Add to
  Dressing Room path also apply on Android, with no visible change in normal flows.

## 3. Device verification carry-forward

No claim in this document is a device or simulator result. Still to check on a
device: install over Build 33 (Closet media intact); camera denial → Settings;
Voice Scan stops at 15 seconds; keyboard sheets; VoiceOver on room tiles and
reactions (including what the rotor speaks for the tile's custom actions under the
New Architecture, which builds them from the action `name`); the Elise chat with
the keyboard up on an iPhone SE and a Face ID phone; the VTO consent step inside
the nested modals; Add to Dressing Room from a live result and from a reopened
Recent Scan; the report sheet presenting from both result surfaces, with no
"already presenting" warning in the Xcode console and VoiceOver announcing the
outcome; whether the result Modal still covers the Dressing Rooms screen after
"View Dressing Room"; K+ state; Watchlist real push; cold-start notification
routing; Universal Links.

## 4. Known residuals, deliberately not changed here

- `AiOutputReportProvider` shows "Your report has been received for review." when
  the reporting service returns a local-only result (no signed-in session, so
  nothing was sent). This predates the lane and is shared with StyleChat; the
  iOS announcement added here repeats the sheet's existing wording.
- The inline "Add Scan to Dressing Room" call to action in Scan Results V2 is not
  gated on the multi-item confirmation step; the sticky action row is.
- The Add to Dressing Room sheet's "View Dressing Room" button is not guarded against
  a repeated tap, and its Android back handler ignores an in-flight save.
- Dressing Room duplicate prevention remains flag-gated dark.
- The Home "Pack for a trip" tile and the Packing route's "Unlock with K+" gate still
  lead to a Packing request that only succeeds where its server side is enabled
  (owner decision).
- The two auth-screen keyboard avoiders pass a 40pt iOS offset from the same sync that
  introduced the chat screen's inset; not analysed here.

Found by the pre-push review of the scanner, VTO and scan-result commits, and left
for a follow-up because each needs either a backend change or a change to code outside
this lane:

- **A completed-empty search can show as an error with Retry when the deferred-commerce
  funnel is on.** The client treats an empty answer as a completed empty search only
  when the backend names it `no_results`. The backend's router takes its error type from
  whichever provider reports one, so a search whose shopping results were all filtered
  out can come back as `disabled` (a provider that is off) instead of `no_results`, and
  the shelf offers a Retry that cannot change the answer. The funnel is off by default
  and its enablement is an owner decision, so this is reachable only after that
  decision. The multi-item path already behaved this way; the single-item deferred
  path is newly affected. The client rule is deliberately conservative (unknown is an
  error, never a no-match); the fix is in the backend (report `no_results` when shopping
  returned candidates that were all filtered, and mark `weak_query`, `non_fashion` and
  `wrong_mode` non-retryable) and needs staging proof before the funnel is enabled.
- **The saved-scan id can be dropped.** `app.js` records a scan's persisted id from an
  effect whose cleanup marks it stale; if `analysis` changes identity while the save is
  still in flight (deferred commerce, sneaker enrichment) the id is never recorded for
  that scan, so the Report control (which fails closed and stays hidden), "View Closet"
  and the purchase-option attach are missing for it. The scan itself is saved. The cause
  predates this lane.
- The VTO consent step is not announced or focused for screen-reader users; the
  action button's label is the only text guaranteed to be read. Confirm on a device.
- The per-account consent record is not removed by terminal account deletion (it holds
  the account id and a timestamp, on the device only).
- The legacy `AnalysisCard` (used only where Scan Results V2 is off) still shows its
  Report control before the scan has a persisted id; Scan Results V2 hides it.
