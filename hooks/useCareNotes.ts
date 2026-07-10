/**
 * Free Tier Utility Expansion — care notes hook.
 */

import { useCallback, useEffect, useState } from 'react';
import {
  loadCareNotes,
  removeCareNote,
  setCareNote,
} from '../services/free-tier/careNotes';
import { recordActivity } from '../services/free-tier/activityLog';
import type { CareNoteEntry } from '../services/free-tier/wardrobeUtilityTypes';

export function useCareNotes() {
  const [notes, setNotes] = useState<Record<string, CareNoteEntry>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let live = true;
    loadCareNotes()
      .then((map) => {
        if (live) setNotes(map);
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setLoading(false);
      });
    return () => {
      live = false;
    };
  }, []);

  const save = useCallback(
    async (itemId: string, patch: { tags?: string[]; note?: string }) => {
      const next = await setCareNote(itemId, patch);
      setNotes(next);
      recordActivity('added_care_note', 'Added care note').catch(() => undefined);
    },
    []
  );

  const toggleTag = useCallback(
    async (itemId: string, tag: string) => {
      const current = notes[itemId]?.tags ?? [];
      const tags = current.includes(tag)
        ? current.filter((t) => t !== tag)
        : [...current, tag];
      setNotes(await setCareNote(itemId, { tags }));
    },
    [notes]
  );

  const remove = useCallback(async (itemId: string) => {
    setNotes(await removeCareNote(itemId));
  }, []);

  return { notes, loading, save, toggleTag, remove };
}
