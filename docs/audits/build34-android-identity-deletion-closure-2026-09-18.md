# Build 34 Android — identity, deletion and regression closure record

Campaign date: 2026-09-18
Scope: cross-account isolation, account-deletion lifecycle, repair regression. Nothing else.
Environment: staging only (`yzqjvdfgefveprobvvyw`). Production (`wyyuqfdxucjksghsmhry`) not accessed.

```text
ANDROID_IDENTITY_LIFECYCLE_CLOSURE=PASS
BACKEND_CHANGES_MADE=0
PRODUCTION_ACCESSED=NO
PRODUCTION_CHANGED=NO
ANDROID_SPECIFIC_REPAIRS=0
```

---

## 0. Source authority

```text
EXPECTED_SHA=f138e8ca3c5ff9ab8e2d865a6b9cf15c0ada38b3
ACTUAL_SHA=f138e8ca3c5ff9ab8e2d865a6b9cf15c0ada38b3   (local HEAD and origin/claude/clever-hopper-2jx4gw)
SHA_MATCH=YES
HEAD_BEFORE=f138e8ca3c5ff9ab8e2d865a6b9cf15c0ada38b3
PORCELAIN_BEFORE=CLEAN
```

No substitution was made. `release/kscan-pre-freeze-v1`, `master`, Build 35 and every
other branch were left alone.

---

## 1. Method — why this campaign is not a re-run of the repair suites

The suites written with B34-FE-FT-001 each drive ONE module against a hand-made
fake. That proves a module. It does not prove the SYSTEM: that the actor
authority `AuthSessionContext` advances is the same one the storage layer reads,
that a cold start resolves an actor before anything commits, or that a purge for
a departed owner spares the signed-in one.

`__tests__/identityLifecycleClosure.test.js` wires the REAL modules into ONE
shared module graph — `services/actorContext.js` (the epoch authority),
`services/actorScope.ts`, `services/free-tier/freeTierStorage.ts`,
`services/kplus/kplusEntitlementStore.ts`,
`services/analytics/posthogIdentitySync.ts`,
`services/deletion/ownerTerminalPurge.ts` — and drives them through the
lifecycles a handset actually goes through. The only fakes are leaf I/O
(AsyncStorage, fault-injectable) and the purge's own injected step primitives.

**A cold start is a fresh graph, not a reset one.** The app's singletons are
module-scoped, so `boot()` re-evaluates the whole graph over the same simulated
disk. That is what makes the cold-start cases real rather than cosmetic.

### The harness is capable of failing

`namespacedKey()` was reverted to the pre-repair shape (owner ignored) and both
suites re-run:

```text
identityLifecycleClosure     pre-repair: 15 pass / 5 FAIL      repaired: 24 pass / 0 fail
freeTierStorageActorIsolation pre-repair:  7 pass / 4 FAIL      repaired: 11 pass / 0 fail
```

The file was restored byte-for-byte (`git status` clean) immediately afterwards.
Assertions that cannot fail are not evidence; these can.

---

## 2. Cross-account gate

```text
CROSS_ACCOUNT_DATA_ISOLATION=PASS
CROSS_ACCOUNT_ENTITLEMENT_ISOLATION=PASS
CROSS_ACCOUNT_ANALYTICS_ISOLATION=PASS
CROSS_ACCOUNT_NOTIFICATION_ISOLATION=PASS
ACCOUNT_SWITCH_RACE_SAFETY=PASS
COLD_START_ACCOUNT_ISOLATION=PASS
STALE_ROUTE_CROSS_ACCOUNT_SAFETY=PASS
CROSS_ACCOUNT_GATE=PASS
```

All twenty §5 invariants hold. How each is enforced:

