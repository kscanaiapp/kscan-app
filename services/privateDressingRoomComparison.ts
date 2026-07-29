/**
 * Two-look comparison over EFFECTIVE looks.
 *
 * PURE, and a LIVE PROJECTION rather than a stored snapshot. Only the two base
 * Phase 2 `lookId` values are ever persisted; the rows below are rebuilt from
 * the current composition plus the current valid overrides every time they are
 * needed. That is what makes a swap on a compared look show up immediately
 * without any cache to invalidate — and it means no synthetic effective-look or
 * comparison identifier exists to go stale.
 *
 * NO WINNER. Phase 3 supports comparison, not automated selection. Nothing here
 * computes a score, a recommendation, or a "best" — the projection reports what
 * is the same, what differs and what is absent, and the decision stays the
 * user's.
 */

import { PRIVATE_SLOT_DISPLAY_ORDER } from '../types/privateDressingRoomComposition';
import type {
  PrivateDressingRoomSlot,
  PrivateLookCompleteness,
} from '../types/privateDressingRoomComposition';
import type { EffectiveLook, EffectiveLookItem } from './privateDressingRoomEffectiveLook';

export type ComparisonRow = {
  slot: PrivateDressingRoomSlot;
  left: EffectiveLookItem | null;
  right: EffectiveLookItem | null;
  /** Both sides present and the same garment. */
  same: boolean;
  /** Both sides present and different garments. */
  different: boolean;
  missingLeft: boolean;
  missingRight: boolean;
  /** This slot holds the session anchor, which is identical on both sides. */
  anchor: boolean;
};

export type ComparisonProjection = {
  available: boolean;
  unavailableReason: 'NEEDS_TWO_LOOKS' | 'LOOK_UNAVAILABLE' | null;
  leftLookId: string | null;
  rightLookId: string | null;
  leftLabel: string | null;
  rightLabel: string | null;
  /**
   * The anchor row, hoisted out of `rows` for presentation when it is identical
   * on both sides. It REMAINS in `rows` as well, so accessibility and
   * validation still see the complete outfit.
   */
  anchorRow: ComparisonRow | null;
  rows: ComparisonRow[];
  differenceCount: number;
  leftCompleteness: PrivateLookCompleteness | null;
  rightCompleteness: PrivateLookCompleteness | null;
  leftMissingSlots: PrivateDressingRoomSlot[];
  rightMissingSlots: PrivateDressingRoomSlot[];
  /** True when the two looks differ in whether they are complete. */
  completenessDiffers: boolean;
};

const UNAVAILABLE: ComparisonProjection = Object.freeze({
  available: false,
  unavailableReason: 'NEEDS_TWO_LOOKS',
  leftLookId: null,
  rightLookId: null,
  leftLabel: null,
  rightLabel: null,
  anchorRow: null,
  rows: [],
  differenceCount: 0,
  leftCompleteness: null,
  rightCompleteness: null,
  leftMissingSlots: [],
  rightMissingSlots: [],
  completenessDiffers: false,
});

function itemForSlot(
  look: EffectiveLook | null,
  slot: PrivateDressingRoomSlot,
): EffectiveLookItem | null {
  if (!look) return null;
  for (const item of look.items) {
    if (item.slot === slot) return item;
  }
  return null;
}

/** "Look 1", "Look 2" — derived from Phase 2 rank, never invented. */
function labelFor(look: EffectiveLook | null): string | null {
  return look ? `Look ${look.rank + 1}` : null;
}

/**
 * Choose the default pair deterministically.
 *
 * Left is the active look. Right is the highest-RANKED look whose id differs —
 * by Phase 2 `rank`, with the canonical `lookId` tie-break, never by current
 * array order. Returns null when fewer than two looks exist; a duplicate is
 * never manufactured to make a pair.
 */
export function defaultComparisonPair(
  looks: readonly EffectiveLook[] | null | undefined,
  activeLookId: string | null | undefined,
): [string, string] | null {
  const available = Array.isArray(looks) ? looks.filter(Boolean) : [];
  if (available.length < 2) return null;

  const ordered = [...available].sort(
    (a, b) => a.rank - b.rank || (a.lookId < b.lookId ? -1 : a.lookId > b.lookId ? 1 : 0),
  );
  const left = ordered.find((look) => look.lookId === activeLookId) ?? ordered[0];
  const right = ordered.find((look) => look.lookId !== left.lookId);
  return right ? [left.lookId, right.lookId] : null;
}

