# Build 34 — Cross-Platform Shared Client Repair & Convergence

Narrow shared-code repair. Not a hostile audit: the defects were already found
and reproduced by the Build 34 Android hostile audit, the Android
identity/deletion closure campaign, and the iOS Build 34 replay. This campaign
converges the shared fixes once so the two platforms cannot drift, and returns
platform-specific work to the submission agents.

```text
CROSS_PLATFORM_SHARED_CLOSURE=PASS

ANDROID_INPUT_SHA=a49203c29988f2838f75ebfe5f6dea74e9370801   EXISTS=YES
IOS_INPUT_SHA=39bf3d2a1750f50ba8b72140a34cdaf27a21b1a7       EXISTS=YES
SHARED_REPAIR_BASE=a49203c29988f2838f75ebfe5f6dea74e9370801
MERGE_BASE(A,I)=3603b3100c14d8ca8039d42d4463171da9c49fe5
```

## 1. Source authority

Both repaired candidate SHAs were fetched and proved to exist as immutable
commit objects. Nothing was substituted.

A note that matters for anyone reading this in the repository: `origin/master`
is an **unrelated history** — a different root commit (`d1bb36ec`, 89 commits)
with no merge base against either candidate. It is not the Build 34 line and
was not used. The Build 34 lineage is `release/kscan-pre-freeze-v1` (Android)
and `release/ios-build34-testflight-staging-v2` (iOS), which share
`3603b310` as their merge base.

```text
android ahead of merge base: 320 commits
ios     ahead of merge base:   6 commits
```

The iOS candidate is the frozen TestFlight-staging authority
(`eb41b1f8`) plus four repairs: two shared (free-tier partitioning, the
Dressing Room share token) and two iOS-only (modal backdrop hit-testing, a
denied camera unmounting the Scanner). The Android candidate carries the same
two shared repairs **and** the whole terminal-deletion stack, so it is a strict
superset of the shared line and is the repair base.

## 2. Shared-file diff

Six files were changed on both sides relative to the merge base.

| FILE | SAME_IMPLEMENTATION | SEMANTICALLY_EQUIVALENT | CONVERGENCE_REQUIRED |
|---|---|---|---|
| `services/free-tier/freeTierStorage.ts` | NO | **NO** | **YES** |
| `services/styleObjects.ts` | NO | NO (iOS also reverts an owner filter) | YES (narrow) |
| `app/(public)/rooms/[token].tsx` | NO | YES | NO |
| `components/dressing-rooms/RoomItemDetailModal.tsx` | NO | NO | NO — iOS-only |
| `app.js` | NO | NO | NO — iOS-only / out of scope |
| `eas.json` | NO | NO | NO — build config |

`RoomItemDetailModal.tsx`, `app.js` and `eas.json` diverge only because of the
two iOS-only repairs and the EAS profile. They are §20 platform boundary and are
handed back, not merged.

`app/(public)/rooms/[token].tsx`: both sides forward the route token at both
call sites. The Android version additionally adds `normalizedRouteToken` to the
effect dependency array, so it is a superset; nothing to converge.

`services/styleObjects.ts`: the iOS candidate is missing the owner filter on
`listDressingRooms` (`.eq('user_id', ownerId)`) because it predates that repair.
That filter is **kept**; taking the iOS side would have reintroduced a
recipient's shared rooms into the owned grid.

## 3. B34-FE-FT-001 — converged

The two candidates fixed this independently and did not agree.

```text
B34_FE_FT_001_ANDROID_IMPLEMENTATION=
  `<base>::<actorId>`, dedicated `anonymous` partition, legacy ADOPTION on
  first authenticated read, envelope-stamp cross-check, explicit owner wins
  over the live actor, owner pinned across read-modify-write.
  clearAllFreeTierStores() = device-wide.

B34_FE_FT_001_IOS_IMPLEMENTATION=
  `<base>::u:<actorId>`, the BARE key doubles as the signed-out partition, no
  adoption, no stamp comparison, partition NEVER taken from a caller-supplied
  id, actor authority failure falls closed.
  clearAllFreeTierStores(actorId) = owner-scoped.

FINAL_CONVERGED_IMPLEMENTATION=
  Android's key shape and both of its independent checks, plus adoption and
  RMW owner pinning; iOS's fail-closed actor authority; and a new owner
  resolution that refuses rather than guesses.
```