| State | Mechanism | Evidence |
|---|---|---|
| Recent scans | actor epoch + owner-filed records | `advanceActorEpoch` first in `resetActorScopedRuntimeState`; `actorScopeAuthority` suite |
| Closet / owned items | `ownerId`-filed records, RLS server-side | `closetSyncStore` owner scope; suites pass |
| Free-tier ×10 stores | physical key namespaced by actor | closure harness, all ten keys |
| Saved Looks, DR sessions/compositions/interactions | `actorId`-filed records | per-store purge primitives take an owner |
| Signature Style | `user:<id>` key | `signatureStyleUserKey` |
| Elise drafts / attachments / handoff / greeting | cleared in `resetActorScopedRuntimeState` | `eliseDraftPersistence`, `eliseSessionLaunchActorBoundary`, `eliseStaleCompletionIsolation` |
| Packing, VTO, weather, stylist identity/voice | cleared in `resetActorScopedRuntimeState` | same function, read line by line |
| Wardrobe Concierge | actor-scoped session | `conciergeActorSessionIsolation` |
| Watchlist | RLS-scoped reads; `resolveWatchlistAvailable` at every surface | prior campaign §7 |
| K+ entitlement | `resetKPlusEntitlementCache()` + in-flight request id | closure harness |
| PostHog identity | `reset()` before every different identity | closure harness |
| Push token ownership | `claimDeviceForCurrentActor()` on sign-IN | source trace |

### Cold start

The window between JS bootstrap and the first `advanceActorEpoch()` is real: the
actor is genuinely `null` then. Three things close it.

1. **The storage layer refuses to guess.** A read taken with no actor resolves to
   the `anonymous` partition — never the pre-namespace global key — and does not
   consume the legacy blob, so the real actor still gets its one legitimate
   adoption afterwards. A write taken then lands in `anonymous` and is never
   attributed to whoever signs in next. Both asserted.
2. **Nothing user-facing reads in that window.** The free-tier surfaces are
   mounted by exactly three call sites — `app/library.tsx:951`,
   `components/AnalysisCard.tsx:628`, `components/scan-results/ScanResultV2.tsx:570`
   — none reachable from the initial route. `components/home/` mounts none of
   them, despite `FreeTierUtilitySection` supporting a `'home'` variant.
3. **The auth gate blocks interaction until the actor resolves.** While
   `getRoutingGuardState` returns `loading`, `recovering` or `redirect`,
   `AuthGate` renders `styles.loadingOverlay` — `StyleSheet.absoluteFillObject`
   with an opaque `backgroundColor` and no `pointerEvents="none"` — over the
   mounted `<Stack>`. The `<Stack>` mounts, but the user cannot navigate into a
   free-tier surface before the epoch advances.

Point 2 rests on where a component happens to be mounted today, not on a rule.
Recorded as **P5-C1**.

### Rapid switch race

`resolveOwner()` runs when the call is MADE, so an in-flight read or
read-modify-write started as A commits to A's namespace even if it lands after B
has signed in — asserted for both `readStore` and `updateStore`, with storage
reads held open across the switch. B's namespace is untouched in both.

The same shape holds for K+: a `refreshKPlusEntitlement()` started as A and
resolved after the switch is discarded by the in-flight request id, and B is left
`loading` — not `active` and not `eligible`. RESOLVING is not Free.

### Stale routes

A Watchlist notification or deep link created for A resolves to
`/watchlist/<uuid>` and nothing more: the route is derived from a validated UUID
only, never from the payload's URL-shaped `deepLink` field, and the screen's own
RLS-scoped read runs under whoever is signed in. A forged, deleted or foreign
watch id therefore reaches an empty error state behind `KPlusGate`, never
another account's content. Dressing Room, Saved Look and auth-callback routes are
RLS- or token-scoped the same way.

One residual, recorded as an observation rather than a defect:
`watchNotificationRouting` holds ONE pending route across the wait for navigator
readiness. If the actor changed during that wait the route would still flush,
landing the new actor on an EMPTY watch detail screen. Navigator readiness
resolves within the first frames of startup and an account switch needs user
interaction on `/auth`, so the window does not exist in practice; no content
crosses in any case.

---

## 3. Account-deletion gate

