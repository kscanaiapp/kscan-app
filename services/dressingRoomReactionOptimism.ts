/**
 * Optimistic reaction state for Dressing Rooms.
 *
 * A reaction that waits for a round trip before it appears reads as a broken
 * control, so both room surfaces apply the change locally first. This module is
 * the pure part of that: given the current selection and counts it returns the
 * next ones, and it is the ONLY place the count arithmetic lives, so the owner
 * screen and the shared-room screen can never drift apart on what a tap does.
 *
 * It deliberately holds no authority. The server decides whether the reaction is
 * allowed (set_dressing_room_item_reaction re-resolves access and rejects a
 * removed or blocked actor), and the caller reconciles against the server after
 * every success. What this provides is the *display* answer while that is in
 * flight, plus the exact prior values to restore if the server says no.
 */

export type ReactionCounts = Record<string, number>;

export type ReactionOptimisticInput<T extends string> = {
  /** The reaction currently attributed to this actor, or null for none. */
  current: T | null;
  /** The reaction the actor just tapped. */
  tapped: T;
  /** Live counts for the item, by reaction type. */
  counts: ReactionCounts;
};

export type ReactionOptimisticResult<T extends string> = {
  /** The selection to show while the mutation is in flight. */
  nextSelection: T | null;
  /** Counts to show while the mutation is in flight. Never negative. */
  nextCounts: ReactionCounts;
  /** True when the tap turns the reaction ON, false when it clears it. */
  active: boolean;
};

function clampCount(value: unknown): number {
  const numeric = typeof value === 'number' && Number.isFinite(value) ? value : 0;
  // Counts are cardinalities: a local decrement must never render a negative,
  // even if the counts this actor holds are momentarily behind the server.
  return numeric < 0 ? 0 : numeric;
}

/**
 * Tapping the reaction already attributed to this actor clears it; tapping a
 * different one moves it. One actor holds at most one reaction per item, which
 * is what the (item_id, user_id) unique index enforces server-side, so the
 * local arithmetic mirrors the same rule rather than inventing a second one.
 */
export function applyOptimisticReaction<T extends string>(
  input: ReactionOptimisticInput<T>,
): ReactionOptimisticResult<T> {
  const { current, tapped, counts } = input;
  const active = current !== tapped;
  const nextCounts: ReactionCounts = { ...counts };

  if (current) {
    nextCounts[current] = clampCount(clampCount(nextCounts[current]) - 1);
  }
  if (active) {
    nextCounts[tapped] = clampCount(nextCounts[tapped]) + 1;
  }

  return {
    nextSelection: active ? tapped : null,
    nextCounts,
    active,
  };
}