Why each choice, where they conflicted:

- **Dedicated anonymous partition (Android).** iOS makes the bare legacy key the
  signed-out partition, so a signed-out reader is handed pre-upgrade data that
  may belong to a real account. Android keeps `anonymous` separate and never lets
  it adopt.
- **Legacy adoption (Android).** iOS orphans every existing user's wardrobe notes
  on upgrade — §12 requires an existing authenticated user not lose valid owned
  state. Adoption is once-only because removing the legacy key *is* the guard.
- **Explicit owner honoured (Android).** `freeTierSupabaseSync` captures the id
  it is syncing for and writes after an await that can outlive the session. iOS
  ignores that id for the partition, so a late response for A writes into B —
  the §14 contamination the campaign asks to prevent.
- **RMW owner pinning (Android).** iOS's `updateStore` resolves the actor
  separately for its read and its write, so a switch landing between them
  commits A's rows into B.
- **Fail-closed authority (iOS).** Android assumes `currentActorId()` cannot
  throw. "Cannot answer" must never read as "signed out", so it is wrapped.

New in the converged version: owner ids are validated rather than repaired. A
non-string, a blank string, the literal `anonymous`, or an id containing the
namespace separator is refused. And an owner that is *supplied but unusable*
refuses the operation instead of falling through to the live actor — the
fall-through would guess precisely the actor whose partition must not receive
another account's rows. An **absent** id (undefined/null) still means "this call
site does not name an owner" and uses the live actor, which is every UI path.

```text
FREE_TIER_STORAGE_CONVERGED=PASS
```

Covered stores (all ten): wishlist intent, style boards (saved outfits),
collections, care notes, wear tracking, brand sizing, outfit feedback (ratings),
activity log, utility meta, sync queue.

## 4. CPR-FT-001 — terminal owner-scoped purge

```text
CPR_FT_001_FINAL_SEVERITY=P3   (unchanged; impact is erasure, not exposure)
```

`services/deletion/ownerTerminalPurge.ts` listed the free-tier stores under
"DELIBERATELY NOT PURGED HERE — device-scoped state … none of these is filed
under an owner". That was true when written. B34-FE-FT-001 made all ten
owner-filed and did not revisit it, so the classification outlived the fact it
described and terminal deletion left the deleted actor's namespace on the
device. Invisible to the next account, but not erased.

`clearFreeTierStoresForActor(actorId)` closes it, with the §6 properties:

| Required property | How |
|---|---|
| requires explicit actor identity | no default argument; blank/unusable id returns `ok:false`, removes nothing |
| cannot default to ambient actor | the function never calls the actor authority at all |
| cannot clear another actor | names `<logical key>::<actorId>` only |
| cannot clear all actors | no `getAllKeys`, no prefix sweep, no `clear()`, no wildcard |
| safe if stores are missing | removing an absent key is a no-op |
| idempotent | repeat runs and unknown actors both succeed |
| tolerant of partial cleanup | a half-cleaned namespace completes normally |
| suitable for purge sequencing | returns `{ok}` for `runStep` |

A blank owner is refused specifically because it would address the `anonymous`
partition, which is device-local history no account deletion may take. The
pre-namespace legacy key is also left alone: an unstamped blob cannot be shown
to belong to the account being deleted.

**Ordering is inherited, not re-implemented.** The step is wired into
`purgeOwnerScopedLocalData`, whose only caller is `terminalDeletionReconciler`,
which already runs a purge only on `decision.action === 'purge'` and destroys
the marker last. Pending, restored, released, transient-error, unauthorized and
non-terminal lifecycles never reach any purge primitive.

```text
FREE_TIER_TERMINAL_PURGE=PASS
ACCOUNT_DELETION_LOCAL_CLEANUP=PASS
```

## 5. P5-C2 — read-fault severity review

The audit recorded this P5 and asked that it not be taken on trust. It should
not have been.

