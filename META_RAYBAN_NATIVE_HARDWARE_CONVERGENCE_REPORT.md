# K Scan AI — Meta Ray-Ban Native Hardware Convergence

**Date:** 2026-08-22
**Phase:** Native Meta device adapter build (DAT 0.9.0)

---

## Executive Verdict

The missing piece really was the native device boundary, and it is now built.
Before this phase the K Scan wearable stack was complete and honest about its
own gap — `metaWearableCompanion.ts` says so in a header comment: *"there is
no code running on the physical Meta glasses in this candidate build."* The
phone minted its own pairing challenge and took its own photo with
`ImagePicker.launchCameraAsync`.

This phase reconciled that stack against the current official Meta Wearables
Device Access Toolkit, built a real DAT 0.9.0 native adapter as an Expo local
module, wired it into the actual scan flow behind a capability-negotiation
layer, and closed the result-grouping question that the previous continuation
left open — which turned out to be a genuine defect, not a documentation gap.

One hard blocker stands between this work and any claim of hardware readiness,
and it is environmental rather than architectural: **the DAT artifacts cannot
be resolved on this machine.** All four return HTTP 401. Nothing in this report
claims a DAT compile, a MockDeviceKit run, or a device session was executed.

**Verdict: PASS WITH CONDITIONS — META NATIVE HARDWARE CANDIDATE PASSES
SOFTWARE/MOCKDEVICE GATES; NAMED PHYSICAL-HARDWARE GATES REMAIN**

with one honest amendment to that wording: the MockDeviceKit gate was **not**
passed, because MockDeviceKit ships inside the same unresolvable package set.
It is named below as a remaining gate rather than reported as met.

---

## Repositories / Branches / SHAs

| Repo | Branch | HEAD | Remote state |
|---|---|---|---|
| `C:\Users\jsmit\kscan-glasses-webapp` | `feature/meta-physical-device-candidate-v1` | `8b67161` | pushed; was `ad7de55` |
| `C:\src\KScan-meta-physical-device-v1` | `feature/meta-physical-device-candidate-v1-mobile` | `466cc6a`+ | **now pushed** (first ever push); was `ad46eb1`, local-only |

`C:\src\KScan-glasses-ingestion-v1` was not merged or drawn from. Nothing in it
was needed: the missing piece was the Meta boundary, which it does not contain.

Verified at session start rather than assumed:

- The webapp branch was **not** at historical Phase A — `ad7de55`, well past it.
- The mobile branch was still at the previously known `ad46eb1`, and was **not**
  pushed; `git ls-remote` showed no such branch on `origin`.
- The mobile tree carried **uncommitted** work: a privacy-geometry extraction
  plus its test, unstaged and untracked. It has been preserved and committed,
  not discarded.

---

## Official Meta DAT Authority

Sources consulted this session (not recalled API names):

- `facebook/meta-wearables-dat-android` — `README.md`, `CHANGELOG.md`, `AGENTS.md`
- `wearables.developer.meta.com/docs/develop/dat/build-integration-android/`
- `wearables.developer.meta.com/docs/reference/android/dat/0.9/`
- `wearables.developer.meta.com/docs/develop/dat/display-android/`

## SDK Version

**0.9.0**, released **2026-08-03** — three weeks before this session. Artifacts:

```
com.meta.wearable:mwdat-core:0.9.0
com.meta.wearable:mwdat-camera:0.9.0
com.meta.wearable:mwdat-display:0.9.0
com.meta.wearable:mwdat-mockdevice:0.9.0
```

Served from `https://maven.pkg.github.com/facebook/meta-wearables-dat-android`,
requiring a personal access token with `read:packages`.

**Resolution was tested, not assumed.** With the only GitHub credential
available on this host (`gh auth` token, scopes `gist, read:org, repo,
workflow` — no `read:packages`) and anonymously, every artifact returns:

```
mwdat-core      -> HTTP 401
mwdat-camera    -> HTTP 401
mwdat-display   -> HTTP 401
mwdat-mockdevice-> HTTP 401
```

