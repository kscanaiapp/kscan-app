# K SCAN AI — PUSH NOTIFICATION / WATCHLIST DELIVERY HOSTILE AUDIT

**Date:** 2026-09-08
**Scope:** Firebase/FCM, APNs, Expo notification wiring, production push credentials,
device-token lifecycle, multi-device behaviour, Watchlist delivery, notification
observability, foreground/background/cold-start handling, notification-driven
navigation, logout/account switching, privacy disclosures.
**Class:** Source / configuration / read-only. No build, no deploy, no device, no
credential change, no production mutation. Backend facts were established with
read-only metadata calls only.

---

## 1. AUTHORITY

`release/kscan-pre-freeze-v1` is the single Build 34 release authority for **both**
platforms. Every iOS repair lane and every Android repair lane on this work is
already merged into it and carries **zero** commits ahead of it, so there is no
divergent per-platform HEAD to reconcile.

| Field | iOS | Android |
|---|---|---|
| PLATFORM | iOS | Android |
| BRANCH | `release/kscan-pre-freeze-v1` | `release/kscan-pre-freeze-v1` |
| HEAD SHA | `718e62cfc10fc2c8b01dcc177d2bf91bbc93a7ca` | `718e62cfc10fc2c8b01dcc177d2bf91bbc93a7ca` |
| UPSTREAM SHA | `718e62cf` (`origin/release/kscan-pre-freeze-v1`) | same |
| AHEAD/BEHIND | 0 / 0 vs upstream | 0 / 0 vs upstream |
| WORKTREE CLEAN | YES (detached read-only worktree at `718e62cf`) | YES |
| BUILD 34 AUTHORITY ANCESTOR | `87dccdd113e1849dfa3644fd536e221e537039b3` — **confirmed ancestor**, 37 commits behind HEAD | same |
| BUILD 35 CONTAMINATION | **NONE.** `claude/ios-build35-stabilization-scobld` (`577b3e28`) is *not* an ancestor of the release branch; zero commits in `87dccdd..718e62cf` reference Build 35 | **NONE** (same lineage) |

Platform-lane branches, all merged with 0 ahead:

* iOS (3 commits since authority): `repair/ios-app-review-metadata-v1` (`55e83552`),
  `repair/ios-apple-credential-state-v1` (`1bbd0bfd`), `repair/ios-device-id-privacy-v1` (`1ae323dd`).
* Android (15 commits since authority): `repair/android-notification-activation-gating` (`efdbfb23`),
  `repair/android-notification-native-resources` (`92782185`),
  `repair/android-notification-permission-containment` (`c4771782`),
  `claude/android-boot-capability-removal-rgrfcm` (`be46078d`), plus audio/FGS governance lanes.
* Notification lifecycle lanes: `repair/build34-notifications-device-revoke-v1` ==
  `claude/build34-notifications-logout-repair-4gigqt` (`4e599d98`) — merged, 0 ahead.
* `repair/watchlist-feature-containment-v1` (`38cb3c35`) — merged, 0 ahead.
* **NOT merged:** `fix/notifications-final-convergence-v1` (`219f27aa`, 99 commits ahead of the
  release branch). Out of scope for this authority; flagged so it is not mistaken for merged work.

Version identity on the authority: `version 1.0.1`, iOS `buildNumber 26`, Android `versionCode 23`.

> `master` (`688dc35e`) is a **different lineage**: it does not contain `87dccdd`, and it
> contains **no push-notification implementation at all** (no `expo-notifications`, no
> `expo-device`, no token table, no sender). Do not audit or ship notifications from `master`.

---

## 2. A. CANONICAL NOTIFICATION ARCHITECTURE

The delivery model is **Expo-managed, not direct**. K Scan never holds an APNs or FCM
token, never talks to APNs or FCM, and holds no APNs/FCM credential of its own.
`supabase/functions/commerce-watch-refresh/pushDelivery.ts` is the **only** push producer
in the entire codebase, and there is **no local/scheduled-notification path anywhere**.

```
                        ── ACTIVATION / REGISTRATION ──
  Onboarding "Notifications" toggle              Post-Watch "alert me?" prompt
  components/account-home/PermissionsStepV1.tsx  services/watchlist/pushRegistration.ts
                │                                            │
                └──────────────┬─────────────────────────────┘
                               ▼
        services/notifications/remotePushCapability.ts
          resolveRemotePushActivationAllowed(platformOS, consumerActive)
            android → requires SMART_WATCHLIST_V1 === true   [GATED]
            ios     → always true                           [NOT GATED]
                               ▼
        expo-notifications 0.32.17 (lazy dynamic import)
          getPermissionsAsync / requestPermissionsAsync
          setNotificationChannelAsync('price-alerts')        (Android only)
          getExpoPushTokenAsync({ projectId: a075728d-…cc2e })
                               ▼
        ExpoPushToken[…]  +  local device_id (AsyncStorage 'kscan-watchlist-device-id')
                               ▼
        supabase.functions.invoke('commerce-watch-refresh', { action:'register_push_token' })
                               ▼
        rpc register_device_push_token(user_id, push_token, platform, device_id)
                               ▼
        TABLE public.user_device_push_tokens
          (user_id, push_token, platform, device_id, created/updated/last_used_at, revoked_at)
          UNIQUE (user_id, device_id)
          UNIQUE (push_token) WHERE revoked_at IS NULL      -- DEF-WL-01
          UNIQUE (device_id)  WHERE revoked_at IS NULL      -- WL-04

                        ── WATCHLIST EVALUATION → DELIVERY ──
  Tier 2 sweep  (x-watchlist-worker-secret header, NO JWT)
    .github/workflows/watchlist-tier2-sweep.yml   [workflow_dispatch ONLY — cron COMMENTED OUT]
        │  gate 1: WATCHLIST_WORKER_SECRET secret      (staging only)
        │  gate 2: SUPABASE_STAGING_FUNCTIONS_URL      (staging only)
        │  gate 3: app_config.watchlist_worker_enabled (seeded FALSE)
        ▼
  Tier 1 refresh (user JWT, action:'refresh')  ── same change engine, same cycle
        │
        ▼
  rpc claim_watchable_commerce_watches / claim_user_commerce_watches_for_refresh
     status=active ∧ deleted_at IS NULL ∧ watch_intent='buy_under' ∧ push_enabled=true
     ∧ kplus_has_active_entitlement ∧ watchlist_actor_is_active
     FOR UPDATE SKIP LOCKED, stamps last_checked_at AS THE CLAIM
        ▼
  refreshWatchObservation() → evaluateWatchRefresh()   (changeEngine.ts, single authority)
        ▼
  PATCH user_commerce_watches (…, deleted_at IS NULL)   ◄── THIS WRITE *IS* THE DEDUPLICATION
        │   fail ⇒ cycle ends, nothing recorded, nothing announced
        ▼
  rpc append_user_commerce_watch_event   (P0002 if watch deleted ⇒ liveness check)
        │   fail ⇒ no push (an unrecorded event is never announced)
        ▼
  deliverPushIfArmed(row, event)      [ONLY event.type === 'target_price_reached']
        ▼
  SELECT push_token, device_id FROM user_device_push_tokens
    WHERE user_id = <watch owner> AND revoked_at IS NULL       ← ALL live devices
        ▼
  Promise.all over every live token — each isolated, one failure cannot suppress a sibling
        ▼
  POST https://exp.host/--/api/v2/push/send
    Authorization: Bearer $EXPO_PUSH_ACCESS_TOKEN (optional)
    { to, title, body, channelId:'price-alerts', sound:'default',
      data: { watchId, eventType, deepLink } }
        │  ticket.status === 'error' && details.error === 'DeviceNotRegistered'
        │     ⇒ rpc revoke_device_push_token(user_id, device_id)
        │  ticket.id retained … and NEVER consumed (see F-07)
        ▼
  EXPO PUSH SERVICE  ──▶ APNs (iOS)        ──▶ device
                     ──▶ FCM  (Android)    ──▶ device
        ▼
  app/_layout.tsx  →  installWatchNotificationRouting()
    setNotificationHandler                    (foreground presentation)
    getLastNotificationResponseAsync()         (cold start)
    addNotificationResponseReceivedListener()  (foreground/background tap)
        ▼
  watchRouteFromNotificationData(data) → `/watchlist/${watchId}` iff watchId is a valid UUID
    (`deepLink` — the URL-shaped field — is DELIBERATELY NEVER READ)
        ▼
  router.push('/watchlist/<uuid>')  →  screen's own RLS-scoped read decides ownership
```

