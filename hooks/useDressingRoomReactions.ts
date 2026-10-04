import { useCallback, useEffect, useRef, useState } from 'react';
import { Alert } from 'react-native';
import { applyOptimisticReaction } from '../services/dressingRoomReactionOptimism';
import { createLatestIntentQueue } from '../services/latestIntentMutationQueue';
import { selectionTick } from '../services/haptics';
import { getItemReactionCounts, getMyItemReaction, setItemReaction } from '../services/styleObjects';
import {
  isActiveDressingRoomReactionType,
  type DressingRoomReactionType,
  type ItemReactionCount,
} from '../types/styleObjects';
import type { ReactionCountsForItem } from '../components/dressing-rooms/ItemReactions';

export type ReactionCountsByItem = Record<string, ReactionCountsForItem>;
export type SelectedReactionsByItem = Record<string, DressingRoomReactionType | null>;

const EMPTY_REACTION_COUNTS: ReactionCountsForItem = {
  love: 0,
  like: 0,
  looking: 0,
  thumbs_down: 0,
};

export function createEmptyReactionCounts(): ReactionCountsForItem {
  return { ...EMPTY_REACTION_COUNTS };
}

export function normalizeReactionItemId(itemId?: string | null): string | null {
  const normalized = String(itemId || '').trim();
  return normalized ? normalized : null;
}

function buildReactionCountsByItem(itemIds: string[], rows: ItemReactionCount[]): ReactionCountsByItem {
  const base = Object.fromEntries(
    itemIds.map((itemId) => [itemId, createEmptyReactionCounts()]),
  ) as ReactionCountsByItem;
  for (const row of rows) {
    const itemId = String(row.item_id || '').trim();
    if (!itemId || !base[itemId] || !isActiveDressingRoomReactionType(row.reaction_type)) continue;
    base[itemId][row.reaction_type] = Number.isFinite(row.count) ? row.count : 0;
  }
  return base;
}

export type ReactionSurfaceContext = {
  enabled: boolean;
  roomId: string | null;
  /**
   * Stable dependency key for the current actor/room/share scope. When it
   * changes, reaction reads are reloaded even if the rendered item ids match.
   */
  scopeKey: string;
  /** Live identity check used before and after every mutation. */
  getIdentity: () => string;
  /**
   * Public shared-room count reads are share-token-bound. Owner surfaces omit
   * this and use authenticated authority.
   */
  getShareToken?: () => string | null;
};

type PendingReactionPayload = {
  reactionType: DressingRoomReactionType;
  active: boolean;
  previousSelection: DressingRoomReactionType | null;
  previousCounts: ReactionCountsForItem;
  roomId: string | null;
  identityAtTap: string;
};

export type UseDressingRoomReactionsResult = {
  reactionCounts: ReactionCountsByItem;
  selectedReactions: SelectedReactionsByItem;
  mutatingReactionItemId: string | null;
  handleReact: (itemId: string, reactionType: DressingRoomReactionType) => void;
  reset: () => void;
};