```text
ACCOUNT_DELETION_ENTRY=PASS
ACCOUNT_DELETION_REQUEST_CONTRACT=PASS
ACCOUNT_DELETION_AUTH_STATE=PASS
ACCOUNT_DELETION_LOCAL_CLEANUP=PASS  (with one documented gap — CPR-FT-001)
ACCOUNT_DELETION_RELAUNCH=PASS
ACCOUNT_DELETION_CROSS_USER_ISOLATION=PASS
ACCOUNT_DELETION_POSTHOG_ISOLATION=PASS
ACCOUNT_DELETION_ENTITLEMENT_ISOLATION=PASS
ACCOUNT_DELETION_NOTIFICATION_ISOLATION=PASS
ACCOUNT_DELETION_RACE_SAFETY=PASS
ACCOUNT_RESTORATION_STATUS=NOT_APPLICABLE (in-app) / PASS (client handling)
ACCOUNT_DELETION_GATE=PASS
```

### The traced path

`app/privacy.tsx` (a `LIMITED_ACCOUNT_ROUTES` member, so still reachable in the
pending state) → explicit confirmation modal → `submitAccountDeletionRequest`.

The request contract is the strong part. A 256-bit opaque status receipt is
generated and persisted to the keychain **before** the request goes out, because
intake revokes the session — mint it server-side and a lost response strands the
device forever. Acceptance is decided by the response's status against the exact
`ACTIVE_DELETION_STATUSES` set, never by HTTP success, and
`completed / rejected / cancelled / restored / purged / failed` can never
normalise to accepted. A malformed timestamp fails closed rather than describing
the grace window untruthfully.

The endpoint opens a **restorable 30-day lifecycle**; it does not delete. The UI
says so, and no local purge happens at submission — only the local privacy
preference is dropped, then `signOut()`, then `router.replace('/auth')`.

`signOut()`'s ordering is hostile-correct and was read line by line:

```text
signedOutRef = true                     seal, before any await
await revokeWatchAlertsForThisDevice()  push route retired while the DEPARTING actor is still live
await stopAvatarSpeechPlayback()
resetActorScopedRuntimeState(null)      epoch advances only now
await supabase.auth.signOut()
clearPersistedAuthSessions()            durable-logout backstop when the server call fails
```

Terminal purge is gated behind `decideTerminalAction`, which authorises
destruction only on `state === 'purged' AND purgeAuthorized === true`. A row that
claims terminal without authority, a `restored` lifecycle, a 404, a 503 and a
transport failure all RETAIN. `restored` releases the marker without purging.
`reconcileTerminalDeletions` runs at authenticated bootstrap and on foreground —
no timer, no polling, no background task — destroys local data first and retires
the marker last, so a crash between them repeats an idempotent cleanup rather
than losing the capability.

Retiring the marker deletes the SecureStore record that carries the receipt, so
the bearer secret does not outlive the lifecycle.

### Local store inventory

| Store | User-scoped | Deletion behaviour | Post-delete content | Status |
|---|---|---|---|---|
| Auth session (SecureStore) | yes | `clearPersistedAuthSessions()` on sign-out, hidden keys | none | PASS |
| Deletion marker + status receipt (SecureStore) | yes | removed when the marker retires, after purge | none | PASS |
| Recent scans | owner | `purgeLocalScansForOwner` | none | PASS |
| Closet items / candidates / sync state / restore media | owner | 4 purge steps | none | PASS |
| Saved Looks | actor | `purgeSavedLooksForActor` | none | PASS |
| DR sessions / compositions / interactions | actor | 3 purge steps | none | PASS |
| Saved-look return context | actor | `purgeSavedLookReturnContextForActor` | none | PASS |
| Stylist voice preference | actor | `purgeStylistVoicePreferenceForActor` | none | PASS |
| Signature Style prefs / feedback / reasons | `user:<id>` | 3 purge steps | none | PASS |
| Packing plan cache | owner | `clearCachedPackingPlan` | none | PASS |
| Onboarding completion | userId | `clearOnboardingComplete` | none | PASS |
| K+ snapshot, Elise drafts/attachments/handoff, VTO media, weather, stylist identity | in-memory / single-slot | cleared at every actor boundary | none | PASS |
| **Free-tier ×10** | **owner (since B34-FE-FT-001)** | **not purged** | **the deleted owner's namespace** | **GAP — CPR-FT-001 (P4)** |
| Device state: watch device id, push-disabled marker, feature-freeze cache, privacy prefs, location disclosure, moderation lists, mirror sessions, avatar engine choice | no | not purged, by design | device settings | PASS (out of scope by §10) |

