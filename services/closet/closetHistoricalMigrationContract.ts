// Build 34 / Track B / Phase B3 — Historical Closet migration contract.
//
// PURE MODULE. No react-native, no expo, no Supabase, no filesystem. Every
// decision the migration engine makes that can be expressed as a function of
// data lives here so it is testable without a device, a network, or a bundler
// — the same discipline closetSyncContract.ts and closetRestoreContract.ts use.
//
// THE GOVERNING RULE OF B3:
//   B3 does not sync. It only decides WHICH pre-existing local items are
//   eligible to be handed to the EXISTING B2B outbound engine
//   (closetSyncEngine.ts#markClosetItemForSync / #runClosetSyncPass) and in
//   what order/bound. Every other decision — facts upsert, privacy
//   sanitization, media upload, conflict handling — belongs to B2B/B2A and is
//   never duplicated here.
//
// THE B2B/B3 BOUNDARY (see closetSyncContract.ts's own doc comment on
// needsSyncWork): an item with NO sidecar entry is exactly B3's territory. An
// item that already has one — however it got one, an opportunistic B2B push
// OR a B2C cross-device restore materialization — is already cloud-known and
// must never be re-classified as "historical."

/** One work bound per automatic migration pass. A product/workload guard, not
 *  a contract limit — a manual/administrative retry may choose a different
 *  bound, but the opportunistic Closet-focus trigger always uses this one. */
export const CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE = 10;

/** Anti-churn cooldown between automatic migration passes for one account.
 *  Mirrors closetRestoreContract.ts's cooldown shape exactly (Addendum C/D):
 *  in-memory only, keyed by actor id, reset by an account change or app
 *  restart. Longer than B2C's 30s because a migration pass that finds nothing
 *  new to enroll is even less likely to have new work moments later — there is
 *  no remote signal (a second device, a teammate) that could produce fresh
 *  historical items between one focus and the next. */
export const CLOSET_HISTORICAL_MIGRATION_COOLDOWN_MS = 60_000;

/** True once the cooldown for this actor has elapsed. Identical shape to
 *  closetRestoreContract.ts#isClosetRestoreCooldownElapsed by design — the two
 *  engines must never silently diverge in how they reason about "did enough
 *  time pass since the last attempt." */
export function isClosetHistoricalMigrationCooldownElapsed(
  lastAttempt: { actorId: string | null; atMs: number } | null,
  actorId: string | null,
  nowMs: number,
): boolean {
  if (!lastAttempt) return true;
  if (lastAttempt.actorId !== actorId) return true; // account change resets it
  return nowMs - lastAttempt.atMs >= CLOSET_HISTORICAL_MIGRATION_COOLDOWN_MS;
}

/**
 * One local Closet item, reduced to exactly what eligibility needs. Kept
 * separate from the full local record so this module never has to know the
 * local Closet's full shape.
 */
export interface ClosetHistoricalMigrationCandidateItem {
  id: string;
  updatedAt: string | null;
  /** Local record's own schema version, when present. */
  schemaVersion: number | null;
}

/**
 * Whether ONE local item is eligible for historical migration.
 *
 * hasSyncEntry: true whenever `getClosetSyncEntry`/`listClosetSyncEntries`
 * already has a record for this clientId — for ANY reason. That single check
 * is what excludes, all at once and without needing to distinguish them:
 *   - an item B2B already opportunistically synced (user edited it while
 *     cloud sync was on)
 *   - an item currently mid-flight, blocked, or in conflict
 *   - an item B2C already materialized from another device (cross-device
 *     restore always writes a sidecar entry — see closetRestoreEngine.ts)
 *   - an item already marked pending_delete
 * so B3 never needs its own notion of "is this a restored item" — the
 * sidecar's mere presence already answers that question, by construction
 * (Micro-addendum, section on B3 eligibility).
 *
 * maxSupportedSchemaVersion: an item from a future/unsupported local schema
 * is left alone rather than guessed at, the same fail-closed direction B2C
 * takes for a future-schema remote row (classifyClosetRestoreSchemaVersion).
 */
export function isClosetHistoricalMigrationEligible(
  item: ClosetHistoricalMigrationCandidateItem,
  hasSyncEntry: boolean,
  maxSupportedSchemaVersion: number,
): boolean {
  if (!item || typeof item.id !== 'string' || !item.id) return false;
  if (hasSyncEntry) return false;
  if (item.schemaVersion != null && item.schemaVersion > maxSupportedSchemaVersion) return false;
  return true;
}

/**
 * Select up to `limit` eligible historical items from the full local Closet,
 * given the set of clientIds that already have a sidecar entry.
 *
 * ORDER: newest `updatedAt` first (section 17) — a stable, deterministic
 * tie-break on `id` keeps the result reproducible when many items share an
 * identical `updatedAt` (e.g. a bulk historical import that stamped them all
 * at once). An item with no `updatedAt` sorts last, never first, so a
 * malformed/legacy record cannot crowd out a well-formed one.
 *
 * PURE: takes the full item list and entry-id set as plain data, returns a
 * plain array of clientIds. Never mutates its inputs.
 */
export function selectClosetHistoricalMigrationCandidates(
  items: ClosetHistoricalMigrationCandidateItem[],
  clientIdsWithSyncEntry: ReadonlySet<string>,
  maxSupportedSchemaVersion: number,
  limit: number = CLOSET_HISTORICAL_MIGRATION_BATCH_SIZE,
): string[] {
  const eligible = (Array.isArray(items) ? items : []).filter((item) =>
    isClosetHistoricalMigrationEligible(item, clientIdsWithSyncEntry.has(item?.id), maxSupportedSchemaVersion),
  );

  const rank = (item: ClosetHistoricalMigrationCandidateItem): number => {
    const parsed = typeof item.updatedAt === 'string' ? Date.parse(item.updatedAt) : NaN;
    return Number.isFinite(parsed) ? parsed : -Infinity;
  };

  eligible.sort((a, b) => {
    const diff = rank(b) - rank(a); // newest first
    if (diff !== 0) return diff;
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0; // deterministic tie-break
  });

  return eligible.slice(0, Math.max(0, limit)).map((item) => item.id);
}