export function useDressingRoomReactions(
  itemIds: string[],
  context: ReactionSurfaceContext,
): UseDressingRoomReactionsResult {
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsByItem>({});
  const [selectedReactions, setSelectedReactions] = useState<SelectedReactionsByItem>({});
  const [mutatingReactionItemId, setMutatingReactionItemId] = useState<string | null>(null);

  const countsRef = useRef<ReactionCountsByItem>({});
  const selectedRef = useRef<SelectedReactionsByItem>({});
  const contextRef = useRef(context);
  contextRef.current = context;
  const queueRef = useRef(createLatestIntentQueue<PendingReactionPayload>());

  const storeCounts = useCallback((next: ReactionCountsByItem) => {
    countsRef.current = next;
    setReactionCounts(next);
  }, []);

  const storeSelected = useCallback((next: SelectedReactionsByItem) => {
    selectedRef.current = next;
    setSelectedReactions(next);
  }, []);

  const readCounts = useCallback(async (ids: string[]) => {
    const token = contextRef.current.getShareToken?.() ?? null;
    return getItemReactionCounts(ids, token ? { shareToken: token } : undefined);
  }, []);

  const refreshItemReactions = useCallback(async (ids: string[], expectedIdentity?: string) => {
    const normalized = Array.from(new Set(ids.map((id) => String(id || '').trim()).filter(Boolean)));
    if (!normalized.length) return;
    if (expectedIdentity && contextRef.current.getIdentity() !== expectedIdentity) return;

    let nextCounts: ReactionCountsByItem;
    try {
      nextCounts = buildReactionCountsByItem(normalized, await readCounts(normalized));
    } catch {
      nextCounts = buildReactionCountsByItem(normalized, []);
    }
    if (expectedIdentity && contextRef.current.getIdentity() !== expectedIdentity) return;
    storeCounts({ ...countsRef.current, ...nextCounts });

    if (!contextRef.current.enabled) {
      const cleared = Object.fromEntries(normalized.map((id) => [id, null])) as SelectedReactionsByItem;
      storeSelected({ ...selectedRef.current, ...cleared });
      return;
    }

    try {
      const mine = await getMyItemReaction(normalized);
      if (expectedIdentity && contextRef.current.getIdentity() !== expectedIdentity) return;
      storeSelected({ ...selectedRef.current, ...mine });
    } catch {
      const cleared = Object.fromEntries(normalized.map((id) => [id, null])) as SelectedReactionsByItem;
      storeSelected({ ...selectedRef.current, ...cleared });
    }
  }, [readCounts, storeCounts, storeSelected]);

  useEffect(() => {
    const normalized = Array.from(new Set(itemIds.map((id) => String(id || '').trim()).filter(Boolean)));
    const identityAtLoad = contextRef.current.getIdentity();
    let cancelled = false;

    if (!normalized.length) {
      storeCounts({});
      storeSelected({});
      return () => { cancelled = true; };
    }

    storeCounts({
      ...buildReactionCountsByItem(normalized, []),
      ...countsRef.current,
    });
    storeSelected({
      ...Object.fromEntries(normalized.map((id) => [id, null])),
      ...selectedRef.current,
    });

    void (async () => {
      let nextCounts: ReactionCountsByItem;
      try {
        nextCounts = buildReactionCountsByItem(normalized, await readCounts(normalized));
      } catch {
        nextCounts = buildReactionCountsByItem(normalized, []);
      }
      if (cancelled || contextRef.current.getIdentity() !== identityAtLoad) return;
      storeCounts(nextCounts);

      if (!contextRef.current.enabled) {
        storeSelected(Object.fromEntries(normalized.map((id) => [id, null])) as SelectedReactionsByItem);
        return;
      }

      try {
        const mine = await getMyItemReaction(normalized);
        if (!cancelled && contextRef.current.getIdentity() === identityAtLoad) storeSelected(mine);
      } catch {
        if (!cancelled && contextRef.current.getIdentity() === identityAtLoad) {
          storeSelected(Object.fromEntries(normalized.map((id) => [id, null])) as SelectedReactionsByItem);
        }
      }
    })();

    return () => { cancelled = true; };
  }, [context.enabled, context.scopeKey, itemIds, readCounts, storeCounts, storeSelected]);

  const handleReact = useCallback((itemId: string, reactionType: DressingRoomReactionType) => {
    if (!contextRef.current.enabled) return;

    const currentReaction = selectedRef.current[itemId] ?? null;
    const previousCounts = countsRef.current[itemId] ?? createEmptyReactionCounts();
    const optimistic = applyOptimisticReaction({
      current: currentReaction,
      tapped: reactionType,
      counts: previousCounts as unknown as Record<string, number>,
    });

    selectionTick();
    setMutatingReactionItemId(itemId);
    storeSelected({ ...selectedRef.current, [itemId]: optimistic.nextSelection });
    storeCounts({
      ...countsRef.current,
      [itemId]: optimistic.nextCounts as unknown as ReactionCountsForItem,
    });

    queueRef.current.submit(
      itemId,
      {
        reactionType,
        active: optimistic.active,
        previousSelection: currentReaction,
        previousCounts,
        roomId: contextRef.current.roomId,
        identityAtTap: contextRef.current.getIdentity(),
      },
      async (payload, isSuperseded) => {
        try {
          // A queued trailing tap from a departed actor/room must never be sent.
          if (contextRef.current.getIdentity() !== payload.identityAtTap) return;
          await setItemReaction(itemId, payload.reactionType, {
            roomId: payload.roomId ?? undefined,
            active: payload.active,
          });
          if (isSuperseded() || contextRef.current.getIdentity() !== payload.identityAtTap) return;
          await refreshItemReactions([itemId], payload.identityAtTap);
        } catch {
          if (isSuperseded() || contextRef.current.getIdentity() !== payload.identityAtTap) return;
          storeSelected({ ...selectedRef.current, [itemId]: payload.previousSelection });
          storeCounts({ ...countsRef.current, [itemId]: payload.previousCounts });
          Alert.alert('Unable to save reaction.', 'Please try again.');
        } finally {
          if (!isSuperseded()) {
            setMutatingReactionItemId((current) => (current === itemId ? null : current));
          }
        }
      },
    );
  }, [refreshItemReactions, storeCounts, storeSelected]);

  const reset = useCallback(() => {
    countsRef.current = {};
    selectedRef.current = {};
    setReactionCounts({});
    setSelectedReactions({});
    setMutatingReactionItemId(null);
  }, []);

  return { reactionCounts, selectedReactions, mutatingReactionItemId, handleReact, reset };
}
