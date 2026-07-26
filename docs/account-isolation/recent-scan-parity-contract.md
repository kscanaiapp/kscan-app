# Recent Scan account-isolation parity contract

Governing document for Stage 1 Recent Scan account isolation across iOS and
Android. **Parity here is behavioral, not source-file identity.** Both platforms
must satisfy the shared authenticated contract and must map their verification
results to the mirrored scenario names below.

| | |
|---|---|
| iOS implementation branch | `fix/ios-v18-account-isolation-parity` (from `4c3fede…`) |
| Android verified baseline | `integration/android-v27-closet-release-candidate` @ `913fb098975edbdabac3ce3019532b21f87b4d1a` |

## 1. Shared authenticated contract

Both platforms must provide all of the following for authenticated actors.

**Owner-authoritative saves.** A UI caller may never choose an `ownerId`. The
persistence layer receives a validated actor context and derives ownership from
it. Authenticated context + matching actor is allowed; authenticated context +
`ownerId: null` is rejected; authenticated context + another user's id is
rejected; a stale context is rejected. On iOS this is
`services/actorContext.resolveWriteAuthority`.

**Actor-filtered reads.** `loadLibrary(actorId)` returns only records visible to
that actor. `undefined` means unfiltered and is reserved for internal
complete-manifest reads. `null` is the signed-out projection. Every direct
consumer of the library service applies the filter — no consumer may read
unfiltered.

**Actor-filtered updates and deletes.** A delete requires BOTH the record id and
the actor to match. An unscoped delete fails closed.

**Per-actor retention.** Each partition — every authenticated actor plus the
ownerless partition — has its own independent maximum of 25 records. Eviction
operates only within the saving actor's partition. Authenticated retention
arithmetic excludes ownerless records.

**Actor-epoch race rejection.** Every asynchronous operation that can commit
Recent Scan state captures `actorId` + `actorEpoch` + `requestId`, and all three
must still be valid before it commits. A captured `userId` alone is insufficient:
A → signed out → A restores the same id, so the epoch is what rejects the stale
request. The epoch advances on every authentication transition (A→B, A→signed
out, signed out→A, A→signed out→A, session invalidation and restoration).

A stale result must not update React state, merge into the local manifest, write
or alter media references, change attachment metadata, trigger eviction, restore
selected-scan state, or repopulate caches — including from a late `catch` or
`finally`.

**Media collision safety.** Media identity is separate from record identity. The
legacy `scan_<Date.now()>_<4-digit random>` record id is not collision resistant
enough to double as a writable path. iOS mints a distinct `m_<base36 time>_<counter>_<64 bits random>`
media asset id and creation is **no-overwrite**: if the destination already
exists — including a deliberately injected collision — a fresh identity is minted
rather than clobbering a file another actor's record may reference.

**Reference-aware media deletion.** Before unlinking, load the complete
normalized manifest, canonicalize comparable URI forms (`file://` prefix,
separators, case), remove the target from the logical post-mutation manifest, and
unlink only when **zero** surviving records across **all** partitions still
reference the path. Never decide from the current actor's visible list. Stage 1
introduces no media-reference database.

**Account-deletion cleanup.** Capture the deleting account's owner id before
remote deletion; after confirmed remote success pass it explicitly to local
cleanup. Delete only records owned by that captured id, preserve ownerless
records and every other actor's records, and use reference-aware media cleanup.
Cleanup is actor-scoped, idempotent, retry-safe, and truthful about partial
failure. A blank or missing captured owner fails closed and never purges the
ownerless partition.

**Immediate state clearing on actor transition.** Clear the visible projection,
close/invalidate selected-scan detail, clear selected image and pending scan
state, advance the epoch, then load the new actor's snapshot, rendering an empty
or loading projection until validation completes.

## 2. Intentional anonymous divergence

This divergence is deliberate and owner-ruled. It is **not** a parity defect.

**iOS** — durable ownerless local saving remains enabled. A signed-out user's
scans persist to the ownerless partition.

**Android** — unauthenticated scans are not durably saved. `persistScanItem`
returns early when there is no actor.

**Shared rule, both platforms** — ownerless records are visible only while signed
out; they are never claimed, uploaded, evicted, mutated or deleted by an
authenticated actor.

Deferred (not Stage 1): unifying anonymous behavior, and any marker
distinguishing a new anonymous scan from a historical ownerless record. Today
both are simply `ownerId == null` on both platforms.

## 3. Mirrored adversarial scenarios

Both platform reports map their tests and results to these exact names.

| # | Scenario | Asserts |
|---|---|---|
| 1 | `AUTH-A-TO-B-VISIBILITY` | An actor sees only its own records; ownerless hidden from all authenticated actors |
| 2 | `AUTH-BOOLEAN-REMAINS-TRUE` | Filtering keys on actor identity, not an `isAuthenticated` flag that stays true across A→B |
| 3 | `SAME-USER-NEW-EPOCH` | A → signed out → A rejects the pre-transition request despite a matching id |
| 4 | `STALE-CLOUD-HYDRATION` | Write authority rejects stale, mismatched and downgraded owners |
| 5 | `STALE-SCAN-ORPHAN-CLEANUP` | Rejected save creates no record and leaves no orphan media; pre-existing/shared media survives |
| 6 | `SAME-ID-CROSS-ACTOR` | Same record id under two owners stays independently addressable for read, delete and retention |
| 7 | `SHARED-MEDIA-REFERENCE` | A file referenced by another actor is never unlinked; last reference removal does unlink |
| 8 | `PER-PARTITION-RETENTION` | 25 A + 25 B + 25 ownerless; adding to one evicts only that partition's oldest |
| 9 | `DETAIL-OPEN-ACTOR-SWITCH` | Detail surface stops exposing the previous actor immediately; no crash, no stale reopen |
| 10 | `ACCOUNT-DELETION-CAPTURED-OWNER` | Purge removes only the captured owner; idempotent; blank owner fails closed |

## 4. Deferred hardening

`DEFERRED HARDENING — ATOMIC LOCAL LIBRARY WRITES`. The manifest write is a
direct `writeAsStringAsync` on both platforms; an interrupted write can still
truncate it. Stage 1 must not worsen this: no new independent direct-write path,
no bypass of the serialized mutation queue, no parallel write that can race the
existing persistence path. Every Stage 1 persistence operation goes through
`enqueueLibraryMutation`.

Also deferred: global manifest schema envelope, general media-library redesign
beyond collision and deletion safety, broad account-deletion redesign.