This single fact determines which evidence categories below can be marked
verified and which cannot.

---

## Supported Hardware / Capability Matrix

Derived from the DAT changelog and reference, and from what the adapter
actually implements. Not assumed from model names.

| Capability | Displayless (camera-first, e.g. `RAYBAN_META`) | Display-capable (e.g. Ray-Ban Display) | K Scan implementation |
|---|---|---|---|
| Device connection | Yes — `Wearables.devices`, `Device.linkState` | Yes | `listDevices()` / `activeDevice()`; only `LinkState.CONNECTED` counts |
| Photo capture | Yes — `Camera.stream.capturePhoto()` | Yes | `capturePhoto()`; primary K Scan path |
| Video | Yes — `StreamConfiguration` | Yes | Attached at **2 fps**, the lowest legal rate; K Scan takes one still |
| Display | **No** | Yes — `DeviceSession.addDisplay`, requires DAM | `displayAvailable()` reads device capability; glanceable render only |
| Device state | Yes — `getDeviceState`, thermal + battery (battery added 0.9) | Yes | `deviceState()`; thermal gate blocks capture at CRITICAL/EMERGENCY |
| Background behavior | Per 0.9 sample background support | Same | **Not exercised** — see remaining gates |
| MockDeviceKit | `MockDeviceKit.pairGlasses(GlassesModel)` | Same | Implemented; **not runnable** (401) |

`GlassesModel` in 0.8+: `RAYBAN_META`, `OAKLEY_META_HSTN`,
`OAKLEY_META_VANGUARD`, `RAYBAN_META_OPTICS`, `META_GLASSES`. The obsolete
`pairRaybanMeta()` is **not** used.

---

## SDK Migration Findings

K Scan had no DAT code at all — every prior grep hit was a build artifact — so
this is a first integration, not a migration. It was written against 0.9
semantics directly, which mattered in several places where an older assumption
would have been wrong:

| 0.9 reality | What a stale integration would have done |
|---|---|
| `DeviceSession.addCamera()` returning `Camera` | `addStream()` — **removed** in 0.9 |
| DAM is the only app model going forward | Omit `DAM_ENABLED`, losing Display entirely |
| `Camera` states STARTING/STARTED/STOPPING/STOPPED | Watch `StreamState` for camera lifecycle |
| `DatResult` is a Java-visible reference type | Rely on Kotlin inline-class behaviour |
| `RegistrationState` is a plain enum (0.7+) | Treat it as the old sealed hierarchy |
| Battery in device state (0.9) | Report thermal only |

---

## Native Adapter

`modules/kscan-meta-wearable/` — an **Expo local module**, deliberately not
edits under `android/`. Prebuild regeneration has repeatedly wiped hand-edited
generated files in this repo; an autolinked local module survives `prebuild`.
Autolinking discovery was verified:

```
'kscan-meta-wearable': { platforms: ['android'],
  android: { modules: ['com.kscan.metawearable.MetaWearableModule'] } }
```

Three files, split along one axis — whether the code may name a DAT type:

- **`MetaWearableEngine.kt`** (main source set) — the entire surface with no
  DAT symbol in it, plus `UnavailableEngine`, which refuses every call with
  `META_ADAPTER_UNAVAILABLE`. It is **not** a simulator and never pretends a
  device, session or capture exists.
- **`DatEngine.kt`** (`mwdat` source set) — the real integration, resolved by
  reflection so the main set never references it.
- **`MetaWearableModule.kt`** — the Expo bridge: OS floor, init guard, error
  translation, single observer closed on destroy.

Both the dependency and the `mwdat` source set are gated on
`kscan.mwdat.enabled` / `KSCAN_MWDAT_ENABLED`, default **off**, and the build
fails loudly with an explanatory message if the flag is on without a token.

### The one unverified symbol

