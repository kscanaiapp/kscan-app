# VTO Integration Defect Ledger — P3-C

Every defect found while building the Live VTO integration candidate, at every
severity. P0–P3 inside the VTO boundary were repaired under this lane's own
authority; P4–P10 are recorded and **not** implemented.

Severity is assigned on consequence, not on convenience. Nothing here was
downgraded to avoid repair work — where a finding was arguable, the reasoning
is written down so a reviewer can disagree with it.

```
P0-P3 FOUND:      4  (P2 x3, P3 x1)
P0-P3 FIXED:      4
P0-P3 REMAINING:  0
CROSS-BOUNDARY BLOCKERS: 0
P4-P10 FOUND:     5  (all DEFERRED, document-only)
```

---

## P0–P3 — repaired

### VTO-LIVE-001

**SEVERITY:** P2
**STATUS:** FIXED
**LOCATION:** `components/vto/VirtualTryOnSheet.tsx`, the Live teardown effect
(`liveSurfaceWithdrawn`); introduced by this lane's own sheet wiring.

**DEFECT:** A running Live session kept the camera open after the Live surface
left the screen. Three routes reached it: minimizing the sheet (which
deliberately keeps the component mounted so an in-flight generation survives),
the capability being withdrawn mid-session (operator kill switch, a lapsed
entitlement, or a garment change to a category Live cannot render), and the
Live panel's error boundary tripping.

**WHY THIS IS AN ISSUE:** A camera held open behind a surface the customer
cannot see is a privacy failure, not a battery one. The minimize route is the
worst of the three because it is a normal, deliberate customer action: collapse
the sheet, keep browsing, and the front camera stays live with no indication in
the app that it is. The kill-switch route is worse in kind — the operator
control that is supposed to stop Live would visibly stop it while the runtime
carried on.

**EVIDENCE:** `useVtoLiveSession` disposes its controller on unmount and on an
explicit `exitLive`. The sheet is not unmounted while minimized (that is
`TryItOnEntry`'s documented reason for keeping it mounted), and neither
`liveOffered` going false nor the error boundary tripping unmounts the hook —
only the panel. So no disposal ran on any of the three paths.

**PROPOSED FIX:** Tear the session down whenever the Live surface is withdrawn,
distinguishing withdrawal from a plain mode switch.

**ACTUAL FIX:** A single `liveSurfaceWithdrawn = !visible || !liveOffered ||
liveCrashed` condition drives `exitLive()`. A mode switch to AI Photo is
deliberately excluded: P3-C §21 requires the Live session to survive a
Photoreal generation so the customer can return to it.

**TEST COVERAGE:** `__tests__/vtoLiveSessionState.test.js` — "nothing invisible
keeps the camera running" (all three routes) and "switching to AI Photo does
NOT tear the Live session down" (the exclusion is asserted, so a later
over-correction that kills the Photoreal round trip fails too).

**AUDIT FOLLOW-UP:** YES — the hostile audit should re-derive the full set of
ways this component can leave the screen; three were found by inspection here,
and inspection is not a proof of completeness.

---

### VTO-LIVE-002

**SEVERITY:** P2
**STATUS:** FIXED
**LOCATION:** `__tests__/vtoPrivacyAndWiring.test.js`, `VTO_ALLOWED_IMPORTS` /
the VTO-NC-010 control. **Pre-existing** — not introduced by this lane.

**DEFECT:** The dependency allow-list scanned only `from '...'` statements. Any
`require('...')` inside an enrolled VTO module was invisible to it.

**WHY THIS IS AN ISSUE:** VTO-NC-010 exists so a VTO surface cannot silently
acquire a dependency nobody approved, and the same test's forbidden-call scan
depends on the enrolled set being complete. A module could have pulled in
anything at all through a lazy require and the control would have reported the
file as unchanged. This lane surfaced it because the Live adapter legitimately
needs two lazy requires (`expo-modules-core` for optional native discovery,
`expo-camera` so the AI-Photo-only path never loads the camera module) — but
the hole was there before, and applies to every VTO module the control names.

**EVIDENCE:** The import extractor is `source.matchAll(/from\s+'([^']+)'/g)`.
Adding `require('expo-modules-core')` to an enrolled module produced no test
failure before the repair.

**PROPOSED FIX:** Guard lazy requires to the same standard as static imports.

