# K SCAN AI — BUILD 34 ANDROID

# STAGING-CERTIFICATION DEVICE HANDOFF

Prepared: 2026-08-31
Convergence branch: `feature/build34-android-certification-voice-convergence-v1`
Base authority: `integration/backend-kplus-complimentary-staging-v1` @ `284a8ea9fcfca0264ba25e76eab23c22b27feaa4`
Staging backend: `yzqjvdfgefveprobvvyw` (K Scan AI Staging)
Artifact class: `STAGING_CERTIFICATION_ARTIFACT = TRUE` / `PRODUCTION_SUBMISSION_ARTIFACT = FALSE`

> **This document supersedes the device classifications in
> `docs/BUILD34_ANDROID_STAGING_CERTIFICATION_REPORT.md`.** That report was
> written against a candidate where K+ was OFF, Watchlist was N/A, and Voice
> Scan did not exist on the lineage. All three are now ON in the
> `staging-certification` profile. Its §L (MIC) and §N (feature matrix) are
> corrected in place and point here; the rest of that report stands.

---

## 0. WHAT CHANGED, AND WHAT THAT MEANS FOR TESTING

| Feature | Previous classification | Now | Why the tester must treat it differently |
|---|---|---|---|
| K+ Early Access | OFF (flag unset) | **ON** | The K+ boundary now renders. Every K+-gated surface becomes reachable. |
| Smart Watchlist | N/A (flag unset) | **ON — FIRST LIVE END-TO-END STAGING EXECUTION** | Staging has **zero** Watch rows, watch events, and device push tokens. Nothing has ever run this path end to end. The device test IS the first execution. |
| Voice Scan | N/A (not implemented) | **ON — NEWLY CONVERGED FROM ACCEPTED #218 LINEAGE — FIRST EXECUTION ON CURRENT INTEGRATION AUTHORITY** | The implementation is accepted, but it has never run on THIS tree, and it introduces the first native microphone path and the second native module. |

Nothing below may be reported as "passed" on the strength of a source check.
Every row is a device observation.

---

## 1. TARGET CERTIFICATION MATRIX

Effective `staging-certification` profile (`extends: staging`, so the backend
is inherited verbatim and cannot drift onto production):

| Feature | State | Gate that makes it true |
|---|---|---|
| Scanner | ON | inherited staging env |
| Text Scan | ON | `EXPO_PUBLIC_ENABLE_TEXTSCAN`, `..._BACKEND_ENABLED` |
| Elise | ON | `EXPO_PUBLIC_AI_STYLIST_ENABLED` (+ backend) |
| Closet | ON | inherited staging env |
| Dressing Rooms | ON | inherited staging env |
| VTO | ON (client) | `EXPO_PUBLIC_VTO_UI_ENABLED` — **server kill switch still OFF, see §6** |
| Packing Intelligence | ON (client) | `EXPO_PUBLIC_PACKING_INTELLIGENCE_V1` — **server gate OFF, see §6** |
| Wardrobe Concierge | ON (client) | `EXPO_PUBLIC_ELISE_CONCIERGE_V1` — **server gate OFF, see §6** |
| K+ Early Access | ON | `EXPO_PUBLIC_KPLUS_EARLY_ACCESS_ENABLED` |
| Smart Watchlist | ON | `EXPO_PUBLIC_SMART_WATCHLIST_V1` |
| Voice Scan | ON | `EXPO_PUBLIC_VOICESCAN_ENABLED` + native `KSCAN_VOICE_CERTIFICATION` |

Backend: `https://yzqjvdfgefveprobvvyw.supabase.co`, `EXPO_PUBLIC_ENVIRONMENT=staging`.

**Production is untouched.** No production feature flag, backend value, or
native permission changed. `__tests__/easConfigIntegrity.test.js` asserts
exhaustively that no profile other than `staging-certification` carries any of
these keys.

---

## 2. BLOCKING PRE-BUILD / PRE-DEVICE ITEMS (OWNER)