`PhotoData`'s byte accessor (`photo.bytes`) could not be confirmed — the
`PhotoData` reference sits behind the same gated registry as the artifacts. It
is isolated in a single one-line function, `photoBytes()`, and commented as
unverified, so confirming it against the real SDK is a one-line change rather
than an audit. **No other DAT symbol in this adapter is unverified**; the rest
come from the official changelog and integration docs. Package roots
(`com.meta.wearable.dat.*`, wildcard-imported as the official Display doc
shows) were corroborated by two independent sources.

---

## React Native / Expo Bridge

`KScanMetaWearable.types.ts` is the only thing K Scan JS knows about Meta. The
native module returns plain bounded maps; no DAT object, no raw exception, no
image buffer crosses.

`requireOptionalNativeModule` — not `requireNativeModule` — so a build without
the adapter returns `null` instead of taking down the JS bundle, which is
currently every build.

Every `MetaWearableException` becomes a coded JS error. Unexpected throwables
are flattened to one opaque code and **the cause is deliberately not
forwarded**, because SDK-internal messages on a capture path can carry buffer
detail that has no business in JavaScript. `CancellationException` is re-thrown
untouched so a cancelled capture settles as cancelled, not as a device fault.

## Initialization

`UNINITIALIZED → INITIALIZING → READY → FAILED`. Nothing runs before READY;
every entry point checks. DAT explicitly forbids calling APIs before
`Wearables.initialize`, and `AGENTS.md` names it as a common mistake.

## Registration

`Wearables.startRegistration(activity)`, state read from
`Wearables.registrationState`, errors from `registrationErrorStream`. Session
creation refuses unless state is `REGISTERED`. Manifest declares
`APPLICATION_ID` / `CLIENT_TOKEN` placeholders and `DAM_ENABLED`. **No
developer secret is committed** — Developer Mode permits `0`.

## Device Discovery

`Wearables.devices` collected continuously. A device that is merely paired but
not `CONNECTED` yields **no** capabilities. When no connected device remains,
capability handles are invalidated immediately rather than at next capture —
that is what prevents a false ready state.

## Session Lifecycle

A session reaching a terminal state is discarded and never reused, enforced on
both the native and JS sides. `startSession()` waits for the observed
transition to `STARTED` rather than assuming `start()` is synchronous.

## Camera

`addCamera(StreamConfiguration(...))` after — and only after — the session is
`STARTED`. Frame rate defaults to **2 fps**, the lowest DAT permits, because
the stream exists only to make `capturePhoto` legal. Typed `CaptureError` cases
map onto distinct K Scan codes.

## Photo Capture

Photo-first, as the product is. The capture is written to app-private storage
natively and only a `file://` URI crosses the bridge — never bytes, never
base64, never a log line. Dimensions travel with it from a header-only decode
(`inJustDecodeBounds`, no full bitmap allocated), because the privacy sanitizer
needs them: **without dimensions a full-resolution capture fails its own
reconstruction check**, since DAT's HIGH quality is 720×1280 and the sanitizer
caps the long edge at 800.

Bounded at 12 MB; timeout clamped to 1–30 s; a timed-out or cancelled capture
deletes its file.

## Display

Attached only when the device reports the capability. The rendered card is
deliberately low-density — title, one supporting line, price, action row —
using `flexBox`/`text`/`buttonGroup`. **The browser HUD was not ported.** A
wearer reading this is walking around.

A display failure never fails a scan: the result is already safe on the phone.

## Device State

Thermal, battery, charging, worn, session state, camera state. Application
correctness never depends on it — every read is failure-tolerant.

## Background Behavior

**Not exercised.** Requires a running session.

---

## MockDeviceKit Validation

**NOT RUN — blocked.** `mwdat-mockdevice:0.9.0` returns HTTP 401 like the rest.
The adapter implements `mockEnable` / `mockPairGlasses` / `mockSetDevicePower` /
`mockSetWorn` / `mockDisconnect` / `mockDisable` against the current
multi-model API, and those calls are ready to run the moment the token exists.

The K Scan browser simulator was **not** substituted for it, and no
mock-derived result is reported as evidence anywhere in this document.