```text
READ_FAULT_BEHAVIOR=
  `readStore` wrapped the ENTIRE read in one `try`. Its `catch` called
  removeItem() before returning the fallback, so any throw deleted the store —
  including a throw from AsyncStorage.getItem() itself.

TRANSIENT_ERROR_DELETES_VALID_DATA=YES
SEVERITY_FINAL=P2   (promoted from P5)
REPAIR_REQUIRED=YES
```

`RATIONALE=` The comment on that `catch` describes case A — corrupt or
version-mismatched payload, where resetting is the only way forward and nothing
of value is lost. The code also caught case B: the native read failing while the
payload is valid and untouched. On Android that store is SQLite-backed, and a
read fails transiently under a locked database, disk pressure, or a CursorWindow
too small for a large row. In case B the client deleted the user's valid data —
silently, permanently, and, because the CursorWindow mode is size-correlated,
preferentially for the users with the most of it. Three of the ten stores (style
boards, utility meta, sync queue) have no Supabase mirror, so for those there is
no recovery; erasing the sync queue additionally discards writes that had not yet
reached the server, so data that *would* have become recoverable never does.

P5 was argued from "pre-existing, and needs a fault to trigger". Impact-based
severity does not work that way. Unrecoverable destruction of user-authored
content on an ordinary recoverable condition is P2.

The read is now split. A failed `getItem` returns the fallback and removes
**nothing**. Only a blob read successfully and then proved unusable is cleared.
A blob stamped for a different actor is refused *without* being deleted —
invisibility is the requirement; destroying another actor's misfiled row is the
same class of mistake as the leak itself. Legacy adoption gets the same
treatment: a fault during the migration read leaves the legacy blob in place for
the retry.

```text
STORAGE_READ_FAULT_SAFETY=PASS
```

## 6. B34-FE-DR-001 — converged

Both candidates reached the same call shape: forward the visitor's route token
as `p_share_token`, omit the key entirely when there is no token so the
owner/member call shape is byte-identical to what shipped. No convergence was
needed on the mechanism.

Two deltas were decided:

**iOS's PGRST202 fallback is NOT carried.** Migration `20260916233708`
(`reaction_counts_bind_anonymous_share_token`) DROPPED the single-argument
overload, and the Android audit read the deployed definition back from staging
with `pg_get_functiondef` — the two-argument form is the only one that exists.
So the fallback is unreachable. It also cannot help: on any backend where it
*did* fire, the token-less call is precisely the pre-repair call, which
authorizes an anonymous viewer nothing and returns zero rows. It therefore
cannot weaken the contract, but it adds a second unexercised call shape to a
security-relevant path, and a missing overload is a deployment fault that should
surface as the error it is. §8 asks that a compatibility fallback be proven
unable to weaken security; the proof holds, and it is still not worth carrying.

**iOS's stricter token normalization IS carried.** The Android version used
`String(options?.shareToken ?? '').trim()`, which coerces a non-string into a
token-shaped value that the backend then compares against
`room_shares.share_token` — turning a caller bug into a silent authorization
attempt. The token is now accepted only as a non-blank string.

Blank or missing token omits the parameter, so the backend's anonymous branch
fails its `token is not null` guard and grants nothing. Wrong, revoked and
expired tokens remain the server's decision; no client path weakens it.

```text
B34_FE_DR_001_CONVERGED=PASS
DRESSING_ROOM_SHARE_TOKEN_CONVERGED=PASS
```

## 7. Regression gates

```text
CROSS_ACCOUNT_DATA_ISOLATION=PASS
CROSS_ACCOUNT_ENTITLEMENT_ISOLATION=PASS
CROSS_ACCOUNT_ANALYTICS_ISOLATION=PASS (Android) / NOT_APPLICABLE_ON_IOS
CROSS_ACCOUNT_NOTIFICATION_ISOLATION=PASS
DELETE_RELAUNCH_CROSS_USER=PASS
COLD_START_ACCOUNT_ISOLATION=PASS
UNRESOLVED_READ_USES_SAFE_PARTITION=PASS
EXISTING_USER_UPGRADE_STATUS=PASS
LATE_A_READ_DOES_NOT_CONTAMINATE_B=PASS
LATE_A_WRITE_DOES_NOT_CONTAMINATE_B=PASS
RMW_PRESERVES_ORIGINAL_ACTOR=PASS
PENDING_RETAINS_LOCAL_DATA=PASS
RESTORED_RETAINS_LOCAL_DATA=PASS
TRANSIENT_ERROR_RETAINS_LOCAL_DATA=PASS
WRONG_ACTOR_NOT_PURGED=PASS
UNAUTHORIZED_PURGE_BLOCKED=PASS
SHARED_KPLUS_ACTOR_ISOLATION=PASS
SHARED_NOTIFICATION_ACCOUNT_LIFECYCLE=PASS
POSTHOG_SHARED_LIFECYCLE_COMPATIBLE=PASS
```

