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
  const normalizedItemId = String(itemId || '').trim();
  return normalizedItemId.length > 0 ? normalizedItemId : null;
}

function buildReactionCountsByItem(itemIds: string[], rows: ItemReactionCount[]): ReactionCountsByItem {
  const base = Object.fromEntries(
    itemIds.map((itemId) => [itemId, createEmptyReactionCounts()]),
  ) as ReactionCountsByItem;
  rows.forEach((row) => {
    const itemId = String(row.item_id || '').trim();
    if (!itemId || !base[itemId]) return;
    if (!isActiveDressingRoomReactionType(row.reaction_type)) return;
    base[itemId][row.reaction_type] = Number.isFinite(row.count) ? row.count : 0;
  });
  return base;
}

type ReactionSurfaceContext = {
  /** Gates a tap before anything happens: not signed in, or no room capability. */
  enabled: boolean;
  /** The room this reaction is scoped to, sent with the mutation. */
  roomId: string | null;
  /**
   * A live "who/where" fingerprint, read fresh on every call from the
   * caller's own state. A tap snapshots this once at the start; any change
   * by the time the network call resolves (room switch, actor switch,
   * sign-out) means a stale completion must neither reconcile against
   * server truth nor roll back — the surface has already moved on.
   */
  getIdentity: () => string;
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
  /**
   * Clears all reaction state. The caller invokes this at the same
   * actor/room boundaries it uses for its own canonical state (sign-out,
   * account switch, room/token switch) so a stale optimistic reaction can
   * never render under a different actor or room than the one it was made
   * under.
   */
  reset: () => void;
};

/**
 * Canonical Dressing Room reaction state machine, shared by the owner screen
 * and the public shared-room screen so a fix (or a semantic, like the tap
 * haptic) only ever has to land once. The pure count/selection math lives in
 * services/dressingRoomReactionOptimism.ts; rapid-tap sequencing lives in
 * services/latestIntentMutationQueue.ts, which bounds N rapid taps on one
 * item to at most one in-flight call plus one trailing call carrying the
 * customer's LAST choice.
 */
export function useDressingRoomReactions(
  itemIds: string[],
  context: ReactionSurfaceContext,
): UseDressingRoomReactionsResult {
  const [reactionCounts, setReactionCounts] = useState<ReactionCountsByItem>({});
  const [selectedReactions, setSelectedReactions] = useState<SelectedReactionsByItem>({});
  const [mutatingReactionItemId, setMutatingReactionItemId] = useState<string | null>(null);

  const contextRef = useRef(context);
  contextRef.current = context;

  const queueRef = useRef(createLatestIntentQueue<PendingReactionPayload>());

  const refreshItemReactions = useCallback(async (ids: string[]) => {
    const normalizedItemIds = Array.from(
      new Set(ids.map((itemId) => String(itemId || '').trim()).filter(Boolean)),
    );
    if (normalizedItemIds.length === 0) return;

    try {
      const counts = await getItemReactionCounts(normalizedItemIds);
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, counts),
      }));
    } catch {
      setReactionCounts((current) => ({
        ...current,
        ...buildReactionCountsByItem(normalizedItemIds, []),
      }));
    }

    if (!contextRef.current.enabled) {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
      return;
    }

    try {
      const mine = await getMyItemReaction(normalizedItemIds);
      setSelectedReactions((current) => ({ ...current, ...mine }));
    } catch {
      setSelectedReactions((current) => ({
        ...current,
        ...Object.fromEntries(normalizedItemIds.map((itemId) => [itemId, null])),
      }));
    }
  }, []);

  useEffect(() => {
    if (itemIds.length === 0) {
      setReactionCounts({});
      setSelectedReactions({});
      return;
    }

    setReactionCounts((current) => ({
      ...buildReactionCountsByItem(itemIds, []),
      ...current,
    }));
    setSelectedReactions((current) => ({
      ...Object.fromEntries(itemIds.map((itemId) => [itemId, null])),
      ...current,
    }));

    let cancelled = false;

    const loadReactions = async () => {
      try {
        const counts = await getItemReactionCounts(itemIds);
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(itemIds, counts));
        }
      } catch {
        if (!cancelled) {
          setReactionCounts(buildReactionCountsByItem(itemIds, []));
        }
      }

      if (!context.enabled) {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(itemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
        return;
      }

      try {
        const mine = await getMyItemReaction(itemIds);
        if (!cancelled) {
          setSelectedReactions(mine);
        }
      } catch {
        if (!cancelled) {
          setSelectedReactions(
            Object.fromEntries(itemIds.map((itemId) => [itemId, null])) as SelectedReactionsByItem,
          );
        }
      }
    };

    void loadReactions();

    return () => {
      cancelled = true;
    };
  }, [itemIds, context.enabled]);

  const handleReact = useCallback(
    (itemId: string, reactionType: DressingRoomReactionType) => {
      if (!contextRef.current.enabled) return;

      const currentReaction = selectedReactions[itemId] ?? null;
      const previousCounts = reactionCounts[itemId] ?? createEmptyReactionCounts();
      const optimistic = applyOptimisticReaction({
        current: currentReaction,
        tapped: reactionType,
        counts: previousCounts as unknown as Record<string, number>,
      });

      // Immediate feedback: the visual change and the haptic both happen
      // before the network call is even started. Do not wait on the round
      // trip -- a reaction that waits to appear reads as a broken control.
      selectionTick();
      setMutatingReactionItemId(itemId);
      setSelectedReactions((current) => ({ ...current, [itemId]: optimistic.nextSelection }));
      setReactionCounts((current) => ({
        ...current,
        [itemId]: optimistic.nextCounts as unknown as ReactionCountsForItem,
      }));

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
            await setItemReaction(itemId, payload.reactionType, {
              roomId: payload.roomId ?? undefined,
              active: payload.active,
            });
            if (isSuperseded() || contextRef.current.getIdentity() !== payload.identityAtTap) return;
            // Reconcile against server truth: other participants may have
            // reacted to the same item while this one was in flight.
            await refreshItemReactions([itemId]);
          } catch {
            if (isSuperseded() || contextRef.current.getIdentity() !== payload.identityAtTap) return;
            // Truthful rollback: a lost membership, a block, a revoked
            // share, or a plain network failure all land here, and the
            // reaction must not linger on screen as though it had been
            // recorded.
            setSelectedReactions((current) => ({ ...current, [itemId]: payload.previousSelection }));
            setReactionCounts((current) => ({ ...current, [itemId]: payload.previousCounts }));
            Alert.alert('Unable to save reaction.', 'Please try again.');
          } finally {
            if (!isSuperseded()) {
              setMutatingReactionItemId((current) => (current === itemId ? null : current));
            }
          }
        },
      );
    },
    [reactionCounts, refreshItemReactions, selectedReactions],
  );

  const reset = useCallback(() => {
    setReactionCounts({});
    setSelectedReactions({});
    setMutatingReactionItemId(null);
  }, []);

  return { reactionCounts, selectedReactions, mutatingReactionItemId, handleReact, reset };
}