---

## K Scan Wearable Session

Two trust boundaries, kept distinct:

- **DAT device connection** — Meta's, hardware-scoped.
- **K Scan wearable session** — K Scan's, account-scoped, minted by
  `wearable-bridge` and carried as a short-lived session token.

`K SCAN READY` requires both. Losing either removes protected capability: DAT
loss invalidates capability handles; K Scan session loss fails
`wearable-scan` / `wearable-save` / `wearable-open-on-phone` at the server.

The adapter deliberately does **not** touch pairing. The bridge contract is
unchanged, and no `meta-wearable-backend-v2`, `wearable-companion-v2` or
Meta-specific pairing table was created. One shared wearable backend remains.

## Privacy

The native path feeds the **same** fail-closed sanitizer, unchanged:

```
META PHOTO -> app-private file -> privacy validation -> face mask
           -> approved image only -> wearable-scan
```

One real defect fixed here: the policy stamped `source: 'phone_camera'`
unconditionally. Once glasses capture exists that is a **false attestation**
stored against the scan, so `source` is now passed by the caller and glasses
captures record `meta_glasses`.

Memory-safety properties: no raw image logging, no base64 across the bridge, no
analytics payload, bounded size, temporary files deleted on every exit path
including cancellation.

## wearable-scan

Unchanged and still authoritative. Confirmed live on App Staging
(`yzqjvdfgefveprobvvyw`), version **3**, `ACTIVE` — alongside `wearable-bridge`
v2, `wearable-save` v2, `wearable-open-on-phone` v1.

## Canonical Analysis / StyleMatch

Unchanged. No Meta-only scanner was created.

---

## Result Grouping

The previous continuation flagged this for explicit verification. It is closed,
and it was a **real defect in both directions**:

- `wearable-scan/normalize.ts` stamped `commerceGroup: 'retail'` on **every**
  product regardless of origin.
- The companion contract accepted only `retail|resale` and clamped anything
  else to `retail`.
- `buildCompanionStyleMatch` allocated a `suggested` bucket that **nothing
  could ever populate**.
- `resultFormatter.js` collapsed any non-`resale` sourceType back to `retail`
  on the way out.

Net effect: a catalog visual-similarity match was presented to the wearer as a
buyable retail listing, and `resale` and `suggested` were permanently empty.

Fixed by deriving the group from provenance — which invents nothing, because
scan-identify already returns the two arrays separately and the canonical
StyleMatch shape already has the buckets:

```
recommendedProducts -> live commerce listings   -> 'retail'
similarityMatches   -> catalog similarity shelf -> 'suggested'
```

**`resale` is still never produced, on purpose.** The response carries no
resale provenance, and deriving one from a retailer name would be a guess
presented to the wearer as a fact. A test pins that absence so removing it has
to be deliberate.

Backward compatible: an older client that does not know `suggested` clamps it
to `retail` — exactly today's behaviour.

## Save

`wearable-save`, session-token authenticated, idempotent on `resultId`, which
is also passed as the stable action id. No optimistic success: the UI reports
saved only after the call resolves. Covered by the existing wearable
integration suite (14 tests, passing).

## Open on Phone

`wearable-open-on-phone` → deep link → `router.push('/wearables/result/<id>')`
— the exact result, not app home.

## Disconnect / Reconnect

Device loss invalidates capability handles and emits
`capabilitiesInvalidated`. Terminal sessions are never reused. Exactly one
native observer exists and it is closed on module destroy, so listeners cannot
stack across reconnects.

## Cancellation

Checked at every bring-up step, and — the case that matters — **a photo that
lands after a cancel is discarded and its file deleted**, never delivered into
a flow that has already ended. Directly tested.

## Security / Privacy

- Raw-image bypass: not reachable; only a file URI crosses, and only a
  sanitized data URL reaches the server.
- Token logging: no credential crosses the bridge.
- Duplicate capture completion: guarded by an atomic in-flight flag plus DAT's
  own `CaptureInProgress`.