Delete → relaunch → B is asserted over a genuinely fresh module graph on the
same simulated disk, and additionally asserts no physical key naming the deleted
actor survives — not merely that reads return the fallback.

```text
POSTHOG_ANDROID_PRESENT=YES  (posthog-react-native ^4.67.0)
POSTHOG_IOS_PRESENT=NO       (no dependency, no analytics modules on that line)
```

`syncPostHogIdentityWith(client, userId)` returns immediately on a null client,
so the absence of the SDK is a no-op rather than a branch. No analytics redesign,
and PostHog was not added to iOS. No RevenueCat client SDK exists on either
candidate and none was added.

## 8. Cold start — recorded debt, not repaired

The storage boundary is sound: a read taken before auth resolves uses the
`anonymous` partition, adopts nothing, and neither account inherits an
unresolved-window write.

What is *not* guaranteed by design is the re-read. The free-tier hooks
(`useWishlistIntent`, `useOutfitCollections`, and siblings) load once with
`useEffect(…, [])` and never re-read on an actor change. In practice every
actor transition passes through the root auth gate's `router.replace`, which
unmounts those surfaces, so they remount and read the arriving actor's
partition. Safety therefore rests on mount order rather than on the store.

Impact is bounded and below P3: every **write** resolves the live actor, so no
A data can be written into B's partition, and any residue would be stale
read-only display that cannot persist. §13 says to document this as debt rather
than redesign absent P0–P3 impact, and that is what is done here.
`services/actorScope.ts` already exports `currentActorScopeKey()`, which is the
reset key those hooks would use; it currently has no consumer.

```text
DEBT=free-tier hooks do not re-read on actor change; isolation does not depend
     on it, cold-start freshness does.
```

## 9. Platform boundary and handoffs

```text
ANDROID_SUBMISSION_AGENT_REQUIRED_COUNT=0
IOS_SUBMISSION_AGENT_REQUIRED_COUNT=3
BACKEND_REVIEW_REQUIRED_COUNT=0 new
```

`IOS_HANDOFF=`

1. **`abd810ca` — modal backdrops hide the controls inside them.** iOS-only
   repair in `components/dressing-rooms/RoomItemDetailModal.tsx`. Outside the
   four campaign targets; not merged here.
2. **`c33e24ab` — a denied camera deletes the whole Scanner screen.** iOS-only,
   and camera is explicitly out of scope by §1.
3. **The deletion stack does not exist on the frozen iOS line.** Verified by
   attempting the port: `services/deletion/` has **zero** files at
   `39bf3d2a`, so `ownerTerminalPurge.ts` and the two purge harnesses conflict
   modify/delete on a cherry-pick. CPR-FT-001's wiring has no host there. This
   is a release-sequencing constraint, not a code defect — see §10.

The converged `freeTierStorage.ts` itself **is** drop-in portable to the iOS
line: its entire dependency surface (`services/actorScope.ts`,
`services/actorContext.js`, `services/free-tier/wardrobeUtilityTypes.ts`) is
byte-identical at both SHAs.

`BACKEND_REVIEW_LEDGER=` no new entries. B34-BE-CON-002 from the prior campaign
remains open and unchanged and is untouched by this work.

```text
BACKEND_CHANGES_MADE=0
PRODUCTION_ACCESSED=NO
PRODUCTION_CHANGED=NO
```

No migration, schema, RLS, RPC, Edge Function, redeploy, flag or secret was
touched. The diff is six files: three shared client modules and three test
files. No `supabase/`, no `android/`, no `ios/`, no manifest, no Gradle, no
entitlement, no `eas.json`, no `app.json`, no `app.js`.

