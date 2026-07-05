/**
 * Free Tier Utility Expansion — optional sync status hook.
 *
 * Fully standalone: no provider, no root wiring, no polling, no network
 * calls unless backend sync flags are enabled. Safe to leave unused.
 */

import { useCallback, useEffect, useState } from 'react';
import { getFreeTierSyncStatus } from '../services/free-tier/freeTierSupabaseSync';
import type { FreeTierSyncStatus } from '../services/free-tier/freeTierSyncTypes';

const DEFAULT_STATUS: FreeTierSyncStatus = {
  enabled: false,
  authenticated: false,
  readEnabled: false,
  writeEnabled: false,
  queueEnabled: false,
  pendingWrites: 0,
};

export function useFreeTierSyncStatus() {
  const [status, setStatus] = useState<FreeTierSyncStatus>(DEFAULT_STATUS);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    try {
      const next = await getFreeTierSyncStatus();
      setStatus(next);
    } finally {
      setLoading(false);
    }
  }, []);

  // One-shot load on mount only. No polling or background refresh.
  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { status, loading, refresh };
}
