// Build 35 -- refinement shortcuts for Packing and Wardrobe Concierge.
//
// A chip is a SHORTCUT, not a second refinement engine. Each one sends an
// ordinary sentence through the same path free text takes -- Packing's
// `refineWith` into packingRefinementIntent, Concierge's chat send into
// eliseOutfitState.readRefinementDirectives -- so a chip and the words it
// stands for can never mean two different things. The sentence is chosen so
// the existing deterministic reader recognises it; __tests__/refinementChips
// proves that against the real server modules.
//
// Two kinds, kept apart on purpose (section 36):
//   constraint -- a standing rule for the active task ("No heels"). The chip
//                 reflects it once it is in the plan's state.
//   action     -- a one-shot request ("Fewer shoes", "Another"). Never shown
//                 as a toggle: there is nothing to be "on".

export type RefinementChipKind = 'constraint' | 'action';

export interface RefinementChip {
  id: string;
  label: string;
  /** The sentence sent, exactly as if typed. */
  message: string;
  kind: RefinementChipKind;
}

export const PACKING_REFINEMENT_CHIPS: readonly RefinementChip[] = [
  { id: 'lighter_layers', label: 'Lighter layers', message: 'Lighter layers', kind: 'constraint' },
  { id: 'warmer', label: 'Warmer', message: 'Make it warmer', kind: 'constraint' },
  { id: 'fewer_shoes', label: 'Fewer shoes', message: 'Fewer shoes', kind: 'action' },
  { id: 'more_repeats', label: 'More repeats', message: 'Pack lighter with more repeats', kind: 'action' },
  { id: 'no_heels', label: 'No heels', message: 'No heels', kind: 'constraint' },
  { id: 'carry_on', label: 'Carry-on only', message: 'Carry-on only', kind: 'constraint' },
];

export const CONCIERGE_REFINEMENT_CHIPS: readonly RefinementChip[] = [
  { id: 'more_casual', label: 'More casual', message: 'Make it more casual', kind: 'constraint' },
  { id: 'dressier', label: 'Dressier', message: 'Make it dressier', kind: 'constraint' },
  { id: 'different_shoes', label: 'Different shoes', message: 'Different shoes', kind: 'action' },
  { id: 'different_color', label: 'Different color', message: 'Another version in a different colour', kind: 'action' },
  { id: 'owned_only', label: 'Use what I own', message: 'Closet only', kind: 'constraint' },
  { id: 'another', label: 'Another', message: 'Another', kind: 'action' },
];

/**
 * Whether a Packing constraint chip is already in force, read from the plan's
 * opaque state. Only ever answers for `constraint` chips; an action is never
 * "on". The state is the server's record, so the chip shows what the plan
 * actually enforces rather than what was tapped.
 */
export function packingChipIsActive(chip: RefinementChip, state: Record<string, unknown> | null | undefined): boolean {
  if (chip.kind !== 'constraint' || !state) return false;
  const constraints = Array.isArray(state.activeConstraints) ? state.activeConstraints : [];
  const rejectedClasses = Array.isArray(state.rejectedGarmentClasses) ? state.rejectedGarmentClasses : [];
  switch (chip.id) {
    case 'no_heels':
      return rejectedClasses.includes('heel');
    case 'carry_on':
      return constraints.includes('carry_on');
    case 'warmer':
      return constraints.includes('warmth:warmer');
    case 'lighter_layers':
      return constraints.includes('warmth:lighter');
    default:
      return false;
  }
}