These are not test rows. Each one, left undone, makes a whole feature
untestable in a way that looks like a product bug on the device.

| # | Item | Observed state | Effect if not done |
|---|---|---|---|
| B1 | `ELISE_PACKING_INTELLIGENCE_V1_ENABLED` staging secret | **ABSENT** → code default `false` | Packing client flag is ON, server refuses. Packing certification is impossible. |
| B2 | `ELISE_CONCIERGE_V1_ENABLED` staging secret | **ABSENT** → code default `false` | Concierge client flag is ON, server refuses. Concierge certification is impossible. |
| B3 | `app_config.vto_generation.enabled` | `false` | VTO renders and every generation is refused by the kill switch. Real-provider VTO cannot be exercised. |
| B4 | EAS file secret `GOOGLE_SERVICES_JSON` | not provisioned | The AAB carries no Firebase config; Android can never obtain a push token. Watchlist push rows below cannot pass. |
| B5 | Expo FCM V1 service-account key (`eas credentials --platform android`) | unconfirmed | Token obtainable, delivery impossible. |
| B6 | A controlled, authenticated staging test account with **active K+** | see §3 | Every K+-gated row (Voice, Watchlist, VTO, Packing, Concierge) is unreachable. |
| B7 | `WATCHLIST_WORKER_SECRET` staging secret | **ABSENT** | Tier-2 scheduled sweep authenticates on this and fails closed. Tier-1 in-app refresh is unaffected. |

How B1/B2 were observed: `supabase secrets list --project-ref yzqjvdfgefveprobvvyw`
returns a SHA-256 digest of each secret's value. Neither name appears at all.
`supabase/functions/stylechat-generate/eliseConfig.ts` reads both with a
`false` default, so absent means off. (The digest is a plain SHA-256 of the
value, so `b5bea41b…67e12b` = `"true"` and `fcbcf165…24f8aa` = `"false"` —
this is how the other `ELISE_*_ENABLED` gates were confirmed ON.)

**Never place credentials in source or in any report, including this one.**

---

## 3. STAGING K+ ENTITLEMENT STATE (READ 2026-08-31)

`user_entitlements` holds 3 rows, all `entitlement_key = 'k_plus'`,
`status = 'active'`, `revoked_at IS NULL`:

| expires_at | expired now? | external_sync_status |
|---|---|---|
| 2027-02-28 | no | `synced` |
| 2027-02-28 | no | `failed_terminal` |
| 2026-08-28 | **yes** | `failed_terminal` |

`kplus_activation_events` holds 20 rows.

Two things follow, and both are useful:

1. **The third row is a live SEC-KPLUS-008 fixture.** Its `status` says
   `active` while its `expires_at` is in the past. The canonical predicate
   `public.kplus_has_active_entitlement` (`status = 'active' AND revoked_at IS
   NULL AND expires_at > now()`) must treat it as **not** active. If any
   surface treats that account as K+, the repair is not doing its job.
2. **Two of three rows failed to mirror to RevenueCat** (`failed_terminal`).
   That is the designed behaviour — a mirror failure must never roll back or
   block a valid local grant — and it gives the RevenueCat-semantics rows in
   §4 something real to observe.

Whether any of these three rows belongs to an account the tester can sign into
is **not** established by their existence (B6).

---

## 4. K+ EARLY ACCESS — DEVICE ROWS

Server authority reminder for every row below: **the K Scan entitlement
database is the source of truth; RevenueCat is a server-side mirror only.**
There is no mobile purchase SDK, no paywall purchase, no Google Play Billing,
and no subscription/trial/auto-renew wording anywhere in the flow.

