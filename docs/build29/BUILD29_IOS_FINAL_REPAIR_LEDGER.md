# Build 29 — iOS Final Repair Ledger

**Branch** `repair/build29-ios-final`
**Base (shared authority)** `3d216e0baad2018741fdf70ed64cbf3359df4d8d`
  (`repair/build29-shared-closure` — the DEF-008/009 closure on top of the
  original frozen shared repair `17124d51…`, published to origin)
**Date** 2026-08-15

This phase started from the frozen Build 29 shared-system repair and repaired only
legitimate iOS/platform-specific defects. Shared defect families were verified, not
reopened.

---

## 0. Source authority

| Check | Expected | Actual | Result |
|---|---|---|---|
| `HEAD` | `17124d5…` | `17124d5…` | VERIFIED |
| `HEAD^{tree}` | `66178e9…` | `66178e9…` | VERIFIED |
| worktree clean | yes | yes | VERIFIED |
| ahead/behind vs shared | 0/0 | 0/0 | VERIFIED |
| `origin/repair/build29-shared-system-fixes` | same SHA | `17124d51…` | PUBLISHED |
| `origin/repair/build29-shared-closure` | new authority | `3d216e0…` | PUBLISHED |

The original shared repair `17124d51…` was initially local-only. It has since been
published to origin, and a narrowly scoped shared closure containing **only** the
DEF-008/DEF-009 boot fixes was cut from it as `repair/build29-shared-closure`
(`3d216e0…`), which is now the final shared authority. The two iOS commits were
replayed onto it conflict-free; the iOS delta is byte-identical to its pre-replay form
(5 files, +668/−1).

Lineage:

```
17124d51  shared repair (published)
   └── 3d216e0  DEF-008/009 shared closure  <- FINAL SHARED AUTHORITY
          ├── 7c253ec  Apple fullName repair      (iOS)
          └── 9c34276  iOS closure ledger         (iOS)
```

---

## 1. Source-closure gate

| Item | Status |
|---|---|
| SHARED SOURCE AUTHORITY | VERIFIED |
| APPLE SIGN-IN | PASS |
| APPLE AUTH CLIENT | PASS *(repaired)* |
| APPLE FULLNAME PRESERVATION | FIXED |
| APPLE REVOCATION SOURCE | PASS |
| APPLE REVOCATION STAGING | PASS |
| APPLE REVOCATION PRODUCTION | PROMOTION_REQUIRED |
| APPLE AUTH IOS CONFIG | PASS |
| APPLE AUTH BACKEND CONTRACT | PASS |
| APPLE PROD CONNECTION | PROMOTION_REQUIRED |
| DRESSING ROOM UNIVERSAL LINK CONFIG | PASS |
| DRESSING ROOM UNIVERSAL LINK RUNTIME | DEVICE_TEST_REQUIRED |
| BROWSER FALLBACK | PASS |
| SHARED ROOM DURABILITY | PASS (shared, verified only) |
| OWNER REVOCATION | PASS |
| BLOCK / REPORT / UGC | PASS |
| IOS ENTITLEMENTS | PASS |
| IOS PRIVACY MANIFEST | PASS |
| IOS NATIVE CONFIG | PASS |
| BOOT/NAVIGATION | PASS *(fixed in shared closure `3d216e0`)* |
| CRITICAL IOS LAYOUT | PASS |
| VOICEOVER SOURCE CONTRACT | PASS |
| VOICEOVER RUNTIME | DEVICE_TEST_REQUIRED |
| ACCOUNT DELETION ENTRY | PASS |
| SENTRY BUILD DEPENDENCY | DISABLED |
| TESTSPRITE | DEFERRED |
| MIRROR LIVE MODEL PROBE | EXTERNAL PENDING |
| WEAR / CPW | NOT REACHABLE (as required) |

---

## 2. Checkpoint A — Apple authentication

### A1 — Source contract (traced, not assumed)