Sixteen owner-scoped subsystems are purged; every §11 and §12 visibility
invariant holds; the one gap is erasure of data nothing can read.

### Delete → relaunch, and delete → B

```text
AUTHENTICATED_AS_A=NO              A_DATA_VISIBLE_TO_B=NO
A_PRIVATE_STATE_VISIBLE=NO         A_LOCAL_FILES_VISIBLE_TO_B=NO
A_LOCAL_CACHE_VISIBLE=NO           A_ENTITLEMENT_APPLIED_TO_B=NO
A_KPLUS_ACTIVE=NO                  A_ANALYTICS_ID_APPLIED_TO_B=NO
A_POSTHOG_IDENTITY_ACTIVE=NO       A_NOTIFICATION_CONTEXT_APPLIED_TO_B=NO
A_NOTIFICATION_CONTEXT_ACTIVE=NO   A_PENDING_DEEP_LINK_APPLIED_TO_B=NO (see §2)
```

Asserted in the harness across all ten free-tier keys after a purge run for A
while B is signed in, plus the purge's own owner targeting: every step received
`USER_A` (or `user:USER_A`), none received `USER_B`. A blank owner reaches no
primitive at all — an empty scope would match the signed-out partition, which is
device-local history no account deletion may take.

### Deletion race safety

`purgeOwnerScopedLocalData` converts a throw, a rejection and an explicit
`{ok:false}` into the same thing: that subsystem is unclean, the marker stays,
the run is retried. One broken subsystem does not stop the other fifteen
(asserted), and a run where every step fails reports `complete: false` with all
sixteen still attempted (asserted). Nothing here reads, writes or resets
current-actor runtime state, so a purge landing mid-switch cannot resurrect the
departed actor or damage the arriving one.

---

## 4. Regression gate

```text
B34_FE_DR_001_REGRESSION=PASS
B34_FE_FT_001_CLOSURE=PASS
B34_FE_FT_001_REGRESSION=PASS
A11Y_REPAIR_REGRESSION=PASS
NEW_INTEGRATION_REGRESSION=PASS
POSTHOG_IDENTITY_REGRESSION=PASS
POSTHOG_FAILURE_ISOLATION=PASS
PUSH_REGRESSION=PASS
EXISTING_USER_UPGRADE_STATUS=PASS
CORE_SMOKE_REGRESSION=PASS
REGRESSION_GATE=PASS
```

**B34-FE-DR-001.** Authenticated in-room path unchanged (the parameter is
omitted, not sent as null); anonymous valid share works; wrong, revoked and
expired shares each read nothing; 150 ids across two batches each carry the same
token. No RPC storm: `normalizedRouteToken` is a string-or-null primitive, so
adding it to the effect deps cannot make the effect re-run on re-render.

**B34-FE-FT-001.** No existing-user data loss (legacy adoption), none on cold
start, no reset per launch (asserted across three consecutive relaunches), no
duplicate migration, no actor-scope crash — `getActorContext()` has no throw
path, and `readStore`/`writeStore`/`updateStore` were each asserted not to
reject, including when the updater itself throws. Anonymous state stays its own
partition. Fault injection: a read fault resolves to the fallback and surfaces no
other account; a write fault returns `false` and leaves a neighbouring account's
store intact; a listing fault leaves `clearAllFreeTierStores` best-effort rather
than rejecting.

