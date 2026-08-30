# Build 34 — Track B — Phase B2C: Closet Cross-Device Restore

**Status:** SOURCE COMPLETE — STAGING VALIDATED — iOS TRACK B END-TO-END PRIVACY BLOCKED ON B2A's NATIVE/DEVICE GATE
**Scope:** INBOUND ONLY. Remote discovery, reconciliation, and private media hydration into the existing local Closet. No conflict UI, no historical (pre-B2B) migration, no Style DNA, no Elise.

---

## 1. Source authority

| | iOS | Android |
|---|---|---|
| B2C parent branch | `integration/ios-build34-kplus-foundation-v1` | `integration/android-build34-kplus-foundation-v1` |
| B2C parent SHA (live-verified) | `5d7665ee83e44a117221c56d190ee666c3de9db6` | `6273b787ed1aebae6652c9796e1543a7159aebbe` |
| B2C branch | `feature/ios-build34-closet-cross-device-restore-v1` | `feature/android-build34-closet-cross-device-restore-v1` |

Backend authority: `maintenance/b34-def001-backend-authority` @ `ca2d781fb051055408b29c28970b2681414741ae`, live-verified identical to the expected authority. **No backend branch was created or needed** — B2C is a pure client that consumes B1A/B1C's existing schema and RLS through the ordinary authenticated Supabase client; it introduces no migration, no RPC, no Storage policy change.

All three parent SHAs matched the phase's expected authorities exactly (`git fetch --all --prune` + `git ls-remote` before branching).

---

## 2. What was built

| File | Role |
|---|---|
| `services/closet/closetRestoreContract.ts` | Pure module: the reconciliation matrix as one classifier, storage-path validation, schema-version handling, dirty-state determination, cache-invalidation rule, keyset-pagination helpers, anti-churn cooldown |
| `services/closet/closetRestoreMedia.ts` | Private media download: signed URL → temp file → verified move into an account-scoped local cache, never touching the original local Closet media roots |
| `services/closet/closetRestoreEngine.ts` | Orchestrator: flag + K+ gate, single-flight, cooldown, paginated discovery loop, per-row reconciliation, bounded-concurrency media hydration, stale-completion guards |
| `services/closetLibrary.js` (extended) | Three new functions used ONLY by the restore engine: `materializeRestoredClosetItem`, `applyRestoredClosetItemFacts`, `applyRestoredClosetItemMedia` — all inside the existing mutation queue |
| `services/closet/closetSyncContract.ts` (extended) | `ClosetSyncEntry` gains two fields: `conflictKind` and `cachedMediaUploadedAt` |
| `services/closet/closetSyncStore.ts` (extended) | `coerceEntry` parses/validates the two new fields on read |
| `constants/featureFlags.ts` (extended) | `CLOSET_CROSS_DEVICE_RESTORE_V1` — the one B2C kill switch, default OFF |
| `services/closetTelemetry.ts` (extended) | 6 restore events added to the existing allowlisted, content-free sink |
| `hooks/useCloset.js` (extended) | Wiring only: fires the restore trigger on Closet focus, re-reads the local Closet when a pass actually changed something |

**No backend file, migration, Storage policy, entitlement, Voice, or Scanner file was touched.** `services/closetLibrary.js`'s existing exports are all unmodified — only three new, narrowly-scoped functions were added.

---

## 3. The reconciliation matrix, as implemented

`closetRestoreContract.ts#classifyClosetRestoreAction` is the single pure function every reconciliation decision routes through:

| Local | Remote | Action |
|---|---|---|
| absent, no sidecar entry | live | `materialize` |
| absent, entry present (serverId confirmed) | live | `materialize` (restart recovery) |
| absent, entry present | tombstoned | `clear_stale_entry` (goal already met) |
| absent, no entry | tombstoned | `skip_goal_already_met` |
| present, **no sidecar entry** | anything | `skip_no_relationship` (PRE-B2B rule, Addendum B) |
| present, entry `pending_delete` | anything | `skip_pending_delete` (never resurrect) |
| present, entry has no `serverId` | anything | `skip_outbound_in_progress` (B2B's own crash-recovery window — see §5) |
| clean, same row_version | unchanged | `noop` |
| clean | newer row_version | `remote_wins` (facts overwrite local) |
| clean | tombstoned | `remote_delete_wins` (local hard delete) |
| dirty | unchanged | `local_outbound_authoritative` (noop for B2C — B2B pushes it) |
| dirty | newer row_version | `conflict_remote_newer` (evidence recorded, nothing overwritten) |
| dirty | tombstoned | `conflict_remote_tombstone` (evidence recorded, nothing deleted) |

"Dirty" (`classifyClosetLocalDirtiness`) is `entry.state === 'pending_delete'` OR `localUpdatedAt !== entry.syncedLocalUpdatedAt` — deliberately NOT `lastFailureClass === 'error'` alone, so a media-only retry failure never blocks a safe facts reconciliation (Addendum H).

---

## 4. Restore triggers, remote discovery, pagination

- **Trigger:** Closet screen gains focus (`hooks/useCloset.js`'s existing `useFocusEffect`), which is the same mechanism B2B's own "app foreground while Closet is visible" claim rests on. No AppState listener, no background scheduler, no periodic polling.
- **Anti-churn cooldown:** 30s in-memory, keyed by actor id (module-scope `lastRestoreAttempt`). A different actor id always elapses immediately; app restart resets it implicitly (never persisted). No pull-to-refresh exists on the Closet screen to wire a bypass to, so none was added.
- **Query:** ordinary authenticated `user_closet_items` select, **no `deleted_at IS NULL` filter** — B1A's SELECT RLS policy has no such predicate, so tombstones are visible by construction. Ordered `updated_at asc, id asc`, page size 20, keyset-paginated via `.or('updated_at.gt.X,and(updated_at.eq.X,id.gt.Y)')` — proven correct on staging even for two rows sharing an identical `updated_at` (the `id` tiebreaker resolved it exactly once, no skip, no duplicate).
- **K+ gate:** evaluated fresh at pass start AND before starting each new page — a lapse mid-pass stops new work but never rolls back what already landed (section 38).

---

## 5. The B2B/B2C boundary: outbound-in-progress

An item whose sidecar entry has `serverId: null` is B2B's own crash-recovery window (`closetFactsSync.ts#findCloudClosetItemByClientId`) — it means this device attempted an outbound write whose result it never confirmed. B2C **must not** touch it: recording it as a conflict would set `lastFailureClass: 'conflict'`, which `closetSyncContract.ts#needsSyncWork` treats as "wait for B2C" — silently freezing the very outbound retry that would otherwise resolve it cleanly on its next pass. `classifyClosetRestoreAction` returns `skip_outbound_in_progress` for this case, proven by a dedicated test.

---

## 6. Facts before media

New-device materialization writes ONLY facts first (`imageUri`/`thumbnailUri: null`); media hydration is a separate, later step over a worklist the facts pass builds as it goes. A media download failure, an invalid path, or a K+ lapse mid-hydration never touches the item's facts.

**Media eligibility** (`isClosetRestoreMediaEligible`): `media_status === 'ready'` AND the row's `storage_path` is byte-for-byte the deterministic path this user+item id derive (`buildClosetPrimaryPath`, reused from B2B's own contract — never re-implemented). A mismatch fails closed for media only; a forged path is never handed to the downloader (proven on staging: the derived path for a real committed item matched exactly, and a fabricated cross-user path is rejected by the same pure function unit-level).

**Cache identity:** durable bucket+path, never a signed URL. The local cache lives at `kscan_closet/remote-cache/{ownerId}/{serverItemId}-{primary|thumb}.jpg` — a namespace disjoint from `kscan_closet/images/` and `kscan_closet/thumbnails/` (the user's own captures), so it is never mistaken for a user-originated original and the existing committed-media orphan sweep never enumerates it (deliberately: its lifecycle is authoritative-reason-only, per §35, not TTL/LRU).

**Cache invalidation:** the only signal that can distinguish "unchanged" from "replaced" at an otherwise-invariant path is `media_uploaded_at`. One new sidecar field, `cachedMediaUploadedAt`, records what this device's cache was populated from; a repeat pass with an unchanged value never redownloads.

**Cache cleanup:** a replacement downloads to a temp file, verifies it landed, and only then retires the old file — never the reverse order. A local hard delete already retires the cache file for free, because `deleteClosetItem`'s existing `unlinkUnreferencedMedia` call treats a remote-cache path exactly like any other referenced media path (proven by test — no B2C-specific delete code was needed for this case). Account-scoped full purge (`purgeClosetRestoreMediaCacheForOwner`) exists as an available primitive for a future account-deletion completion worker, deliberately **left unwired** — matching the exact precedent `closetLibrary.js#purgeLocalClosetForOwner` and `closetSyncStore.ts#purgeClosetSyncStateForOwner` already set (both also unwired at submission, matching the Recent Scan pattern of waiting for confirmed server-side purge). Ordinary logout/account-switch relies on the same **structural** per-owner-directory isolation the B2B sidecar itself relies on — no eager wipe, matching precedent.

---

## 7. Defects found and repaired during B2C

### Repair — a test-harness gap in an inherited B2B/intake test file (not a B2B defect)

`__tests__/closetIntakeStateIntegrity.test.js` loads the real `hooks/useCloset.js` through a hand-built require map that pre-dates B2C. Adding the new `closetRestoreEngine` import to the hook made every focus-triggering test in that file throw (`resumeClosetRestore is not a function`) because the map had no entry for it and fell through to an empty stub object. Repaired by adding the same inert, observable-only stub the file already uses for `closetSyncCoordinator`. **Not a B2B or B2C production defect** — the production `hooks/useCloset.js` code is correct; only the test file's fixed require map needed to learn about the new dependency. Fixed identically on both platforms.

### No inherited B1/B2 production defects found

The schema/RLS/media-path contract was re-verified byte-for-byte against the current live backend authority (§9) and found unchanged from what B2B's own ledger recorded. No narrow inherited repair was required.

---

## 8. Deliberate boundaries

- **Not a second sync engine.** All durable state lives in B2B's existing sidecar (`kscan_closet/kscan_closet_sync.json`), extended by exactly two fields. No `closet_restore.json`, no second mutation queue, no second durable vocabulary.
- **Not a migration tool.** A local item with no B2B sidecar relationship is left untouched, unconditionally (the PRE-B2B rule) — B3 owns systematic historical adoption.
- **Conflicts are recorded, never resolved.** `conflictKind` distinguishes the two inbound shapes (`remote_newer_local_dirty`, `remote_tombstone_local_dirty`) as one small flat optional field alongside the existing `conflictExpectedRowVersion` — no conflict history, no second conflict store, no UI.
- **No background scheduler, no AppState listener.** Restore runs only when the Closet screen gains focus.
- **Media concurrency is 2**, not B2B's 1 — a download has no comparable decode/mask/re-encode memory cost to a sanitizer pass, so a slightly higher bound was chosen without inventing a new concurrency regime.

---

## 9. Staging validation (project `yzqjvdfgefveprobvvyw`)

Schema/RLS preflight: `user_closet_items` has all 24 columns, RLS enabled with the same 3 K+-gated policies and no DELETE policy, matching the B1A/B1C migrations byte-for-byte — zero drift since B2B's own preflight.

A real cross-device scenario was run as genuinely authenticated fixture users (`set local role authenticated` + `request.jwt.claims`, so actual RLS applied):

| Case | Result |
|---|---|
| "Device A" facts + media populated via the real INSERT/UPDATE RLS path (not service-role bypass) | 3 rows created: one live+media-ready, one live+media-pending, one tombstoned; `row_version` advanced correctly on each write |
| "Device B" discovery query (page size 2, no `deleted_at` filter) | Page 1 returned the pending item and the tombstoned item (both sharing an identical `updated_at` to the microsecond); page 2, using the exact `.or()` keyset filter the engine builds, returned exactly the remaining item — no skip, no duplicate |
| Derived media path for the real ready item | Matched `buildClosetPrimaryPath(userId, serverId)` exactly, character for character |
| Cross-account isolation | As the second fixture user: only that user's own row was visible; as the first user: the second user's row never appeared |
| Non-K+ fixture user | 0 rows visible via the same SELECT, even though rows exist in the table |
| Fixture cleanup | 0 Closet rows, 0 entitlement rows, 0 fixture auth users remaining after teardown |

**Production (`wyyuqfdxucjksghsmhry`) was never contacted.**

Not run in this environment (no device/simulator): an actual on-device `createSignedUrl` + `FileSystem.downloadAsync` round trip. The signed-URL primitive is byte-for-byte the one B2B already proved live on staging (`services/closet/closetMediaSync.ts#verifyObjectExists`); B2C's download path (`closetRestoreMedia.ts`) was proven at the unit/engine level against a faithful fake.

---

## 10. iOS qualification (not conflated with B2A's native gate)

```
IOS B2C SOURCE:              COMPLETE
IOS B2C STAGING RESTORE:     VERIFIED (schema/RLS/pagination/isolation, real fixture data)
IOS TRACK B END-TO-END PRIVACY:  BLOCKED — B2A IOS NATIVE COMPILE/DEVICE GATE (pre-existing, unrelated to B2C)
```

---

## 11. B2C handoff

**Ready for a future phase to consume:**
- a fully reconciled local Closet whose sidecar entries carry `serverId`, `serverRowVersion`, `syncedLocalUpdatedAt`, `mediaState`, and (new) `cachedMediaUploadedAt` — kept current by both B2B (outbound) and B2C (inbound) without either overwriting the other's evidence
- conflict evidence with a `conflictKind` distinguishing the two inbound shapes, ready for a future conflict-resolution UI to consume without redesigning the sidecar
- an account-scoped, replaceable, non-authoritative restored-media cache namespace, cleanable by the same purge primitives B2B already established the pattern for

**Still open, deliberately out of scope for this phase:**
- resolving a recorded conflict (a UI, or an owner-chosen policy)
- historical/pre-B2B local-item migration into cloud sync (B3)
- wiring the account-deletion completion worker to the three now-available purge primitives (`purgeLocalClosetForOwner`, `purgeClosetSyncStateForOwner`, `purgeClosetRestoreMediaCacheForOwner`)
- the full Track B hostile audit and integration-readiness certification (a separately authorized phase)
