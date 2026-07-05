/**
 * Free Tier Utility Expansion — local-only pending-write queue.
 *
 * This queue stores intended backend writes on device. It never makes
 * network calls; sync consumers drain it when backend flags are enabled.
 * Local free-tier features work normally whether or not the queue is used.
 */

import { readStore, writeStore } from './freeTierStorage';
import type { FreeTierSyncEntityName, FreeTierSyncOperation } from './freeTierSyncTypes';

const SYNC_QUEUE_KEY = 'kscan.freeTier.syncQueue.v1' as const;

export interface FreeTierPendingWrite {
  id: string;
  entity: FreeTierSyncEntityName;
  operation: FreeTierSyncOperation;
  payload: unknown;
  createdAt: string;
  retryCount: number;
  lastError?: string;
}

function generateQueueId(): string {
  return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/** Add a write operation to the local queue. Returns true on success; never throws. */
export async function enqueueFreeTierWrite(
  entity: FreeTierSyncEntityName,
  operation: FreeTierSyncOperation,
  payload: unknown
): Promise<boolean> {
  try {
    const queue = await getPendingFreeTierWrites();
    const next: FreeTierPendingWrite = {
      id: generateQueueId(),
      entity,
      operation,
      payload,
      createdAt: new Date().toISOString(),
      retryCount: 0,
    };
    return await writeStore(SYNC_QUEUE_KEY, [...queue, next]);
  } catch {
    return false;
  }
}

/** Return all pending writes. Corrupt queue is reset to empty. */
export async function getPendingFreeTierWrites(): Promise<FreeTierPendingWrite[]> {
  const queue = await readStore<FreeTierPendingWrite[]>(SYNC_QUEUE_KEY, []);
  if (!Array.isArray(queue)) return [];
  return queue.filter(isValidPendingWrite);
}

/** Remove a single pending write by id. Returns true on success. */
export async function clearFreeTierWrite(id: string): Promise<boolean> {
  try {
    const queue = await getPendingFreeTierWrites();
    const filtered = queue.filter((item) => item.id !== id);
    if (filtered.length === queue.length) return false;
    return await writeStore(SYNC_QUEUE_KEY, filtered);
  } catch {
    return false;
  }
}

/** Clear the entire queue. Returns true on success. */
export async function clearAllFreeTierWrites(): Promise<boolean> {
  try {
    return await writeStore(SYNC_QUEUE_KEY, []);
  } catch {
    return false;
  }
}

/** Return the number of pending writes. */
export async function getFreeTierPendingWriteCount(): Promise<number> {
  const queue = await getPendingFreeTierWrites();
  return queue.length;
}

/** Increment retry count and optionally store last error. Does not throw. */
export async function markFreeTierWriteRetry(
  id: string,
  errorMessage?: string
): Promise<void> {
  try {
    const queue = await getPendingFreeTierWrites();
    const updated = queue.map((item) => {
      if (item.id !== id) return item;
      return {
        ...item,
        retryCount: item.retryCount + 1,
        lastError: errorMessage,
      };
    });
    await writeStore(SYNC_QUEUE_KEY, updated);
  } catch {
    // best-effort
  }
}

function isValidPendingWrite(value: unknown): value is FreeTierPendingWrite {
  if (typeof value !== 'object' || value === null) return false;
  const item = value as Partial<FreeTierPendingWrite>;
  return (
    typeof item.id === 'string' &&
    typeof item.entity === 'string' &&
    (item.operation === 'upsert' || item.operation === 'delete') &&
    typeof item.createdAt === 'string' &&
    typeof item.retryCount === 'number'
  );
}