**Accessibility.** The repair added only accessibility props plus `hitSlop`.
`hitSlop` extends the 32dp remove circle from an 8dp inset to exactly the tile
edge (8 − 8 = 0 … 40 + 8 = 48), so the enlarged target stays inside `itemTile`,
which is `overflow: 'hidden'` — no growth beyond the parent, no clipping, no
layout change. `accessible` / `importantForAccessibility` on the disabled back
control are accessibility-tree properties only; the `width: 44` spacer that holds
the header layout is untouched.

**Startup order.** `onAuthStateChange` advances the actor epoch and claims device
push ownership synchronously, before `setSession`; React then commits with
`PostHogBridge` as the first sibling, so analytics identity syncs before any
screen's mount effect; K+ resolves inside screens afterwards, where every surface
already renders a distinct resolving state. Order verified by reading the
provider tree and the auth callback, not inferred.

**Push.** Untouched by all three repairs. Production stays dark
(`EXPO_PUBLIC_SMART_WATCHLIST_V1` on `staging-certification` only, `src/main`
removing `POST_NOTIFICATIONS`); certification stays activatable. No production
push was enabled.

---

## 5. Findings

### CPR-FT-001 — CROSS_PLATFORM_REVIEW_REQUIRED — P4

```text
FINDING_ID=CPR-FT-001
SEVERITY=P4
SHARED_FILE=services/deletion/ownerTerminalPurge.ts
  (plus a new owner-scoped primitive in services/free-tier/freeTierStorage.ts)
FEATURE=Account deletion / Free Tier utility
ANDROID_EVIDENCE=purgeOwnerScopedLocalData runs sixteen owner-scoped steps; none
  is free-tier. The module header justifies the omission by listing "free-tier
  device stores" under device-scoped state, "none of these is filed under an
  owner". That was true before B34-FE-FT-001 and is false after it: the stores
  are now keyed kscan.freeTier.*::<userId>.
EXPECTED=After the backend confirms a terminal purge for owner A, A's local
  owner-filed private state is destroyed.
ACTUAL=A's free-tier namespace (wishlist, saved outfits, collections, care notes,
  wear log, brand sizing, outfit ratings, activity log, style boards, sync queue)
  survives indefinitely.
CUSTOMER_IMPACT=None observable. No other account can read it — proven — and the
  deleted account cannot sign in. It is bytes on the user's own device that no
  surface renders. What it contradicts is the product's OWN standard, which is to
  erase owner-filed local data when a deletion reaches terminal.
WHY_P4_AND_NOT_P3=Every §11 and §12 invariant is about visibility and every one
  holds. Nothing is exposed, to anyone, ever. §10 also says to focus on user
  identity and private state rather than requiring deletion of everything local.
  This is unreadable residue, not a leak — so it is debt with a strong
  architectural argument, not a publication blocker. Stated plainly so the owner
  can overrule it: if the standard is "owner-filed means purged, full stop", this
  becomes P3 and the gate fails.
WHY_NOT_REPAIRED_HERE=§3. services/deletion/ownerTerminalPurge.ts and
  services/free-tier/freeTierStorage.ts are shared React Native business logic
  that iOS ships too. Handed to the cross-platform integration manager.
SUGGESTED_FIX=Add purgeFreeTierStoresForOwner(ownerId) to freeTierStorage.ts —
  removing exactly the `::<ownerId>` namespace, never the legacy key and never
  another owner's — wire it as a seventeenth step, and correct the module
  header's "deliberately not purged" list. Do NOT reach for
  clearAllFreeTierStores(): it is device-wide and would take the signed-in
  actor's data with it, which is the exact bug that module header warns against.
```

### P5-C1 — free-tier reads have no actor dependency