- Oversized payload: 12 MB ceiling.
- Stale session: terminal sessions rejected on both sides.
- Public artifact separation: the public Meta simulator was **not** altered; no
  MockDeviceKit, DAT debug control, credential or native QA flag was added to
  any public web artifact.

---

## Defects Found

1. **Result grouping collapse** (both directions) — similarity matches
   mislabelled as retail; `suggested` unreachable. *Real, fixed.*
2. **Privacy provenance falsehood** — policy would attest `phone_camera` for a
   glasses capture. *Real, fixed.*
3. **Capture dimensions** — a glasses capture without dimensions fails the
   sanitizer's own reconstruction check at DAT HIGH quality. *Real, fixed at
   the native source.*
4. **`meta-physical-candidate` EAS profile inherited its Supabase target** via
   `extends: preview`; the repo's provenance gate reads `eas.json` literally
   and does not resolve `extends`, so an inherited target read as *no target
   declared*. **Pre-existing and failing before this session.** *Fixed.*

## Defects Fixed

All four above.

## Upstream Meta SDK Issues

None reproduced — the SDK could not be fetched. No workaround for any
mock-only or SDK-side defect was written into production code.

---

## Automated Tests

| Suite | Result |
|---|---|
| `metaWearableDevice.test.js` (new) | **26 pass / 0 fail** |
| `metaWearablePrivacyGeometry.test.js` | 11 pass / 0 fail |
| `wearable-scan` Deno normalization (+5 new) | **16 pass / 0 fail** |
| Companion result contract (+4 new) | **29 pass / 0 fail** |
| Companion protocol / pairing / statemachine / reconnect | 67 / 18 / 30 / 13 pass |
| Wearable integration | 14 pass / 0 fail |
| Webapp contract + static | pass |
| Mobile full suite | **6132 pass / 7 fail** (6198 total) - all 7 pre-existing |

The new orchestration suite covers capability negotiation, capability-driven
(never model-driven) experience selection, bring-up ordering, hardware release
on every failure path, cleanup failures not masking the original error,
cancellation including the late-photo case, and glanceable mapping.

`services/metaWearableDevice.ts` has **zero runtime imports** by design, and
the harness runs it in a sandbox whose `require()` throws — so if anyone later
adds a native import there, the tests fail loudly instead of the capability
layer silently becoming device-only.

---

## Android Builds

`tsc --noEmit` on the mobile candidate: **clean**.

ESLint: **not run** - the mobile repo has no ESLint config (`eslint.config.*`
absent), so lint is not wired there. Not a regression; noted rather than
silently skipped.

Expo autolinking discovery: **verified** (output quoted in the Native Adapter
section).

Gradle configuration including the new module: **BUILD SUCCESSFUL**, with
`Project ':kscan-meta-wearable'` present in the project graph.

Module compile — `:kscan-meta-wearable:assembleDebug` with the DAT flag
**off**: **BUILD SUCCESSFUL, 0 Kotlin errors.**

That build caught a real bug in this session's own code and is worth recording
rather than quietly fixing: the Expo `AsyncFunction(...) Coroutine { }` infix
form needs `import expo.modules.kotlin.functions.Coroutine`, which was missing.
Every suspend-bodied function failed to resolve. Verified against the installed
`expo-modules-core@3.0.30` source rather than guessed, then fixed and rebuilt
clean. It is exactly the class of error that source-text-only checking would
have missed.

Full app APK: **not built**. The candidate APK gate remains open.

## Runtime Validation

### What ran

- Mobile full suite: **6198 tests, 6132 pass, 7 fail.**
- Webapp suites: companion protocol 67, pairing 18, state machine 30, result
  contract 29, reconnect 13, wearable integration 14, `wearable-scan` Deno 16,
  plus contract and static - **all passing**.
- `tsc --noEmit`: clean.
- Gradle project configuration: successful, module present in the graph.
- `:kscan-meta-wearable:assembleDebug` (flag off): **BUILD SUCCESSFUL**,
  0 Kotlin errors.