**ACTUAL FIX:** Added `VTO_ALLOWED_LAZY_REQUIRES` and a companion assertion
that scans **every** module in `VTO_ALLOWED_IMPORTS` — not just the two
expected to have requires — so a new lazy require anywhere in the VTO surface
fails the control.

**TEST COVERAGE:** `__tests__/vtoPrivacyAndWiring.test.js` — "VTO-NC-010: a
lazily-required module is guarded exactly like a static import".

**AUDIT FOLLOW-UP:** YES — other structural allow-lists in this repo may share
the same static-import-only assumption. Not surveyed here; that is an audit
question, not a P3-C one.

---

### VTO-LIVE-003

**SEVERITY:** P2
**STATUS:** FIXED
**LOCATION:** `hooks/useVtoLiveSession.ts#capturePreview`,
`components/vto/VtoLivePanel.tsx`; introduced by this lane.

**DEFECT:** The "Capture preview" control invoked `capturePreview()` on the
native session and discarded the returned frame handle. Nothing was rendered,
stored, or reported.

**WHY THIS IS AN ISSUE:** A control that takes an action and produces no
observable result is broken from the customer's side — they tap it, the camera
does work, and nothing happens. It is also the more dangerous half of the
capture pair to leave half-wired: `capturePreview` returns the COMPOSITED
image, and the reason it exists as a separate command from `capturePersonFrame`
is precisely that the two must never be confused. A dangling capture path with
no defined consumer is where that confusion starts.

**EVIDENCE:** `onCapturePreview={() => { void live.capturePreview(); }}` — the
resolved handle had no consumer.

**PROPOSED FIX:** Retain the captured URI and render it, or remove the control.

**ACTUAL FIX:** The hook holds `previewUri` and the panel renders it as a
local thumbnail. It is a session artifact: `exitLive` clears it, nothing
persists it, and it cannot reach the generative path — `assertCleanPersonFrame`
refuses a PREVIEW handle at the handoff regardless of what the UI does with it.

**TEST COVERAGE:** `__tests__/vtoLiveSessionState.test.js` — "the
capture-preview control has a visible result" and "a captured PREVIEW can never
reach the generative path".

**AUDIT FOLLOW-UP:** NO.

---

### VTO-LIVE-004

**SEVERITY:** P3
**STATUS:** FIXED
**LOCATION:** `components/vto/VirtualTryOnSheet.tsx#handleSelectMode`,
`services/vto/vtoTelemetry.ts`; introduced by this lane.

**DEFECT:** The Live/AI Photo mode toggle emitted the existing
`vto_entry_impression` and `vto_entry_tap` events, because the telemetry
allow-list had no event for a mode choice and an unlisted event is silently
dropped.

**WHY THIS IS AN ISSUE:** It corrupts a metric that already means something
else. `vto_entry_impression` counts customers reaching the try-on surface;
firing it again every time somebody flips a segmented control would inflate it
by an unknown factor, and the inflation would be invisible — the event name
would look correct in every dashboard. Reporting a false number is worse than
reporting none, and quietly dropping the event instead would have been worse
still, because then the mode choice would be unmeasurable at exactly the moment
product needs to know whether anyone picks Live.

**PROPOSED FIX:** Add a real event rather than overloading one that means
something else.

**ACTUAL FIX:** Added the allowlisted `vto_mode_selected` event and a `mode`
property (`'live' | 'ai_photo'`). Content-free, consistent with the file's
existing rule that adding a dimension is a deliberate edit: the mode name only,
never a capability reason or a device identifier.

**TEST COVERAGE:** Covered by the existing telemetry allow-list controls in
`__tests__/vtoPrivacyAndWiring.test.js`, which execute the emitter and drop
anything unlisted.

**AUDIT FOLLOW-UP:** NO.

---

## P4–P10 — DEFERRED (document-only authority)

### VTO-LIVE-005

**SEVERITY:** P5
**STATUS:** DEFERRED
**LOCATION:** `services/vto/vtoFeatureControl.ts#getVtoRemoteConfig`

**DEFECT:** A read that resolves to disabled (or fails) is deliberately not
memoized, and the `inFlight` promise only collapses *concurrent* callers. A
shelf of ten product cards mounting in sequence with the feature off therefore
issues up to ten `app_config` queries per surface.

