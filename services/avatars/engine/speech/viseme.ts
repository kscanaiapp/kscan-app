import type { AvatarAssetCapabilities, AvatarMouthState, AvatarViseme } from '../types';

const ROUND = new Set(['o', 'u', 'w', 'q']);
const WIDE = new Set(['e', 'i', 'y']);
const OPEN = new Set(['a']);
const LABIAL = new Set(['b', 'm', 'p']);

/**
 * Visual viseme derivation, not phonetics. The only claim being made is which
 * mouth shape reads correctly for this character at this instant.
 *
 * This intentionally differs from the legacy `characterToMouthState` in one
 * respect: b/m/p are labial closures and resolve to a CLOSED mouth, where the
 * legacy path opened them to `halfOpen`. Shadow mode exists partly to measure
 * that difference against real speech before it becomes visible.
 */
export function characterToViseme(char: string): AvatarViseme {
  if (/\s/.test(char) || /[.,!?;:'"()\-\u2014]/.test(char)) return 'rest';
  const c = char.toLowerCase();
  if (ROUND.has(c)) return 'round';
  if (WIDE.has(c)) return 'wide';
  if (OPEN.has(c)) return 'open';
  if (LABIAL.has(c)) return 'labial';
  if (/[a-z]/.test(c)) return 'consonant';
  return 'rest';
}

export function phonemeToViseme(phoneme: string): AvatarViseme {
  const p = phoneme.toUpperCase().replace(/[0-9]/g, '');
  if (['M', 'B', 'P'].includes(p)) return 'labial';
  if (['OW', 'UW', 'UH', 'W', 'AO'].includes(p)) return 'round';
  if (['IY', 'IH', 'EH', 'EY', 'Y'].includes(p)) return 'wide';
  if (['AA', 'AE', 'AH', 'AY'].includes(p)) return 'open';
  if (['SIL', 'SP', 'PAU'].includes(p)) return 'rest';
  return 'consonant';
}

/**
 * Capability-aware fallback. A package that lacks a shape degrades to the
 * nearest shape it actually ships, and a package with no approved closed mouth
 * is not animated at all. The engine never substitutes another avatar's art and
 * never asks the renderer for a state the package cannot draw.
 */
export function visemeToMouthState(viseme: AvatarViseme, caps: AvatarAssetCapabilities): AvatarMouthState {
  if (!caps.mouthClosed) return 'closed';
  switch (viseme) {
    case 'rest':
    case 'labial':
      return 'closed';
    case 'round':
      return caps.mouthRound ? 'round' : caps.mouthOpen ? 'open' : caps.mouthHalfOpen ? 'halfOpen' : 'closed';
    case 'wide':
      return caps.mouthWide ? 'wide' : caps.mouthOpen ? 'open' : caps.mouthHalfOpen ? 'halfOpen' : 'closed';
    case 'open':
      return caps.mouthOpen ? 'open' : caps.mouthHalfOpen ? 'halfOpen' : 'closed';
    case 'consonant':
      return caps.mouthHalfOpen ? 'halfOpen' : caps.mouthOpen ? 'open' : 'closed';
  }
}