**Per-hop table**

| Hop | Source file | Function | In | Out | Authority | Error handling | Retry | Observability |
|---|---|---|---|---|---|---|---|---|
| Capability | `services/notifications/remotePushCapability.ts` | `resolveRemotePushActivationAllowed` | `Platform.OS`, `SMART_WATCHLIST_V1` | boolean | build flag, `=== 'true'` | fail-closed | n/a | **none** |
| Permission | `services/watchlist/pushRegistration.ts` | `enableDeviceNotifications` / `requestWatchAlerts` | OS prompt | granted / typed reason | OS | typed reason codes | user-driven | **none** |
| Token | same | `getExpoPushTokenAsync({projectId})` | EAS projectId | `ExpoPushToken[…]` | Expo | `token_failed` | user-driven | **none** |
| Register | `supabase/functions/commerce-watch-refresh/index.ts` | `handleRegisterPushToken` | token, platform, deviceId | `{registered:true}` | `requireUser()` + `watchlist_actor_is_active` | 400/403/502 typed | none | `watchlist_push_token_register_failed` (failures only) |
| Persist | migration `20260830212508` + `20260830190000` + `20260902120000` | `register_device_push_token` | 4 args | row | `security definer`, service_role only | raises | n/a | none |
| Claim | `20260902120000` | `claim_watchable_commerce_watches` | limit, interval | rows | `FOR UPDATE SKIP LOCKED` | claim = 0 rows | next sweep | `watchlist_worker_claim{,_failed}` |
| Evaluate | `changeEngine.ts` | `evaluateWatchRefresh` | state + observation | event / null | single change authority | pure | n/a | none |
| Route lookup | `index.ts:163` | `deliverPushIfArmed` | `user_id` | live tokens | `revoked_at IS NULL` | silent return on !ok | none | **none — device count is never logged** |
| Send | `pushDelivery.ts` | `sendWatchPush` | token + event | ticket | Expo push API | never throws; typed result | **none** | `watchlist_push_delivery_failed` (failures only) |
| Dead token | `index.ts:190` | `revoke_device_push_token` | user, device | bool | ticket `DeviceNotRegistered` | `.catch(()=>null)` | n/a | none |
| Receipts | — | **DOES NOT EXIST** | ticketId | — | — | — | — | **none** |
| Present | `watchNotificationRouting.ts` | `setNotificationHandler` | notification | banner+list | expo | try/catch swallow | n/a | none |
| Route | same | `watchRouteFromNotificationData` | payload `data` | route / null | UUID regex only | null ⇒ no nav | n/a | **none** |
| Navigate | `app/_layout.tsx:447` | `router.push` | route | navigation | expo-router | none | n/a | **none** |

---

## 3. B. ANDROID STATUS — FCM / FIREBASE / EXPO

Android is `NATIVE_AUTHORITATIVE` (`config/native-config-authority.json`): `android/` is
committed and is what produces the AAB; `app.json`'s `android` block must stay in sync but
does not drive the build. Firebase is used for **exactly one thing** — letting
`expo-notifications` obtain an Android push token. No Analytics, Crashlytics, Performance
or Ads product is declared anywhere. There is **no direct FCM API use** in K Scan; FCM is
purely Expo's Android transport.

The Android notification posture is a deliberately governed four-state matrix
(`android/app/build.gradle` + `config/native-config-authority.json`):

```
push OFF / voice OFF → android/app/src/release       (neither grant)      ← ORDINARY PRODUCTION
push OFF / voice ON  → android/app/src/certification (RECORD_AUDIO)
push ON  / voice OFF → android/app/src/push          (POST_NOTIFICATIONS)
push ON  / voice ON  → android/app/src/voicePush     (both)               ← staging-certification
```

* `android/app/src/main/AndroidManifest.xml` removes `POST_NOTIFICATIONS`
  (`tools:node="remove"`) and `RECEIVE_BOOT_COMPLETED`, neutralising
  expo-notifications' own library-manifest contributions. `app.json`
  `android.blockedPermissions` lists both. Ordinary production therefore declares
  **no notification permission at all** — correct for a build with no push consumer.
* Notification icon/color are natively materialised as all four required meta-data keys
  (`com.google.firebase.messaging.default_notification_{icon,color}` and
  `expo.modules.notifications.default_notification_{icon,color}`), with a dedicated
  monochrome `notification_icon.png` in five density buckets. Not the launcher icon.
* Channel `price-alerts` is created client-side before the first token request and is sent
  as `channelId` by the producer — client and sender agree (test-enforced).
* `build.gradle` enforces the invariant **PUSH ACTIVATED ⇒ GOOGLE_SERVICES_JSON MATERIALIZED
  ⇒ PLUGIN APPLIED ⇒ FCM CONFIG PRESENT**, keyed on the capability and not on a profile
  name, and throws `GradleException` otherwise. `google-services.json` is correctly
  git-ignored and supplied as an EAS file secret — **no Firebase credential is committed**.

**Production readiness metadata**

| Field | Value |
|---|---|
| PROJECT IDENTITY | Firebase project — **UNKNOWN**. No Firebase project id/number exists anywhere in source (correct: the file is a secret). |
| ANDROID APP ID / PACKAGE | `com.kscanai.app` (`app.json` + `android/app/build.gradle`) |
| CONFIG PRESENT | **NO.** No `google-services.json`; `docs/build34-android-certification-handoff.md` B4 records `eas env:list` showing the EAS file-secret store **empty for every environment**. |
| EXPECTED ENVIRONMENT | staging-certification (the only profile that sets `EXPO_PUBLIC_SMART_WATCHLIST_V1`) |
| SOURCE OF AUTHORITY | `android/app/build.gradle` (native) + EAS file secret `GOOGLE_SERVICES_JSON` |
| CONSISTENT | **NO** — capability, permission and channel wiring are complete and correct; the credential does not exist. |

**Android verdict:** mechanism complete and unusually well governed; **delivery
impossible**. Production is *coherently* dark (no permission, no token, no consumer). A
push-capable Android artifact currently **cannot be built at all** — the gradle guard
throws because `GOOGLE_SERVICES_JSON` is absent. Expo's FCM V1 service-account key (B5) is
also unconfirmed, so even a token would not deliver.

---

## 4. C. iOS STATUS — APNs / EXPO

iOS is `CNG_AUTHORITATIVE`: **no `ios/` directory is committed**; `app.json`'s `ios` block
is the sole source of truth and Expo prebuild generates the Info.plist/entitlements.

* `app.json` plugins include `["expo-notifications", { "mode": "production", icon, color }]`.
  Verified against the installed plugin source
  (`node_modules/expo-notifications/plugin/src/withNotificationsIOS.ts:21-23`):
  `mode` is written directly to the **`aps-environment`** entitlement ⇒
  `aps-environment = production`. Test-enforced (`NOTIF-01`) against regression to
  `development` or `undefined`.
* `enableBackgroundRemoteNotifications` is not set, so **no `UIBackgroundModes:
  remote-notification`** is added. Correct: these are alert pushes with
  `sound: 'default'`, never silent/background data pushes.
* Bundle identifier `com.kscanai.app` — matches Android package
  (`crossPlatformInvariants.bundleIdMustMatch`).
* Privacy manifest declares `NSPrivacyCollectedDataTypeDeviceID`, Linked, non-tracking,
  purpose AppFunctionality. That is the correct declaration for a device push route.
* Delivery model: **Expo-managed APNs**. Nothing in the app or backend talks to APNs.
  Expo must hold an APNs auth key for the `com.kscanai.app` app id.

**Production readiness metadata**

| Field | Value |
|---|---|
| BUNDLE ID MATCH | **VERIFIED** — `com.kscanai.app` in `app.json`, matches the Android package |
| PUSH CAPABILITY | **CONFIGURED** — via `expo-notifications` plugin; entitlement is generated at prebuild, not present in committed source |
| APNs CREDENTIAL TYPE | Expo/EAS-managed APNs key (implied by the Expo push transport). **No repository evidence of any uploaded key.** |
| CREDENTIAL ASSOCIATED WITH CORRECT APP/TEAM | **UNKNOWN** — no Apple Team ID, no key id, no `eas credentials --platform ios` evidence anywhere in the repo |
| PRODUCTION-ELIGIBLE | **REQUIRES CREDENTIAL-PORTAL VERIFICATION.** `docs/apple-app-store-submission-runbook.md:50` states "EAS credentials are incomplete for non-interactive store builds." |
| EAS/EXPO CONFIG CONSISTENT | **YES** for project identity (`a075728d-bd77-446f-843d-0f63fd54cc2e` read explicitly, never implicitly discovered — NOTIF-14) |