| # | Row | Expected |
|---|---|---|
| K-01 | Grant: fresh account activates K+ | Entitlement granted; `campaignStatus: granted`; K+ surfaces unlock without any purchase UI |
| K-02 | Existing-active: activate again on an already-active account | `already_active`; no duplicate row; no second RevenueCat grant |
| K-03 | Expiry: sign in as the account whose `expires_at` is past | Treated as **not** K+; K+ surfaces locked; upgrade sheet offered |
| K-04 | Revocation: revoke server-side mid-session | Client loses K+ on next resolve; any in-flight K+ capability stops (see V-14 for Voice) |
| K-05 | Actor switch A→B | B never sees A's entitlement state |
| K-06 | Process death | Entitlement re-resolves from server on relaunch, not from a cached claim |
| K-07 | Offline → reconnect | Offline does not grant K+; on reconnect state re-resolves correctly |
| K-08 | RevenueCat mirror semantics | A `failed_terminal` mirror does **not** degrade the local entitlement; the user keeps K+ |
| K-09 | Anonymous actor rejection | Anonymous session activating K+ → `403 ACCOUNT_REQUIRED`; no entitlement written |
| K-10 | Deactivated-account rejection | Deactivated/mid-deletion account → `403 ACCOUNT_DEACTIVATED`; no entitlement written |
| K-11 | SEC-KPLUS-008 canonical logic | A **revoked** grant with a future `expires_at` is reported as consumed, **not** `already_active`, and is **not** mirrored to RevenueCat |
| K-12 | No monetization surface | No Play Billing sheet, no price, no trial/auto-renew wording anywhere in the K+ flow |

**Live backend evidence already in hand (do not re-derive):** staging
`kplus-activate` is **v13, ACTIVE, verify_jwt true**. Its deployed bundle was
downloaded and compared byte-for-byte against this branch's source:

| File | SHA-256 (LF-normalised) | Result |
|---|---|---|
| `functions/kplus-activate/index.ts` | `7059163d47b5bd7c3cc5556ab9d533419d1775545ac1d601e8242f108bc4c8a6` | **identical** |
| `functions/_shared/deletion/common.ts` | `037415daa130c2983a3b9247c4cf0bb4533353a2f0d1f8ab6a0ce335add45f19` | **identical** |
| `functions/_shared/revenuecat/revenueCatClient.ts` | `b4ebc049af655b103ee90056012d9dafc984557f74a6626d30ec215d3c851069` | **identical** |

So the SEC-KPLUS-008 canonical-entitlement repair is live on staging.

> **Governance caveat, carried forward deliberately.** v13 was deployed
> through the connected staging control plane, **not** through this
> repository's governed deploy workflow. Byte parity is recorded above so the
> deployed behaviour is not in question. If governance requires provenance as
> well as parity, redeploy the identical merged source through the approved
> staging path after merge and re-prove parity — the hashes above are the
> expected result.

---

## 5. SMART WATCHLIST — DEVICE ROWS

### CLASSIFICATION: **FIRST LIVE END-TO-END STAGING EXECUTION**

`watchlist_worker_enabled.enabled = true`, but as of 2026-08-31:

```
user_commerce_watches      0
user_commerce_watch_events 0
user_device_push_tokens    0
```

No Watch has ever been created on staging. Do not report Watchlist as
"previously passing"; there is nothing to have passed.

| # | Row | Expected |
|---|---|---|
| W-01 | Scan/result containing a genuinely watchable listing | Watch affordance is **reachable and visible** (this was a prior defect class — the button existed but no shipped surface rendered it) |
| W-02 | Watch action → create watch | Row appears in `user_commerce_watches` for the signed-in user |
| W-03 | Watchlist screen | The new Watch is listed with correct product/price |
| W-04 | Tier-1 refresh | In-app refresh updates price/availability; event row written |
| W-05 | Persisted watch state | State survives navigating away and back |
| W-06 | Pause / resume | Both directions persist server-side |
| W-07 | Target-price configuration (if supported) | Value persists and is honoured by refresh |
| W-08 | Actor switch A→B | B sees **none** of A's Watches |
| W-09 | A→B→A isolation | A's Watches return intact; B never saw them |
| W-10 | Process death | Watches restore from server, not from a stale cache |
| W-11 | Restore → refresh | Refresh works after restore |
| W-12 | Delete | Row removed; no orphan events |
| W-13 | SEC-KPLUS-001 device claim | A device token owned by another actor is **claimed**, not shared: registering on this device transfers ownership and the previous owner stops receiving that device's alerts |