```
Welcome/onboarding  app/auth/index.tsx  (Continue with Apple, iOS-gated)
  -> AppleAuthentication.signInAsync  scopes FULL_NAME + EMAIL, SHA-256 nonce
  -> supabase.auth.signInWithIdToken  provider 'apple', raw nonce
  -> services/appleCredentialLink.ts  best-effort authorization-code handoff
  -> supabase/functions/apple-credential-link      exchanges code, stores token
  -> supabase/functions/apple-revoke-credential    revokes at deletion (TN3194)
  -> public.apple_auth_credentials    RLS on, zero policies, service_role only
```

### A2 — REPAIRED: Apple-provided name was discarded

Apple returns `fullName` only on the **first** authorization for an Apple ID + app
pair, and never includes it in the identity token — so the backend cannot recover it
later. The client read `identityToken` and `authorizationCode` off the credential and
never read `fullName`, leaving the account permanently nameless.

Confirmed against live production data rather than inferred: the one existing
production Apple identity has no `name`/`full_name`/`given_name` in `identity_data`
and no `full_name`/`first_name` in `raw_user_meta_data`.

Fix — `services/appleDisplayName.ts`, wired into the existing handler:

* writes through the **existing** contract (`buildSignupNameMetadata`), landing in
  `user_metadata` where `resolveUserFirstName` / `resolvePreferredName` already read.
  No new storage path, no new update mechanism;
* never overwrites an existing non-empty name — checked against every field the
  resolver honours (`first_name`, `given_name`, `full_name`, `name`, `display_name`);
* writes nothing when Apple supplies no name (the normal repeat-sign-in case);
* best-effort and never rethrows: the session already exists when it runs;
* only the outcome status word is traced; the name never is.

Already correct in the shared source and therefore **not** repaired:

* the Apple control invokes the real authentication path (historical no-op is gone);
* cancellation maps `ERR_REQUEST_CANCELED` to "Sign-in cancelled.", not a failure;
* success enters the same canonical session path as other providers.

### A3 — Production Apple credential gap

| Contract | Status |
|---|---|
| `APPLE_AUTH_SOURCE_CONTRACT` | VERIFIED |
| `APPLE_AUTH_STAGING_CONTRACT` | VERIFIED |
| `APPLE_AUTH_PRODUCTION_CONTRACT` | **GAP** |
| `APPLE_PRODUCTION_CONNECTION` | **PRODUCTION_PROMOTION_REQUIRED** |

Staging (`yzqjvdfgefveprobvvyw`) — `apple_auth_credentials` present, RLS enabled, zero
policies, `authenticated` holds no privilege, `service_role` granted; both
`apple-credential-link` (v29) and `apple-revoke-credential` (v27) ACTIVE. Matches source.

Production (`wyyuqfdxucjksghsmhry`, the target of the `production` EAS profile) —
`apple_auth_credentials` **absent**; `apple-credential-link` **absent**;
`apple-revoke-credential` **absent**.

Scope of the gap: **sign-in itself works in production** — the Apple provider is
configured there and one Apple identity exists. What is missing is only the
revocation infrastructure, so account deletion cannot revoke the user's Sign in with
Apple authorization. That is the TN3194 / Guideline 5.1.1(v) obligation.

Promotion requirements (no production mutation performed):

1. apply `supabase/migrations/20260810120000_apple_auth_credentials.sql`;
2. deploy `apple-credential-link` (verify_jwt **true**);
3. deploy `apple-revoke-credential`;
4. set the five function secrets — `APPLE_TEAM_ID`, `APPLE_KEY_ID`,
   `APPLE_PRIVATE_KEY`, `APPLE_CLIENT_ID` (`com.kscanai.app`, the bundle ID, not a
   Services ID), `APPLE_TOKEN_ENCRYPTION_KEY` (base64 of 32 random bytes).

No unknown architecture is required — every piece exists in source and is already
proven in staging. This is a promotion, not a design gap, so it is **not** a STOP.

---

## 3. Checkpoint B — Universal Links

