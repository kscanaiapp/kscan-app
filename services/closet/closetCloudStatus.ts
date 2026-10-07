import type { ClosetSyncEntry } from './closetSyncContract';

export type CloudClosetStatus = 'RESOLVING' | 'K+ REQUIRED' | 'SYNC READY' | 'SYNCING' | 'RESTORING' | 'WILL RETRY' | 'RETRY NEEDED' | 'SYNCED ON THIS DEVICE';
/** Read-only projection over the existing sidecar and live engine activity.
 * Running is never persisted: after process death pending work becomes WILL RETRY.
 * Historical capability proof alone can never report that current items synced. */
export function projectCloudClosetStatus(input: {
  entitlement: string;
  syncing: boolean;
  restoring: boolean;
  readFailed: boolean;
  outboundProven: boolean;
  entries: Record<string, ClosetSyncEntry>;
  items: readonly { id: string; updatedAt?: string }[];
}): CloudClosetStatus {
  if (input.entitlement === 'loading' || input.entitlement === 'error') return 'RESOLVING';
  if (input.entitlement !== 'active') return 'K+ REQUIRED';
  if (input.readFailed) return 'RETRY NEEDED';
  if (input.restoring) return 'RESTORING';
  if (input.syncing) return 'SYNCING';
  const entries = Object.values(input.entries);
  if (entries.some(entry => entry.state === 'error' || entry.state === 'blocked' || entry.mediaState === 'blocked')) return 'RETRY NEEDED';
  if (entries.some(entry => entry.state === 'pending' || entry.state === 'pending_delete' || entry.mediaState === 'pending')) return 'WILL RETRY';
  const allCurrent = input.items.length > 0 && input.items.every(item => {
    const entry = input.entries[item.id];
    return entry?.state === 'synced' && !!entry.serverId && entry.mediaState === 'ready'
      && !!item.updatedAt && entry.syncedLocalUpdatedAt === item.updatedAt;
  });
  return input.outboundProven && allCurrent ? 'SYNCED ON THIS DEVICE' : 'SYNC READY';
}