- Live backend inventory on App Staging: `wearable-bridge` v2, `wearable-save`
  v2, `wearable-open-on-phone` v1, `wearable-scan` v3 - all `ACTIVE`.

### The 7 mobile failures are pre-existing, and that was proven, not assumed

They concern production-profile feature flags and `package.json` dependencies.
A negative control was run rather than asserted - every build profile compared
against `HEAD`:

```
meta-physical-candidate  identical_to_HEAD=False   <- the only one touched
preview                  identical_to_HEAD=True
development              identical_to_HEAD=True
production               identical_to_HEAD=True
staging                  identical_to_HEAD=True
package.json touched:    NO
```

The failing tests read exactly those unchanged inputs. The count also moved
**8 -> 7** across this session: the eighth was the `meta-physical-candidate`
Supabase-target failure, which was failing before this work and is now fixed.
No failure was introduced.

### Environment faults, recorded so they are not misread as product defects

1. `local.properties` was first written with unescaped Windows backslashes. A
   Java properties file treats `\` as an escape, so the path was mangled and
   Gradle failed with *"The filename, directory name, or volume label syntax is
   incorrect"* while configuring `:app` - inside the React Native root plugin,
   nothing to do with this module. Rewritten with forward slashes; the same
   command then succeeded. This was an environment fault of my own making, not
   a build regression.
2. A `git worktree` negative control was abandoned after `node_modules`
   symlinking hung on Windows. The profile-comparison method above replaced it
   and is stronger evidence anyway.

### MockDeviceKit journey

**Not run.** Every stage - registration, permissions, pairing, power,
fold/unfold, don/doff, disconnect, session start/stop, camera attach, capture -
is blocked by one cause: `mwdat-mockdevice:0.9.0` returns HTTP 401. No
substitute was used, and no stage is reported as passed.

### Live staging path

**Not run.** The authenticated leg (privacy -> `wearable-scan` -> StyleMatch ->
Save / Open-on-Phone) needs a staging account, and no credentials exist on this
host: no `.env`, no `SUPABASE_*`, no test-account variables. **No dev-auth
bypass was implemented** to work around it.

---

## Commits / Push Confirmation

**Mobile** - `kscanaiapp/kscan-app`, branch
`feature/meta-physical-device-candidate-v1-mobile`. This branch had **never
been pushed** before this session; this is its first push.

| SHA | Commit |
|---|---|
| `9d39dbd` | `refactor(meta): extract testable privacy geometry and record capture provenance` |
| `4143e03` | `feat(meta): add native Meta Wearables Device Access Toolkit adapter (DAT 0.9)` |
| `af6dcbb` | `feat(meta): capture from the glasses when they are there, the phone when they are not` |
| `466cc6a` | `fix(meta): import the Expo Coroutine infix builder so the adapter compiles` |
| `693b4fb` | `docs(meta): finalize convergence report with SHAs and push confirmation` |

`9d39dbd` preserves the uncommitted privacy-geometry work that was already in
the tree at session start; it was not discarded.

**Webapp** - `kscanaiapp/kscan-glasses-webapp`, branch
`feature/meta-physical-device-candidate-v1`.

| SHA | Commit |
|---|---|
| `8b67161` | `fix(meta): group wearable results by provenance instead of labelling all retail` |

**Push confirmation** - local HEAD equals origin HEAD for both, trees clean:

```
WEBAPP local=8b671618360aa9806b089108facc9c8de89139eb  origin=8b671618360aa9806b089108facc9c8de89139eb
MOBILE local=693b4fb (== origin/feature/meta-physical-device-candidate-v1-mobile)
```

No merge to `main`/`master`. No force push. Feature branches only.

---

## Evidence Classification

| Category | Status |
|---|---|
| META DAT SOURCE VERIFIED | **VERIFIED** — official repo + docs, this session |
| DAT VERSION VERIFIED | **VERIFIED** — 0.9.0, released 2026-08-03 |
| DAT INITIALIZATION VERIFIED | **NOT VERIFIED** — code written; SDK unresolvable |
| REGISTRATION VERIFIED | **NOT VERIFIED** — same |
| DEVICE DISCOVERY VERIFIED | **NOT VERIFIED** — same |
| DAT SESSION VERIFIED | **NOT VERIFIED** — same |
| CAMERA CAPABILITY VERIFIED | **NOT VERIFIED** — same |
| PHOTO CAPTURE VERIFIED | **NOT VERIFIED** — same |
| DISPLAY CAPABILITY VERIFIED | **NOT VERIFIED** — same |
| MOCKDEVICEKIT VERIFIED | **NOT VERIFIED** — `mwdat-mockdevice` 401 |
| NATIVE BRIDGE VERIFIED | **VERIFIED (flag off)** — autolinked, compiles clean; DAT-linked variant unbuilt |
| K SCAN AUTH VERIFIED | **NOT VERIFIED** — no staging credentials on this host |
| K SCAN WEARABLE SESSION VERIFIED | **NOT VERIFIED** — requires auth |
| PRIVACY VERIFIED | **PARTIAL** — geometry and provenance unit-verified; device path not run |
| WEARABLE-SCAN VERIFIED | **PARTIAL** — deployed v3 ACTIVE confirmed; not invoked (no auth) |
| STYLEMATCH VERIFIED | **NOT VERIFIED** — requires an authenticated scan |
| RESULT MAPPING VERIFIED | **VERIFIED** — 9 new contract tests, both directions |
| SAVE VERIFIED | **PARTIAL** — contract tests pass; no authenticated round trip |
| OPEN-ON-PHONE VERIFIED | **PARTIAL** — routing verified by test + source; no live run |
| RECONNECT VERIFIED | **PARTIAL** — JS-layer verified; DAT-layer not run |
| BACKGROUND VERIFIED | **NOT VERIFIED** |
| ANDROID BUILD VERIFIED | **PARTIAL** — module assembles + `tsc` clean; full APK not built |
| CANDIDATE APK VERIFIED | **NOT VERIFIED** |
| PHYSICAL META HARDWARE VERIFIED | **NOT VERIFIED** — no glasses present |

---

## Remaining Physical-Hardware Gates

1. **GitHub Packages token with `read:packages`** — the gate everything else
   sits behind. Owner action; the current `gh` token lacks the scope.
2. **DAT compile** — build with `KSCAN_MWDAT_ENABLED=true` and confirm
   `photoBytes()` against the real `PhotoData`.
3. **MockDeviceKit journey** — registration, permissions, pairing, power,
   don/doff, disconnect, session, camera, capture; `RAYBAN_META` plus a
   display-capable model, to prove capability negotiation rather than names.
4. **Meta developer registration** — real `APPLICATION_ID` / `CLIENT_TOKEN`,
   Developer Mode, Meta AI app.
5. **Staging credentials** — for the authenticated
   privacy → `wearable-scan` → StyleMatch → Save/Open round trip.
6. **Deploy the `wearable-scan` grouping fix** — source and tests landed; live
   is still v3 with the old all-`retail` behaviour. Left undeployed
   deliberately: it is a governed release action, not a build step.
7. **Physical glasses** — background/foreground, thermal, reconnect-under-load.

---

## Final Verdict

**PASS WITH CONDITIONS — META NATIVE HARDWARE CANDIDATE PASSES SOFTWARE GATES;
NAMED PHYSICAL-HARDWARE GATES REMAIN**

The software boundary is real, ordered correctly against DAT 0.9 semantics,
capability-driven rather than model-driven, and tested where it can be tested.
Four genuine defects were found and fixed, one of them pre-existing and failing
before this session.

What is *not* claimed: no DAT code has been compiled, no MockDeviceKit journey
has been run, and no glasses session has ever existed. Those gates are named
above with the exact blocker, and every one of them traces back to a single
missing token scope.
