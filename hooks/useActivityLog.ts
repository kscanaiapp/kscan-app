/**
 * Free Tier Utility Expansion — activity log hook.
 */

import { useCallback, useEffect, useState } from 'react';
import { loadActivityLog } from '../services/free-tier/activityLog';
import type { ActivityEvent } from '../services/free-tier/wardrobeUtilityTypes';

export function useActivityLog(limit = 8) {
  const [events, setEvents] = useState<ActivityEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    let live = true;
    loadActivityLog()
      .then((list) => {
        if (live) setEvents(list.slice(0, limit));
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, [limit, reloadToken]);

  const reload = useCallback(() => setReloadToken((t) => t + 1), []);

  return { events, loading, reload };
}