`docs/watchlist-tier2-operations.md:102` claims "iOS is complete: `aps-environment` appears
under `expo config --type introspect`, and `getExpoPushTokenAsync()` resolves." That
evidence proves the **entitlement** and **token minting** only. `getExpoPushTokenAsync`
succeeding proves the EAS project id is valid; it does **not** prove Expo can reach APNs.
Do not read it as APNs readiness.

**iOS verdict:** entitlement and runtime wiring are correct and production-shaped. The
APNs credential is unproven from source and must be verified in the Expo/Apple portals.
Separately, iOS carries a deliberate asymmetry that is a defect in its own right — see
**F-01**.

---

## 5. D. MULTI-DEVICE LIFECYCLE

### Token type stored
**Expo Push Token only** (`ExpoPushToken[…]` / `ExponentPushToken[…]`, server-validated
against `EXPO_PUSH_TOKEN_PATTERN`). No raw APNs device token and no FCM registration token
is ever obtained, stored, or transmitted by K Scan.

### Data model
`public.user_device_push_tokens` — `user_id` (FK `auth.users` ON DELETE CASCADE),
`push_token`, `platform` (CHECK `ios|android`), `device_id` (CHECK 1..200 chars),
`created_at`, `updated_at`, `last_used_at`, `revoked_at`.
`device_id` is a client-minted UUID in AsyncStorage — **not** the push token, so it
survives token rotation.

Constraints:
* `UNIQUE (user_id, device_id)` — re-registering a device updates, never duplicates.
* `UNIQUE (push_token) WHERE revoked_at IS NULL` — DEF-WL-01.
* `UNIQUE (device_id) WHERE revoked_at IS NULL` — WL-04. **At most one live actor per
  physical handset, structurally.**

RLS/authorization: RLS enabled; `authenticated` gets **SELECT own rows only**; all
INSERT/UPDATE/DELETE revoked from `anon`/`authenticated`. Every write goes through a
`security definer` RPC granted to `service_role` alone. The client **never supplies a
user_id** — identity is always re-derived from `requireUser()`. Arming actions additionally
require `watchlist_actor_is_active(user_id)`; disarming deliberately does not, so an
account in the deletion grace period can still turn alerts off.

### Hostile scenario results

| # | Scenario | Result | Mechanism |
|---|---|---|---|
| A | Two devices, same account; OFF on device 1 | **PASS** | `revoke_device_push_token` is keyed `(user_id, device_id)`; device 2's row untouched. Sender fans out over every live row independently. |
| B | Logout on device 1 | **PASS (bounded best-effort)** | `signOut()` seals the actor, then awaits `revokeWatchAlertsForThisDevice()` under a 4000 ms deadline, **before** `supabase.auth.signOut()` so the call is still authenticated. Device 2 unaffected. If the revoke is abandoned, the arriving actor's `claim_device_for_actor` and the `device_id` partial unique index both close it. |
| C | Account A → logout → Account B | **PASS** | Three independent guards: (1) client `claimDeviceForCurrentActor()` on **sign-IN** (arrival is observable, departure is not); (2) `register_device_push_token` retires every live row sharing this `device_id` **or** `push_token` before upserting; (3) `UNIQUE (device_id) WHERE revoked_at IS NULL`. A's route cannot become B's. |
| D | A → B → A | **PASS** | `revokeThisDevicePushRoute()` mutates **no actor-bound state**, so a completion landing after the next sign-in is structurally incapable of touching the new actor. `claimDeviceForCurrentActor()` re-asserts custody on each arrival. |
| E | Token replacement | **PASS on the same device** | `register_device_push_token` upserts on `(user_id, device_id)`, replacing `push_token` and clearing `revoked_at`. The old token is **not explicitly retired** — it is superseded because the row is the route. A token rolled while the app is closed leaves a stale row until the next send returns `DeviceNotRegistered`; because receipts are never read, that only happens if the *ticket* carries it (see **F-07**). |
| F | Duplicate token across actors | **PASS** | `UNIQUE (push_token) WHERE revoked_at IS NULL` makes it unrepresentable. Verified live on staging by the project's own probe D-7 (duplicate live token rejected `23505`). |

**Token refresh:** `attachPushTokenRefreshListener()` is installed for the whole app
lifetime in `app/_layout.tsx` with correct disposal (including a `disposed` flag so a
listener resolved after unmount is removed). It re-registers a rolled token **only** if a
`device_id` already exists (mints nothing) **and** the RP-104 explicit-OFF marker is absent.
On Android with the capability dark it is not even installed and the native module is never
loaded.

**Reinstall / cleared storage:** `device_id` is lost, so the old row is orphaned and stays
`revoked_at IS NULL`. It stops being deliverable via `UNIQUE (device_id)` /
`register_device_push_token` retirement **only when the same handset registers again**.
With no receipt consumption, an orphaned row can otherwise remain live indefinitely
(**F-07**).

---

## 6. E. WATCHLIST DELIVERY

1. **Condition:** `target_price_reached` only. `pushDelivery.ts` can render four event
   types, but `deliverPushIfArmed` returns early unless
   `event.type === 'target_price_reached'`, so `price_decreased`,
   `listing_unavailable` and `listing_available_again` are **never pushed** in V1.
2. **Backend process:** `commerce-watch-refresh`. Tier 2 = header-authenticated sweep
   (constant-time secret compare); Tier 1 = user-JWT `refresh`. Both use the **same**
   `evaluateWatchRefresh` change engine.
3. **Records:** `user_commerce_watches` (state) and `user_commerce_watch_events` (ledger),
   plus `user_device_push_tokens` (routes).
4. **Eligibility:** `status='active'` ∧ `deleted_at IS NULL` ∧ `watch_intent='buy_under'`
   ∧ `push_enabled=true` ∧ K+ entitlement active ∧ `watchlist_actor_is_active` ∧ due by
   `MIN_REFRESH_INTERVAL_MS`. Delivery additionally requires the event to have been
   **recorded** (`append_user_commerce_watch_event` succeeded — which also refuses `P0002`
   for a deleted watch, making it the liveness check).
5. **Device list:** every row for the watch owner with `revoked_at IS NULL`, ordered
   `last_used_at DESC NULLS LAST`.
6. **Attempts:** exactly one per live token, per event. No retry.
7. **Provider:** Expo Push Service (`exp.host/--/api/v2/push/send`).
8. **Invalid token:** ticket `status:'error'` with `details.error === 'DeviceNotRegistered'`
   ⇒ `revoke_device_push_token(user, device)` immediately.
9. **Siblings:** yes — `Promise.all` with a per-token `try/catch`; no throw escapes and no
   sibling is skipped. Test-enforced (`NOTIF-06`).
10. **Navigation payload:** `{ watchId, eventType, deepLink }`. Only `watchId` is consumed.

**Idempotency / deduplication authority:** there is **no idempotency key** on
`user_commerce_watch_events`. Deduplication is the `PATCH user_commerce_watches` advance of
`current_price_amount` / `target_reached_at` (documented as WL-03), and a failed observation
write correctly ends the cycle so nothing is recorded and nothing is announced. Concurrency
is closed at the claim, not at the write: **both** tiers claim under
`FOR UPDATE SKIP LOCKED` and stamp `last_checked_at` **as the claim itself**
(`claim_watchable_commerce_watches`, `claim_user_commerce_watches_for_refresh`), so two
concurrent refreshes of one watch cannot both do provider work. Duplicate device rows are
unrepresentable. Provider retries do not exist. **Assessment: no duplicate-push race is
reachable in the current design.**

**The blocking gap:** nothing schedules the evaluator.
`.github/workflows/watchlist-tier2-sweep.yml` is `workflow_dispatch` only — the `schedule:`
cron is **commented out**; the URL variable is `SUPABASE_STAGING_FUNCTIONS_URL` (staging by
name); `app_config.watchlist_worker_enabled` is seeded `{"enabled": false}`; and there is
**no `pg_cron`, no Supabase cron, and no production invoker anywhere in the repository**.
Autonomous Watchlist alerts therefore cannot fire in any environment as shipped. Only a
user pressing Refresh inside the app can produce an event — which defeats the purpose of a
price alert.

---

## 7. F. COLD-START NAVIGATION

`installWatchNotificationRouting()` is installed once in the root `Layout()` effect, with
a `disposed` guard and correct `subscription.remove()` teardown. All three states are wired:

