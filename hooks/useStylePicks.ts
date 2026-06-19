import { useState, useCallback } from 'react';
import type { StylePick, StylePicksStatus } from '../types/stylePicks';

export interface RefreshStylePicksResult {
  ok: boolean;
  persisted: false;
  backendConnected: false;
  reason: 'backend_not_connected';
}

export interface UseStylePicksReturn {
  picks: StylePick[];
  status: StylePicksStatus;
  isLoading: boolean;
  error: string | null;
  backendConnected: false;
  refresh: () => Promise<RefreshStylePicksResult>;
}

/**
 * Placeholder hook for Style Picks / AI-curated recommendations.
 *
 * Backend integration not yet connected.
 * All operations are in-memory with async-safe delays.
 * Future backend wiring will not break callers because the contract is async today.
 */
export function useStylePicks(): UseStylePicksReturn {
  const [picks] = useState<StylePick[]>([]);
  const [status, setStatus] = useState<StylePicksStatus>('backend_not_connected');
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async (): Promise<RefreshStylePicksResult> => {
    setIsLoading(true);
    setStatus('loading');
    setError(null);

    // Async-safe delay to force UI loading state handling now.
    await new Promise((resolve) => setTimeout(resolve, 300));

    // No backend connected — placeholder empty state
    setIsLoading(false);
    setStatus('backend_not_connected');

    return {
      ok: true,
      persisted: false,
      backendConnected: false,
      reason: 'backend_not_connected',
    };
  }, []);

  return {
    picks,
    status,
    isLoading,
    error,
    backendConnected: false,
    refresh,
  };
}
