# Build 34 — Track B — Phase B2B: Closet Client Sync + Cloud Media Upload

**Status:** SOURCE COMPLETE — STAGING VALIDATED — iOS B2A NATIVE GATE STILL OUTSTANDING
**Scope:** OUTBOUND ONLY. No cross-device restore, no historical migration, no Signature Style, no Elise.

---

## 1. Source authority

| | iOS | Android |
|---|---|---|
| B2A parent branch | `feature/ios-build34-closet-media-privacy-v1` | `feature/android-build34-closet-media-privacy-v1` |
| B2A parent SHA | `092bdc1` (PR #215) | `64decd9` (PR #216) |
| B2B branch | `feature/ios-build34-closet-client-sync-v1` | `feature/android-build34-closet-client-sync-v1` |

Both B2A heads were live-verified with `git fetch --all --prune` plus `gh pr view` before branching; neither PR was merged as a prerequisite.

The B1C backend authority advanced from the recorded `c7fddfd` to `144a5fe`, but the only delta is `.github/workflows/zap-baseline-staging.yml` — the Closet media contract itself is byte-identical, so `c7fddfd`'s contract remains current.

---

## 2. Local Closet authority (mapped, not assumed)

| Question | Answer |
|---|---|
| Local store | `services/closetLibrary.js` — manifest at `kscan_closet/kscan_closet.json`, media under `kscan_closet/images/` and `kscan_closet/thumbnails/` |
| Stable local id | `closet_{base36 ts}_{counter}_{random}`, assigned in `buildClosetRecord`, never regenerated → reused verbatim as B1A `client_id` |
| Schema version | `CLOSET_ITEM_SCHEMA_VERSION = 2` → sent as `schema_version` |
| Account binding | `ownerId` on each record + `services/actorContext.js` (`actorId` + monotonic `epoch`) |
| Local UI thumbnail | `THUMB_WIDTH = 640` — untouched by B2B, and NOT the cloud derivative |
| Delete semantics | **HARD delete.** `deleteClosetItem` removes the record from the manifest; there is no local tombstone |

**The hard delete is the single most consequential local fact for B2B.** Sync state carried on the item record would be destroyed by exactly the operation whose evidence B2B most needs to keep. That is why durable sync state lives in an account-partitioned sidecar (`kscan_closet/kscan_closet_sync.json`), not on the item.

---

## 3. What was built

| File | Role |
|---|---|
| `services/closet/closetSyncContract.ts` | Pure contract: durable state vocabulary, retry/backoff, failure classification, local→cloud field projection, deterministic Storage paths |
| `services/closet/closetSyncStore.ts` | The durable sidecar. Account-partitioned, allowlist-rebuilt on read, single mutation queue |
| `services/closet/closetFactsSync.ts` | B1A facts: insert, conditional update, recover-by-`client_id`, tombstone |
| `services/closet/closetMediaSync.ts` | B2A sanitize → deterministic primary + thumbnail upload → verify → READY commit |
| `services/closet/closetSyncEngine.ts` | Orchestrator: flag + K+ gate, single-flight, restart discovery, stale-operation guards |
| `services/closet/closetSyncCoordinator.ts` | The local-mutation seam and its ordering rules |
| `constants/featureFlags.ts` | `CLOSET_CLOUD_SYNC_V1` — one kill switch, default OFF |
| `services/closetTelemetry.ts` | 8 sync events added to the existing allowlisted, content-free sink |
| `hooks/useCloset.js` | Wiring only: local-first on save, mark-before-delete, focus resume |

`services/closetLibrary.js` was **not modified**. No backend file, migration, Storage policy, entitlement, or Voice file was touched.

---

## 4. Ordering rules

**Save/edit — local first, then mark.** The local write is the user's actual outcome and is never delayed or conditioned on cloud state. A crash between the two leaves a local-only item, which is a correct resting state.

**Delete — mark first, then delete.** The opposite order, because the local delete is destructive: marking afterwards means a crash in between destroys the only evidence a cloud tombstone is still owed. A refused local delete reverts the mark.

---

## 5. Defects found and repaired during B2B

### P1 — media saga silently staled the tracked `row_version`

`closetMediaSync` performs two writes of its own (the reservation and the READY commit), and B1A's `set_user_closet_items_update_authority` trigger bumps `row_version` on every update. The engine originally recorded only the revision returned by the **facts** write, so after any media upload the sidecar held a revision two behind the server.

**Consequence:** the next edit's conditional `.eq('row_version', expected)` would match zero rows and be classified a conflict — a phantom conflict against a server nothing else had touched. Every item with media would have become un-editable after its first successful sync.

**Repair:** `ClosetMediaSyncResult` now carries `rowVersion`, sourced from `.select()` on both the reservation and the commit, and the engine persists it on every media outcome.

**Proof:** caught by 5 focused tests, and confirmed independently on staging — the positive path ends at `row_version = 3` after a single create + media upload (1 insert + 2 media updates).

### P2 — a media outcome could overwrite a `pending_delete`

If the user deleted an item while its media upload was in flight, the media result handler wrote `state: 'synced'` over the `pending_delete` the delete had just recorded, resurrecting the item as synced and dropping the tombstone evidence.

**Repair:** all three media outcome handlers now run through `applyMediaOutcome`, which preserves `pending_delete` and only refreshes `serverRowVersion`.

**Proof:** `DELETE RACE: a delete during upload wins`.

---

## 6. Staging validation (project `yzqjvdfgefveprobvvyw`)

Preflight schema check found **no drift**: all 24 columns, RLS enabled with 3 K+-gated policies and no DELETE policy, all 5 media CHECK constraints including both path-derivation constraints, both authority triggers, bucket `style-library-images` present and `public: false`.

Runtime validation ran as real authenticated users via `set local role authenticated` + JWT claims, so actual RLS applied rather than being bypassed.

| Case | Result |
|---|---|
| Facts insert (no `user_id` sent) | Row created, `user_id` server-stamped, `row_version = 1` |
| Media reserve + READY commit | `media_status = 'ready'`, both derived paths accepted, `row_version = 3` |
| Duplicate `client_id`, same user | `unique_violation` — refused |
| Path forgery into another user's folder | `check_violation` — refused |
| Traversal path (`../../etc/passwd`) | `check_violation` — refused |
| READY without a storage path | `check_violation` — refused |
| Non-K+ insert | `insufficient_privilege` — refused; verified via service_role that **zero** rows landed |
| Non-K+ select | 0 rows visible — cannot even see the K+ user's row |
| Same `client_id`, different user | Accepted — uniqueness is account-scoped, not global |
| Client hard delete | Removed 0 rows; the row survived |
| Tombstone (`deleted_at`) | Applied, row retained |
| Stale conditional write (`row_version = 1` vs server 4) | Matched 0 rows; fresh write matched 1 |

**Fixtures fully removed.** Final verification: 0 closet rows, 0 fixture entitlements, 0 fixture users, 0 fixture storage objects.

**Production (`wyyuqfdxucjksghsmhry`) was never contacted.**

---

## 7. Deliberate boundaries

- **Not B2C.** No remote discovery, no new-device hydration, no remote→local materialization, no media download, no inbound conflict resolution. B2B reads the cloud only for server acknowledgment, `client_id` recovery, and conflict detection.
- **Not B3.** `needsSyncWork` returns false for an item with no sidecar entry, so a discovery pass never sweeps up pre-existing local items. An entry is created only by a user save/edit/delete or an explicit retry — opportunistic sync, not bulk migration.
- **Conflicts are detected, never merged.** A stale write retains the local item, records `conflictExpectedRowVersion`, and stops. B2C owns reconciliation.
- **Media concurrency is one item at a time**, including sanitization, because B2A decodes/detects/masks/re-encodes a full-resolution image and concurrent passes are how a mobile process gets killed for memory.
- **No background scheduler.** Passes run on save, Closet open, app foreground, and explicit retry — the same conclusion `closetCandidateClassification.js` reached.

---

## 8. Out-of-scope findings (documented, not fixed)

| Severity | Finding |
|---|---|
| P1 | `services/savedScanMedia.ts` still routes uploads through `services/privacyImageSanitizer.js`, the passthrough B1C proved defective (`faceBlurApplied: false`, returns its input). B2B does not use it, and deliberately re-implements `base64ToArrayBuffer` rather than importing from that module. Repairing the saved-scan pipeline is its own pass. |
| P2 | iOS B2A native compilation and physical-device pixel validation remain unperformed (no Xcode in this environment). B2B's media path is only as trustworthy as B2A's native half. |
| P3 | The B1C branch advanced to `144a5fe` for an unrelated ZAP workflow edit; harmless, but the recorded authority SHA in Track B docs is now one commit behind. |
| P4 | `deleteClosetItem` returns `false` indistinguishably for "not found" and "write failed". B2B's revert path treats both the same, which is correct today but would matter if delete ever needed retry. |
| P4 | The sidecar has no compaction: a very long-lived account accumulates one small entry per synced item. Bounded by Closet size, so not a growth risk at current scale. |

---

## 9. B2C handoff

**Ready for B2C to consume:**
- local `client_id` ↔ server `id` mapping, durably persisted per account
- cloud facts rows with the full B1A taxonomy
- cloud media identity: bucket + both deterministic object paths, `media_status`, `media_uploaded_at`
- `serverRowVersion` per item, kept current across both facts and media writes
- tombstones (`deleted_at`) with local evidence consumed only after the cloud confirms
- per-item sync status and blocked reasons from B2A's closed vocabulary
- conflict evidence (`lastFailureClass: 'conflict'` + `conflictExpectedRowVersion`)

**B2C still has to build:** remote discovery/listing, new-device hydration, remote→local materialization, media download and local caching, and inbound conflict resolution (including deciding what wins for the items B2B has parked as conflicts).