| State | Path | Status |
|---|---|---|
| **Foreground** | `setNotificationHandler` ⇒ `shouldShowBanner/List/Alert: true`, no sound, no badge. `addNotificationResponseReceivedListener` routes on tap. `attachNotificationReceivedListener` never navigates, so foreground receipt cannot double-navigate with the tap. | **CORRECT** |
| **Background** | `addNotificationResponseReceivedListener` | **CORRECT** |
| **Cold start** | `getLastNotificationResponseAsync()` before the listener is attached | **WIRED, ordering unproven** |

**Cold-start replay, verified in native source.** On Android,
`NotificationManager.onNotificationResponseReceived` buffers into
`mPendingNotificationResponses` while no listener exists, and `addListener` replays the
buffer to a newly registered `NotificationsEmitter`, which sets
`lastNotificationResponseBundle` and emits. Because K Scan calls
`getLastNotificationResponseAsync()` **before** attaching its JS listener, the replayed
`sendEvent` has no JS subscriber and the launch response is consumed exactly once. That is
the right shape — but it depends on native/JS initialisation order that source cannot
settle, and the project's own device matrix records P-06/P-07 (a real notification arrives
and routes) as **unverified**.

**Hostile cases**

| Case | Behaviour | Verdict |
|---|---|---|
| Malformed / non-Watchlist payload | `watchRouteFromNotificationData` returns `null`; no navigation | **SAFE** (test-enforced) |
| Non-UUID / forged `watchId` | Rejected by the UUID regex before it can become a route | **SAFE** (test-enforced) |
| URL-shaped `deepLink` field | **Never read.** The app is not steerable to an arbitrary destination by a push payload | **SAFE** (test-enforced) |
| Another actor's / deleted watch id | Routes to `/watchlist/<uuid>`; the screen's own RLS-scoped read returns nothing and it shows its error state. Ownership is decided by the database under the viewer's session, never by the notification | **SAFE — no cross-user content exposure** |
| Notification arrives before router hydration | `router.push` is called with **no `navReady` gate**, unlike every other navigation in `_layout.tsx` | **UNGUARDED** (F-05) |
| Auth slower than navigation / user logged out | Notification navigation consults **no** session state. Recovery depends entirely on `AuthGate`, whose `shouldCommitRouteNavigation` refuses a repeat of an identical destination | **RACE** (F-05) |
| Stale notification, same process | `clearLastNotificationResponse()` is **never called**; the response persists in native module memory for the whole process | **DEFECT** (F-06) |
| Notification belongs to prior actor | Route shape is per-watch; RLS returns nothing for the new actor | **SAFE** |

Nothing here crashes, loops, or exposes another user's content. The two real problems are
an unguarded navigation and an unclearable launch response.

---

## 8. G. OBSERVABILITY

Backend logging is structured JSON via `logEvent` (stdout) / `alertEvent` (stderr,
`severity:'alert'`, greppable). Identifiers are correctly reduced:
`shortUserId()` → 8 chars + `…`, `watchId.slice(0,8)`.

| Signal | Observable? | Evidence |
|---|---|---|
| WATCHLIST CONDITION FOUND | **NO** | no event on a successful evaluation; `watchlist_worker_claim{count}` only |
| DELIVERY REQUEST CREATED | **NO** | `deliverPushIfArmed` logs nothing on the success path |
| DEVICE COUNT | **NO** | `liveTokens.length` is never logged — "was any device even targeted?" is unanswerable |
| PROVIDER ACCEPTED | **NO** | `ok:true` / `ticketId` are logged nowhere and persisted nowhere |
| PROVIDER REJECTED | **YES** | `watchlist_push_delivery_failed{watchId8, errorCode}` |
| INVALID TOKEN | **PARTIAL** | the same failure event carries the code; the resulting revoke is `.catch(()=>null)` and logs nothing |
| TOKEN REVOKED | **PARTIAL** | failures only (`watchlist_push_token_revoke_failed`); a successful revoke is silent |
| RETRY | **N/A** | no retry exists |
| FINAL FAILURE | **NO** | no terminal-outcome signal; acceptance is never reconciled with delivery |
| USER OPENED NOTIFICATION | **NO** | zero analytics anywhere on the notification path |
| NAVIGATION SUCCESS/FAILURE | **NO** | `router.push` result is not observed |

Additionally, the RP-109 logout-revocation outcome is recorded **only** through
`traceAuthLifecycle`, which returns immediately unless `__DEV__`
(`services/authLifecycleTrace.ts:29`). In production a timed-out or failed sign-out
revocation is **completely invisible**.

**Can "why did User X's Watchlist notification not arrive?" be answered today? NO.** With
the current signals an operator cannot distinguish: no event raised · event raised but
`push_enabled` false · zero live device rows · Expo rejected · Expo accepted and APNs/FCM
dropped it · delivered but never tapped · tapped but navigation failed. Only the middle
"Expo rejected" case is visible.

**Privacy of what IS logged: clean.** No full push token, device token, Expo token, email,
Watchlist item title, price, or raw auth material appears in any log statement on this
path. `traceAuthLifecycle`'s field type is a closed union that structurally cannot carry a
token, device id, email, URL or backend body. `LogoutPushRevocationOutcome` is a closed set
of five opaque words. No analytics were added by this audit.

---

## 9. H. PRIVACY PROCESSORS

| Recipient | What actually leaves K Scan | Class |
|---|---|---|
| **Expo (Expo Application Services / exp.host)** | Expo push token; EAS project id `a075728d-…cc2e`; notification **title and body — which contain the watched item's display title and its price**; `channelId`; `sound`; and `data` = `{ watchId (internal UUID), eventType, deepLink }`. Optional `EXPO_PUSH_ACCESS_TOKEN`. | DEVICE ROUTING + **NOTIFICATION CONTENT** + COMMERCE DATA (item + price) |
| **Apple / APNs** | The same alert payload, relayed by Expo to the device. K Scan never contacts APNs directly. | DEVICE ROUTING + NOTIFICATION CONTENT |
| **Google / Firebase / FCM** | The same, relayed by Expo, plus the FCM app identity from `google-services.json` at registration. K Scan makes **no** direct FCM API calls. | DEVICE ROUTING + NOTIFICATION CONTENT |
| **Supabase** | `user_id`, `push_token`, `platform`, `device_id`, timestamps, `revoked_at`; plus watch state/events. First-party backend, not a notification-specific processor. | USER ACCOUNT + DEVICE ROUTING + COMMERCE |
| PostHog | **nothing** — no notification event is captured anywhere | ANALYTICS: none |

Deliberately **not** sent: retailer redirect URL, provider identifier, raw retailer
payloads, user email, auth/session material. Payload text is clamped (title ≤ 80, body
≤ 160, item ≤ 60). `data` carries only an internal id, and the app resolves everything else
from its own RLS-scoped row. This is a well-designed minimal payload.

**Disclosure comparison — `NO DISCLOSURE FOUND`.**

* `docs/privacy-data-management.md`: **zero** mentions of push notifications, push tokens,
  the Expo push service, APNs, or FCM (grep for `push|notif|expo|apns|fcm|firebase|apple`
  returns only unrelated `EXPO_PUBLIC_*` env-var names).
* `KSCAN_Legal_PreLaunch_Checklist.md` (present on `master`, **absent from the release
  branch**): the word "notification" appears only in breach-notification items. No
  push-processor entry, no Expo/Apple/Google notification-processor row.
* No processor matrix, sub-processor list, or DPA inventory exists anywhere in the
  repository. The user-facing policy is hosted off-repo at `https://kscan.app/legal/privacy`
  and cannot be verified from source.
* What **is** correctly disclosed: `app.json` `privacyManifests` declares
  `NSPrivacyCollectedDataTypeDeviceID` (Linked, non-tracking, AppFunctionality) — the right
  Apple declaration for a device push route.
* Deletion coverage is correct: `user_device_push_tokens` is registered in
  `supabase/functions/_shared/deletion/userDataResources.ts:118` as
  `auth_delete_cascade`.

**Verdict: NO DISCLOSURE FOUND** for Expo as a notification processor, and none for the
fact that a watched item's title and price transit Expo, Apple and Google. Legal documents
were not rewritten (out of scope) — this is reported for owner action.

---

## 10. I. CREDENTIAL / CONFIGURATION MATRIX