Tier-2 (scheduled sweep) is **not** part of the device path and is blocked on
B7 regardless.

---

## 6. VTO / PACKING / CONCIERGE — CLOSURE ROWS

| # | Row | Expected | Blocked by |
|---|---|---|---|
| VT-01 | Staging VTO kill switch enabled by owner, real provider exercised | Real generation returns a real image | B3 |
| VT-02 | Provider success | Result rendered, attributed correctly, quota decremented |  |
| VT-03 | Provider failure | Typed error, no charge claimed, no mock image presented as a real result |  |
| VT-04 | Provider retry | Bounded; no runaway spend on the shared key |  |
| VT-05 | Kill switch OFF | Server refuses regardless of what the client believes | — |
| PK-01 | Packing server gate confirmed ON, then a packing request | Packing intelligence responds | B1 |
| PK-02 | Packing without K+ | Refused, upgrade offered |  |
| CN-01 | Concierge server gate confirmed ON, then a concierge request | Concierge responds | B2 |
| CN-02 | Concierge without K+ | Refused, upgrade offered |  |

**Deployed-vs-source parity (checked 2026-08-31, `supabase functions download`):**
`vto-generate` and `commerce-watch-refresh` bundles are at source parity with
this branch except for three **non-behavioural** drifts:

- `scan-identify/canonicalCommerce.ts` — one redundant trailing `continue;` as
  the last statement of a `for` body (semantic no-op)
- `_shared/scanHelpers.ts` — comment box-rule lengths only
- `vto-generate/providers/mockResultAsset.ts` — one character inside an
  embedded base64 **mock** image

Also confirmed live: `tryon-clothes-pro` on staging is the **retired 410
handler**, not the old anon-reachable provider proxy. That repair is in place.

Do not modify the production versions of any of these controls.

---

## 7. VOICE SCAN — DEVICE ROWS

### CLASSIFICATION: **NEWLY CONVERGED FROM ACCEPTED #218 LINEAGE — FIRST EXECUTION ON CURRENT INTEGRATION AUTHORITY**

The accepted contract, unchanged from #218:

```
K+ active user → Voice affordance → explicit tap → JIT mic permission
→ Android ON-DEVICE recognition → partial/final transcript → review
→ explicit acceptance → Text Scan submission (source=voicescan)
→ existing authenticated Text Scan → existing commerce path
```

There is no automatic submission, no background listening, no always-on
microphone, no cloud STT fallback, and no mock transcription fallback.

| # | Row | Expected |
|---|---|---|
| V-01 | Android 15 — permission allow | Listening starts; JIT prompt appeared only on the tap |
| V-02 | Android 15 — permission deny | Typed "microphone unavailable" state; typing still works; no retry loop |
| V-03 | Android 16 — permission allow | As V-01 |
| V-04 | Android 16 — permission deny | As V-02 |
| V-05 | On-device recognizer unavailable | `on_device_recognition_unavailable`; **no cloud fallback**; user directed to typing |
| V-06 | Start listening | Sheet shows listening state |
| V-07 | Partial transcript | Live text updates while speaking |
| V-08 | Natural speech end | Moves to finalizing → review. **Never auto-submits** |
| V-09 | Manual stop | Same terminal path as V-08 |
| V-10 | Review | Transcript shown for the user to read/edit before anything is sent |
| V-11 | Accept | Transcript lands in the existing Text Scan query field; still requires the existing explicit Submit tap |
| V-12 | Cancel | Session ends; **no transcript retained anywhere** |
| V-13 | Cancel, then a late native callback | The stale callback must **not** repopulate a draft or move the UI (session-identity guard) |
| V-14 | K+ revoked mid-session | Session is abandoned; microphone released |
| V-15 | Background mid-listen | Microphone released immediately (`ProcessLifecycleOwner.onStop`) |
| V-16 | Resume after background | No zombie session; a new tap starts cleanly |
| V-17 | Process death mid-listen | No orphaned recognizer, no retained transcript |
| V-18 | A logout while listening | Session ends; nothing survives the logout |
| V-19 | B login after A's session | B sees **no** trace of A's transcript or draft |
| V-20 | A→B→A | A's Voice state does not resurrect across the round trip |
| V-21 | Offline before submission | Voice still works (recognition is on-device); submission fails with the normal Text Scan offline error |
| V-22 | Network loss after transcript, before submit | Transcript preserved in the input; submit reports the normal error; nothing silently lost |
| V-23 | Duplicate tap | One session only; no double permission prompt, no second recognizer |
| V-24 | Long transcript | 15s cap fires, finalizes to review, does not auto-submit |
| V-25 | Empty / invalid transcript | "We didn't catch that" — no submission, no empty query sent |
| V-26 | Text Scan result parity | A spoken query and the same query typed produce equivalent results |
| V-27 | Commerce result parity | Commerce behaviour is identical for both |
| V-28 | Voice flag ON, **K+ inactive** | Tap opens the upgrade sheet. **No mic permission prompt, no session** |
| V-29 | iOS built from the SAME `staging-certification` profile | Voice affordance **does not render at all**. See below |

