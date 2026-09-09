# Terminal local-deletion cleanup (iOS Repair 07, Android Repair 09)

Internal technical contract. The backend half is Repair 06, whose client-facing
contract lives in `docs/deletion/terminal-status-client-contract.md` on the
backend authority branch. This document is the device side: what it stores,
what it is allowed to destroy, and what it must never touch.

**Status: source implemented for both platforms. Production backend dependency
pending.** Repair 06 is deployed and certified on staging only. Until it is
promoted and certified on production, this path fails closed on a production
build — the intake response carries no `statusReceiptBound` field, the marker
is recorded as `unsupported`, and no terminal cleanup ever runs, on either
platform. Account deletion itself is unaffected.

Repair 07 (iOS) built the whole architecture below and held the destructive
half behind an iOS-only guard in `app/_layout.tsx` while it was certified.
Repair 09 (Android) is a hostile platform-safety review of every primitive
described here, followed by the smallest possible change: removing that guard.
Nothing below was redesigned, forked, or reimplemented for Android — every
module in `services/deletion/` and every owner-scoped purge primitive it calls
is platform-neutral by construction (`expo-secure-store` backs onto the
Android Keystore the same way it backs onto the iOS Keychain, `expo-crypto` /
Web Crypto supply CSPRNG bytes identically on both runtimes, and every purge
primitive takes its target owner as an explicit argument rather than reading
the live actor). iOS and Android now run the exact same
`TerminalDeletionBridge` code path in `app/_layout.tsx`, at the exact same two
lifecycle boundaries, with no platform conditional anywhere in that path.

---

## 1. Why a capability instead of a session

Deletion intake destroys the caller's ability to authenticate: it revokes all
sessions, bans the Auth user for the full 30-day grace window, and
`process-account-deletions` eventually deletes the Auth identity outright. By
the time the interesting answer exists — *did the purge actually happen?* —
there is no session, no Auth user, and no identity provider left.

So the device creates a 256-bit opaque bearer capability, persists it to the
keychain **before** submitting the deletion, and later presents it to
`deletion-status`, which needs no session at all.

Format is derived from canonical backend source, not from memory:
`ksdel_v1_` + 43 unpadded base64url characters, exactly 52 characters.

---

## 2. Ordering (load-bearing)

```
authenticated owner resolved
      ↓
CSPRNG receipt generated            (expo-crypto / Web Crypto; never Math.random)
      ↓
owner-bound marker persisted        (keychain only; never AsyncStorage)
      ↓
POST handle-user-deletion { statusReceipt }
```

If the response is lost in transit the device still holds the capability, so a
lifecycle that *did* commit stays observable. Reversing these two steps would
strand the user permanently, and an executable test asserts the order.

Every failure to produce a capability — no resolvable owner, no secure RNG, no
keychain — falls through to the exact request this app has always sent. Losing
terminal tracking costs a status lookup; failing the submission would cost the
user the ability to delete their account at all.

---

## 3. Binding states

`statusReceiptBound` is reported truthfully by the backend, **including false**,
and its absence is meaningful too.

| Marker state | Cause | Queryable? | Raw capability kept? |
|---|---|---|---|
| `unconfirmed` | no response observed (lost response) | **yes** — this is the recovery path | yes |
| `bound` | `statusReceiptBound: true` | yes | yes |
| `unbound` | `statusReceiptBound: false` | no | **no** — it can never resolve anything |
| `unsupported` | field absent (backend predates Repair 06) | no | **no** |

`unconfirmed` is deliberately queryable. Asking is safe: an unbound capability
simply resolves to `not_found`, which authorises nothing.

---

## 4. The terminal rule

```
purge local data   ⟺   state === 'purged'   AND   purgeAuthorized === true
```

Both halves. `services/deletion/terminalDeletionDecision.ts` is the only module
that can produce the `purge` action, and it produces it from exactly one
`return`. Nothing else authorises destruction — not elapsed time, not a local
clock, not a missing account, not a 401/403, not a failed sign-in, not a
logout, not the user pressing Delete Account, and not a successful deletion
*request*.

| Answer | Marker | Local data |
|---|---|---|
| `pending` | retained | retained |
| `failed` | retained | retained (worker may still retry) |
| `restored` | **cleared** | retained |
| `purged` + `purgeAuthorized: true` | cleared **after** cleanup | **destroyed** |
| `purged` + `purgeAuthorized: false` | retained | retained |
| `404` / `400` / `503` / network error / malformed | retained | retained |

---

## 5. Persistence inventory

The classification the cleanup is built on. "Owner binding" is the Supabase
user id, which is also what every owner-scoped store files records under.

### Owner-scoped — destroyed by terminal cleanup

