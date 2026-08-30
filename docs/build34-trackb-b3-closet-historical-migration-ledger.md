# Build 34 — Track B — Phase B3: Historical Closet Migration

**Status:** SOURCE COMPLETE — FOCUSED + FULL REGRESSION GREEN — STAGING NOT YET RUN IN THIS ENVIRONMENT
**Scope:** Enrolls pre-existing, never-synced local Closet items into the EXISTING B2B outbound sync engine. No new sync engine, no new backend table, no new backend endpoint, no Signature Style, no Elise.

---

## 1. Source authority

| | iOS |
|---|---|
| B3 parent branch | `feature/ios-build34-closet-cross-device-restore-v1` (B2C) |
| B3 parent SHA (live-verified) | `77404982fd6e5d7b04846863d929a3e538217945` |
| B3 branch | `feature/ios-build34-closet-historical-migration-v1` |

Android is the byte-for-byte equivalent: parent `feature/android-build34-closet-cross-device-restore-v1` @ `3b920dd63...` (tip at the time of branching), branch `feature/android-build34-closet-historical-migration-v1`. See the Android checkpoint note in this doc's companion section for the platform-specific SHA record.

`git fetch --all --prune` was run and the live tip of both B2C branches was verified against `git log --oneline -1` immediately before branching. Both B2C branches are the confirmed final heads for Track B B1A/B1C/B2A/B2B/B2C — no branch descends from either of them, and both already carry `docs/build34-trackb-b2a-closet-media-privacy-ledger.md`, `...-b2b-...`, and `...-b2c-...`. No backend branch was created or needed: B3 introduces zero backend/schema changes — it consumes the identical `user_closet_items` contract B2B and B2C already use, via B2B's own client functions.

---

## 2. What was built

| File | Role |
|---|---|
| `services/closet/closetHistoricalMigrationContract.ts` | Pure module: eligibility (`isClosetHistoricalMigrationEligible`), batch selection (`selectClosetHistoricalMigrationCandidates`, newest-`updatedAt`-first, deterministic tie-break), and the anti-churn cooldown (`isClosetHistoricalMigrationCooldownElapsed`) |
| `services/closet/closetHistoricalMigrationEngine.ts` | Orchestrator: flag + B2B-flag + K+ gate, single-flight, cooldown, one bounded batch selection per pass, then hands off to B2B's own `markClosetItemForSync` + `runClosetSyncPass` — unmodified |
| `constants/featureFlags.ts` (extended) | `CLOSET_LEGACY_MIGRATION_V1` — the one B3 kill switch, default OFF |
| `services/closetTelemetry.ts` (extended) | 3 migration events added to the existing allowlisted, content-free sink (`closet_migration_started`, `closet_migration_batch_marked`, `closet_migration_completed`) — no new properties needed, reuses the existing `countBucket` |
| `hooks/useCloset.js` (extended) | Wiring only: fires the migration trigger on Closet focus, alongside the existing B2B/B2C triggers. Fire-and-forget, no local re-read (B3 never materializes/edits/deletes a local item, so there is nothing for a re-read to pick up) |
| `__tests__/closetHistoricalMigration.test.js` | New: 23 tests loading the REAL B3 modules directly on top of the REAL, unmodified B2B stack (`closetSyncContract`, `closetSyncStore`, `closetFactsSync`, `closetMediaSync`, `closetSyncEngine`) |
| `__tests__/closetIntakeStateIntegrity.test.js` (repaired) | Test-harness gap, same class as B2C's own — see §7 |

**No backend file, migration, Storage policy, entitlement, Voice, or Scanner file was touched.** `services/closet/closetSyncEngine.ts`, `closetSyncStore.ts`, `closetFactsSync.ts`, `closetMediaSync.ts`, and `closetSyncContract.ts` are all byte-for-byte unmodified — B3 imports and calls them, never edits them.

---

## 3. The eligibility rule, as implemented

`closetHistoricalMigrationContract.ts#isClosetHistoricalMigrationEligible` is the single pure function every selection decision routes through:

| Local item | Sidecar entry | Eligible? |
|---|---|---|
| present | none | **yes** — the exact B2B/B3 boundary (`needsSyncWork`'s own doc comment) |
| present | any entry at all (synced, pending, error, blocked, pending_delete, or a B2C-restore-written entry) | no — already cloud-known, for any reason |
| present, unsupported future schema version | (irrelevant) | no — fail-closed, mirrors B2C's `classifyClosetRestoreSchemaVersion` |

This single check is what makes B3 need no separate notion of "is this a restored item" or "is this already synced": the sidecar's mere presence for a `clientId` already answers the question, because B2C's cross-device restore always writes a sidecar entry on materialization (`closetRestoreEngine.ts#writeSyncedEntry`), and B2B's own save/edit path always writes one via `markClosetItemForSync`. An item with genuinely no entry can only be one thing: a local item nothing in the cloud pipeline has ever touched.

---

## 4. The migration pass, end to end

```
Closet screen gains focus (hooks/useCloset.js's existing useFocusEffect)
  -> flag (CLOSET_LEGACY_MIGRATION_V1) + B2B flag (CLOSET_CLOUD_SYNC_V1) + K+ active, all fresh
  -> 60s in-memory cooldown, keyed by actor id (mirrors B2C's shape exactly)
  -> one read of the local Closet + one read of the full sidecar (no network)
  -> select up to 10 eligible items, newest updatedAt first
  -> markClosetItemForSync(userId, clientId) for each — B2B's own function, unmodified
  -> runClosetSyncPass({ reason: 'legacy_migration' }) ONCE for the whole batch
```

From the moment `markClosetItemForSync` returns, a migrated item is **architecturally indistinguishable** from one the user just edited while cloud sync was on. There is no "migrated" flag anywhere in the sidecar or on the local record — B2B's crash recovery, conflict detection, retry/backoff, and B2A privacy sanitization all apply to it exactly as they would to any opportunistically-synced item, because it is now going through the identical code path.

**Batching is a work bound, not a queue.** The 10-item cap (`CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE`) only limits how many items one pass *marks*; B2B's own sidecar is still the durable queue. A Closet with 12 legacy items migrates 10 on the first focus and the remaining 2 on the next pass 60+ seconds later (proven by test `BATCH: a second pass ... migrates the remaining items`), with no risk of double-marking because the first 10 already have sidecar entries by then.

**Requiring `CLOSET_CLOUD_SYNC_V1` too** (not nested as a flag-of-a-flag, but checked directly in `isClosetHistoricalMigrationEligibleNow`) is deliberate: enrolling an item into a sync engine that is itself off would only populate the sidecar with inert `pending` entries. Both flags independently default OFF in every profile including production.

---

## 5. Non-destructive guarantees

- **Migration failure never damages the local item.** B3 never writes to the local Closet manifest at all — only to the sidecar, via B2B's own `markClosetItemForSync`, which itself only ever creates/updates a sidecar entry and never touches `kscan_closet.json`.
- **A local delete or edit racing the migration always wins.** B3 marks by `clientId` only; it never carries item content forward. The actual facts payload is read fresh by B2B's `discoverPendingWork`/`syncOneItem` at sync-pass time, from whatever the local Closet currently contains. Test `RACE: an item deleted locally before the mark lands is never resurrected` proves that an item removed between B3's read and the handoff produces zero cloud rows and leaves, at most, an inert `pending` sidecar entry with no `serverId` — which `discoverPendingWork` never surfaces as work and which resurrects nothing (see `closetSyncEngine.ts`'s own comment on that exact shape).
- **K+ loss never destroys local data.** A migration pass that finds K+ inactive is a pure no-op (`skippedReason: 'not_kplus'`) — it does not clear, roll back, or touch anything. Proven by test; reactivation on the very next pass migrates the same items with no special-casing (identical to B2B's and B2C's own reactivation story).
- **No second sync mechanism.** Every durable byte B3 ever writes is a `markClosetItemForSync` call into the existing `kscan_closet_sync.json` sidecar. There is no `closet_migration.json`, no migration queue, no migration-specific Supabase call, and no migration-specific media/facts code anywhere in this phase.

---

## 6. Idempotency and account isolation

- **Crash/restart:** a second, independent pass over the same local Closet finds every already-marked item now carries a sidecar entry and re-selects zero of them (`IDEMPOTENT` test). No duplicate cloud row is ever possible because B2B's own unique-violation recovery (`findCloudClosetItemByClientId`) already governs that path, unmodified.
- **Already-synced / B2C-restored items:** both produce a sidecar entry through a path other than B3, and are therefore excluded by the single eligibility check (`BOUNDARY` tests). B3 has no separate code path for "was this restored" — it doesn't need one.
- **Cross-account:** `loadCloset(userId)` and `listClosetSyncEntries(userId)` are both already account-partitioned by B1A ownership and by the sidecar's own per-owner structure respectively; a migration pass for account A never reads, marks, or uploads account B's items (`ISOLATION` test).

---

## 7. Defects found and repaired during B3

### Repair — the same test-harness gap pattern B2C's own ledger recorded (not a B2B/B2C/B3 production defect)

`__tests__/closetIntakeStateIntegrity.test.js` loads the real `hooks/useCloset.js` through a hand-built require map that predates B3. Adding the new `closetHistoricalMigrationEngine` import to the hook made every focus-triggering test in that file throw (`resumeClosetHistoricalMigration is not a function`), identical in shape to the gap B2C's ledger documents for `resumeClosetRestore`. Repaired by adding the same inert, observable-only stub the file already uses for `closetSyncCoordinator` and `closetRestoreEngine`. **Not a production defect** — `hooks/useCloset.js` itself is correct; only the test file's fixed require map needed to learn about the new dependency.

### No inherited B1/B2A/B2B/B2C production defects found

`markClosetItemForSync`, `runClosetSyncPass`, the sidecar contract, and `listClosetSyncEntries` were all re-read against this branch's live tip and used unmodified. No narrow inherited repair was required or performed.

---

## 8. Deliberate boundaries

- **Not a second sync engine.** All durable state B3 writes lives in B2B's existing sidecar, through B2B's own `markClosetItemForSync`. No new file, no new table, no new vocabulary.
- **Not B2B, not B2A.** B3 never upserts facts, never sanitizes media, never uploads a byte, and never talks to Supabase or Storage directly — `runClosetHistoricalMigrationEngine` imports `supabaseClient` only to resolve the current `userId` via `auth.getSession()`, exactly as `closetSyncEngine.ts` and `closetRestoreEngine.ts` already do.
- **No background scheduler, no AppState listener.** Migration runs only when the Closet screen gains focus, the same trigger B2B and B2C already use, alongside them in the same `useFocusEffect`.
- **No completion marker file.** Per the governing addendum, a persisted "migration complete" marker was deliberately not added: the 60s cooldown already bounds the cost of an empty scan (one local-only read of the manifest + sidecar, no network), and a typical Closet is small enough that this is not a measured cost — adding a second persisted signal for it would be exactly the kind of second small persistence surface the governing rules ask this phase to avoid. If a future phase's staging measurements show otherwise, this is a narrow, additive change to make later.

---

## 9. Test coverage

`__tests__/closetHistoricalMigration.test.js` — 23 tests, loading the real `closetHistoricalMigrationContract.ts` and `closetHistoricalMigrationEngine.ts` wired directly on top of the real, unmodified `closetSyncContract.ts` / `closetSyncStore.ts` / `closetFactsSync.ts` / `closetMediaSync.ts` / `closetSyncEngine.ts` (the same modules `__tests__/closetCloudSync.test.js` exercises), with only the genuine external boundaries faked (Supabase, expo-file-system, the B2A native privacy engine, the entitlement snapshot, the local Closet manifest). Covers: 1/10/12/0-item batches, already-synced exclusion, B2C-restored exclusion, pending-delete exclusion, K+ inactive/reactivated/signed-out, migration-flag-off, B2B-flag-off, cooldown elapsed/not-elapsed/reset-on-account-switch, crash/restart idempotency, a local delete racing the mark, cross-account isolation, and a future/unsupported schema version.

**Focused:** `node --test __tests__/closetHistoricalMigration.test.js` — 23/23 pass.
**Full regression:** `node scripts/run-all-tests.js` — 5644 tests, 5639 pass, 0 fail, 5 pre-existing skips (unchanged from before this phase), after the one test-harness repair in §7.

---

## 10. Staging

Not run in this environment (no Supabase MCP staging credentials exercised for this phase). B3 introduces zero new backend surface — no migration, no new table, no new RLS policy, no new Storage path — so there is nothing new for a staging preflight to verify beyond what B2B's and B2C's own staging runs already proved for `user_closet_items` and `style-library-images`. The one thing worth verifying live before enabling `CLOSET_LEGACY_MIGRATION_V1` in any profile is behavioral, not schematic: that a real device with a genuine pre-B2B local Closet enrolls its items exactly as this phase's unit/engine tests predict. That is a device-level verification, not a schema one, and is out of scope for this environment (no simulator/device available here, same limitation B2A/B2B/B2C's own ledgers record for their native-side verification).

**Production (`wyyuqfdxucjksghsmhry`) was never contacted.**

---

## 11. B3 handoff

**Ready for B4 to consume:** a fully reconciled cloud Closet that now includes historical items, materializing through the exact same `user_closet_items` facts/media path B2B and B2C already proved on staging. B4's Signature Style derivation needs nothing new from B3 — it reads authoritative cloud evidence whenever it exists, migrated or not, and correctly derives an empty/partial profile from whatever subset has landed at any given moment (Track B addendum, "B3 does not require all historical items to finish before B4").

**B3 does not build:** any UI, any migration progress indicator, any user-visible "importing your Closet" state, or any historical-migration-specific telemetry beyond the three bounded, content-free events in §2. None of these were in scope.