| Layer | Android | iOS |
|---|---|---|
| App identity | **VERIFIED** — `com.kscanai.app` (`app.json` + `android/app/build.gradle`) | **VERIFIED** — `com.kscanai.app` (`app.json`, CNG-authoritative) |
| Expo project | **VERIFIED** — `a075728d-bd77-446f-843d-0f63fd54cc2e`, read explicitly (NOTIF-14) | **VERIFIED** — same project |
| Firebase project | **MISSING** — no config; EAS file-secret store empty for every environment | **NOT APPLICABLE** |
| FCM configuration | **MISSING** — `GOOGLE_SERVICES_JSON` not provisioned (handoff B4); Expo FCM V1 key unconfirmed (B5) | **NOT APPLICABLE** |
| APNs configuration | **NOT APPLICABLE** | **UNKNOWN** — `aps-environment: production` is CONFIGURED via the plugin; the APNs key itself is **REQUIRES CREDENTIAL-PORTAL VERIFICATION** |
| Push credential authority | EAS file secret + Expo FCM V1 key — **MISSING** | Expo/EAS-managed APNs key — **UNKNOWN** |
| Backend environment | **MISSING for production.** production = `wyyuqfdxucjksghsmhry`; certification extends `staging` = `yzqjvdfgefveprobvvyw`. **No profile pairs Watchlist-ON with the production backend.** | identical |
| Token table / function | **MISSING in production** — `user_device_push_tokens` does not exist in `wyyuqfdxucjksghsmhry.public` (read-only `list_tables`). **VERIFIED in staging** (ledger `20260830212508`, `…212518`, `…214752`, `20260831135158`, `20260902144906`) | identical |
| Watchlist sender | **MISSING in production** — `commerce-watch-refresh` is **not among the 18 deployed Edge Functions** on `wyyuqfdxucjksghsmhry` (read-only `list_edge_functions`). No scheduler exists in any environment | identical |
| Production ready? | **NO** | **NO** |

Zero credentials, keys, tokens or secret values were printed. Existence, scope,
identifiers and environment only.

---

## 11. J. FINDINGS

### P0 – P1

**None.** Specifically ruled out with evidence:

* **No cross-user notification delivery.** Three independent guards
  (`claim_device_for_actor` on arrival, `register_device_push_token` retirement, and two
  partial unique indexes on `push_token` and `device_id` where `revoked_at IS NULL`).
* **No auth/session token leakage.** The push payload carries `{watchId, eventType,
  deepLink}` and clamped display text; no log statement on this path emits a token, email,
  or backend body.
* **No other user's Watchlist data in a payload.** Payload text is built from the watch
  owner's own row, and tap-through resolves through the viewer's own RLS-scoped read.
* **No production credentials committed.** `google-services.json` is git-ignored and
  absent; no APNs key, no service-account key, no Expo access token in source.
* **No destructive credential/config issue.** The gradle guard fails a push build closed
  rather than shipping a silent non-deliverer.

---

### P2

#### F-01 — iOS production requests notification permission and registers a push route for a feature that cannot exist in that build

* **ID:** F-01
* **SEVERITY:** P2 — *iOS production notification delivery clearly impossible while the UI offers it*
* **PLATFORM:** iOS
* **FILE / SERVICE:** `services/notifications/remotePushCapability.ts:58`;
  `components/account-home/PermissionsStepV1.tsx:66,230-249`;
  `services/watchlist/pushRegistration.ts:487`; `eas.json` (`production` profile)
* **ROOT CAUSE:** `REMOTE_PUSH_GATED_PLATFORMS = ['android']`, and
  `resolveRemotePushActivationAllowed` returns `true` unconditionally for any platform not
  in that list. `EXPO_PUBLIC_SMART_WATCHLIST_V1` is set **only** in
  `staging-certification`, so in a production build `WATCHLIST_AVAILABLE === false` and
  every Watchlist surface, route and write path is dark. On Android the capability gate
  turns the onboarding row into a passive `NOT AVAILABLE` status. On iOS the same row
  renders a **live toggle** whose copy reads *"Get notified when a watched item hits your
  target price."* Turning it on requests the real OS permission, mints an Expo push token,
  and writes a `user_device_push_tokens` row — for a feature that cannot be reached, on a
  backend where the table does not exist. The asymmetry is deliberate (Android Repair 05
  scoped itself to Android to avoid darkening iOS as a side effect) and is currently
  **enshrined by tests** #5/#14/#15 as an "iOS NEGATIVE CONTROL".
* **USER IMPACT:** An iOS user is asked for notification permission, is told they will get
  price alerts, and never receives one. Nothing in the UI is ever honest about it.
* **PRODUCTION IMPACT:** Apple App Store Review exposure — a permission prompt and product
  copy for functionality absent from the binary. Also an unnecessary data collection: a
  device push route is created and transmitted with no purpose it can serve.
* **PROOF:** `eas.json` `production` env has no `EXPO_PUBLIC_SMART_WATCHLIST_V1`;
  `resolveSmartWatchlistEnabled` requires `=== 'true'`; `resolveWatchlistAvailable` is that
  flag alone; `isRemotePushActivationGated('ios') === false`; `PermissionsStepV1`
  `actionType={remotePushAllowed ? 'toggle' : 'status'}`. Test #14 asserts
  "IOS NEGATIVE CONTROL: enabling notifications behaves exactly as before" — passing.
* **RECOMMENDED FIX:** Add `'ios'` to `REMOTE_PUSH_GATED_PLATFORMS` so the one canonical
  capability decision governs both platforms, and let the existing passive `NOT AVAILABLE`
  row render on iOS. The three iOS-negative-control tests must be inverted in the same
  change. Passive handling (presentation, tap routing) must stay ungated, as it already is.
  Do **not** remove the `expo-notifications` plugin or the `aps-environment` entitlement —
  that would be a different, larger decision and would break the certification lane.
* **SOURCE CHANGE:** YES · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** YES (iOS)

#### F-02 — No scheduler exists for the Watchlist evaluator in any environment

* **ID:** F-02
* **SEVERITY:** P2 — *Watchlist sender cannot reach registered devices*
* **PLATFORM:** Both (backend)
* **FILE / SERVICE:** `.github/workflows/watchlist-tier2-sweep.yml`;
  `supabase/migrations/20260831000100_watchlist_worker_enablement.sql`
* **ROOT CAUSE:** The Tier 2 sweep endpoint is complete and correctly governed but has no
  invoker. The workflow is `workflow_dispatch` only — its `schedule:` cron is commented
  out; it targets `SUPABASE_STAGING_FUNCTIONS_URL` (staging by name, and the doc states
  production activation "is intentionally not expressible from this file");
  `app_config.watchlist_worker_enabled` is seeded `{"enabled": false}`; and there is no
  `pg_cron`, no Supabase cron, and no other scheduler anywhere in the repository.
* **USER IMPACT:** A price alert can only ever be produced by the user manually pressing
  Refresh while inside the app — which is exactly the situation a push notification exists
  to replace. Left alone, a Watch never fires.
* **PRODUCTION IMPACT:** The headline K+ Smart Watchlist promise cannot be delivered.
* **PROOF:** `grep -rniE "pg_cron|cron\.schedule|pg_net"` over `supabase/` and
  `.github/workflows/` returns only two unrelated comments; the workflow's `schedule:`
  block is commented out; the migration seeds the flag false.
* **RECOMMENDED FIX:** Provide a production-capable scheduled invoker (uncommented cron
  with a production functions URL and a production `WATCHLIST_WORKER_SECRET`, or `pg_cron`
  + `pg_net` inside the project), then flip `app_config.watchlist_worker_enabled` as the
  deliberate owner action the design already anticipates. Sequence it **after** F-03 so a
  sweep never runs against a database whose device-route hardening is not in place.
* **SOURCE CHANGE:** YES (workflow) · **BACKEND CHANGE:** YES (secret + flag + deploy) ·
  **NEW BINARY REQUIRED:** NO

#### F-03 — Migration filename rename inverted the apply order of the DEF-WL-01 actor-isolation repair

* **ID:** F-03
* **SEVERITY:** P2 — a fresh database cannot be migrated; on a database where the table
  pre-exists, the cross-actor hardening is silently reverted
* **PLATFORM:** Backend
* **FILE / SERVICE:** `supabase/migrations/20260830190000_watchlist_push_token_actor_isolation.sql`;
  `supabase/migrations/20260830212508_user_device_push_tokens.sql`;
  `config/migration-authority-manifest.json`