| Class | Storage | Owner binding | Primitive |
|---|---|---|---|
| Recent Scans + media | FileSystem manifest | per-record `ownerId` | `purgeLocalScansForOwner` |
| Closet items + media | FileSystem manifest | per-record `ownerId` | `purgeLocalClosetForOwner` |
| Closet candidates + media | FileSystem manifest | per-record `ownerId` | `purgeLocalClosetCandidatesForOwner` |
| Closet sync state | FileSystem, nested per owner | structural | `purgeClosetSyncStateForOwner` |
| Closet restore media cache | per-owner directory | structural | `purgeClosetRestoreMediaCacheForOwner` |
| Private saved looks | FileSystem manifest | per-record `actorId` | `purgeSavedLooksForActor` |
| Dressing-room sessions | FileSystem manifest | per-record `actorId` | `purgeDressingRoomSessionsForActor` † |
| Dressing-room compositions | FileSystem manifest | per-record `actorId` | `purgeDressingRoomCompositionsForActor` † |
| Dressing-room interactions | FileSystem manifest | per-record `actorId` | `purgeDressingRoomInteractionsForActor` † |
| Saved-look return context | AsyncStorage, single slot | envelope `actorId` | `purgeSavedLookReturnContextForActor` † |
| Stylist voice preference | AsyncStorage, per-actor key | key | `purgeStylistVoicePreferenceForActor` † |
| Style DNA preferences | AsyncStorage, per-user key | key | `clearStyleDnaPreferencesForUser` |
| Style DNA feedback | AsyncStorage, per-user prefix | key | `clearLocalStyleDnaForUser` |
| Style DNA reasons | AsyncStorage, per-user prefix | key | `clearReasonsForUser` |
| Packing plan cache | AsyncStorage, per-actor key | key | `clearCachedPackingPlan` |
| Onboarding completion | AsyncStorage, per-user key | key | `clearOnboardingComplete` |

† Added by Repair 07. The other eleven already existed and were deliberately
left unwired — several say so in their own comments ("intentionally not wired
to any production deletion caller", "terminal purge waits for a confirmed
server-side purge"). Repair 07 is the caller they were waiting for.

### Session-scoped — already gone, and MUST NOT be touched here

StyleChat composer drafts, today-weather, VTO runtime + media derivatives, K+
entitlement, Packing runtime, stylist identity, style memory cache, attachment
store, visual context, handoff context.

`resetActorScopedRuntimeState` clears all of these on **every** actor
transition, so the departed actor's copy is already gone before terminal
cleanup runs. Several are single-slot stores, so the slot now holds the
**current** actor's data — clearing it during A's cleanup would destroy B's.

### Device-scoped — never destroyed

Watchlist device id and push-disabled marker, feature-freeze config, privacy
preferences, location-disclosure acknowledgement, hidden-content and
hidden-user moderation lists, free-tier device stores, mirror sessions, avatar
animation engine choice. None is filed under an owner, and this repair does not
reclassify device state as user-owned deletion data.

---

## 6. Actor isolation

The scenario the design exists for:

```
A requests deletion  →  A signs out  →  B signs in  →  A is purged server-side
                                                    →  device reconciles A's receipt
                                                    →  ONLY A's local data is removed
                                                    →  B's session, storage and runtime state are untouched
```

Consequences, all enforced by test:

- The reconciliation bridge is **not** gated on a signed-in user. Gating it on
  `user` — the obvious-looking guard — would make terminal cleanup structurally
  impossible, because it always runs after the actor is gone.
- Every purge target comes from the marker's own stored owner scope, never from
  the live actor context.
- No blanket operation is reachable from this path: no `AsyncStorage.clear()`,
  no keychain sweep, no `clearAll*` variant, no `signOut`, no
  `resetActorScopedRuntimeState`.
- A blank owner fails closed rather than matching the ownerless signed-out
  partition, which is device-local history no account deletion may take.

---

## 7. Lifecycle boundaries

Cold start, and a real `background|inactive → active` transition — the same two
boundaries `AppleCredentialStateBridge` uses on iOS (that bridge stays iOS-only;
only its lifecycle SHAPE is reused here), for both iOS and Android since
Repair 09. No timers, no polling, no background fetch, no background task, no
silent push, no new background mode, no new entitlement, no new permission on
either platform. An in-flight guard collapses overlapping foreground events
into a single pass, and each pass is bounded to a small number of markers.

`expo-secure-store` and `expo-crypto` were already shipped dependencies on both
platforms; neither Repair 07 nor Repair 09 adds a new one.

---

## 8. Secret handling

The raw capability exists in exactly two places: the platform keychain, and the
JSON body of two requests. It is never written to AsyncStorage, never placed in
a URL or query string, never logged, never sent to analytics or crash
telemetry, never put into navigation params, and never shown in the UI. The
keychain index stores record ids only — no capability and no fingerprint of one.

A capability that can never resolve a lifecycle (`unbound`, `unsupported`) has
its raw value dropped immediately: a stored secret that authorises nothing is
only a liability.

---

## 9. Order of destruction

Local data first, marker last.

A crash between them leaves a marker whose lifecycle is already purged, and the
next boundary simply repeats an idempotent cleanup. The reverse order would
lose the capability while data remained — permanently, and silently. A partial
cleanup is **not** completion: the marker survives and the remaining subsystems
are retried.