```text
FINDING_ID=P5-C1   SEVERITY=P5   CLASSIFICATION=CROSS_PLATFORM_REVIEW_REQUIRED
SHARED_FILE=hooks/useWishlistIntent.ts, useWardrobeUtility.ts, useActivityLog.ts,
  useCareNotes.ts, useCostPerWear.ts, useOutfitCollections.ts,
  useBrandSizingMemory.ts, useOutfitFeedback.ts
DESCRIPTION=Each reads its store in a mount effect with no auth or actor
  dependency, so it never re-reads when the actor changes. Safe today for two
  reasons that are both circumstantial rather than enforced: the routing guard
  unmounts these screens on sign-out, and no surface reachable before the actor
  resolves mounts one. FreeTierUtilitySection nonetheless supports a 'home'
  variant; the day Home adopts it, it mounts under the auth-gate overlay, reads
  the anonymous partition, and never re-reads.
SUGGESTED_FIX=Key the effects on currentActorScopeKey() — the helper that exists
  for exactly this and already catches B -> A (same id, new epoch), which
  isAuthenticated and user?.id both miss.
```

### P5-C2 — a transient storage read fault destroys that store

```text
FINDING_ID=P5-C2   SEVERITY=P5   CLASSIFICATION=CROSS_PLATFORM_REVIEW_REQUIRED
SHARED_FILE=services/free-tier/freeTierStorage.ts (readStore catch)
DESCRIPTION=The catch removes the key before returning the fallback, so an I/O
  fault that has nothing to do with the payload erases that actor's store.
  PRE-EXISTING — the same line was there before B34-FE-FT-001 and is unchanged;
  it is recorded here because the fault-injection pass made it visible.
SUGGESTED_FIX=Delete only on a parse/version failure, which is what the comment
  actually describes; return the fallback without deleting on an I/O error.
```

```text
ANDROID_SPECIFIC_P0_P3=0
CROSS_PLATFORM_REVIEW_REQUIRED_COUNT=3 (CPR-FT-001 P4, P5-C1, P5-C2)
BACKEND_REVIEW_REQUIRED_COUNT=0 new
  (B34-BE-CON-002 from the prior campaign remains open and unchanged)
```

---

## 6. Tests

```text
TARGETED=114 suites / 2480 tests — 2475 pass, 1 fail, 4 skipped
  The single failure is "no repo migration other than the blocking one assumes
  the internal schema", a recorded identity in config/test-failure-baseline.json.
NEW_UNEXPECTED_TEST_FAILURES=0
```

```text
FULL_SUITE  before this campaign: 9046 tests — 8968 pass, 13 fail, 65 skipped, exit 0
FULL_SUITE  after  this campaign: 9070 tests — 8992 pass, 13 fail, 65 skipped, exit 0
```

The 13 failures are the same 13 recorded identities both times
("Observed failures: 13; known: 13; unexpected: 0"). The delta is exactly the
+24 tests this campaign adds. No test was deleted, skipped or weakened, and the
campaign changes no production source file — its only additions are
`__tests__/identityLifecycleClosure.test.js` and this record.

### Core smoke regression

Every feature's own suites ran inside the full suite above and are green modulo
the recorded baseline, so each row below is SMOKE_STATUS=PASS /
REGRESSION_FOUND=none: AUTH, ONBOARDING, SCANNER, COMMERCE, SAVE, CLOSET, ELISE,
DRESSING ROOMS, PACKING, CONCIERGE, WATCHLIST, VTO, K+, PRIVACY/ACCOUNT.

---

## 7. Cleanup

```text
PORCELAIN_AFTER=CLEAN
UNPUSHED_COMMITS=0
BACKEND_CHANGES_MADE=0
PRODUCTION_ACCESSED=NO
PRODUCTION_CHANGED=NO
EMULATOR_STATUS=UNAVAILABLE_NON_BLOCKING
TESTSPRITE_STATUS=UNAVAILABLE_NON_BLOCKING
```

The negative-control edit to `services/free-tier/freeTierStorage.ts` was restored
byte-for-byte and verified clean before anything was committed. No synthetic
staging actors or resources were created: every isolation scenario was driven
through the real modules offline, so staging needed no writes at all.
