# Build 34 — Android hostile audit, repair and publication-readiness record

Campaign date: 2026-09-18
Environment: staging only (`yzqjvdfgefveprobvvyw`). Production (`wyyuqfdxucjksghsmhry`) was never read, written or deployed to.
Android authority: `release/kscan-pre-freeze-v1` @ `c6ee31adb0932d4d476cc218c1a7bff434b10bc8`
Audit/repair branch: `claude/clever-hopper-2jx4gw`
Backend contract treated as frozen: `repair/build34-backend-closure-20260917` @ `3ce5e60d` (PR #437, unmerged)

```text
ANDROID_PUBLICATION_READINESS=PASS
PRODUCTION_ACCESSED=NO
PRODUCTION_CHANGED=NO
BACKEND_CHANGES_MADE=0
AUDIT_INTRODUCED_DEFECTS=0
```

---

## 1. Authority

```text
ANDROID_AUTHORITY_BRANCH=release/kscan-pre-freeze-v1
ANDROID_AUTHORITY_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
UPSTREAM_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
AHEAD_BEHIND=0/0 at audit start
AUDIT_START_SHA=c6ee31adb0932d4d476cc218c1a7bff434b10bc8
PORCELAIN_BEFORE=CLEAN
BUILD35_CONTAMINATION=NO
```

`release/kscan-pre-freeze-v1` is named as `CURRENT_RELEASE_BRANCH` by the Build 34
backend closure record and is 1253 commits ahead of `origin/master`, which has
diverged onto a CI/deletion-worker line (89 commits) carrying none of the Build 34
mobile work. `master` is therefore not the Android authority and was not used.

Build 35 contamination was ruled out three ways: no path in the tree matches
`build35`; `origin/integration/build35-convergence-checkpoint-v1` is not an
ancestor; and the only `build35`-named commit in the lineage (`54729ef7`, PR #270)
is Apple-credential revocation in the account-deletion purge — Build 34 deletion
work under a misleading branch name, not R&D.

### Supabase target

```text
SUPABASE_STAGING_TARGET_VERIFIED=YES
  yzqjvdfgefveprobvvyw = "K Scan AI Staging"     (us-west-1, ACTIVE_HEALTHY)
  wyyuqfdxucjksghsmhry = "KScan App Production"  (FORBIDDEN — not accessed)
```

Every remote statement in this campaign was a read (`pg_proc`, `pg_indexes`,
`pg_get_functiondef`, `supabase_migrations.schema_migrations`, `room_shares`).
No DDL, no DML, no function deploy, no migration.

### Environment limits

```text
EMULATOR_AVAILABLE=NO           (no Android SDK, no adb, no emulator binary)
ANDROID_NATIVE_BUILD=NOT_ATTEMPTED  (no SDK to build against)
TESTSPRITE_STATUS=UNAVAILABLE_NON_BLOCKING
```

Compensated with: full offline suite (483 files / 9016 tests), `tsc --noEmit`,
the repo's own native-config-parity, dependency-reachability,
migration-provenance, edge-parity and security gates, live read-only staging
contract probes, and source-level trace of every seam listed below.

---

## 2. P0–P3 ledger

Three defects were found, proven, repaired and regression-covered. None remains open.

### B34-FE-DR-001 — P2 — anonymous public Dressing Rooms showed 0 reactions

```text
SEVERITY=P2
LOCATION=services/styleObjects.ts:getItemReactionCounts; app/(public)/rooms/[token].tsx
ROOT_CAUSE=The governed backend contract moved and the client did not follow it.
  Staging migration 20260916233708 (reaction_counts_bind_anonymous_share_token)
  DROPPED public.get_item_reaction_counts(uuid[]) and replaced it with
  (p_item_ids uuid[], p_share_token text default null), whose anonymous branch
  requires the token to name a live, unrevoked, unexpired share. The client
  called it with item ids only.
USER_IMPACT=Every visitor to a shared Dressing Room link is anonymous by
  construction, so the token was always null, the predicate false for every item,
  and the RPC returned no rows. Not an error path: buildReactionCountsByItem
  zero-fills whatever the RPC omits, so every item on every public room rendered
  0/0/0/0 with no error state — a silently wrong answer on the surface whose
  entire purpose is showing what other people thought of the look.
RUNTIME_PROOF=Live on yzqjvdfgefveprobvvyw: pg_proc shows
  get_item_reaction_counts(uuid[],text) as the ONLY overload;
  pg_get_functiondef returns the token-required anonymous branch verbatim; the
  migration ledger carries version 20260916233708.
REPAIR=Forward the share token the visitor already arrived with. Trimmed, never
  case-folded (room_shares.share_token is compared with `=`). The parameter is
  OMITTED rather than sent as null when absent, so the authenticated in-room path
  keeps its exact previous call shape — that caller takes the membership /
  can_access_room_messages() branch, where p_share_token is ignored.
COMMIT=fc6f6fa9
TESTS=__tests__/dressingRoomReactionShareTokenBinding.test.js (13)
STATUS=FIXED_VERIFIED
```

The backend predicate is untouched and is not weakened to admit the old client.
The wrong-token, revoked-token and expired-token cases in the new suite exist to
keep it that way.

### B34-FE-FT-001 — P2 — free-tier wardrobe data crossed accounts on a shared device

```text
SEVERITY=P2
LOCATION=services/free-tier/freeTierStorage.ts
ROOT_CAUSE=Every store lived at ONE device-wide AsyncStorage key. writeStore
  stamped the envelope with a userId "for future per-user isolation"; readStore
  never read it. clearAllFreeTierStores() carried the comment "safe to call on
  sign-out if wired later" and had ZERO call sites.
USER_IMPACT=On a handset where one account signed out and another signed in, the
  arriving account read the departing account's wishlist, saved outfits,
  collections, care notes, wear log, brand sizing, outfit ratings and activity
  log. Deleting the account did not help — none of it is server state, so nothing
  removed it. The free-tier sync queue shared the same key, so one account's
  pending writes could be flushed under another account's session.
NOT_LATENT=EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED,
  EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED and
  EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED are all "true" on the PRODUCTION
  EAS profile; app/library.tsx, components/AnalysisCard.tsx and
  components/scan-results/ScanResultV2.tsx mount those surfaces.
REPAIR=Namespace the physical key by the owning actor, resolved from the existing
  authority (services/actorScope -> actorContext). No call-site changes. The
  envelope userId is now verified as a second, independent check. An explicit
  userId resolves the read and the write together.
COMMIT=a7400c79
TESTS=__tests__/freeTierStorageActorIsolation.test.js (11)
STATUS=FIXED_VERIFIED
```

**Why not "clear on sign-out".** `resetActorScopedRuntimeState()` runs on every
actor BOUNDARY, and a cold start with a restored session is a boundary — the
guard's first `noteActor()` returns true. Clearing there would erase the user's
own wardrobe notes on every launch, a worse defect than the one being fixed.

**Upgrade path and its one honest limit.** Pre-namespace data is adopted into the
first actor that reads it and the legacy key is then removed, so an existing user
keeps their data and no second actor can ever adopt it. Residue: on a device
already shared by two accounts before this build, whichever opens the app first
inherits the legacy blob — one bounded window, against today's permanent leak in
both directions. Discarding legacy data outright would close it by silently
deleting the wardrobe notes of every single-account user on upgrade.

**Why it escaped device certification** — see P4-02: the three production flags
above are set on the `production` profile and on NO staging profile, so the
`staging-certification` AAB the owner device-tests does not render these surfaces
at all.

### A11Y-SOC-001/002/003 — P3 — shared room/look tile controls were unreachable by voice

```text
SEVERITY=P3
LOCATION=components/StyleObjectCards.tsx (Header, ItemTile)
SURFACES=app/dressing-rooms/index.tsx, app/dressing-rooms/[id].tsx,
  app/looks/[id].tsx — all production-shipping (DRESSING_ROOM_* and
  PRIVATE_DRESSING_ROOM_* are true on the production EAS profile)
ROOT_CAUSE=
  001  The back control's only content was the glyph "<", with no role and no
       label, so TalkBack announced "less than". With no onBack it rendered an
       EMPTY focusable control that announced nothing and did nothing.
  002  No per-item control named its item, so on a grid of identical tiles
       nothing said which item a control would act on.
  003  The remove control — a DESTRUCTIVE action — rendered the letter "x" with
       no role and no label, in a 32dp circle against Android's 48dp minimum.
USER_IMPACT=A screen-reader user could not identify the back affordance, and
  could destroy a saved item from a Dressing Room or Look without the control
  ever stating what it was or which item it acted on.
REPAIR=Role + name on all three controls; the item name derived from the same
  fields the tile renders, in the same precedence, falling back to "this item"
  rather than a UUID; hitSlop raises the remove control's effective target to
  exactly 48dp without moving a pixel; the empty back control leaves the
  accessibility tree rather than merely being disabled.
COMMIT=2011cfb4
TESTS=__tests__/styleObjectCardsAccessibility.test.js (6)
STATUS=FIXED_VERIFIED
```

Pre-repair evidence: a walk of every `TouchableOpacity`/`Pressable` opening tag
in `app/` and `components/` found 18 with neither `accessibilityLabel` nor
`accessibilityRole`, 5 of them in this file. The remaining 13 all carry visible
text children and are recorded as P5-01.

---

## 3. Backend reopen blockers

### B34-BE-CON-002 — the source-identity ledger row has no index behind it

```text
BACKEND_SURFACE=public.dressing_room_items
ANDROID_CALLER=services/styleObjects.ts (addScanImageToDressingRoom,
  addProductMatchToDressingRoom) — client-side check-then-insert
EXPECTED_CONTRACT=supabase_migrations.schema_migrations version 20260916234025
  ("dressing_room_items_source_idempotency") records, as its applied statement:
    create unique index if not exists dressing_room_items_source_identity_key
    on public.dressing_room_items (dressing_room_id, source_type, source_id);
  with the comment "the write path upserts on this key so a repeated add is
  idempotent rather than a 23505 error."
ACTUAL_CONTRACT=The index does NOT exist on staging. pg_indexes on
  public.dressing_room_items returns only _pkey, _room_created_idx,
  _room_sort_idx, _storage_idx and _dedupe_key_key; a direct pg_class lookup for
  dressing_room_items_source_identity_key returns 0 rows, and the table carries
  zero unique constraints.
USER_IMPACT=None observed in Build 34. The client's own double-submit guard
  (savingRef in AddScanToDressingRoomModal) covers the ordinary path, and the
  dedupe helper is inert because DRESSING_ROOM_DEDUPE_V1 and
  DRESSING_ROOM_CANONICAL_ITEM_V1 are set on no profile, so no row carries a
  canonical dedupe key. The stated atomicity guarantee simply is not there.
SEVERITY=P3 (backend governance) — the ledger asserts a constraint the schema
  does not have, so a future build that trusts it and switches to an upsert would
  find no conflict target.
REPRODUCTION=Read-only, staging: compare the statements column of the
  20260916234025 ledger row against pg_indexes for the same table.
SUGGESTED_BACKEND_FIX=Owner decision — either apply the recorded index (note it
  is room-scoped, unlike the sibling dedupe-key index, which is GLOBALLY unique
  and would collide across rooms if DRESSING_ROOM_DEDUPE_V1 were ever enabled),
  or retract the ledger row so the recorded and live schemas agree.
BACKEND_REVIEW_REQUIRED=YES
BUILD34_BACKEND_REOPEN_BLOCKER=classified, NOT repaired in this campaign
```

No other backend defect was found. Every other contract the Android client
touches was verified live against staging and matches.

---

## 4. First-deployment gates

### PostHog

```text
POSTHOG_SDK_PRESENT=YES            posthog-react-native ^4.67.0
POSTHOG_INITIALIZATION_LOCATION=services/analytics/posthogClient.core.ts
  (module scope) + PostHogAnalyticsProvider at the root of app/_layout.tsx
POSTHOG_PROJECT_CONFIG_SOURCE=env only — EXPO_PUBLIC_POSTHOG_API_KEY /
  EXPO_PUBLIC_POSTHOG_HOST. No hardcoded token or host. A host that is not an
  http(s) URL counts as absent.
POSTHOG_AUTOCAPTURE=OFF   verified in the vendor bundle, not just the config:
  PostHogProvider derives captureNone = (autocapture === false), and both
  captureTouches and captureScreens are gated on !captureNone. The app passes
  autocapture={false}.
POSTHOG_SESSION_REPLAY=OFF (enableSessionReplay: false)
POSTHOG_FEATURE_FLAGS=OFF (disableRemoteFeatureFlags: true, preloadFeatureFlags:
  false). PostHog controls NO K Scan flag; every flag is a build-time
  EXPO_PUBLIC_* constant resolved in constants/featureFlags.ts. PostHog cannot
  override the authoritative mechanism because it is never consulted by it.
POSTHOG_IDENTIFY_USED=YES   POSTHOG_RESET_USED=YES
POSTHOG_OPT_IN_OUT_BEHAVIOR=defaultOptIn: true, unconditional once configured.
  opt_out_of_sale is a CCPA/CPRA "do not sell" flag and is deliberately NOT
  reinterpreted as analytics consent. The module says so and does not read it.
POSTHOG_ERROR_BOUNDARY_INTERACTION=PostHogAnalyticsProvider wraps ErrorBoundary
  (see P5-02). errorTracking.autocapture is false, so PostHog captures no
  exception and the app's boundary is the only error consumer.
POSTHOG_NETWORK_FAILURE_BEHAVIOR=every exported call is wrapped in try/catch and
  returns void; the five bridged sinks swallow their own failures by contract.
```

Initialization happens once per process (a module-level `const`), only when
configured, and never constructs the vendor SDK otherwise — proven behaviourally,
not by source text: `__tests__/posthogDisabledStateEgress.test.js` runs the real
module in a child process against a recording vendor stub across nine
misconfiguration shapes and asserts zero vendor calls, with a configured build as
the negative control.

**Event surface.** Exactly five telemetry sinks are bridged: Closet candidates,
K+, Today-with-Elise, Voice, VTO. Each has TWO allowlists — event name and
property name — plus a `^[A-Za-z0-9_.:-]{1,64}$` value scrub that cannot express
a URI, a path, a filename, an email or a query string. There is no free-text
property anywhere. `services/style-chat/eliseVisualAttachmentTelemetry.ts` is
deliberately NOT bridged and is inert (`sink = null`) because it has no
allowlist. No event carries a token, an image, a conversation, a room body, an
email or a coordinate. There is no notification telemetry at all (P6-01).

```text
POSTHOG_CROSS_ACCOUNT_ISOLATION=PASS
```
`syncPostHogIdentityWith` always `reset()`s before establishing a different
identity, so anonymous -> A, A -> B, A -> logout -> B and a coalesced A -> B all
reset first. `PostHogBridge` is the FIRST sibling under the provider stack, so
React runs its effect before any feature screen's mount effect — identity is
synced before any screen can capture.

```text
POSTHOG_INTEGRATION_STATUS=PASS
POSTHOG_IDENTITY_STATUS=PASS
POSTHOG_PRIVACY_STATUS=PASS
POSTHOG_FAILURE_ISOLATION=PASS
POSTHOG_REGRESSION_STATUS=PASS
POSTHOG_FINDINGS_P0_P3=0
POSTHOG_FINDINGS_P4_P10=P4-01, P5-02, P5-03
```

### RevenueCat

```text
REVENUECAT_CLIENT_SDK_PRESENT=NO
```

This is the campaign's central RevenueCat finding and it is load-bearing:
`react-native-purchases` is absent from `package.json` and from the installed
tree, and no first-party client file imports any RevenueCat SDK. The only
client-side occurrence of the word is a comment in
`components/account-home/PermissionsStepV1.tsx`. RevenueCat exists ONLY
server-side (`supabase/functions/kplus-reconcile-revenuecat`, `kplus-activate`,
`_shared/revenuecat/revenueCatClient.ts`, and the deletion purge).

```text
REVENUECAT_SDK_VERSION=n/a            REVENUECAT_INITIALIZATION_LOCATION=none
REVENUECAT_PUBLIC_API_KEY_SOURCE=none in the mobile bundle
REVENUECAT_APP_USER_ID_SOURCE=n/a — the client never identifies to RevenueCat
REVENUECAT_ENTITLEMENTS_REFERENCED=none client-side
REVENUECAT_OFFERINGS_REFERENCED=none   REVENUECAT_PURCHASE_API_USED=NO
REVENUECAT_RESTORE_API_USED=NO
REVENUECAT_SERVER_RECONCILIATION_USED=YES (backend only)
REVENUECAT_WEBHOOK_DEPENDENCY=backend only
REVENUECAT_OFFLINE_BEHAVIOR=n/a client-side
```

Native purchase APIs are not shipping and are unreachable: there is no SDK to
call. No purchase flow was created.

**K+ authority.** `services/kplus/kplusClient.ts` reads the caller's own
RLS-scoped `user_entitlements` row and invokes `kplus-activate`; it never
computes, extends or invents a grant. `resolveState()` agrees with the canonical
server predicate field for field (`status='active' AND revoked_at IS NULL AND
expires_at IS NOT NULL AND expires_at > now()`), and `getKPlusEntitlementSnapshot`
downgrades a lapsed 'active' at READ time so a session that sits open past expiry
cannot keep presenting it. An 'active' row with no readable expiry fails closed.

RESOLVING != FREE is enforced through one shared helper
(`isKPlusEntitlementUnresolved`) consumed by `KPlusGate`, `KPlusActivationStep`
and `useVtoAvailability`; `app/packing/index.tsx` renders a distinct
`packing-kplus-resolving` state rather than the gate. No surface renders the
free-tier lock or routes to the upgrade sheet while the answer is unknown.

`resetKPlusEntitlementCache()` runs synchronously from
`resetActorScopedRuntimeState` before any await, and bumps an in-flight request
id so a prior actor's late refresh/activate response is discarded.

```text
REVENUECAT_INTEGRATION_STATUS=PASS   (correct shape: no client SDK, server authority)
REVENUECAT_IDENTITY_STATUS=PASS      (no client identity exists to leak)
REVENUECAT_CROSS_ACCOUNT_ISOLATION=PASS
REVENUECAT_KPLUS_AUTHORITY_STATUS=PASS
REVENUECAT_FAILURE_ISOLATION=PASS    (RevenueCat is not on any client path, so it
  cannot be an availability dependency; a backend reconciliation failure surfaces
  as externalSyncStatus on the row and never revokes local presentation)
REVENUECAT_REGRESSION_STATUS=PASS    (the complimentary path is unchanged: grant
  reason 'complimentary_early_access' is read from user_entitlements exactly as
  before, and no new client dependency was introduced)
REVENUECAT_FINDINGS_P0_P3=0
REVENUECAT_FINDINGS_P4_P10=0
```

### Push notifications

```text
NOTIFICATION_PROVIDER=Expo Push -> FCM
NOTIFICATION_CLIENT_LIBRARY=expo-notifications ~0.32.17
TOKEN_TYPE=Expo push token
TOKEN_REGISTRATION_ENTRY_POINT=services/watchlist/pushRegistration.ts —
  requestWatchAlerts(), reached ONLY from the post-Watch-creation "alert me?"
  prompt in components/ProductShelf.tsx, and enableDeviceNotifications() from
  the account-home permissions surface. Never on launch, never in onboarding.
TOKEN_STORAGE_LOCATION=device id + explicit-disable + device-push-owner keys in
  AsyncStorage; the token itself is held by the backend, not mirrored locally.
TOKEN_BACKEND_TABLE_OR_RPC=user_device_push_tokens via the commerce-watch-refresh
  Edge Function (actions: claim_device, revoke_push_token)
TOKEN_REFRESH_HANDLER=attachPushTokenRefreshListener(), installed once in
  app/_layout.tsx with cleanup; re-registration is gated by the same capability
  decision and refuses to rebuild a route the user explicitly revoked.
FOREGROUND/BACKGROUND/TAP=services/watchlist/watchNotificationRouting.ts
DEEP_LINK_ROUTER=watchRouteFromNotificationData -> /watchlist/<uuid>
USER_PREFERENCE_SOURCE=OS permission + an explicit per-device disable flag +
  the backend row (the backend row is the delivery authority)
LOGOUT_CLEANUP=revokeWatchAlertsForThisDevice(), awaited before the actor epoch
  advances, with a 4000ms deadline and a bounded opaque outcome code
ACCOUNT_SWITCH_CLEANUP=claimDeviceForCurrentActor() on sign-IN, which retires
  every other actor's live route on this handset
```

**Production ships push dark.** `EXPO_PUBLIC_SMART_WATCHLIST_V1` is set on
`staging-certification` and on NO other profile. The client capability decision
(`services/notifications/remotePushCapability.ts`) is derived from that one flag,
and its native projection in `android/app/build.gradle` selects
`src/release/AndroidManifest.xml`, which grants no `POST_NOTIFICATIONS` —
`src/main` removes it with `tools:node="remove"`, which neutralises
expo-notifications' own library declaration as well. So the production artifact
requests no notification permission, mints no token, registers no device and
declares no notification permission. `RECEIVE_BOOT_COMPLETED` is suppressed in
all four capability states.

**Route safety.** The route is derived ONLY from a syntactically valid UUID
`watchId`. The payload's URL-shaped `deepLink` field is deliberately never read,
so a forged push cannot steer the app. A forged, deleted or foreign watch id
resolves to the ordinary detail route, where the screen's own RLS-scoped read
returns nothing and it shows its error state — ownership is decided by the
database under the viewer's session. Both `/watchlist` routes additionally check
`resolveWatchlistAvailable()` and wrap content in `KPlusGate`, so a stale
notification cannot bypass the K+ boundary; entitlement is re-resolved on
foreground.

**Cold start and replay.** A launch response is retained and flushed on the
navigator's own readiness signal (no timer, no polling), then cleared through
expo-notifications' API with an independent module-scoped consumed flag, so a
Fast Refresh / StrictMode double-mount / root remount cannot replay it. One
pending slot, not a queue, so a burst of taps cannot become a burst of
navigations.

```text
NOTIFICATION_INTEGRATION_STATUS=PASS
NOTIFICATION_PERMISSION_STATUS=PASS   (contextual, never at launch; denial leaves
  the Watch valid with push_enabled false and never blocks creation)
NOTIFICATION_TOKEN_REGISTRATION=PASS
NOTIFICATION_CROSS_ACCOUNT_ISOLATION=PASS
NOTIFICATION_DUPLICATE_PROTECTION=PASS (single listener install with cleanup;
  one pending route slot; launch response cleared and flagged)
NOTIFICATION_FOREGROUND_STATUS=PASS
NOTIFICATION_BACKGROUND_STATUS=PASS
NOTIFICATION_COLD_START_STATUS=PASS
NOTIFICATION_DEEP_LINK_STATUS=PASS
NOTIFICATION_PRIVACY_STATUS=PASS      (payload carries watchId/eventType only;
  no token, share secret, message body or PII; bounded opaque outcome codes)
NOTIFICATION_FAILURE_ISOLATION=PASS   (every activation path is fire-and-forget
  and never delays or fails sign-in, sign-out or Watch creation)
NOTIFICATION_UPGRADE_REGRESSION=PASS  (a pre-N-6 install with a device id but no
  owner record is attributed to the actor present at the first claim rather than
  presented as OFF over a possibly-live route)
NOTIFICATION_POSTHOG_INTERACTION=PASS (there is none — no notification event
  reaches any analytics sink; see P6-01)
NOTIFICATION_KPLUS_INTERACTION=PASS
NOTIFICATION_FINDINGS_P0_P3=0
FIRST_DEPLOYMENT_NOTIFICATION_GATE=PASS
```

```text
FIRST_DEPLOYMENT_THIRD_PARTY_GATE=PASS
```

---

## 5. P4–P10 ledger

### P4-01 — PostHog is configured by no committed profile

```text
FINDING_ID=P4-01   SEVERITY=P4   FEATURE=Analytics
LOCATION=eas.json (all profiles), .env.example:169-170
DEFECT_TYPE=configuration / activation
DESCRIPTION=EXPO_PUBLIC_POSTHOG_API_KEY and EXPO_PUBLIC_POSTHOG_HOST are
  commented out in .env.example and set on NO EAS profile, so every artifact
  built from this tree ships with PostHog inert. If the keys are supplied through
  EAS-managed environment variables (not visible in this repo and not verifiable
  from this session) the integration activates; every activation path was audited
  in that state too.
USER_IMPACT=None. TECHNICAL_IMPACT=The first deployment of PostHog would collect
  nothing unless the keys are provisioned out of band.
WHY_NOT_P0_P3=Fail-safe direction, and the app is byte-for-byte unaffected.
SUGGESTED_FIX=Owner decides: provision via `eas env` for the intended profiles,
  or state explicitly that Build 34 ships analytics dark.
ESTIMATED_SCOPE=configuration only   RELEASE_RECOMMENDATION=decide before release
```

### P4-02 — the certification artifact omits three production-shipping surfaces

```text
FINDING_ID=P4-02   SEVERITY=P4   FEATURE=Free Tier Utility / release process
LOCATION=eas.json — production vs staging / staging-certification
DESCRIPTION=EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED,
  EXPO_PUBLIC_FREE_TIER_WISHLIST_INTENT_ENABLED and
  EXPO_PUBLIC_FREE_TIER_OUTFIT_GENERATOR_ENABLED are "true" on `production` and
  set on NO staging profile. `staging-certification` extends `staging`, so the
  AAB the owner device-tests does not render FreeTierUtilitySection (Closet),
  ScanResultUtilityFooter, SavedItemUtilityPanel, WishlistIntentCard or the
  outfit-generator cards — all of which DO ship to customers.
  EXPO_PUBLIC_TODAY_WITH_ELISE_V1 is inverted the other way (false in production,
  true in staging).
CUSTOMER_IMPACT=Indirect but real: this is why B34-FE-FT-001 survived every prior
  device certification — the leaking surfaces are invisible in the artifact that
  gets tested.
TECHNICAL_IMPACT=The repo's own staging/production parity gate already fails on
  this and the failure is recorded in config/test-failure-baseline.json ("staging
  exposes exactly the production client-feature flag set"), so the drift is known
  and accepted rather than undetected.
WHY_NOT_P0_P3=A process/coverage gap, not a source defect; the production
  artifact itself is correct and the features do activate.
SUGGESTED_FIX=Align the staging profile with production for these four keys, or
  record each as environment-specific with a reason in the parity gate's
  ENVIRONMENT_SPECIFIC_KEYS map.
RELEASE_RECOMMENDATION=Before the next certification build
```

### P4-03 — preview and development profiles point at production Supabase

```text
FINDING_ID=P4-03   SEVERITY=P4   FEATURE=Build configuration
LOCATION=eas.json build.preview.env / build.development.env
DESCRIPTION=Both carry EXPO_PUBLIC_SUPABASE_URL =
  https://wyyuqfdxucjksghsmhry.supabase.co (PRODUCTION) and the production
  publishable key. `preview` is an internally distributed APK.
CUSTOMER_IMPACT=None directly; internal preview testing writes to the production
  project. TECHNICAL_IMPACT=Production data is reachable from a non-release build
  whose flag set is not the production one.
WHY_NOT_P0_P3=Pre-existing, deliberate-looking, and no production change is made
  by this campaign. The release-critical profiles (production, staging,
  staging-certification) are each correctly targeted, and the native build guard
  independently refuses a certification build pointed at production.
SUGGESTED_FIX=Point preview/development at staging, or record the intent.
RELEASE_RECOMMENDATION=Before broadening internal distribution
```

### P4-04 — the Closet renders every item in a plain ScrollView

```text
FINDING_ID=P4-04   SEVERITY=P4   FEATURE=Closet / Dressing Room detail
LOCATION=app/library.tsx:724-1041 (closetPairs/scanPairs/inspirationPairs.map
  inside one ScrollView); app/dressing-rooms/[id].tsx:981-1223 (items.map)
DESCRIPTION=No virtualisation and no pagination; one <Image> mounts per item.
  Recent scans are capped at MAX_SCANS = 25 per partition, but the Closet is
  explicitly uncapped by design ("NO 25-item eviction cap" —
  services/closetLibrary.js:11), so it grows with the wardrobe.
CUSTOMER_IMPACT=Scroll jank and image-memory pressure on mid-range Android as the
  wardrobe grows; an out-of-memory kill is plausible at several hundred items.
WHY_NOT_P0_P3=No runtime evidence of failure is available in this environment (no
  emulator, no device), and §37 explicitly does not require production-scale
  benchmarking to PASS. Claiming a blocker here would be asserting more than the
  evidence supports.
SUGGESTED_FIX=FlatList/FlashList with windowing for the Closet grid; the two
  screens that already use FlatList are the pattern.
ESTIMATED_SCOPE=medium (one screen each)   RELEASE_RECOMMENDATION=Build 35
```

### P5-01 — thirteen touchables still carry no explicit role

```text
FINDING_ID=P5-01   SEVERITY=P5   FEATURE=Accessibility (various)
LOCATION=app.js (4), app/style-chat/debug-memory.tsx (2),
  components/style-chat/StyleChatSignatureStyleCard.tsx (2),
  app/auth/index.tsx, app/auth/reset.tsx, app/auth/update-password.tsx,
  app/auth/callback.tsx (1 each), components/dressing-rooms/RoomItemDetailModal.tsx (1)
DESCRIPTION=Each carries a visible <Text> child, so TalkBack announces the label
  and the control is actionable; what is missing is accessibilityRole="button",
  so it is not announced AS a button. The RoomItemDetailModal case is a backdrop
  Pressable (dismiss-on-tap) with a keyboard-reachable close elsewhere.
WHY_NOT_P0_P3=No control is anonymous and none is destructive-and-unlabelled —
  that class was A11Y-SOC-003 and is fixed.
SUGGESTED_FIX=Add accessibilityRole="button"; for the backdrop, accessibilityRole
  ="none" plus accessibilityElementsHidden.
RELEASE_RECOMMENDATION=Build 35
```

### P5-02 — the app's ErrorBoundary sits inside the PostHog provider

```text
FINDING_ID=P5-02   SEVERITY=P5   FEATURE=Startup resilience
LOCATION=app/_layout.tsx:550-567
DESCRIPTION=<PostHogAnalyticsProvider> wraps <ErrorBoundary>, so a render-time
  throw from the vendor provider is not caught by the app's own boundary. With
  PostHog unconfigured the wrapper returns <>{children}</> and the risk is zero;
  configured, PostHogProvider does little (a memo, a debug effect, a View with
  touch handlers, all autocapture off) and no throw path was identified.
SUGGESTED_FIX=Swap the two. ErrorBoundary has no dependency on PostHog context,
  and no first-party code calls usePostHog(), so the swap is behaviourally inert.
  (Verified separately: the fallback's SafeAreaView does NOT need SafeAreaProvider
  in react-native-safe-area-context 5.6.2, so the boundary renders correctly even
  though the provider is its own child.)
RELEASE_RECOMMENDATION=Build 35
```

### P5-03 — one telemetry sink has no allowlist and stays unbridged

```text
FINDING_ID=P5-03   SEVERITY=P5   FEATURE=Elise visual attachments
LOCATION=services/style-chat/eliseVisualAttachmentTelemetry.ts
DESCRIPTION=Unlike the five bridged sinks it has no event-name allowlist and its
  outcome properties pass through as raw strings (one call site forwards a raw
  backend errorCode). It is deliberately left inert (sink = null) and is NOT
  bridged to PostHog, which is why this is debt and not a privacy finding.
SUGGESTED_FIX=Give it the same two-allowlist + SAFE_STRING discipline, then bridge.
RELEASE_RECOMMENDATION=Build 35
```

### P5-04 — clearAllFreeTierStores is not wired to terminal deletion

```text
FINDING_ID=P5-04   SEVERITY=P5   FEATURE=Account deletion / Free Tier
LOCATION=services/free-tier/freeTierStorage.ts; services/deletion/ownerTerminalPurge.ts
DESCRIPTION=After B34-FE-FT-001 a deleted account's local free-tier data is
  unreadable by any other actor, which closes the disclosure. It is not ERASED.
  clearAllFreeTierStores() now clears every namespace and would do exactly this
  job from the terminal-deletion purge; it is still called from nowhere.
WHY_NOT_P0_P3=No longer a disclosure; it is residual local storage for an account
  that no longer exists.
SUGGESTED_FIX=Call it from the terminal-deletion purge, scoped to the deleted
  actor's namespace.
RELEASE_RECOMMENDATION=Build 35
```

### P5-05 — four flags are set on staging profiles and consumed by no client code

```text
FINDING_ID=P5-05   SEVERITY=P5   FEATURE=Configuration hygiene
LOCATION=eas.json staging/staging-certification
DESCRIPTION=EXPO_PUBLIC_AVATAR_MOTION_V1, EXPO_PUBLIC_ELISE_V10,
  EXPO_PUBLIC_ELISE_SPEECH and EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED appear in
  no first-party source file; their only other occurrence is the leak-control
  list in __tests__/easConfigIntegrity.test.js. They configure nothing.
SUGGESTED_FIX=Remove, or wire the consumer they were added for.
RELEASE_RECOMMENDATION=Build 35
```

### P6-01 — no notification telemetry exists

```text
FINDING_ID=P6-01   SEVERITY=P6   FEATURE=Watchlist notifications
DESCRIPTION=No notification receipt, open or destination-action event reaches any
  analytics sink. This is why NOTIFICATION_POSTHOG_INTERACTION passes trivially,
  and it also means the first push deployment will produce no funnel data.
SUGGESTED_FIX=If wanted, add an allowlisted sink distinguishing
  notification_received / notification_opened / destination_action_completed —
  and never report the third on the strength of a tap.
RELEASE_RECOMMENDATION=Build 35
```

### P6-02 — a device-local "do not sell" flag ratchets onto the next account

```text
FINDING_ID=P6-02   SEVERITY=P6   FEATURE=Privacy preferences
LOCATION=contexts/PrivacyPreferencesContext.tsx:192-204; services/privacyLocalStore.js
DESCRIPTION=The local store is device-wide, and a local ON propagates into the
  authenticated account's remote row when the remote is OFF. On a shared device
  the next account can therefore acquire the previous one's opt-out.
WHY_NOT_P0_P3=The direction is strictly privacy-PROTECTIVE and the local value is
  never presented as account-level when a remote row exists; it is unexpected
  state, not exposure. Arguably correct for a device-level "do not sell" signal.
SUGGESTED_FIX=Owner decision: scope the local store by actor, or state that the
  signal is intentionally device-level.
RELEASE_RECOMMENDATION=Build 35
```

### P6-03 — free-tier legacy adoption has one shared-device window

```text
FINDING_ID=P6-03   SEVERITY=P6   FEATURE=Free Tier (introduced by the B34-FE-FT-001 repair)
DESCRIPTION=On a device already shared by two accounts BEFORE this build, the
  first account to open the app after upgrade adopts the pre-namespace blob. One
  bounded, one-time window, chosen over silently deleting every single-account
  user's wardrobe notes on upgrade. Documented in the module header.
SUGGESTED_FIX=None recommended. Revisit only if shared-device usage proves common.
RELEASE_RECOMMENDATION=No action
```

### P7-01 — TODAY_WITH_ELISE sub-flags are true while the master is false in production

```text
FINDING_ID=P7-01   SEVERITY=P7   LOCATION=eas.json build.production.env
DESCRIPTION=EXPO_PUBLIC_TODAY_WITH_ELISE_GENERATED_GREETING_V1 and
  ..._WEATHER_V1 are "true" while EXPO_PUBLIC_TODAY_WITH_ELISE_V1 is "false".
  The master gates the feature, so the two are dead config, not live behaviour.
SUGGESTED_FIX=Remove the subordinate keys from production.
```

### P7-02 — an expo-dev-client property is set with no dev client in the build

```text
FINDING_ID=P7-02   SEVERITY=P7   LOCATION=android/gradle.properties
DESCRIPTION=EX_DEV_CLIENT_NETWORK_INSPECTOR=true, but expo-dev-client is not a
  dependency and every profile sets developmentClient false, so it is inert.
SUGGESTED_FIX=Remove.
```

### P8-01 — the navigator-readiness poll runs to its deadline after succeeding

```text
FINDING_ID=P8-01   SEVERITY=P8   LOCATION=app/_layout.tsx:136-151
DESCRIPTION=setInterval(check, 50) is cleared by a 2000ms timeout and on unmount,
  but not when isReady() first returns true, so it keeps firing a no-op check for
  the remainder of the window. Bounded and negligible.
SUGGESTED_FIX=clearInterval inside check() on success.
```

### P7-03 — a dev-only debug route still exists in the release router

```text
FINDING_ID=P7-03   SEVERITY=P7   LOCATION=app/style-chat/debug-memory.tsx
DESCRIPTION=The Style Memory debug screen remains a file route in release. It is
  gated on __DEV__ (a release build renders DebugUnavailableScreen), sits behind
  the auth guard, and nothing in the app links to it — it is reachable only by
  someone hand-typing kscan://style-chat/debug-memory. Its own header already
  says "keep it out of broad public builds or add a stronger flag".
WHY_NOT_P0_P3=It exposes nothing: the debug content is unreachable in release.
SUGGESTED_FIX=Move it behind a build-time exclusion, or accept the __DEV__ gate
  and delete the header's own caveat.
RELEASE_RECOMMENDATION=Build 35
```

```text
P4_TOTAL=4  P5_TOTAL=5  P6_TOTAL=3  P7_TOTAL=3  P8_TOTAL=1  P9_TOTAL=0  P10_TOTAL=0
```

---

## 6. Feature activation matrix (Build 34 production artifact)

| Feature | Flag | Prod | Cert | Reachable | Backend | Status |
|---|---|---|---|---|---|---|
| Auth / onboarding | ONBOARDING_FRAMEWORK_V1 | on | on | yes | yes | PASS |
| Scanner (camera + gallery) | inherited | on | on | yes | scan-identify | PASS |
| Scan Room / Results V2 | SCAN_ROOM_V2_UI, SCAN_RESULTS_V2_UI | on | on | yes | yes | PASS |
| Text Scan | ENABLE_TEXTSCAN, TEXTSCAN_BACKEND_ENABLED | on | on | yes | yes | PASS |
| Commerce / retailer results | inherited | on | on | yes | yes | PASS |
| Recent scans (cap 25) | inherited | on | on | yes | local | PASS |
| Closet | CLOSET_SEPARATION_V1 + intake chain | on | on | yes | yes | PASS |
| Signature Style | FREE (server entitlement) | on | on | yes | yes | PASS |
| Elise / Style Chat | AI_STYLIST_ENABLED (+backend) | on | on | yes | yes | PASS |
| Dressing Rooms + sharing | DRESSING_ROOM_COLLABORATION/MESSAGES/REACTIONS_V1 | on | on | yes | yes | PASS |
| Public room preview + reactions | inherited | on | on | yes | yes | PASS (repaired) |
| Private Dressing Room / Saved Looks | PRIVATE_DRESSING_ROOM_* | on | on | yes | yes | PASS |
| Free Tier utility (wishlist, outfit generator) | FREE_TIER_* | on | **off** | yes | local | PASS (repaired; see P4-02) |
| Weather styling | WEATHER_STYLING_CONTEXT_ENABLED | on | on | yes | yes | PASS |
| Today with Elise | TODAY_WITH_ELISE_V1 | **false** | on | — | — | INTENTIONALLY_DISABLED |
| K+ Early Access | KPLUS_EARLY_ACCESS_ENABLED | off | on | — | yes | INTENTIONALLY_DISABLED |
| Smart Watchlist + push | SMART_WATCHLIST_V1 | off | on | — | yes | INTENTIONALLY_DISABLED |
| Voice Scan | VOICESCAN_ENABLED + native selector | off | on | — | yes | INTENTIONALLY_DISABLED |
| VTO (still image) | VTO_UI_ENABLED + server kill switch + K+ | off | on | — | yes | INTENTIONALLY_DISABLED |
| Packing Intelligence | PACKING_INTELLIGENCE_V1 + K+ | off | on | — | yes | INTENTIONALLY_DISABLED |
| Wardrobe Concierge | ELISE_CONCIERGE_V1 + K+ | off | on | — | yes | INTENTIONALLY_DISABLED |
| Mirror Selfie | MIRROR_SELFIE_V1 | on | on | **no on Android** | — | NOT_BUILD34_SHIPPING (Android) |
| Closet cloud sync / restore / migration | CLOSET_CLOUD_SYNC_V1 etc. | off | off | — | yes | INTENTIONALLY_DISABLED |

Mirror Selfie is flag-on everywhere but composed with platform support in one
authority (`services/mirror/mirrorSelfieAvailability.ts`): its extraction runtime
`modules/kscan-pii-native` declares `"platforms": ["apple"]`, so Android resolves
unavailable regardless of the flag. That is a correct composition, not an
unreachable feature.

Every INTENTIONALLY_DISABLED row is fail-closed (`=== 'true'`), gated at every
surface and write path (Watchlist additionally via `resolveWatchlistAvailable()`
in both routes, the service layer and both product shelves), and can be activated
by profile alone after the production migration.

```text
FEATURES_DISCOVERED=23 product areas across 34 routes
FEATURES_BUILD34_SHIPPING=14
FEATURES_INTENTIONALLY_DISABLED=8
FEATURES_UNREACHABLE=0
FEATURE_ACTIVATION_STATUS=PASS
```

### Navigation reachability

All 27 non-API routes were walked. Five carry no literal `router.push` string and
each is reached another way, by design:

```text
/auth/callback            OAuth deep link; the guard has its own isAuthCallbackUrl path
/auth/update-password     password-recovery deep link; guard: isPasswordRecoveryRoute
/onboarding               guard redirect destination ('/onboarding?resume=terms')
                          plus goBackOrOnboarding() from the auth screen
/rooms/[token]            constructed by buildNativeRoomPath() in app/+native-intent.ts
/style-chat/debug-memory  deliberately unlinked; __DEV__-gated (P7-03)
```

No shipping feature exists only as an unreachable screen.

```text
NAVIGATION=PASS
```

---

## 7. Permissions

Declared in `app.json` and native-authoritative in
`android/app/src/main/AndroidManifest.xml`; parity is enforced by
`scripts/check-native-config-parity.js` (17 checks, PASS).

| Permission | Declared | Runtime request | Feature | Denial path | Status |
|---|---|---|---|---|---|
| CAMERA | yes | contextual, on Scanner entry | Scanner | in-screen "enable in settings" copy | PASS |
| INTERNET | yes | n/a | all | n/a | PASS |
| VIBRATE | yes | n/a | haptics | n/a | PASS |
| ACCESS_COARSE_LOCATION | yes | contextual, weather styling only | Weather | feature degrades, app unaffected | PASS |
| POST_NOTIFICATIONS | **removed** | none in production | Watchlist (dark) | n/a | PASS |
| RECORD_AUDIO | **removed** | none in production | Voice (dark) | n/a | PASS |
| RECEIVE_BOOT_COMPLETED | **removed everywhere** | n/a | none | n/a | PASS |
| ACCESS_FINE_LOCATION | **removed** | never | none | n/a | PASS |
| READ/WRITE_EXTERNAL_STORAGE | **removed** | never | none | n/a | PASS |
| FOREGROUND_SERVICE(+MEDIA_PLAYBACK) | **removed** | never | none | n/a | PASS |
| SYSTEM_ALERT_WINDOW | debug only, removed in release | n/a | none | n/a | PASS |

`tools:node="remove"` is used rather than mere omission, because
expo-notifications, expo-audio and expo-location each contribute their own
declarations to the merged manifest. Three library-contributed foreground
services (`AudioControlsService`, `AudioRecordingService`, `LocationTaskService`)
and the unreachable ML Kit barcode delegate activity are removed individually.

```text
ANDROID_PERMISSIONS=PASS
STORE_DISCLOSURE_IMPACT=production declares 4 permissions, all used
```

---

## 8. Release / build configuration

```text
applicationId=com.kscanai.app      versionCode=23 (EAS appVersionSource=remote)
minify(R8)=ON in release           shrinkResources=OFF (declared, unproven)
allowBackup=false                  dataExtractionRules: cloud-backup + device-transfer excluded
usesCleartextTraffic=debug manifest only; no network-security-config (platform default)
debuggableVariants=[]              newArch=true  hermes=true  edgeToEdge=true
signing=EAS-managed; no keystore committed (android/app/.gitignore)
provenance=kscan_build_profile + kscan_source_commit as resValue AND BuildConfig
deep links=kscan:// (autoVerify false) + https://kscan.app/rooms (autoVerify true)
google-services.json=never committed; plugin applied only when the EAS file
  secret materialises; a push-activated build without it fails the Gradle guard
BUILD_CONFIG_VALID=YES   RELEASE_CONFIG_VALID=YES
```

Four capability manifests (`release` / `certification` / `push` / `voicePush`)
are selected by two independent Gradle booleans; all four are declared exceptions
in `config/native-config-authority.json` and held to the same base by the parity
gate. Fail-closed guards refuse to build a certification artifact pointed at
production, a Voice-flagged build without the native grant (or vice versa), and a
push-activated build without FCM configuration.

No debug menu, test endpoint, localhost reference, mock provider or diagnostic UI
is reachable in a release build; `QA_TOOLS_ENABLED` and the `SCAN_DIAG` /
`SCAN_RESULTS_DEMO_UI` / `TEXTSCAN_DEMO_RESULTS` flags are all fail-closed and
set on no shipping profile.

```text
NO_SERVER_SECRETS_IN_CLIENT=YES
```
Only the publishable Supabase anon keys appear in `eas.json`, which is their
intended place. `GEMINI_API_KEY` is read only by `app/api/analyze+api.js` (an
Expo Router server route, excluded from the native bundle) and
`SNEAKER_DATABASE_API_KEY` only by a provider with no importer; neither is
`EXPO_PUBLIC_`-prefixed, so Expo's inliner leaves both `undefined` in the client
bundle. No service-role key, private key, webhook secret or bearer token exists
in any client path.

---

## 9. Validation

```text
FULL_SUITE=483 files
  BEFORE: 9016 tests — 8938 pass, 13 fail, 65 skipped, exit 0
  AFTER:  9046 tests — 8968 pass, 13 fail, 65 skipped, exit 0
  The 13 failures are the SAME 13 identities both times, every one of them
  already recorded in config/test-failure-baseline.json ("Observed failures: 13;
  known: 13; unexpected: 0"). The delta is exactly the +30 tests this campaign
  added, all passing. No pre-existing test was deleted, skipped, weakened or
  rewritten to match broken behaviour.
TYPECHECK=tsc --noEmit clean
NATIVE_CONFIG_PARITY=PASS (17 checks)
DEPENDENCY_REACHABILITY=PASS (no unapproved critical/high; no path drift)
MIGRATION_PROVENANCE=PASS (168 files, 3 declared logical aliases)
EDGE_FUNCTION_PARITY=PASS
SECURITY_VALIDATION=PASS (11/12; the one "failure" is a negative control the
  runner deliberately excludes — validate-zap-target.js must reject
  https://localhost/, and it does)
```

---

## 10. Cleanup

```text
PORCELAIN_AFTER=CLEAN
UNPUSHED_COMMITS=0
BACKEND_CHANGES_MADE=0
PRODUCTION_ACCESSED=NO
No temporary credentials, no local Supabase linkage, no test fixtures, no
screenshots or customer media, and no debug instrumentation were added.
```