* **ROOT CAUSE:** MIG-01 7B (2026-09-02) renamed `20260830160000_user_device_push_tokens.sql`
  → `20260830212508_…` to resolve a filename collision with
  `20260830160000_vto_feature_control.sql`. That rename moved the file that **creates the
  table and defines the un-hardened `register_device_push_token`** from *before* to
  *after* `20260830190000_watchlist_push_token_actor_isolation.sql`, the DEF-WL-01 repair.
  `supabase db push --include-all` applies in filename-version order, so:
  1. `20260830190000` now runs **first** and references `public.user_device_push_tokens` as
     a return type, in an `UPDATE`, and in `CREATE UNIQUE INDEX` — the table does not exist
     yet ⇒ `42P01`, aborting the run. A fresh database cannot be migrated.
  2. If the table pre-exists, `20260830212508` runs **after** and `create or replace
     function public.register_device_push_token` **without** the actor-isolation `UPDATE`
     block, reverting the hardening. (Confirmed: the isolation block appears 0 times in
     that file's function body.) With both partial unique indexes present, the arriving
     actor's registration then fails `23505` instead of retiring the departed route.
  No later migration re-establishes the hardened function — `20260831120000` adds
  `claim_device_for_actor` only, and `20260902120000` adds the device index and the claim
  RPCs.
* **USER IMPACT:** None today. **Staging is unaffected** because its applied ledger uses
  different, correctly ordered versions (`…212508` table, `…212518` RPCs, `…214752`
  hardening). The exposure is on any future fresh apply: production activation, a staging
  rebuild, `supabase db reset`, or a local bootstrap.
* **PRODUCTION IMPACT:** The repository's canonical schema authority for Watchlist push
  **cannot be applied to a clean database**, and its second-order behaviour would remove a
  cross-actor push-leak repair. The manifest's own note asserts the hardening is
  "unaffected by this rename" — true of the *ledger* version, false of the *canonical
  filename* order. `scripts/verify-migration-authority.js` only checks that a file's
  version prefix equals its `ledgerVersion`; it has **no cross-file dependency ordering
  check**, so the guard passes while the invariant is broken.
* **PROOF:**
  `ls supabase/migrations | sort` places `20260830190000_watchlist_push_token_actor_isolation.sql`
  at index 144 and `20260830212508_user_device_push_tokens.sql` at 146.
  `20260830190000` lines 35 / 77 / 87 reference the table.
  `awk '/create or replace function public.register_device_push_token/,/^\$\$;/'` over
  `20260830212508` contains 0 occurrences of the isolation block.
  `config/migration-authority-manifest.json` entry `20260830212508` records the rename and
  the reason, and also shows `ledgerSqlHash != canonicalSqlHash`.
* **RECOMMENDED FIX:** Renumber the actor-isolation migration to a version that sorts after
  `20260830212508` (e.g. `20260830214752`, matching the staging ledger version it was
  actually applied under) and update its manifest entry, **or** make it idempotent and
  self-sufficient. Then add an ordering guard: for each migration, assert that every
  `public.<table>` it references is created by an earlier-sorting file. Correct the
  manifest note's claim.
* **SOURCE CHANGE:** YES · **BACKEND CHANGE:** NO (staging already correct; production has
  none of it) · **NEW BINARY REQUIRED:** NO

#### F-04 — The Watchlist push stack is absent from the production backend

* **ID:** F-04
* **SEVERITY:** P2 — *production notification delivery impossible on both platforms*
* **PLATFORM:** Both (backend)
* **FILE / SERVICE:** Supabase project `wyyuqfdxucjksghsmhry` ("KScan App Production")
* **ROOT CAUSE:** Watchlist was never deployed to production. Read-only verification:
  `commerce-watch-refresh` is **not among the 18 ACTIVE Edge Functions**, and
  `user_device_push_tokens`, `user_commerce_watches` and `user_commerce_watch_events` are
  **not present** in the production `public` schema. Compounding this,
  `staging-certification` — the only profile that enables Watchlist — `extends: staging`
  and therefore points at `yzqjvdfgefveprobvvyw`. **No build profile pairs Watchlist-ON
  with the production backend**, and `build.gradle` explicitly asserts that certification
  must be staging.
* **USER IMPACT:** In production, `register_push_token` has no endpoint and there is no
  sender. Any iOS user who enables the onboarding toggle (see F-01) is registering against
  a function that does not exist.
* **PRODUCTION IMPACT:** Push delivery is structurally impossible in production today. This
  is coherent for Android (dark by capability) and incoherent for iOS (offered by UI).
* **PROOF:** `mcp Supabase list_edge_functions(wyyuqfdxucjksghsmhry)` — 18 functions, no
  `commerce-watch-refresh`. `list_tables(wyyuqfdxucjksghsmhry, public)` — 56 tables, no
  watch/push tables. `eas.json`: `staging-certification.extends = "staging"`.
* **RECOMMENDED FIX:** Treat "Watchlist push in production" as an explicit, sequenced
  activation: fix F-03, deploy the migrations and the function to production, provision the
  production worker secret and scheduler (F-02), provision credentials (F-08/F-09), and
  only then set `EXPO_PUBLIC_SMART_WATCHLIST_V1` on a production profile. Until then, F-01
  is the correct thing to close so the UI stops promising it.
* **SOURCE CHANGE:** NO · **BACKEND CHANGE:** YES · **NEW BINARY REQUIRED:** NO (except via F-01)

---

### P3

#### F-05 — Notification navigation is gated by neither router readiness nor auth state, and the guard's dedupe can strand the actor

* **ID:** F-05 · **SEVERITY:** P3 (meaningful navigation race) · **PLATFORM:** Both
* **FILE / SERVICE:** `app/_layout.tsx:444-450`;
  `services/watchlist/watchNotificationRouting.ts:82,90`; `services/routingGuard.js:49-57`
* **ROOT CAUSE:** `installWatchNotificationRouting` calls `router.push(route)` with no
  `navReady` check and no session check, while **every other** navigation in
  `_layout.tsx` is gated on `navReady` (and, for the dev route jump, additionally on
  `guardState.action === 'allow'`). Recovery relies solely on `AuthGate`, whose
  `shouldCommitRouteNavigation` returns `previousRequestedDestination !== requestedDestination`
  and whose `lastRedirectRef` is cleared only on a settled `allow`. If the notification
  push lands in the window after a first redirect has committed `/onboarding` but before
  the `allow` clears the ref, the guard computes the same destination, refuses the commit,
  and the unauthenticated actor is left on `/watchlist/<uuid>` under the permanent
  `auth-gate-redirecting` overlay.
* **USER IMPACT:** A tapped alert can land a logged-out user on a spinner with no
  self-recovery. No data is exposed — the screen's RLS read returns nothing.
* **PRODUCTION IMPACT:** Latent while push is dark; a real cold-start dead-end the moment
  it is not.
* **PROOF:** `_layout.tsx:207` gates the guard's own redirect on `navReady`; the
  notification effect at 444-450 has no such condition and no auth dependency.
  `routingGuard.js:56` is the dedupe; `_layout.tsx:231-236` clears the ref only on `allow`.
* **RECOMMENDED FIX:** Hold the resolved notification route in state and navigate from an
  effect that requires `navReady && guardState.action === 'allow'`, consuming it once —
  the pattern `DEV_INITIAL_ROUTE` already uses. Never drop the route: a tap that arrives
  during bootstrap should be honoured after the gate settles.
* **SOURCE CHANGE:** YES · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** YES

#### F-06 — The launch notification response is never cleared, so it can re-navigate within the process

* **ID:** F-06 · **SEVERITY:** P3 · **PLATFORM:** Both
* **FILE / SERVICE:** `services/watchlist/watchNotificationRouting.ts:78-82`
* **ROOT CAUSE:** `getLastNotificationResponseAsync()` is read but
  `clearLastNotificationResponse()` is never called. Verified in native source: Android's
  `NotificationsEmitter` holds `lastNotificationResponseBundle` in module memory, cleared
  only by that API or process death. Any remount of the root `Layout` re-runs the effect
  and re-reads the same response, navigating the user to a watch they already visited. The
  expo-notifications API doc names precisely this use: *"May be used when an app selects a
  route based on the notification response, and it is undesirable to continue selecting the
  route after the response has already been handled."*
* **USER IMPACT:** Unrequested jumps to a stale watch detail screen after an ErrorBoundary
  reset or any root remount.
* **PRODUCTION IMPACT:** Confusing navigation; no data exposure.
* **PROOF:** `grep -rn clearLastNotificationResponse services/` returns nothing;
  `node_modules/expo-notifications/android/src/main/java/…/NotificationsEmitter.kt:19,43-46,74`.
* **RECOMMENDED FIX:** Call `clearLastNotificationResponse()` immediately after a launch
  response has been converted into a navigation.
* **SOURCE CHANGE:** YES · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** YES

#### F-07 — Expo push receipts are never consumed, so dead routes can persist indefinitely

* **ID:** F-07 · **SEVERITY:** P3 (dead-token accumulation) · **PLATFORM:** Both
* **FILE / SERVICE:** `supabase/functions/commerce-watch-refresh/pushDelivery.ts:76-81,134-139`;
  `index.ts:180-205`
* **ROOT CAUSE:** The design is explicit and honest that an accepted **ticket** is not
  delivery, and it retains `ticketId` "as the key a receipt lookup is keyed on" — but no
  receipt lookup exists. `grep` for `getReceipts` across `supabase/` and `services/`
  returns only those comments. `ticketId` is not persisted anywhere, so even a later
  reconciliation has nothing to key on. Only a **ticket-time** `DeviceNotRegistered`
  triggers revocation; the far more common receipt-time `DeviceNotRegistered` (the normal
  way APNs/FCM report an uninstalled or rotated token) is never seen.
* **USER IMPACT:** After a reinstall, an OS token rotation while the app is closed, or an
  app removal, the row stays `revoked_at IS NULL` and is targeted on every future event.
  The user's other devices are unaffected (independent delivery), so this degrades
  efficiency and diagnosability rather than delivery.
* **PRODUCTION IMPACT:** Silent accumulation of undeliverable routes with no signal, and no
  way to distinguish "accepted then dropped" from "delivered".
* **PROOF:** no `/push/getReceipts` call anywhere; `ticketId` returned by `sendWatchPush`
  is discarded by `deliverPushIfArmed`.
* **RECOMMENDED FIX:** Persist `ticketId` with the event, and add a bounded receipt-polling
  pass (`POST https://exp.host/--/api/v2/push/getReceipts`, ≤ 1000 ids per call) that
  revokes on `DeviceNotRegistered` and logs terminal outcomes. This is also the single
  highest-value fix for the observability gap in F-10.
* **SOURCE CHANGE:** NO · **BACKEND CHANGE:** YES · **NEW BINARY REQUIRED:** NO

#### F-08 — Android FCM credential absent; a push-capable Android artifact cannot be built

* **ID:** F-08 · **SEVERITY:** P3 (owner credential action; fails closed, does not ship broken)
* **PLATFORM:** Android
* **FILE / SERVICE:** EAS file secret `GOOGLE_SERVICES_JSON`; Expo FCM V1 service-account key;
  `android/app/build.gradle:255-352`
* **ROOT CAUSE:** No Firebase Android app / `google-services.json` has been provisioned.
  `docs/build34-android-certification-handoff.md` B4/B5 record `eas env:list` showing the
  EAS file-secret store **empty for every environment**, and the FCM V1 key as unconfirmed.
* **USER IMPACT / PRODUCTION IMPACT:** No Android push, in any environment. The gradle
  guard converts this into a **build failure** rather than a silent non-deliverer, which is
  the correct posture — so it is a P3 blocker on activation, not a shipped defect.
* **PROOF:** no `google-services.json` under `android/`; handoff B4 "STILL NOT
  PROVISIONED — OWNER ACTION REQUIRED"; B5 "STILL UNCONFIRMED".
* **RECOMMENDED FIX:** Owner: register the Android app for `com.kscanai.app` in Firebase,
  upload `google-services.json` as an EAS **file** secret named `GOOGLE_SERVICES_JSON`, and
  upload the FCM V1 service-account key via `eas credentials --platform android`. Validate
  on `kscan: googleServicesConfigured=true` in the build log, then inspect the merged
  manifest of both a production and a push-capable AAB.
* **SOURCE CHANGE:** NO · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** YES (Android)

#### F-09 — iOS APNs push credential unproven from repository evidence

* **ID:** F-09 · **SEVERITY:** P3 · **PLATFORM:** iOS
* **FILE / SERVICE:** Expo/EAS iOS credentials for `com.kscanai.app`
* **ROOT CAUSE:** Expo-managed APNs delivery requires an APNs auth key held by the Expo
  project. No Apple Team ID, key id, or `eas credentials --platform ios` evidence exists in
  the repository, and `docs/apple-app-store-submission-runbook.md:50` records that "EAS
  credentials are incomplete for non-interactive store builds."
  `docs/watchlist-tier2-operations.md:102`'s "iOS is complete" refers to the
  `aps-environment` entitlement and successful token minting — neither implies APNs reach.
* **PRODUCTION IMPACT:** **REQUIRES CREDENTIAL-PORTAL VERIFICATION.** Must not be inferred
  as PASS.
* **PROOF:** as cited; `app.json` contains no `ios.entitlements` block (the entitlement is
  generated by the plugin), and `__tests__/watchlistAndroidPushConfig.test.js:206` asserts
  `'aps-environment' in entitlements || ios.usesAppleSignIn !== undefined` — a tautology
  given `usesAppleSignIn: true`, so that particular assertion verifies nothing.
* **RECOMMENDED FIX:** Owner: confirm in the Expo dashboard / `eas credentials --platform
  ios` that a Push Notifications key exists for `com.kscanai.app` under the correct Apple
  team, and record key id + team id (not the key) in the readiness ledger. Tighten the
  tautological assertion to check the introspected entitlement.
* **SOURCE CHANGE:** test only · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** NO

#### F-10 — Observability cannot answer "why did this user's alert not arrive?"

* **ID:** F-10 · **SEVERITY:** P3 (observability gap preventing incident diagnosis)
* **PLATFORM:** Both
* **FILE / SERVICE:** `supabase/functions/commerce-watch-refresh/index.ts`;
  `services/authLifecycleTrace.ts:29`
* **ROOT CAUSE:** Only failure paths are logged. No signal exists for condition-found,
  delivery-request-created, device count, provider acceptance, terminal outcome,
  notification opened, or navigation result. A successful `revoke_device_push_token` is
  silent and its failure is `.catch(()=>null)`. The RP-109 logout-revocation outcome is
  emitted only through `traceAuthLifecycle`, which returns immediately unless `__DEV__` —
  so in production a timed-out sign-out revocation is invisible.
* **PRODUCTION IMPACT:** Any "my alert never arrived" report is undiagnosable. Seven
  distinct failure modes are indistinguishable.
* **PROOF:** the full `logEvent`/`alertEvent` inventory for this function is 18 call sites,
  all failure- or claim-scoped; `grep -rniE "capture\(|posthog|analytics"` over the three
  notification service files returns nothing.
* **RECOMMENDED FIX:** Add success-path events with safe fields only —
  `watchlist_push_attempted{watchId8, deviceCount}`,
  `watchlist_push_accepted{watchId8, ticketId}`,
  `watchlist_push_receipt{watchId8, status, errorCode}`,
  `watchlist_push_route_revoked{uid8, reason}` — and promote the logout-revocation outcome
  off the `__DEV__`-only trace onto a production-safe sink using the existing closed
  reason-code vocabulary. Never log a full token, item title, price, or email. **Not
  implemented in this audit, per scope.**
* **SOURCE CHANGE:** YES (small) · **BACKEND CHANGE:** YES · **NEW BINARY REQUIRED:** NO

#### F-11 — The canonical device-level notification OFF is unreachable after onboarding

* **ID:** F-11 · **SEVERITY:** P3 · **PLATFORM:** Both
* **FILE / SERVICE:** `components/account-home/PermissionsStepV1.tsx`;
  `app/onboarding/index.tsx:702`; `hooks/usePermissionPreferences.ts`
* **ROOT CAUSE:** `disableDeviceNotifications()` — RP-104's correct, well-tested canonical
  disable — is reachable **only** from the Notifications toggle in `PermissionsStepV1`,
  which is mounted **only** by `/onboarding`. No code navigates to `/onboarding` after
  completion, and no other surface (including `app/privacy.tsx`) exposes a notifications
  control. Additionally the toggle's state lives in ephemeral `useState` with **no
  mount-time reconciliation**: `getNotificationPermissionStatus()` is exported but **never
  called anywhere in app code**, so the row shows OFF even when the device is registered.
* **USER IMPACT:** A user who enabled notifications during onboarding has no in-app way to
  revoke the backend delivery route. OS Settings silences the notification but leaves the
  `user_device_push_tokens` row live and deliverable; only signing out revokes it. And the
  toggle misreports its own state whenever onboarding is revisited.
* **PRODUCTION IMPACT:** Latent while push is dark. Once push works this is a consent-control
  gap of exactly the kind RP-104 was written to close, reintroduced by reachability rather
  than by logic.
* **PROOF:** `grep -rln "usePermissionPreferences|disableNotificationDelivery"` over `app/`
  and `components/` returns only `app/onboarding/index.tsx` and `PermissionsStepV1.tsx`;
  `grep -rn "getNotificationPermissionStatus" app/ components/ hooks/` returns nothing;
  `PermissionsStepV1` imports no `useEffect`.
* **RECOMMENDED FIX:** Surface the same `PermissionsStepV1` notifications row in a
  persistent settings/account location, and reconcile it on mount from
  `getNotificationPermissionStatus()` plus the actor's own
  `user_device_push_tokens` row (an RLS-permitted SELECT the client already has).
* **SOURCE CHANGE:** YES · **BACKEND CHANGE:** NO · **NEW BINARY REQUIRED:** YES

---

### P4+ (recorded, not repaired)

* **F-12** — Three of `pushDelivery.ts`'s four event types (`price_decreased`,
  `listing_unavailable`, `listing_available_again`) are fully implemented but unreachable:
  `deliverPushIfArmed` returns early unless `target_price_reached`. Intentional V1 scope;
  record it so it is not mistaken for a delivery bug.