| Item | Status |
|---|---|
| `IOS_UNIVERSAL_LINK_SOURCE_CONFIG` | VERIFIED |
| `IOS_UNIVERSAL_LINK_GENERATED_CONFIG` | NOT_AVAILABLE (no Mac toolchain; no build performed) |
| Domain-side AASA | VERIFIED (live) |
| `IOS_UNIVERSAL_LINK_DEVICE_RUNTIME` | DEVICE_TEST_REQUIRED |
| `BROWSER_FALLBACK` | VERIFIED |

* `app.json` -> `ios.associatedDomains` = `["applinks:kscan.app"]`.
* `https://kscan.app/.well-known/apple-app-site-association` is served and valid:
  `appID` `Y9K3XPR9J2.com.kscanai.app` (bundle ID matches), `paths` `["/rooms/*"]`.
  Both halves of the Universal Link contract are in place.
* Route: `app/(public)/rooms/[token].tsx`. `(public)` is a route group, so the URL path
  is `/rooms/<token>` — expo-router owns the link delivery; there is no handwritten
  `NSUserActivity`/`UIApplicationDelegate` handler and none is needed.
* Share URL builder: `https://kscan.app/rooms/${encodeURIComponent(shareToken)}`
  (`app/dressing-rooms/[id].tsx`). Normal HTTPS; **no** custom-scheme regression. The
  `kscan://` scheme remains a secondary Android intent filter only.

No configuration defect found, so **no commit was made for this checkpoint**.

Observation (not repaired, not a Build 29 defect): Android auto-verifies
`/account/restore` as an app link, but the iOS AASA scopes `applinks` to `/rooms/*`
only, so restoration links open in the browser on iOS. That matches the restoration
design (a public web route) — flagged for owner awareness only. Changing it is a
production web mutation and out of scope.

### Manual device QA script

1. Install the Build 29 iOS artifact.
2. Open a valid `https://kscan.app/rooms/<token>` URL from outside K Scan (Messages/Mail).
3. Confirm iOS opens K Scan directly rather than Safari.
4. Confirm the correct Dressing Room share/redemption flow opens.
5. Remove the app (or test where it is unavailable).
6. Open the same HTTPS URL.
7. Confirm Safari receives the K Scan web fallback.
8. Redeem as a second account, cold-restart, and confirm the room is reachable from
   the Dressing Room page **without** the original URL.

---

## 4. Checkpoint C — Native configuration / App Store artifacts

`npm run verify:apple-readiness` and `npm run verify:apple-submission` both exit 0 —
32 PASS, 3 WARN; `eas metadata:lint` reports the store configuration valid. The
governed scripts were used as-is; nothing was weakened to make them green.

* **Entitlements** — `usesAppleSignIn: true` and `associatedDomains` present; no unused
  capability added.
* **Privacy manifest** — no tracking, no tracking domains, declares email / user ID /
  photos-videos, collected data not used for tracking, `UserDefaults` required-reason
  entry present. No ATT, ads, or media-library dependency.
* **Orientation / device family** — iPhone portrait-only (certified baseline preserved);
  iPad all four orientations; `UIRequiresFullScreen` unset so Split View stays
  available; `supportsTablet: true`. No Android orientation finding was copied across.
* **Version/build** — marketing `1.0.1`, `buildNumber` `29`. **Not incremented.**
  `eas.json` sets `appVersionSource: remote`, so EAS remote holds build-number
  authority; app.json is not the source of truth.
* **Release-only config** — production profile has
  `EXPO_PUBLIC_KSCAN_OBSERVABILITY_ENABLED=false` (Sentry runtime OFF) and
  `SENTRY_DISABLE_AUTO_UPLOAD=true` on every profile (source-map upload OFF). No DSN is
  set anywhere and none was added. TestSprite is not involved.

The 3 WARNs are environmental/ASC-class -> **OWNER_ACTION_REQUIRED**, not source defects:

1. App Store Connect app ID not configured in `eas.json`;
2. App Review contact and demo account not encoded in `store.config.json` — Apple
   requires a working demo account for an app behind sign-in, so this is a real
   submission prerequisite;
3. EAS iOS credentials still require interactive Apple Developer validation.

---

## 5. Checkpoint D — Runtime / UX

### D1 — Boot/navigation readiness: DEF-008 and DEF-009 -> FIXED IN SHARED CLOSURE

Reconciled against the frozen shared source: **neither had been resolved by the shared
repair.** Both live in shared cross-platform code, so neither was patched on this
branch. They were escalated, and the owner authorised a narrowly scoped shared closure
containing only these two fixes — commit `3d216e0`, now the final shared authority,
which this iOS branch is rebased onto.

**DEF-008 — `app/_layout.tsx`.** The readiness poll stopped after 2 s via
`setTimeout(clearInterval, 2000)` without ever setting `navReady`, and the effect only
re-runs when `navigationRef` identity changes. Any cold start where the navigator
mounted later than that deadline stranded `navReady` at `false` permanently; the
redirect effect is gated on it while `guardState.action === 'redirect'` renders the
full-screen spinner. Fixed by removing the deadline — the poll now runs until readiness
arrives and stops itself the moment it does.

This waits longer; it does not bypass anything. `navReady` only gates whether the
*router* can accept a navigation — `guardState` keeps sole authority over whether one
is *allowed* — so the prohibition on "arbitrary timeout navigation that bypasses
privacy/auth initialization" is respected, and a guard test pins it.

**DEF-009 — `services/supabasePrivacy.js`.** The privacy bootstrap gates routing and
ran on a bare `fetch` with no deadline. A *refused* connection was always handled
correctly; a socket that is open and silent never settles, so the request never
rejected, the catch never ran, and `bootStatus` never left `'loading'`. Fixed with an
`AbortController` on a 10 s deadline: aborting rather than racing a promise tears the
socket down, `fetch` rejects, and the existing catch reaches its already-correct
degraded state (remote unavailable, boot released). A timeout is deliberately never
converted into a successful empty read — that would look like a clean fetch of no
preferences and silently reset the user's privacy settings.

The required invariant — *cold launch -> bootstrap completes or fails recoverably ->
navigation available -> no indefinite loading state* — now holds on both paths.
Guards: `__tests__/bootRecovery.test.js` (6 tests, shared branch).

### D2 — VoiceOver

Source contract PASS across onboarding/auth, Scanner, Scan Result, Closet, Dressing
Rooms, shared-room safety actions and Elise controls: roles, labels, state and hints
are present (e.g. `accessibilityRole="button"`,
`accessibilityLabel="Continue with Apple"`, `accessibilityState={{disabled, busy}}`).
Shared accessibility fixes were not reimplemented. Actual VoiceOver behaviour is
`VOICEOVER_RUNTIME_TEST_REQUIRED`.

### D3 — iPhone/iPad layout

No iOS-specific drift found. `KeyboardAvoidingView` with iOS `padding` behaviour and
`useSafeAreaInsets` on the auth screen; `OnboardingShell` supplies safe-area padding,
keyboard avoidance and `getOnboardingBottomClearance`; room screens carry safe-area
insets and a `goBackOrHome` exit control. Shared fixes were left alone.

### D4 — Apple control presentation

Rendered only when `AppleAuthentication.isAvailableAsync()` resolves true. `minHeight:
52` exceeds the 44 pt minimum target; ink/pearl treatment matches the Google control;
the icon is U+F8FF, the Apple logo glyph, which renders correctly under the iOS system
font. No parallel Apple login screen was created.

---

## 6. Checkpoint E — Safety / UGC / account flows

All verified reachable in the shipping client; no moderation platform was built and no
backend permission was broadened.