/**
 * Build the aligned comparison.
 *
 * Rows follow the canonical slot order and cover the UNION of both looks'
 * slots, so a garment present on one side and absent on the other produces a
 * row rather than silently disappearing.
 */
export function projectComparison(input: {
  looks: readonly EffectiveLook[] | null | undefined;
  comparedLookIds: readonly string[] | null | undefined;
  anchorClosetItemId?: string | null;
}): ComparisonProjection {
  const looks = Array.isArray(input?.looks) ? input.looks.filter(Boolean) : [];
  const selected = Array.isArray(input?.comparedLookIds) ? input.comparedLookIds : [];

  if (looks.length < 2) return { ...UNAVAILABLE, unavailableReason: 'NEEDS_TWO_LOOKS' };
  if (selected.length !== 2 || selected[0] === selected[1]) {
    return { ...UNAVAILABLE, unavailableReason: 'NEEDS_TWO_LOOKS' };
  }

  const left = looks.find((look) => look.lookId === selected[0]) ?? null;
  const right = looks.find((look) => look.lookId === selected[1]) ?? null;
  // A selected look that no longer exists invalidates the pair rather than
  // silently comparing against something else.
  if (!left || !right) return { ...UNAVAILABLE, unavailableReason: 'LOOK_UNAVAILABLE' };

  const anchorId = input.anchorClosetItemId ?? null;
  const slots: PrivateDressingRoomSlot[] = [];
  for (const slot of PRIVATE_SLOT_DISPLAY_ORDER) {
    const present =
      left.items.some((item) => item.slot === slot) ||
      right.items.some((item) => item.slot === slot);
    if (present) slots.push(slot);
  }

  const rows: ComparisonRow[] = [];
  let differenceCount = 0;
  let anchorRow: ComparisonRow | null = null;

  for (const slot of slots) {
    const leftItem = itemForSlot(left, slot);
    const rightItem = itemForSlot(right, slot);
    const same =
      !!leftItem && !!rightItem && leftItem.closetItemId === rightItem.closetItemId;
    const different =
      !!leftItem && !!rightItem && leftItem.closetItemId !== rightItem.closetItemId;
    const missingLeft = !leftItem;
    const missingRight = !rightItem;
    // The anchor is the anchor only where BOTH sides carry it — that is the
    // case presentation may safely merge into a shared header.
    const anchor =
      !!anchorId &&
      leftItem?.closetItemId === anchorId &&
      rightItem?.closetItemId === anchorId;

    const row: ComparisonRow = {
      slot,
      left: leftItem,
      right: rightItem,
      same,
      different,
      missingLeft,
      missingRight,
      anchor,
    };
    if (different || missingLeft || missingRight) differenceCount += 1;
    if (anchor && !anchorRow) anchorRow = row;
    rows.push(row);
  }

  return {
    available: true,
    unavailableReason: null,
    leftLookId: left.lookId,
    rightLookId: right.lookId,
    leftLabel: labelFor(left),
    rightLabel: labelFor(right),
    anchorRow,
    rows,
    differenceCount,
    leftCompleteness: left.completeness,
    rightCompleteness: right.completeness,
    leftMissingSlots: [...left.missingSlots],
    rightMissingSlots: [...right.missingSlots],
    completenessDiffers: left.completeness !== right.completeness,
  };
}

/** Whether a Compare entry should be offered at all. */
export function canCompare(looks: readonly EffectiveLook[] | null | undefined): boolean {
  return Array.isArray(looks) && looks.filter(Boolean).length >= 2;
}

/** Copy for the comparison surface. Deliberately contains no winner language. */
export const PRIVATE_COMPARISON_COPY = Object.freeze({
  entry: 'Compare looks',
  title: 'Compare',
  needsTwoLooks: 'You need another outfit to compare.',
  lookUnavailable: 'One of those outfits is no longer available.',
  same: 'Same in both',
  differs: 'Different',
  missing: 'Not in this look',
  anchorRow: 'Both looks are built around this piece.',
  close: 'Close comparison',
});