* **F-13** — `claim_watchable_commerce_watches` requires `watch_intent='buy_under'` **and**
  `push_enabled=true`, so a `just_watching` Watch is never background-refreshed at all. Its
  price never updates without a manual refresh. Product-scope observation.
* **F-14** — `__tests__/watchlistAndroidPushConfig.test.js:206` is a tautology
  (`… || ios.usesAppleSignIn !== undefined`) and verifies no iOS push property. Test-quality
  only; NOTIF-01 provides the real coverage.
* **F-15** — `getNotificationPermissionStatus()` is exported and never called: dead code
  whose absence is the mechanism of F-11.
* **F-16** — `KSCAN_Legal_PreLaunch_Checklist.md` exists on `master` but not on the release
  branch, so the release lineage carries no legal checklist at all. Process observation.

---

## 12. K. RECOMMENDED CLOSURE PLAN

Ordered by dependency and risk. **Nothing below was implemented.**

**Stage 0 — stop promising what cannot be delivered (ship-blocking for iOS)**
1. **F-01.** Add `'ios'` to `REMOTE_PUSH_GATED_PLATFORMS`; invert the three iOS
   negative-control tests. This is the smallest change that makes the shipping iOS build
   honest, and it depends on nothing else. New iOS binary.

**Stage 1 — make the schema authority applicable (blocks every backend stage)**
2. **F-03.** Renumber the actor-isolation migration after `20260830212508`, update its
   manifest entry, correct the manifest note, and add a cross-file
   references-a-later-created-table ordering guard.