| Control | Location |
|---|---|
| Report Message | `RoomMessagesPanel` — `room-message-report-<id>` |
| Report User | `RoomMessagesPanel` — `room-message-report-user-<id>`, `room-safety-report-user-<id>` |
| Block User | `RoomMessagesPanel` — `room-message-block-<id>`, `room-hidden-sender-block-<id>`, `room-safety-block-<id>` |
| Unblock | `app/privacy.tsx` — `privacy-unblock-<id>` |
| Owner share-link cancellation | `app/dressing-rooms/[id].tsx` — `handleRevokeShare` |
| Delete Account | `app/privacy.tsx` — reachable from every Home variant via `/privacy` |

Revocation and blocking remain separate controls, as the in-source comments require:
disabling the link kills invitation-token access, blocking kills the account-to-account
relationship. Blocking stays backend-enforced. Deletion/grace/restoration architecture
is untouched; automatic purge remains out of Build 29.

`dressing_room_item_reactions` — no GRANT was issued. Client reachability only was
checked, per instruction.

---

## 7. Wear / CPW (Build 30) remains unreachable

`WEAR_TRACKING_ACTIVE` is a hard-coded `false` in `constants/featureFlags.ts`. Both
entry points — the Closet "Wear History" button (`app/library.tsx`) and "Wore this
look" (`app/looks/[id].tsx`) — are gated on it and do not render. The separate
free-tier Cost Per Wear surface is independently inactive: the development, staging and
production EAS profiles set **zero** `EXPO_PUBLIC_FREE_TIER_*` variables. (`preview`,
an internal-distribution profile that is never submitted, does set them.)

`WEAR / CPW = NOT REACHABLE IN BUILD 29` — verified, nothing activated or polished.

---

## 8. Not iOS repairs — carried forward unchanged

* **Mirror Selfie authenticated model probe** — request contract VERIFIED, live
  authenticated round-trip PENDING. Backend/runtime certification. Feature not disabled
  and not modified.
* **HIBP leaked-password protection** — owner/billing action. No auth weakening.
* **stylist-speech / stylechat production promotion** — identified by the shared phase;
  promotion requirements carried, functions not redesigned here.

---

## 9. Testing

| Scope | Result |
|---|---|
| Full suite (`npm run test:all`) — after replay onto `3d216e0` | **6466 tests, 6407 pass, 0 fail, 59 skipped** — exit 0 |
| Shared closure suite on `3d216e0` | **6455 tests, 6396 pass, 0 fail, 59 skipped** — exit 0 |
| Apple + auth + boot family | **146 pass, 0 fail** |
| New `__tests__/appleDisplayName.test.js` | **11 pass, 0 fail** |
| New `__tests__/bootRecovery.test.js` (shared) | **6 pass, 0 fail** |
| `tsc --noEmit` | clean |
| `verify:apple-readiness` | exit 0 — 32 PASS / 3 WARN |
| `verify:apple-submission` | exit 0 — `eas metadata:lint` valid |

Status vocabulary is kept distinct and not collapsed: everything above is
`SOURCE_TESTED` or `CONFIG_VERIFIED`. No `DEVICE_TEST_REQUIRED` or
`ARTIFACT_TEST_REQUIRED` item is reported as passing. No EAS build was performed.

---

## 10. Outstanding

**Remaining App Store blockers**

1. Apple production revocation promotion (migration + 2 functions + 5 secrets) —
   TN3194 / Guideline 5.1.1(v).
2. App Review demo account + contact in `store.config.json`.
3. App Store Connect app ID in `eas.json`; EAS iOS credential validation.
4. HIBP leaked-password protection (owner/billing).

**Closed in the shared closure `3d216e0` (not on this branch)**

5. DEF-008 — navigation-readiness polling gave up after 2 s. FIXED.
6. DEF-009 — privacy bootstrap fetch was unbounded. FIXED.

**Remaining device/runtime tests**

7. Universal Link resolution on a real device (script in §3).
8. VoiceOver runtime pass over the critical flows.
9. Mirror Selfie live authenticated model probe.

**Mutations performed:** production **none**; staging **none**. All backend interaction
was read-only inspection.
