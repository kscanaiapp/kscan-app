import AsyncStorage from '@react-native-async-storage/async-storage';

import { currentActorId } from './actorScope';

/**
 * No-DB UGC safety local store.
 *
 * Stores content ids and user ids the user has chosen to hide after reporting.
 * Device-local only; no backend sync, no block enforcement, no cross-device filtering.
 *
 * ACTOR SCOPING. These lists are per-ACCOUNT, not per-device. Report & Hide is a
 * personal moderation decision: which senders and messages one account no longer
 * wants to see. Before this partitioning the store used two flat device-wide
 * keys, so on a shared handset Actor A's hidden senders silently filtered Actor
 * B's room chat -- B saw "You have reported or hidden all recent activity in
 * this room" for content B never reported, with no way to reverse it, and A's
 * safety choices were inferable by B. Every read and write below is confined to
 * the live actor's partition; the signed-out device-local partition is keyed
 * separately as ANONYMOUS_PARTITION.
 *
 * The v1 keys are NOT migrated into any actor's partition. A device-wide list
 * has no recorded owner, so adopting it would hand whichever account happens to
 * open a room first exactly the cross-actor state this partitioning exists to
 * prevent. They are deleted on first access instead: losing a hide is
 * recoverable (Report & Hide again, or Block for the durable server-side
 * control), whereas leaking one account's moderation history to another is not.
 */
const LEGACY_HIDDEN_CONTENT_IDS_KEY = 'kscan.hidden_content_ids.v1';
const LEGACY_HIDDEN_USER_IDS_KEY = 'kscan.hidden_user_ids.v1';
const HIDDEN_CONTENT_IDS_KEY = 'kscan.hidden_content_ids.v2';
const HIDDEN_USER_IDS_KEY = 'kscan.hidden_user_ids.v2';

const ANONYMOUS_PARTITION = 'anonymous';

/** Live actor partition. Never a caller-supplied value. */
function actorPartition(): string {
  return currentActorId() ?? ANONYMOUS_PARTITION;
}

let legacyPurged = false;

/**
 * One-time removal of the unpartitioned v1 keys. Never throws and never blocks
 * a read: a device that keeps failing to delete them simply keeps ignoring
 * them, because nothing below ever reads those keys.
 */
async function purgeLegacyKeysOnce(): Promise<void> {
  if (legacyPurged) return;
  legacyPurged = true;
  try {
    await AsyncStorage.multiRemove([
      LEGACY_HIDDEN_CONTENT_IDS_KEY,
      LEGACY_HIDDEN_USER_IDS_KEY,
    ]);
  } catch {
    // Best effort only.
  }
}

type PartitionedIds = Record<string, string[]>;

function normalizePartitions(parsed: unknown): PartitionedIds {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  const output: PartitionedIds = {};
  for (const [partition, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!Array.isArray(value)) continue;
    output[partition] = value.filter((id): id is string => typeof id === 'string');
  }
  return output;
}

async function readPartitions(key: string): Promise<PartitionedIds> {
  await purgeLegacyKeysOnce();
  try {
    const raw = await AsyncStorage.getItem(key);
    if (!raw) return {};
    const partitions = normalizePartitions(JSON.parse(raw));
    // A malformed payload is discarded rather than reinterpreted: the shape
    // decides whose ids these are, and a wrong guess is a cross-actor leak.
    if (Object.keys(partitions).length === 0) {
      await AsyncStorage.removeItem(key).catch(() => undefined);
    }
    return partitions;
  } catch {
    return {};
  }
}

async function readIdsForCurrentActor(key: string): Promise<string[]> {
  const partitions = await readPartitions(key);
  return partitions[actorPartition()] ?? [];
}

async function addIdForCurrentActor(key: string, id: string): Promise<boolean> {
  if (typeof id !== 'string' || !id) return false;
  try {
    const partition = actorPartition();
    const partitions = await readPartitions(key);
    const current = partitions[partition] ?? [];
    if (current.includes(id)) return true;
    partitions[partition] = [...current, id];
    await AsyncStorage.setItem(key, JSON.stringify(partitions));
    return true;
  } catch {
    return false;
  }
}

export async function readHiddenContentIds(): Promise<string[]> {
  return readIdsForCurrentActor(HIDDEN_CONTENT_IDS_KEY);
}

export async function addHiddenContentId(id: string): Promise<boolean> {
  return addIdForCurrentActor(HIDDEN_CONTENT_IDS_KEY, id);
}

/**
 * Read the current account's device-local list of hidden/reported user ids.
 * These ids are added when a user reports content and the sender/author id is known.
 */
export async function readHiddenUserIds(): Promise<string[]> {
  return readIdsForCurrentActor(HIDDEN_USER_IDS_KEY);
}

/**
 * Persist a user id to the current account's device-local hidden-user list.
 * Returns true if the id is already present or was successfully persisted.
 */
export async function addHiddenUserId(id: string): Promise<boolean> {
  return addIdForCurrentActor(HIDDEN_USER_IDS_KEY, id);
}

/**
 * Validate that a value is a non-empty string that looks like a UUID.
 * Used for app-level validation of optional room_id references before submitting reports.
 */
export function isValidUuid(value: unknown): value is string {
  if (typeof value !== 'string' || !value) return false;
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  return uuidRegex.test(value);
}
