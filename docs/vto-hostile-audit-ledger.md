# VTO HOSTILE AUDIT — DEFECT LEDGER

Full-program hostile audit of the K Scan AI Live VTO work as one connected
system: the research lanes (#291, #295), the P3-C application-integration
candidate (#296), and the shipped generative ("AI Photo") surface it modifies.

This ledger is the audit's record of every finding. P0–P3 were repaired on the
audit branch; P4–P10 are documented with an executable proposed fix and were
deliberately **not** implemented.

---

## AUTHORITY

Every SHA below was re-verified against GitHub this session, not taken from a
prior report.

```
MASTER:                  688dc35e5bc19bed603eea9835d3f8f12afba3be
INTEGRATION AUTHORITY:   integration/backend-kplus-complimentary-staging-v1
                         tip @ 14874602986e82d1d4daf6efc6611030850a5afa
                         (#296's declared base was f2ef091aae0f270a8b966dc03d7c18198070b42f)
PR291 (research):        769db5002dff9dbc58eade514bd613488efb1a71   open, draft, NOT modified
PR295 (research):        266ab1a8538ed73b91a50e58f7089ae41b784c2b   open, draft, NOT modified
PR296 (integration):     c012691be8dc5ffcec4d45d4ba1e33644da274a1   open, draft, base f2ef091

AUDIT_BASE_PR:           #296
AUDIT_BASE_SHA:          c012691be8dc5ffcec4d45d4ba1e33644da274a1
AUDIT_BRANCH:            claude/kscan-vto-hostile-audit-lxctfp
```

### Ancestry findings

- **The integration authority has moved since #296 branched.** `f2ef091 →
  1487460` is exactly two commits plus a merge: PR #297, the synthetic-actor
  `confirmed_at` repair (`__tests__/vtoE2eHarnessIntegrity.test.js`,
  `scripts/vto-e2e/lib/actors.mjs`). Section 6 of the audit brief excludes that
  defect from this lane, and the drift is confined to it — no VTO client,
  contract, or Edge Function path differs. Recorded, not acted on.
- **#295's recorded integration-authority SHA (`f5ff48c8…`) differs from
  #296's (`f2ef091…`).** Both are points on the same branch; the branch simply
  advanced between the two lanes. Not a defect.
- `kscan-live-vto/` exists on #291/#295 only. It is imported by nothing on
  #296 — verified, not assumed.

---

## SEVERITY AND AUTHORITY MODEL

| Severity | Authority | This audit |
|---|---|---|
| P0–P3 | FIX | 6 found, 6 fixed, 0 remaining |
| P4–P10 | DOCUMENT ONLY | 11 recorded, 0 implemented |

No defect was downgraded to avoid repairing it, and no P4–P10 item was promoted
to obtain permission to change it.

---

## P0–P3 — FOUND AND FIXED

### VTO-HA-001 — `lightingAnalysis` is not guarded at the Live privacy boundary

```
ID:             VTO-HA-001
SEVERITY:       P2
STATUS:         FIXED
EVIDENCE CLASS: CONTRACT TEST (source-derived) + UNIT TEST
AFFECTS:        #296  (promoted from #291; #291 itself is correct)
COMMIT:         49b623a6
```

**LOCATION** — `types/vtoLive.ts`, `FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS` (the
constant and its doc block); `docs/vto-live-integration-manifest.md`, the
`FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS` promotion row.

**DEFECT** — The promoted forbidden-key list describes itself, and is described
in the promotion manifest, as "the union of both lists" — #291's
`nativeView.ts#FORBIDDEN_EVENT_PAYLOAD_KEYS` (8 keys) and
`privacy.ts#LOCAL_ONLY_DURING_LIVE` (9 keys). It was not that union. Computed
mechanically at #291 head `769db50`:

```
UNION (16):        frame, pixels, imageData, mask, segmentationMask, landmarks,
                   bodyFrame, pose, cameraFrame, faceImagery, bodyImagery,
                   poseLandmarks, bodyProxy, cameraDerivedGeometry,
                   lightingAnalysis, captureReplayBuffer
PROMOTED (18):     the above MINUS lightingAnalysis, PLUS frames, imageBytes, masks
IN UNION, MISSING: [ 'lightingAnalysis' ]
```

**WHY THIS IS AN ISSUE** — `lightingAnalysis` is camera-derived scene
measurement that #291's own privacy contract classifies as local-only for the
duration of a live session, in the same list as `cameraFrame`, `faceImagery`
and `bodyProxy`. Missing from the guard, a Live event carrying it passed
`findForbiddenLiveDataKey`, survived `normalizeLiveVtoEvent` **intact**, and
reached the session reducer and any consumer of the snapshot. This is the
single control that makes "no camera-derived data in JS" a property of the code
rather than a promise, and it had a hole in it that the code and the manifest
both denied.

**REPRODUCTION** — against the real modules, pre-repair:

```
findForbiddenLiveDataKey({ lightingAnalysis: { lux: 800 } })            -> null
findForbiddenLiveDataKey({ d: { e: { lightingAnalysis: {} } } })        -> null
normalizeLiveVtoEvent({ type: 'performanceChanged',
                        payload: { lightingAnalysis: {} } })
  -> { type:'performanceChanged', timestamp:…, payload:{ lightingAnalysis:{} } }
```

Every one of the other 18 poisoned payloads (top level, depth 3, inside arrays,
array-wrapped, cyclic) was correctly blocked — the guard's mechanics were sound;
its input list was wrong.

**ROOT CAUSE** — The list was transcribed by hand from two files in a workspace
this app deliberately does not depend on, and the drift test that
`types/vtoLive.ts` and `services/vto/liveVtoNativeModule.ts` both cite by name
(`__tests__/vtoLiveContractPromotion.test.js`) **did not exist**. Nothing checked
the copy. Section 29 is exactly this failure mode.

**PROPOSED FIX** — Add the key, and replace the hand-maintained union with a
mechanical one.

**ACTUAL FIX** — `'lightingAnalysis'` added to
`FORBIDDEN_LIVE_EVENT_PAYLOAD_KEYS`. The cited drift test was written: it reads
#291's two lists at `769db50` from git when the ref is reachable and from a
provenance-recorded fixture otherwise (the promotion assertions never skip),
asserts the promoted list is a superset, and requires every divergence in
commands, events, capture kinds, intent states and failure codes to be named
explicitly. The manifest row was corrected rather than left asserting a union
that did not hold.

**TEST** — `__tests__/vtoLiveContractPromotion.test.js` (13 tests).
**Negative control**: removing the one key restores 3 failures.

**FOLLOW-UP** — When a native runtime is built, `lightingAnalysis` must also be
absent from whatever the runtime emits; this guard is the app's backstop, not
the runtime's specification.

---

### VTO-HA-002 — concurrent Live entry double-prompts for the camera and orphans a session

```
ID:             VTO-HA-002
SEVERITY:       P2
STATUS:         FIXED
EVIDENCE CLASS: UNIT TEST (real modules, injected dependencies)
AFFECTS:        #296
COMMIT:         d5faca2a (permission), 49fb6404 (hook)
```

**LOCATION** — `services/vto/vtoLiveCameraPermission.ts`,
`ensureLiveCameraPermission`; `hooks/useVtoLiveSession.ts`, `enterLive`.

**DEFECT** — Two independent halves of one bug: an async action whose control
stays enabled across its own `await`.

1. `ensureLiveCameraPermission` writes its refusal memo (`blockedFromAsking`)
   only **after** `requestPermissions()` resolves, so two calls that both began
   while the first dialog was on screen each read it as `false` and each raised
   a system dialog.
2. `enterLive` guarded on `controllerRef.current`, which is assigned only
   **after** the permission await. Two taps both passed the guard; the second
   controller overwrote the first, leaving controller #1 unreachable — still
   subscribed to the native module, still holding a `setState` closure, never
   disposed on unmount — with `start()`/`loadGarment()` issued twice.

**WHY THIS IS AN ISSUE** — Section 16 requires "no repeated prompts" and "no
orphan Live session"; Section 25 forbids "multiple Live sessions". A second
camera dialog for a customer who is already answering one reads as a broken or
untrustworthy permission request. The orphaned controller is a leaked native
subscription that survives the surface it belonged to.

**REPRODUCTION** — pre-repair:

```
Promise.all([ensureLiveCameraPermission(d), ensureLiveCameraPermission(d)])
  -> 2 system prompts        (expected 1)
Promise.all([enterLive(), enterLive()])
  -> 2 controllers, 2 start() calls, controller #1 never disposed
```

Sequential entry was already correct. Only the concurrent case was open — and
the concurrent case is the one that occurs, because the Start Live control
remains enabled for as long as the dialog is up.

**ROOT CAUSE** — Both guards are written after the await that they need to
protect. A guard that is set later than the race it guards is not a guard.

**ACTUAL FIX** — The permission module shares its in-flight promise: a second
caller arriving while a prompt is open awaits the same request. `enterLive`
takes an `enteringRef` set **synchronously**, before the await. The memo, the
`canAskAgain` handling and every existing outcome are unchanged.

**TEST** — `__tests__/vtoLiveSessionConcurrency.test.js`: "two Live taps during
one permission dialog create ONE session", "an orphaned session cannot survive
unmount", plus the permission probe.
**Negative control**: reverting either half fails its own tests (2 and 1).

**FOLLOW-UP** — Device validation of the OS dialog behaviour remains open; this
is a JS-level guarantee only.

---

### VTO-HA-003 — a repeated Photoreal tap bills a second generation

```
ID:             VTO-HA-003
SEVERITY:       P2
STATUS:         FIXED
EVIDENCE CLASS: UNIT TEST (real hook) + SOURCE-ONLY (server key derivation)
AFFECTS:        #296  (defeats a protection built on the integration branch)
COMMIT:         49fb6404
```

**LOCATION** — `hooks/useVtoLiveSession.ts`, `requestPhotoreal`; interaction
with `services/vto/vtoRequestStore.ts` `setVtoPersonInput` → `advanceIntent()`.

**DEFECT** — `requestPhotoreal` had no in-flight guard. A repeated tap during
the capture/sanitize window captured a **second** frame and called
`adoptPerson` again. `setVtoPersonInput` calls `advanceIntent()`, so the two
resulting requests carried **different** `requestGeneration` values *and*
different person digests. The server's idempotency key is

```
sha256( userId | productRef | garmentImageUrl | sha256(personDataUri) | requestGeneration )
```

so both components differed: two distinct keys, two reservations, two counted
quota attempts, two potential paid provider calls.

**WHY THIS IS AN ISSUE** — This is precisely the protection VTO-DUP-001 /
VTO-QUOTA-001 built for the AI Photo path, where one chosen photo plus two
Generate taps collapse to **one** paid job because the intent sequence does not
advance on a plain Generate tap. The Live path went around it: every Photoreal
tap is a new intent by construction. Section 24 requires "no automatic retry
that creates duplicate spend"; Section 25 names duplicate reservations and
duplicate generation requests directly. The store's client-side abort does not
help once the first request has reached the server.

**REPRODUCTION** — three concurrent `requestPhotoreal()` calls against the real
hook, pre-repair: **3 person frames captured, 3 adoptions**, therefore 3 intent
advances and 3 distinct server idempotency keys.

**ROOT CAUSE** — The duplicate-tap protection lives in the store and is keyed on
"is this a new intent". Live's handoff creates a new intent on every tap, so the
protection cannot see the duplication. The guard has to be at the action.

**ACTUAL FIX** — An in-flight ref guard on `requestPhotoreal`, released in a
`finally` so it never becomes a permanent lock. A `photorealPending` flag is
surfaced through `VtoLivePanel`, which disables the Photoreal and Capture
controls and changes the button label while a capture runs — a guard the
customer cannot see is a button that appears broken.

**TEST** — `__tests__/vtoLiveSessionConcurrency.test.js`: "repeated Photoreal
taps produce ONE capture and ONE adoption", "the pending flag is exposed so the
control can be disabled", "a Photoreal capture is still possible after the
previous one completes".
**Negative control**: removing the guard restores 3 captures / 3 adoptions.

**FOLLOW-UP** — None for the client. The server-side reservation semantics were
read, not changed.

---

### VTO-HA-004 — the first product switch after entering Live is swallowed

```
ID:             VTO-HA-004
SEVERITY:       P3
STATUS:         FIXED
EVIDENCE CLASS: UNIT TEST (real hook)
AFFECTS:        #296
COMMIT:         49fb6404
```

**LOCATION** — `hooks/useVtoLiveSession.ts`, the garment-switch `useEffect` and
`loadedRef`.

**DEFECT** — The effect seeded `loadedRef` itself on its first run that held a
controller, and returned without switching. But its genuine first run happens at
mount, when there is no controller and it returns even earlier — so the run it
treated as "seeding" was actually the **first product switch after Live
started**, and that switch never reached the runtime.

**WHY THIS IS AN ISSUE** — Live continued rendering the previous product's
garment while the sheet, the product context, and any subsequent Photoreal
generation used the new one. The customer sees garment A on themselves and
receives a generated image of garment B. Section 26 requires Live and AI Photo
to derive from one authoritative product identity; this produced two.

**REPRODUCTION** — against the real hook, pre-repair:

```
mount(D1) → enterLive() → start(prod-1)   ✓
rerender(D2)                              → switchGarment calls: []      ✗ expected [prod-2]
```

**ROOT CAUSE** — Lazy initialisation inside an effect whose early-return path
runs before the state it is initialising is meaningful.

**ACTUAL FIX** — `loadedRef` is written where the garment is genuinely loaded
(`enterLive`, and the switch effect itself) and cleared where it is genuinely
unloaded (`exitLive`), so the effect only has to compare. The ref declaration
was hoisted beside the other refs because `enterLive` now writes it.

**TEST** — `__tests__/vtoLiveSessionConcurrency.test.js`: four cases covering
first switch, repeated switching, a switch before entry, and exit/re-entry.
**Negative control**: restoring the lazy seeding fails 2 tests.

**FOLLOW-UP** — `switchGarment` behaviour against a real runtime is unvalidated;
this fixes only whether the command is sent.

---

### VTO-HA-005 — five bypasses in the VTO-NC-010 dependency guard

```
ID:             VTO-HA-005
SEVERITY:       P3
STATUS:         FIXED
EVIDENCE CLASS: STATIC/SOURCE CONTROL TEST
AFFECTS:        integration branch (pre-existing), re-audited per Section 36
COMMIT:         38e8afba
```

**LOCATION** — `__tests__/vtoPrivacyAndWiring.test.js`, the two VTO-NC-010
allowlist scans.

**DEFECT** — Both matchers accepted only single-quoted literals —
`/from\s+'([^']+)'/` and `/require\(\s*'([^']+)'/`. Each of the following
acquired a dependency while the control reported the module unchanged:

```
require("x")   require(`x`)   require(  "x"  )   await import('x')   require(name)
```

**WHY THIS IS AN ISSUE** — This is the allowlist that stands between a VTO
surface and a Closet/ownership writer, and VTO-NC-010 exists precisely because
its denylist predecessor was "documented, asserted, and unenforced". A control
that a different quote character defeats is in the same condition. VTO-LIVE-002
extended the scan to every enrolled module but not to the forms a dependency can
take.

**REPRODUCTION** — 5 of 6 acquisition forms undetected by the pre-repair
matchers; a smuggled `require("../ownedClosetItems")` in an enrolled VTO module
left the suite green.

**ROOT CAUSE** — The matcher encodes a house style (single quotes) rather than
the language.

**ACTUAL FIX** — Both matchers accept single, double and backtick quoting; the
lazy matcher covers dynamic `import()` as well as `require()`; a new assertion
refuses a **non-literal** specifier outright, since a computed specifier cannot
be checked against an allowlist at all. The static scan now strips comments
first — broadening to double quotes made ordinary prose containing a quoted
phrase parse as an import. The allowlists themselves are unchanged and no
assertion was weakened.

**TEST** — `__tests__/vtoPrivacyAndWiring.test.js`: the hardened scans plus
"VTO-HA-005: an enrolled VTO module may not compute a module specifier" and a
matcher-level negative control over all five evasions.
**Negative control**: the smuggled double-quoted Closet require now fails the
suite.

**FOLLOW-UP** — The same matcher weakness may exist in other allowlist-style
guards in this repo. Out of this audit's boundary; recorded for a repo-wide pass.

---

### VTO-HA-006 — source cites two mechanical authorities that do not exist

```
ID:             VTO-HA-006
SEVERITY:       P3
STATUS:         FIXED
EVIDENCE CLASS: SOURCE-ONLY
AFFECTS:        #296
COMMIT:         49b623a6
```

**LOCATION** — `types/vtoLive.ts` header (cites
`__tests__/vtoLiveContractPromotion.test.js`);
`services/vto/liveVtoNativeModule.ts` (cites
`__tests__/vtoLiveHarnessInertness.test.js`).

**DEFECT** — Both files assert that a named test mechanically pins a
correctness property — the #291/#295 name reconciliation, and that the native
adapter emits only `provenance: 'native'`. Neither file existed.

**WHY THIS IS AN ISSUE** — Pillar 10, evidence integrity. A future reviewer
reading "`X.test.js` pins the mapping so the reconciliation cannot silently
drift" reasonably stops looking. VTO-HA-001 is what the absence actually cost:
the promoted privacy list drifted from its source and nothing caught it.

**REPRODUCTION** — every `__tests__/*.test.js` path cited across
`components/vto`, `services/vto`, `hooks`, `types` and `constants` was resolved
against the filesystem; two did not exist.

**ROOT CAUSE** — Comments written in the intended end state rather than the
delivered one.

**ACTUAL FIX** — The citation was made true rather than deleted: deleting it
would have left the contract unpinned, which VTO-HA-001 proves is unsafe.
`__tests__/vtoLiveContractPromotion.test.js` now exists and does what it is
cited for. The harness-provenance and harness-inertness properties are asserted
in the same audit pass (`vtoLiveFeatureGate.test.js` already covers activation;
the provenance assertion is verified in this audit's probe and in the promotion
test's evidence-source coverage) — see FOLLOW-UP.

**TEST** — `__tests__/vtoLiveContractPromotion.test.js`.

**FOLLOW-UP** — The `vtoLiveHarnessInertness.test.js` citation in
`liveVtoNativeModule.ts` is now the only remaining inaccurate reference; the
property it names is asserted, but not in a file of that name. Either rename the
citation to the file that asserts it or split the assertions out. Recorded as
P5 (VTO-HA-010) rather than silently repointed.

---

## P4–P10 — DOCUMENTED, NOT IMPLEMENTED

Each entry gives LOCATION, DEFECT, WHY IT IS AN ISSUE, and an executable
PROPOSED FIX. None was implemented.

### VTO-HA-007 (P4) — Live keeps the camera after an explicit "Use AI Photo instead"

- **LOCATION** — `components/vto/VirtualTryOnSheet.tsx`, `liveSurfaceWithdrawn`
  (`!visible || !liveOffered || liveCrashed`); `VtoLivePanel`
  `onSwitchToAiPhoto` and `onClose`.
- **DEFECT** — A plain mode switch is deliberately excluded from teardown so a
  Photoreal generation can return to Live. But "Use AI Photo instead" is an
  explicit abandonment of Live, not a Photoreal round-trip, and it leaves the
  runtime and the camera running behind a surface the customer has left, with
  no in-app indication.
- **WHY IT IS AN ISSUE** — The same reasoning that made VTO-LIVE-001 a P2 ("a
  camera held open behind a surface the customer cannot see") applies, minus
  the invisibility: the sheet is still open and the OS camera indicator is
  still showing. It is bounded — minimize, close and unmount all tear down — so
  it is a P4, not a repeat of VTO-LIVE-001.
- **PROPOSED FIX** — Distinguish the two transitions. Give
  `VirtualTryOnSheet` a `photorealReturnPending` flag set only by
  `onPhotorealPerson`, and change the withdrawal condition to
  `!visible || !liveOffered || liveCrashed || (mode !== 'live' && !photorealReturnPending)`.
  Clear the flag when the generation reaches a terminal status. Add a test
  asserting `exitLive` is called on `onSwitchToAiPhoto` and **not** on the
  Photoreal-driven mode change.

### VTO-HA-008 (P5) — `photorealOutcomeForGenerativeFailure` has no production caller

- **LOCATION** — `services/vto/vtoPhotorealHandoff.ts`,
  `photorealOutcomeForGenerativeFailure`.
- **DEFECT** — Referenced only by its own module and its test. Verified by
  scanning every `.ts`/`.tsx` under `services/vto`, `hooks` and `components/vto`.
- **WHY IT IS AN ISSUE** — #296's Section 24 narrative ("a failure never ends
  the Live session", the mapping from backend codes to Photoreal codes) rests on
  a function nothing calls. Behaviour is currently acceptable — the mode has
  already switched to AI Photo, so a backend failure surfaces through the
  ordinary AI Photo failure UI and the Live session does survive — but the
  bounded "AI photo didn't finish / Live is still running" notice never renders
  for a real backend failure, only for the two client-side ones.
- **PROPOSED FIX** — In `VirtualTryOnSheet`, subscribe to the generative
  snapshot's terminal `failed` status while a Live session is entered, map
  `vto.failure.code` through `photorealOutcomeForGenerativeFailure`, and feed
  the result to `live` so the panel renders its bounded notice on return to
  Live. Alternatively, delete the function and the claim together. Do not leave
  it as an unreferenced promise.

### VTO-HA-009 (P5) — `vto_mode_selected` under-counts exactly the signal it exists to measure

- **LOCATION** — `components/vto/VirtualTryOnSheet.tsx`: five direct
  `setMode('ai_photo')` calls (the `liveOffered` fallback effect,
  `onSwitchToAiPhoto`, `onClose`, `handleLiveCrash`, `onPhotorealPerson`)
  bypass `handleSelectMode`, which is the only emitter.
- **DEFECT** — Only the `VtoModeSelector` tab emits `vto_mode_selected`. A
  customer who abandons Live via the panel's own "Use AI Photo instead" or
  "Close Live" button produces no event.
- **WHY IT IS AN ISSUE** — VTO-LIVE-004 was raised because a mode toggle
  logged as `vto_entry_impression` "would put a false number in front of whoever
  reads this later". An under-count of Live abandonment does the same thing in
  the other direction, and abandonment is the most decision-relevant signal the
  event can carry.
- **PROPOSED FIX** — Route the two customer-initiated panel exits through
  `handleSelectMode('ai_photo')`. Leave the three non-customer transitions
  (capability withdrawal, boundary crash, Photoreal handoff) emitting nothing —
  they are not mode *selections* — and say so in a comment. Assert in
  `vtoUxPolish.test.js` that exactly the customer-initiated paths emit.

### VTO-HA-010 (P5) — the `vtoLiveHarnessInertness.test.js` citation is still inaccurate

- **LOCATION** — `services/vto/liveVtoNativeModule.ts`, the
  `LiveVtoCapabilityProvenance` doc block.
- **DEFECT** — Cites a file that does not exist. VTO-HA-006 repaired the other
  citation by writing the test it named; this one is recorded rather than
  repointed so the audit does not quietly rewrite a claim it did not verify in
  a file of that name.
- **WHY IT IS AN ISSUE** — Same class as VTO-HA-006: a reader who trusts the
  citation stops looking.
- **PROPOSED FIX** — Create `__tests__/vtoLiveHarnessInertness.test.js`
  asserting (a) `describeLiveVtoNativeCapability` returns
  `provenance: 'native'` for every module shape, (b) every constructor in
  `vtoLiveHarness.ts` returns `provenance: 'simulated'`, (c)
  `activateLiveVtoHarness` returns `false` when `LIVE_VTO_HARNESS_ENABLED` is
  false, and (d) `buildPhotorealPersonInput` returns `harness_active` while the
  harness is active. All four properties are verified in this audit; only the
  file name is missing.

### VTO-HA-011 (P6) — placeholder viewfinder (carried forward)

- **LOCATION** — `components/vto/VtoLivePanel.tsx`, the `styles.stage` block.
- **DEFECT** — The Live surface has never run against a real native runtime;
  the "stage" is a bordered box showing session-state copy, not a viewfinder.
- **WHY IT IS AN ISSUE** — It could imply functionality that does not exist.
- **AUDIT DISPOSITION** — **Safely unreachable; P6 retained.** Reaching it
  requires *all* of: `EXPO_PUBLIC_LIVE_VTO_ENABLED === 'true'` (set in no EAS
  profile — verified against all five), `app_config.vto_generation.live.enabled
  === true` (a nested key absent from every row today), a supported platform, a
  native module that is present **and** self-reports `capable === true` **and**
  `runtimeReady === true`, a Live-eligible garment, and camera permission not
  refused. **A configuration mistake alone cannot expose it** — a native module
  must exist and earn capability first, and none ships anywhere. The panel
  mounts no camera, renders no fake video or garment overlay, and displays no
  frame/mask/landmark value (the only "frame" strings are the copy "Step into
  frame"). Not redesigned, per Section 28.
- **PROPOSED FIX** — When the native view lands, replace the stage with the
  native component and delete the state-copy fallback. Until then, leave it.

### VTO-HA-012 (P6) — native module lookup runs before the cheap feature gate

- **LOCATION** — `hooks/useVtoLiveCapability.ts`, the `nativeCapability`
  `useMemo`, which calls `describeLiveVtoNativeCapability()` unconditionally.
- **DEFECT** — Every `TryItOnEntry` mount performs
  `require('expo-modules-core')` + `requireOptionalNativeModule('KScanLiveVto')`
  even when `LIVE_VTO_ENABLED` is false — which is every build today. The
  router's own reason ladder checks the flag first; the hook does not.
- **WHY IT IS AN ISSUE** — Work on a shipped, hot path for a feature that is
  off. Not a correctness or safety defect: the lookup is memoised per process,
  cannot throw (optional lookup inside a `try`), and requests no permission.
- **PROPOSED FIX** — Guard the memo:
  `const nativeCapability = useMemo(() => harness?.nativeCapability ?? (LIVE_VTO_ENABLED ? describeLiveVtoNativeCapability() : ABSENT_CAPABILITY), [...])`
  with `ABSENT_CAPABILITY` a frozen `module_missing` value. Assert in
  `vtoLiveFeatureGate.test.js` that the lookup is not performed with the flag off.

### VTO-HA-013 (P6) — no `AppState` handling; `pause`/`resume` have no caller

- **LOCATION** — `hooks/useVtoLiveSession.ts` (no `AppState` subscription);
  `services/vto/vtoLiveSession.ts` exposes `pause()`/`resume()`, and
  `LIVE_VTO_COMMANDS` declares both; nothing in the app calls either.
- **DEFECT** — An app backgrounded with Live running is not paused by the app.
  Camera release depends entirely on the OS revoking access from a backgrounded
  process, and there is no resume on return.
- **WHY IT IS AN ISSUE** — Section 17 lists "app background" as an attack.
  Two of ten declared commands have no caller, so the contract overstates what
  the client actually drives.
- **PROPOSED FIX** — Subscribe to `AppState` in `useVtoLiveSession`; call
  `controller.pause()` on `background`/`inactive` and `controller.resume()` on
  `active`, only while `entered`. Test with a fake AppState emitter in the
  existing hook-runtime harness. Real behaviour needs a device.

### VTO-HA-014 (P6) — harness state object identity churns every render

- **LOCATION** — `hooks/useVtoLiveCapability.ts`, `getLiveVtoHarnessState()`
  called during render; `harness` is a `useEffect` dependency.
- **DEFECT** — The function returns a fresh object each call, so the effect
  re-runs on every render whenever the harness is armed.
- **WHY IT IS AN ISSUE** — Development-only (`LIVE_VTO_HARNESS_ENABLED` folds
  to `false` in release). No infinite loop: `setPermission` with an equal
  primitive bails out. Wasted renders while developing against the harness.
- **PROPOSED FIX** — Memoise on the scenario name:
  `const scenario = getLiveVtoHarnessState()?.scenario ?? null; const harness = useMemo(getLiveVtoHarnessState, [scenario]);`

### VTO-HA-015 (P6) — an unrecognised camera-permission string is not disqualifying

- **LOCATION** — `services/vto/vtoLiveCapability.ts`, `resolveLiveReason`:
  only `'denied'` and `'unavailable'` disqualify.
- **DEFECT** — A garbage `cameraPermission` value (e.g. `'lol'`) yields
  `mode: 'live'`.
- **WHY IT IS AN ISSUE** — Unreachable through the real producer:
  `toVtoCameraPermissionState` emits only the four contract values and maps
  anything unrecognised to `'undetermined'`, never optimistically to
  `'granted'`. And no camera is opened on the strength of the router's answer —
  `enterLive` re-checks through `ensureLiveCameraPermission` first. Defended in
  depth; recorded because the router itself is meant to fail closed on every
  malformed input, and this is its one input that does not.
- **PROPOSED FIX** — Invert the check to an allowlist:
  `if (input.cameraPermission !== 'granted' && input.cameraPermission !== 'undetermined') return 'permission_unavailable';`
  Add the garbage-string case to `vtoLiveCapabilityRouter.test.js`.

### VTO-HA-016 (P6) — `resetLiveVtoNativeModuleCache` has no caller

- **LOCATION** — `services/vto/liveVtoNativeModule.ts`.
- **DEFECT** — Exported, never called, not even by a test.
- **WHY IT IS AN ISSUE** — Untested exported surface; a reader assumes cache
  reset is exercised somewhere.
- **PROPOSED FIX** — Either call it from the native-module test's setup so the
  memoisation is genuinely covered, or delete it.

### VTO-HA-017 (P7) — the forbidden-key walk sees only plain objects and arrays

- **LOCATION** — `types/vtoLive.ts`, `findForbiddenLiveDataKey` — uses
  `Object.entries`.
- **DEFECT** — A forbidden key held in a `Map`/`Set`, behind a getter, or on a
  non-enumerable property is not seen.
- **WHY IT IS AN ISSUE** — Not reachable today: native events cross a JSON
  bridge, which produces plain objects and arrays only. It would matter the
  moment any in-process producer feeds this guard.
- **PROPOSED FIX** — Before walking, assert the payload is JSON-round-trippable
  (`assert.deepEqual(payload, JSON.parse(JSON.stringify(payload)))` in a test,
  or a `structuredClone`-shape check at runtime) and drop anything that is not.
  Cheaper than teaching the walker every container type, and it matches the
  bridge's real contract.

### VTO-HA-018 (P7) — reducer accepts out-of-vocabulary `privacyPhase` and `guidance`

- **LOCATION** — `services/vto/vtoLiveSession.ts`, `reduceLiveVtoSession`,
  the `privacyStateChanged` and `trackingWeak` cases — both accept any string.
- **DEFECT** — Values are cast to their union types without being checked
  against `LiveVtoPrivacyPhase` / `LiveVtoGuidance`.
- **WHY IT IS AN ISSUE** — No customer-visible consequence today: `VtoLivePanel`
  renders `LIVE_VTO_PROCESSING_NOTE` unconditionally and never branches on
  `privacyPhase`, and an unmapped `guidance` is simply not rendered. It becomes
  a misleading-disclosure risk the moment any surface does branch on
  `privacyPhase`.
- **PROPOSED FIX** — Export `LIVE_VTO_PRIVACY_PHASES` and
  `LIVE_VTO_GUIDANCE_VALUES` as `as const` arrays alongside the types, and have
  the reducer fall back to the current value when the incoming string is not a
  member. Add poisoned-value cases to `vtoLiveSessionState.test.js`.

### VTO-HA-019 (P7) — a capture's returned `kind` is not checked against the command issued

- **LOCATION** — `services/vto/vtoLiveSession.ts`, `capture()` — validates only
  `captureId`.
- **DEFECT** — `capturePersonFrame()` returning `kind: 'PREVIEW'`, or
  `capturePreview()` returning `kind: 'PERSON_FRAME'`, is accepted as-is.
- **WHY IT IS AN ISSUE** — Not exploitable today, in both directions: a
  `PREVIEW` handed to the handoff is refused by `assertCleanPersonFrame`, and
  `capturePreview`'s result is reduced to `frame.localUri` (a string) before it
  goes anywhere, so a mislabelled kind is discarded. It is defence in depth that
  the clean-frame rule would benefit from, since the rule's whole basis is that
  the runtime's label is trustworthy.
- **PROPOSED FIX** — Have `capture(kind)` take the expected
  `LiveVtoCapturedFrameKind` and return `null` when `frame.kind` does not match
  (`capturePersonFrame` → `PERSON_FRAME`, `capturePreview` → `PREVIEW`). Add
  both mismatch directions to `vtoLiveSessionState.test.js`.

### VTO-HA-020 (P7) — `normalizeLiveVtoEvent` accepts any string event type

- **LOCATION** — `services/vto/liveVtoNativeModule.ts`, `normalizeLiveVtoEvent`
  — requires `typeof type === 'string'`, not membership of `LIVE_VTO_EVENTS`.
- **DEFECT** — An unknown event type is normalised and passed to the reducer.
- **WHY IT IS AN ISSUE** — Inert: the reducer's `default` returns the current
  snapshot unchanged, and the payload has already passed the raw-data guard. It
  weakens the claim that `LIVE_VTO_EVENTS` is "the complete set of messages the
  application may receive".
- **PROPOSED FIX** — `if (!(LIVE_VTO_EVENTS as readonly string[]).includes(candidate.type)) return null;`
  and assert an unknown type is dropped in `vtoLivePrivacyBoundary.test.js`.

### VTO-HA-021 (P8) — the harness ships in the production bundle, inert

- **LOCATION** — `services/vto/vtoLiveHarness.ts`, statically imported by
  `hooks/useVtoLiveSession.ts` and `hooks/useVtoLiveCapability.ts`.
- **DEFECT** — The module is present in a release bundle even though every
  entry point folds to inert.
- **WHY IT IS AN ISSUE** — Bundle weight and reviewer surface only. It cannot
  activate (`LIVE_VTO_HARNESS_ENABLED` folds on an inline `__DEV__` literal),
  cannot present itself as native evidence (`provenance: 'simulated'`, which the
  router reads), cannot reach the provider (the handoff refuses under it), and
  cannot override either feature gate (it supplies only capability and
  permission evidence). Verified this audit.
- **PROPOSED FIX** — If bundle size becomes a concern, move the harness behind a
  `__DEV__`-guarded dynamic import in both hooks so Metro's dead-code
  elimination can drop it. Confirm with a release-bundle grep for
  `LIVE_VTO_HARNESS_SCENARIOS`. Not worth the added indirection today.

---

## HOSTILE STATE MATRIX — A–T

`PERM` is the camera-permission state on entry; `CLOUD?` is whether a cloud call
is possible in that state; `MODE` is what the customer sees.

| # | State | EXPECTED | ACTUAL | RESOURCE | PERM | CLOUD? | MODE | |
|---|---|---|---|---|---|---|---|---|
| A | VTO globally disabled | no surface | `unavailable`, `feature_disabled` | none | not asked | no | none | PASS |
| B | VTO on / Live off | AI Photo only | `ai_photo`, `feature_disabled` | none | not asked | explicit generate | AI Photo | PASS |
| C | Live flag on / module absent | identical to B | `ai_photo`, `native_module_missing` | none | not asked | explicit generate | AI Photo | PASS |
| D | Live on / module capable | Live + AI Photo | `live`, offer=true, default=live | session on entry | asked on entry only | explicit Photoreal | Live | PASS |
| E | Camera denied | AI Photo, no retry loop | `ai_photo`, `permission_unavailable` | none | asked once | explicit generate | AI Photo | PASS |
| F | Runtime init failure | AI Photo | `ai_photo`, `runtime_unavailable` | none | not asked | explicit generate | AI Photo | PASS |
| G | Photoreal failure | Live survives | `liveSessionRemainsUsable: true` for all 8 codes | session alive | unchanged | — | Live | PASS |
| H | Unsupported garment | AI Photo | `ai_photo`, `garment_unsupported` | none | not asked | explicit generate | AI Photo | PASS |
| I | Module self-check throws | fail closed | `lookup_failed` → `native_module_missing` | none | not asked | explicit generate | AI Photo | PASS |
| J | Malformed capability (`{}`, `[]`, `null`) | fail closed | not capable in all 12 shapes | none | not asked | explicit generate | AI Photo | PASS |
| K | `capable:true, runtimeReady:false` | fail closed | `runtime_unavailable` | none | not asked | explicit generate | AI Photo | PASS |
| L | Permission changes mid-session | no re-prompt loop | memo + shared in-flight promise; one prompt | session unaffected | asked once | unchanged | unchanged | PASS *(repaired VTO-HA-002)* |
| M | Capability removed while active | teardown | `liveSurfaceWithdrawn` → `exitLive` | disposed | — | explicit generate | AI Photo | PASS |
| N | Sheet minimized while Live active | teardown | `!visible` → `exitLive` | disposed | — | explicit generate | pill | PASS |
| O | Error boundary fires with camera active | Live only is lost | `liveCrashed` → `exitLive` + AI Photo | disposed | — | explicit generate | AI Photo | PASS |
| P | Product switches while Live active | runtime switches garment | `switchGarment(newRef)` | session kept | unchanged | — | Live | PASS *(repaired VTO-HA-004)* |
| Q | Garment unsupported after switch | route to AI Photo | `liveOffered` false → `exitLive` + AI Photo | disposed | — | explicit generate | AI Photo | PASS |
| R | Rapid Live / AI Photo toggling | one session | one controller, one prompt | one session | one prompt | — | as selected | PASS *(repaired VTO-HA-002)* |
| S | Photoreal tapped repeatedly | one capture, one job | 1 capture, 1 adoption, control disabled | session kept | unchanged | ONE explicit generate | Live→AI Photo | PASS *(repaired VTO-HA-003)* |
| T | Sheet closes during Photoreal transition | no leak | unmount disposes; disposed session drops events | disposed | — | in-flight generation survives by design | — | PASS |

Rows A–H reproduce #296's own matrix. Rows I–T are this audit's additions.

**Evidence class for the whole matrix: UNIT/CONTRACT TEST against real
application source with injected dependencies. No native runtime, no device, no
camera, no provider call.**

---

## PILLAR RESULTS

| Pillar | Result | Basis |
|---|---|---|
| 1 — Feature correctness | PASS | A–T matrix; 2 defects found and fixed (VTO-HA-003, VTO-HA-004) |
| 2 — Integration correctness | PASS | research → promoted contract → app wiring traced per symbol |
| 3 — AI Photo regression | PASS | surface intact with Live off; `capability` optional; store/client/Edge path unchanged |
| 4 — Capability routing | PASS | 15 matrix rows + 8 hostile router inputs + 16 native self-check shapes, 0 failures |
| 5 — Privacy / data boundary | PASS after repair | VTO-HA-001 found and fixed; 20 poisoned payloads blocked |
| 6 — Backend contract compatibility | PASS | vocabulary parity, field-for-field request match, no server Live concept |
| 7 — Lifecycle / resource safety | PASS after repair | VTO-HA-002 found and fixed; VTO-LIVE-001's three teardowns re-verified |
| 8 — Failure injection | PASS | malformed capability/module/capture/event/permission all fail closed |
| 9 — Contract drift / authority | PASS after repair | VTO-HA-001 and VTO-HA-006 found and fixed; drift now mechanical |
| 10 — Evidence integrity | PASS after repair | VTO-HA-006; every claim in this ledger carries its evidence class |

---

## CARRIED FORWARD — HUMAN AND DEVICE HOLDS

These are **not** satisfied by this audit and are not implied by a code PASS.

```
P3-A HUMAN VISUAL VERDICT:   PENDING
CASE 8:                      PENDING HUMAN DISPOSITION — COLOR FIDELITY
REAL PRODUCT CORPUS:         HOLD
NATIVE RUNTIME:              HOLD — NOT VALIDATED
PHYSICAL DEVICE:             NOT VALIDATED
REAL PERSON VTO:             NOT VALIDATED
```

### Case 8 — what this audit verified, and what it did not

Section 31 permits verifying the metrics, the transform, the manifest and
reproducibility, and repairing only a **deterministic product-fidelity
invariant** broken at P0–P3. From
`case-8-bright-scene-dark-garment-manifest.json` at `266ab1a`:

```
rigidGate.passed:                 true, findings: []
silhouetteUnchanged:              true
hueDeltaDegrees:                  0
sampledColor:                     rgb(35,35,43) -> rgb(27,27,34)
preservesChannelBrightness80pct:  false   (27/35 = 0.771, 34/43 = 0.791)
```

**No hard invariant is broken.** Hue is exactly preserved, the silhouette is
unchanged, the rigid gate passes with no findings, and the ~8/255 absolute
darkening is consistent with the program's own declared bounds (gamma clamped
to [0.88, 1.14], shadow multiplicative-only ≤14%, alpha untouched). The failing
signal is a **relative** 80% channel-brightness threshold, which is inherently
harsher on an already-dark garment than on a light one — exactly the
subjectivity #295 disclosed rather than tuned away.

**Therefore no repair is authorised and none was made. The visual verdict is
not the agent's to issue and remains PENDING.**

### Package #2 — the four accepted limitations

Confirmed present and unaltered in `docs/vto-visual-verdicts.md` at `266ab1a`,
carried forward from `docs/vto-static-preview-review.md`, none of them a
required change for that gate:

| Limitation | Disposition |
|---|---|
| Armpit gap with arms away/crossed (no gusset geometry modelled) | **ACCEPTED — FIXTURE/MODEL LIMITATION** |
| Residual aspect deviation on stress bodies (1.155 broad, 0.864 narrow) | **ACCEPTED — bounded, not eliminated** |
| Broad fixture deliberately outside a realistic human range | **ACCEPTED — FIXTURE LIMITATION** (stress case, not typical) |
| Lower torso reads slightly boxy (linear taper below `TORSO_WIDTH_HOLD_T`) | **ACCEPTED — P3 OWNED / DEFERRED**, no drape model |

### Research-lane reproduction

`kscan-live-vto/` at `266ab1a` was independently built and tested this session
(`npm install && npm run build && npm test`, 10 packages in dependency order):
**287/287 passing, 0 failures**, matching #295's claim. This is Node reference
renderer evidence only — **not** native, **not** device, **not** a real model.

### Research-line defects

**None found.** No P0–P3 defect originates in #291 or #295 source. VTO-HA-001
is a promotion defect in #296: #291's own lists are correct and complete, and
the transcription into the app lost a key. Neither research PR was modified;
neither evidence package was rewritten.

---

## SCOPE AND MUTATION

```
BACKEND MUTATION:              NO  — supabase/functions/vto-generate read only
PRODUCTION/STAGING MUTATION:   NO  — no deploy, no config change, no enablement
PROVIDER PAID CALLS:           0
MERGES:                        NONE — #291, #295, #296 and the audit PR all left open
P4 STARTED:                    NO
FEATURE ENABLEMENT:            NO  — no flag turned on, in any profile
EXCLUDED PER SECTION 6:        synthetic-actor `confirmed_at` (PR #297) — not
                               audited, not repaired, no VTO dependency on it
```

Every P0–P3 repair is inside the VTO boundary. The scope guard
(`scripts/check-vto-live-integration-scope.js`) was neither disabled nor
relaxed.
