import type { PackingPlan } from '../types/packing';

export type RefinementChipKind = 'constraint' | 'action';
export interface RefinementChip { id: string; label: string; message: string; kind: RefinementChipKind; }

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

export function packingChipIsActive(chip: RefinementChip, plan: PackingPlan | null | undefined): boolean {
  if (chip.kind !== 'constraint' || !plan) return false;
  const notes = plan.constraints.notes.map((note) => note.toLowerCase());
  switch (chip.id) {
    case 'no_heels': return notes.some((note) => /\bno\s+heels?\b|\bwithout\s+heels?\b/.test(note));
    case 'carry_on': return notes.some((note) => /\bcarry[- ]on\s+only\b/.test(note));
    case 'warmer': return notes.some((note) => /\bwarmer\b|\bfor\s+the\s+cold\b/.test(note));
    case 'lighter_layers': return notes.some((note) => /\blighter\s+layers?\b/.test(note));
    default: return false;
  }
}