**WHY THIS IS AN ISSUE:** Wasted round trips on the shopping surface, on the
path the customer is most likely to be on. It is not a correctness bug — the
non-memoization is a deliberate and correct kill-switch property, since caching
"enabled" would defeat the switch — so the fix has to preserve that asymmetry
rather than simply adding a cache.

**PROPOSED FIX:** Memoize the disabled answer for a much shorter window than
the enabled one (single-digit seconds), so a kill switch still arrives promptly
while a shelf render costs one query instead of ten.

---

### VTO-LIVE-006

**SEVERITY:** P6
**STATUS:** DEFERRED
**LOCATION:** `components/vto/TryItOnEntry.tsx`

**DEFECT:** `useVtoAvailability` returns `loading`, and this component ignores
it. While the remote config and K+ state resolve, `available` is false and the
component returns null; when they land, the Try It On button appears.

**WHY THIS IS AN ISSUE:** The affordance pops into an already-rendered product
card, which can shift layout under a customer's thumb mid-tap. Pre-existing
behaviour, not introduced by this lane, and unchanged by it.

**PROPOSED FIX:** Reserve the button's height while `loading`, or render a
non-interactive placeholder of the same size. Do not render an enabled button
optimistically — that would invite a tap the server would refuse.

---

### VTO-LIVE-007

**SEVERITY:** P6
**STATUS:** DEFERRED
**LOCATION:** `components/vto/VtoLivePanel.tsx`

**DEFECT:** The panel's "stage" is a text placeholder. There is no native
camera view to mount, because no Live native module exists.

**WHY THIS IS AN ISSUE:** It is correct for this lane — inventing a viewfinder
with nothing behind it would be worse — but it means the Live surface has never
been seen in its real form, and its layout, safe-area behaviour and control
placement are therefore unvalidated. Any conclusion about Live's UX drawn from
this build would be drawn from a placeholder.

**PROPOSED FIX:** Revisit the panel's layout when the native view lands, as
part of the same change that introduces it. Do not treat the current layout as
reviewed.

---

### VTO-LIVE-008

**SEVERITY:** P7
**STATUS:** DEFERRED
**LOCATION:** `services/vto/vtoLiveCameraPermission.ts` — the `blockedFromAsking`
module-scoped flag.

**DEFECT:** The no-repeat-prompt memory is module-scoped and process-lived. It
is not cleared at the actor boundary, unlike the VTO request store, which is
reset by `resetActorScopedRuntimeState`.

**WHY THIS IS AN ISSUE:** If one actor declines the camera and a different
actor signs in on the same device without an app restart, the second actor is
not prompted and Live silently reports unavailable for them. Low severity
because the OS permission is genuinely device-scoped rather than actor-scoped,
so the outcome matches the platform's own model, and because the fallback is
the fully working AI Photo experience. It is recorded because the app's own
convention elsewhere is that actor transitions clear runtime state, and this
deviates from it.

**PROPOSED FIX:** Call `resetLiveCameraPermissionMemory()` from the existing
actor-scoped reset, alongside `resetVtoRequestState`. Not done here: that reset
lives outside the VTO boundary this lane is authorized to modify.

---

### VTO-LIVE-009

**SEVERITY:** P8
**STATUS:** DEFERRED
**LOCATION:** `services/vto/vtoLiveGarment.ts#TEMPLATE_FAMILY_BY_CANONICAL`

**DEFECT:** The mapping from K Scan's canonical taxonomy to the research
template families is many-to-one and lossy: every `top` becomes
`'simple-top'`, even where the research contract distinguishes `'t-shirt'` and
`'sweater'`.

**WHY THIS IS AN ISSUE:** Once a renderer actually consumes `templateFamily`,
a sweater rendered with a t-shirt's template would be a visible fidelity
defect. Harmless today because nothing consumes the field, which is exactly why
it is recorded rather than fixed — the correct mapping is a question for the
first session with a renderer that can be looked at, not a guess made now.

**PROPOSED FIX:** Derive the family from the existing commerce category and
subcategory once a renderer exists to validate the choice against, and widen
`DEFAULT_LIVE_VTO_SUPPORTED_CATEGORIES` only alongside it.

---

## Cross-boundary blockers

```
NONE
```

No P0–P3 defect required changing a protected non-VTO subsystem. VTO-LIVE-008
is the only finding whose repair would cross the boundary, and it is a P7 —
document-only for two independent reasons.