### Why V-29 exists

`staging-certification` is a **shared** profile — an EAS profile's `env` is
profile-level, not platform-level, and this one also declares
`ios.buildConfiguration`. So `EXPO_PUBLIC_VOICESCAN_ENABLED=true` reaches iOS
builds too.

On this lineage iOS cannot survive that: iOS is CNG_AUTHORITATIVE, `app.json`
IS the Info.plist, and it declares neither `NSMicrophoneUsageDescription` nor
`NSSpeechRecognitionUsageDescription` (`microphonePermission: false` on
expo-camera/expo-audio deletes the microphone key). iOS **terminates the app**
when `SFSpeechRecognizer.requestAuthorization` or
`AVAudioSession.requestRecordPermission` run without a usage string — and the
capability probe would not have caught it, because `getCapabilities` only
reads `supportsOnDeviceRecognition`, which needs no authorization. The crash
would land *after* the availability check passed.

`VOICE_NATIVE_PROVISIONED_PLATFORMS` (`services/voice/voiceRecognition.ts`)
therefore lists `android` only, and `VoiceScanButton` returns null before the
K+ gate on anything else. To enable iOS: land the two Info.plist strings on
the iOS lineage (PR #222), then add `'ios'` to that list — the test derives
its expectation from `app.json`, so it will tell you.

**No raw microphone audio may be logged or persisted.** The Voice modules
write nothing to `AsyncStorage`, `SecureStore`, the filesystem, or any table;
the telemetry allowlist cannot carry text (asserted in
`__tests__/androidGooglePlayComplianceV1.test.js`).

---

## 8. NATIVE PERMISSION POSTURE

| | default / production release | `staging-certification` release |
|---|---|---|
| `RECORD_AUDIO` | removed (`tools:node="remove"` in `src/main`) | granted |
| manifest used | `android/app/src/release/AndroidManifest.xml` | `android/app/src/certification/AndroidManifest.xml` |
| selector `KSCAN_VOICE_CERTIFICATION` | unset | `"true"` |
| `FOREGROUND_SERVICE_MICROPHONE` | removed | removed |
| `<service>` elements | none | none |
| package / signing | `com.kscanai.app`, EAS-managed | identical |
| iOS from the same profile | Voice does not render (`VOICE_NATIVE_PROVISIONED_PLATFORMS`) | unchanged — no iOS plist key added |

`app.json` continues to list `RECORD_AUDIO` under `blockedPermissions` and
**not** under `permissions` — that is the statement about the default
artifact, and it stays true.

Also denied in **both** profiles: broad Bluetooth, contacts, SMS, call log,
fine/background location, broad storage/media, advertising ID.

### ARTIFACT-ONLY OBLIGATION (cannot be closed from source)

Manifest-merger precedence is build-time behaviour. Before certification:

```bash
aapt2 dump xmltree --file base/manifest/AndroidManifest.xml app-release.aab | grep -i RECORD_AUDIO
```

- certification AAB → `RECORD_AUDIO` **present**
- production AAB → `RECORD_AUDIO` **absent**

A certification AAB whose merged manifest lacks `RECORD_AUDIO` must not be
certified: Voice would render and never obtain permission.

---

## 9. ANDROID WATCHLIST PUSH / FCM

Mechanism is wired in source; the credential is an owner action (B4/B5). See
`docs/watchlist-tier2-operations.md` §2 for the full provisioning runbook and
the reason it is wired natively rather than through `expo.android.googleServicesFile`.

Build-log proof line: `kscan: googleServicesConfigured=true`.

| # | Row | Expected |
|---|---|---|
| P-01 | Notification permission — contextual / JIT | Prompt appears only after the post-Watch "alert me?" prompt, never at launch |
| P-02 | Permission denied | Watch stays valid with `push_enabled = false`; Watch creation never blocked |
| P-03 | Expo push token creation | Token obtained on a Play-distributed artifact |
| P-04 | Server registration | Row in `user_device_push_tokens` bound to the signed-in user |
| P-05 | `push_enabled` transition | Watch flips to `push_enabled = true` only after successful registration |
| P-06 | Delivery | A real notification arrives on the device |
| P-07 | Deep-link tap | Tapping routes to the correct Watch |
| P-08 | A→B token ownership | The token follows the current actor, never both |
| P-09 | Logout revocation | Token revoked on logout; no alerts after |
| P-10 | New-actor device claim | New actor claims the device token; prior owner stops receiving |
| P-11 | Invalid / dead token retirement | Server retires tokens that fail delivery |

**No claim of Android Watchlist push readiness is permitted until a
Play-distributed artifact actually receives and routes a push (P-06/P-07).**

---

## 10. NATIVE LIBRARY / AAB GATES (ARTIFACT-ONLY)

Voice adds the second native module (`kscan-voice-native`, Kotlin +
`androidx.lifecycle:lifecycle-process`), so the AAB must be inspected
directly. No source assertion substitutes for this.

| # | Check | Requirement |
|---|---|---|
| A-01 | Packaged ABIs | Enumerate all; `arm64-v8a` present |
| A-02 | 32-bit dependency | No required 32-bit-only native dependency |
| A-03 | Native `.so` inventory | Enumerate every `.so` shipped |
| A-04 | 16 KB page-size compatibility | All `.so` compatible |
| A-05 | ELF alignment | Correct for every `.so` |
| A-06 | ZIP alignment | Correct where applicable |
| A-07 | Debug artifacts | No debug native artifacts |
| A-08 | Dev client | No dev client in the artifact |
| A-09 | Merged manifest | Per §8 |

---

## 11. DATA SAFETY / PRIVACY — WHAT ACTUALLY LEAVES THE DEVICE

`RECORD_AUDIO` is **not** equivalent to collecting audio. Determined by
inspection of `KScanVoiceNativeModule.kt`:

- the recognizer is only ever created via
  `SpeechRecognizer.createOnDeviceSpeechRecognizer()` — never
  `createSpeechRecognizer()`, which may be cloud-backed
- `SpeechRecognizer.isOnDeviceRecognitionAvailable()` is checked before every
  session; when false the session is **refused**, not downgraded
- `RecognizerIntent.EXTRA_PREFER_OFFLINE` is set
- raw audio is never written to disk, a table, or a log; the only value that
  leaves the module is the transcript string
- the microphone is released on app background via `ProcessLifecycleOwner`

**Conclusion on current evidence: raw microphone audio does not leave the
device.** What leaves the device is the *accepted transcript*, and only after
the user reads and accepts it — travelling through the **existing** Text Scan
path (`scan-identify`, `mode: "text"`, `source: "voicescan"`; `source` is a
trace label the server logs, it changes no routing).

Play Data Safety therefore reconciles as:

| Data type | Collected? | Basis |
|---|---|---|
| Audio / voice recordings | **No** | On-device recognition only; no audio transmitted or stored |
| User-generated / search content | **Yes — already declared** | The accepted transcript is a search query, identical in kind to a typed Text Scan query |
| AI processing | **Already declared** | The transcript enters the existing declared AI path; Voice adds no new model, backend, or LLM |

**If a later change makes raw audio leave the device, or introduces a cloud
recognizer, stop — that is a different Data Safety declaration and must be
classified separately before certification.**
`__tests__/androidGooglePlayComplianceV1.test.js` fails on either change.

---

## 12. ACCOUNT DELETION

The deletion registry (`supabase/functions/_shared/deletion/userDataResources.ts`)
retains all five entries and **none were removed**:

`user_entitlements`, `kplus_activation_events`, `user_commerce_watches`,
`user_commerce_watch_events`, `user_device_push_tokens`.

Voice Scan introduces **no** new user-linked table, storage object path, or
persistent device record — verified: nothing under `services/voice/`,
`hooks/useVoiceScan.ts`, or the native module writes to `AsyncStorage`,
`SecureStore`, the filesystem, or Supabase. There is deliberately **no**
persistent voice-transcript store. Nothing to add to the registry.

Deletion registry and parity suites were run after convergence and pass.

---

## 13. WHAT SOURCE VERIFICATION ALREADY CLOSED

Do not spend device time re-proving these; spend it on the rows above.

| Gate | Result |
|---|---|
| Voice focused tests (state machine, contract, session guards, UI wiring) | 75 / 75 pass |
| #218 session-guard tests | pass (stale-callback + session identity) |
| K+ feature-flag tests | pass, incl. Voice-without-K+ refusal |
| Watchlist authority / reachability / Android push config | pass |
| EAS config integrity | pass, incl. exhaustive no-leak control |
| Android Google Play compliance | pass, 23 tests |
| Native/config parity gate | pass, 17 tests incl. 10 new negative controls |
| TypeScript (`tsc --noEmit`) | clean |
| Full governed suite (`npm run test:all`) | **0 unexpected failures** (20 recorded pre-existing) |
| Edge function parity / dependency reachability | pass |

Production negative controls (all passing, all failing correctly when mutated):
K+ / Watchlist / Voice flag leaking into production; `KSCAN_VOICE_CERTIFICATION`
leaking into any other profile; `RECORD_AUDIO` promoted into `app.json`
permissions; `RECORD_AUDIO` un-blocked; `RECORD_AUDIO` granted in the main
manifest; a microphone foreground-service permission; a `<service>` element;
an undeclared build-profile manifest; a declared exception the build never
selects.

---

## 14. KNOWN UNRESOLVED — PHYSICAL/ARTIFACT ONLY

1. Merged-manifest `RECORD_AUDIO` presence (certification) and absence
   (production) — §8
2. All AAB native-library gates — §10
3. Android push delivery and routing on a Play-distributed artifact — §9
4. Watchlist end-to-end, first execution — §5
5. Voice on-device behaviour on real Android 15 and 16 hardware — §7
6. VTO real-provider success/failure/retry, pending B3 — §6
7. Packing / Concierge server gates, pending B1 / B2 — §6

## 15. KNOWN PRE-EXISTING, OUT OF THIS PR'S SCOPE

`npm run verify:migration-provenance` fails on the base branch with two
undeclared duplicate logical migrations:

- `20260721170559_dr3_collaborative_interactions.sql` ≡ `20260721201218_dr3_collaborative_interactions.sql`
- `20260721183308_dr4_collab_idempotency_room_scope.sql` ≡ `20260721201347_dr4_collab_idempotency_room_scope.sql`

All four files exist at base `284a8ea9`; this branch adds and modifies **no**
migrations. It is already reflected in the recorded full-suite failure
baseline. The safe remedy is to declare the pairs as aliases of one
`logicalId` in `config/migration-provenance-manifest.json` — **never** to
rename or delete an applied migration. Left for a separate change so this PR
carries no unrelated drift.