**Stage 2 — credentials (owner-only; parallel with Stage 1)**
3. **F-08.** Firebase Android app + `GOOGLE_SERVICES_JSON` file secret + Expo FCM V1 key.
4. **F-09.** Verify/create the Expo APNs key for `com.kscanai.app`; record key id and team
   id in the readiness ledger.

**Stage 3 — make failure visible before turning delivery on**
5. **F-07.** Persist `ticketId`; add bounded receipt polling with revoke-on-
   `DeviceNotRegistered`.
6. **F-10.** Success-path and revocation events; move the logout-revocation outcome off the
   `__DEV__`-only trace.

**Stage 4 — client correctness (one binary, batched)**
7. **F-05** navigation gating · **F-06** `clearLastNotificationResponse()` · **F-11**
   persistent, reconciled notifications control.

**Stage 5 — production backend activation (only after 1-7)**
8. **F-04.** Deploy the migrations and `commerce-watch-refresh` to
   `wyyuqfdxucjksghsmhry`.
9. **F-02.** Production worker secret + a real scheduler; flip
   `app_config.watchlist_worker_enabled`.
10. Only then consider a build profile that pairs `EXPO_PUBLIC_SMART_WATCHLIST_V1=true`
    with the production backend, and re-gate F-01 accordingly.

**Stage 6 — disclosure and device proof**
11. Add Expo (and the Apple/Google notification relays) to the processor disclosure, and
    disclose that a watched item's title and price transit them. Legal documents were not
    modified here.
12. Execute the device matrix the project already wrote: Android P-01…P-07 and the iOS
    equivalents, plus merged-manifest inspection of a production AAB (`POST_NOTIFICATIONS`
    and `RECEIVE_BOOT_COMPLETED` absent) and of a push-capable AAB
    (`POST_NOTIFICATIONS` present, `RECEIVE_BOOT_COMPLETED` still absent).

---

## 13. Verification performed

* Read-only detached worktree at `718e62cf`. Main worktree left clean throughout.
* `node --test` over the notification/Watchlist suites: **141 tests, 141 pass, 0 fail** —
  `logoutPushRevocationDeadline`, `notificationDeviceRevocation`,
  `androidNotificationActivationGating`, `notificationsClosureConvergence`,
  `watchlistNotificationRouting`, `watchlistFeatureContainment`.
  (`typescript` was installed into the throwaway worktree only, so the behavioural
  fake-timer tests could execute. No project file was modified.)
* **RP-104 HOLDS.** All 25 RP-104 assertions pass: device-scoped revoke naming exactly one
  `device_id` and no actor-wide selector; no Watch/target/entitlement deleted; OFF with no
  device id succeeds **without minting one**; a backend failure, a thrown transport error
  and an unavailable session all refuse to report OFF; no raw backend text reaches the UI;
  no OS permission API is touched and no claim of revoked OS authorization is made; a
  push-token refresh after OFF does not re-register; and all four stale-completion
  orderings (stale ON after OFF, stale OFF after ON, and a completion landing after the
  actor changed) mutate nothing.
* **RP-109 HOLDS, no regression.** `LOGOUT_PUSH_REVOCATION_DEADLINE_MS = 4000`, verified
  as an exported constant with no added dependency; the actor is sealed before the attempt;
  the revocation runs while the old session still exists and resolves the **old**
  authenticated session; success settles without the clock and clears its timer; a hung
  request resolves `timed_out` at the deadline and leaves no live timer; a rejection landing
  after the deadline is consumed rather than unhandled; every outcome is an opaque reason
  code; no outcome can stop the logout; and the result mutates no actor-bound state.
* Read-only Supabase metadata: `list_projects`, `list_edge_functions(production)`,
  `list_tables(production, public)`, `list_migrations(staging)`. No `execute_sql`, no write,
  no deploy, no migration.
* No push sent, no device registered, no build, no simulator/emulator, no TestFlight/Play
  upload, no credential created, rotated or read.

---

## 14. L. VERDICT

**CONDITIONAL — PUSH STACK IS FUNDAMENTALLY SOUND; LISTED ISSUES REQUIRE CLOSURE**

The architecture is correct and unusually well governed for its stage. The transport choice
(Expo push) is coherent and means K Scan holds no APNs or FCM credential of its own. The
multi-device model is the strongest part of the system: two partial unique indexes make
both the token-collision and the device-collision states unrepresentable, ownership is
claimed on **arrival** rather than trusted to departure, and every one of the six hostile
multi-device scenarios passes. RP-104 and RP-109 hold in full, proven behaviourally rather
than by source reading. The notification payload is minimal and privacy-conscious, routing
is derived only from a validated UUID and never from the payload's URL-shaped field, and
Android's four-state native capability matrix with a fail-closed FCM guard is exemplary.
No P0 or P1 exists: no cross-user delivery path, no token leakage, no committed credential.

It is not production-ready. Nothing can currently be delivered end to end in any
environment — the evaluator has no scheduler (**F-02**), the stack is not deployed to
production at all (**F-04**), the Android credential does not exist (**F-08**), and the iOS
APNs credential is unproven (**F-09**). The repository's own migration set cannot be applied
to a clean database, and a filename rename inverted the DEF-WL-01 hardening's apply order
(**F-03**). Most urgently for the shipping binary, iOS asks users for notification
permission and registers a device route for a feature that is dark in that build and absent
from that backend (**F-01**) — the one finding that affects users today. And if delivery
were switched on tomorrow, no operator could explain a single missed notification
(**F-07**, **F-10**).

Close F-01 before the next iOS submission. Close F-03 before any backend activation. Treat
Stages 2-5 as the ordered activation runbook.

---

*Read-only audit. No fix was implemented, no production surface was altered, and no
credential value appears in this document.*