## 10. Recommended merge order

Owner controls the merge. Nothing here is merged by this campaign.

This branch is **stacked on PR #439's head** (`claude/clever-hopper-2jx4gw` @
`a49203c2`), so its PR targets that branch and its diff is exactly the six
converged files. The sequence that follows from that and from §9.3:

1. **This PR into `claude/clever-hopper-2jx4gw` first.** It replaces #439's
   free-tier variant with the converged one in place, so #439 goes to the
   release branch already carrying it rather than having to be re-reviewed
   afterwards.
2. **PR #439 into `release/kscan-pre-freeze-v1` second.** Re-run the
   identity/deletion closure harness after the merge; it is the suite that
   would notice a bad resolution. Note #439's body still describes its own
   free-tier implementation — that description is superseded by this
   convergence, and the PR body should be updated before it merges.
3. **PR #440 (iOS) last, and NOT by cherry-picking this branch.** Take
   `services/free-tier/freeTierStorage.ts` wholesale (it is drop-in portable),
   and take the `getItemReactionCounts` normalization. Do **not** attempt the
   `ownerTerminalPurge` wiring on that line — there is nothing to wire it into.
   Doing this also retires the upgrade-visible data loss #440 currently declares
   as unavoidable ("an existing user who set shopping intents while signed in
   will no longer see them"): the converged module adopts pre-partition data
   into the first authenticated reader's namespace, so that loss does not occur.
4. **Decide explicitly whether Build 34 iOS ships terminal free-tier purge.**
   It cannot, on the frozen line, without also taking the Android/shared Build
   34 deletion stack — which would also bring `posthog-react-native` and the
   analytics modules onto an iOS build that deliberately has neither. That is a
   release-scope decision for the owner, not a repair. If iOS ships without it,
   CPR-FT-001 remains open **on iOS only**, at P3, and should be recorded as
   such rather than reported closed cross-platform.

## 11. Tests

```text
TESTS_BEFORE=9070 (8992 pass, 13 fail, 65 skipped, exit 0) — at ANDROID_INPUT_SHA
TESTS_AFTER=9096  (9018 pass, 13 fail, 65 skipped, exit 0)
KNOWN_BASELINE_FAILURES=13
NEW_UNEXPECTED_FAILURES=0
```

The 13 failing identities are byte-identical between the two runs (diffed, not
eyeballed). The delta is exactly the +26 tests this campaign adds. No test was
deleted, skipped, weakened or rewritten; the only edits to existing tests are
two exact-count assertions moved 16 → 17 and one purge-harness allowlist entry,
all because a seventeenth owner-scoped subsystem now exists.

`__tests__/build34SharedClientConvergence.test.js` asserts against the real
module graph, and closes the two places the existing closure suite stopped one
step short — it asserted a deleted namespace was *unreadable* and that a read
fault *resolved*, never that the namespace was gone or that the data survived.

It ends with four mutants, each reintroducing one pre-repair behaviour into the
real source and asserting the matching invariant fails: the device-global key,
the uncompared envelope stamp, delete-on-read-fault, and a terminal purge with
no free-tier step. Writing them produced a result worth recording: **flattening
the key alone does not reopen the leak** — the envelope-stamp check catches A's
blob under the shared key and refuses it — so the mutant has to defeat both
layers. The "two independent checks" claim is load-bearing, and there is now a
test asserting the namespace holds the boundary alone with the stamp check
removed.

## 12. Verdict

```text
P0_FOUND=0   P1_FOUND=0   P2_FOUND=1 (P5-C2, promoted)   P3_FOUND=1 (CPR-FT-001)
P0_OPEN_SHARED=0   P1_OPEN_SHARED=0   P2_OPEN_SHARED=0   P3_OPEN_SHARED=0

CROSS_PLATFORM_SHARED_CLOSURE=PASS
```

Both P2 and P3 are repaired in this branch with regression coverage and mutants.
The one caveat that is not a shared defect: per §10.4, CPR-FT-001 cannot be
closed on the frozen iOS line without a release-scope decision.
