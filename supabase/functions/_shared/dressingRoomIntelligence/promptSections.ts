/**
 * Prompt-safe Room Intelligence sections (E4.1).
 *
 * WHY THIS EXISTS: the manifest is only useful if the model is told what it
 * MEANS. Previously the prompt listed evidence items with no statement that
 * the list was the whole room, so "what is missing?" had no grounded answer —
 * absence of a shoe in the list was indistinguishable from a shoe that simply
 * was not attached. This module states the room contract explicitly, and
 * states the limits of that contract just as explicitly.
 *
 * Every untrusted value is escaped by the caller-supplied escaper, so this
 * module cannot become a second escaping opinion (the Build 29 pass removed
 * one of those already).
 */

import type { RoomManifest } from './roomManifest.ts';

export type EscapeFn = (value: string) => string;

/**
 * The behavioural contract. Written as rules the model can apply rather than
 * prose, because these are the properties the runtime matrix asserts.
 */
function groundingRules(manifest: RoomManifest): string[] {
  const ownershipRule = manifest.roomKind === 'owned_room'
    ? 'These items belong to the user; "your jacket" is accurate.'
    // Shared and mixed rooms both fall here: in a mixed room the user owns
    // only part of it, so blanket ownership language is wrong for the rest.
    : 'Ownership is NOT established for every item. Say "the jacket in this room", never "your jacket".';

  return [
    'ROOM GROUNDING RULES (these override any styling instinct):',
    '1. The item list below is the COMPLETE and CURRENT contents of this room.',
    '   If a garment is not listed, it is not in the room. Absence is real, not unknown.',
    '2. Never state or imply that the room contains an item that is not listed.',
    '3. Anything you recommend that is not listed is a SUGGESTION. Introduce it as',
    '   one ("you could add...", "consider..."), never as something already present.',
    `4. ${ownershipRule}`,
    '5. Reason only over the fields given. Fields listed as unavailable were not',
    '   measured — say so if asked rather than estimating them.',
    '6. This list replaces anything said earlier in the conversation. If an item',
    '   you discussed before is absent now, it has been removed: do not reason',
    '   over it and do not ask the user to confirm its removal.',
    '7. Removing or keeping pieces is a valid answer. "Nothing is missing" is a',
    '   valid answer. Do not add a product merely to have something to say.',
  ];
}

/** Serialize the manifest as a typed, bounded, escaped prompt section. */
export function serializeRoomManifestSection(
  manifest: RoomManifest,
  escape: EscapeFn,
): string | null {
  if (!manifest.authorized || manifest.items.length === 0) return null;

  const lines: string[] = [
    '[Dressing Room — Server-Verified Room Contents]',
    'TRUST CLASS: IN_ROOM. Every item below was resolved and authorized by the',
    'server for this user. The descriptive values are server-held, not caller-supplied.',
    `roomKind: ${escape(manifest.roomKind)}`,
    `roomRevision: ${escape(manifest.revision)}`,
    `itemCount: ${manifest.items.length}`,
    `structureCoverage: upperBody=${manifest.coverage.hasUpperBody} ` +
      `lowerBody=${manifest.coverage.hasLowerBody} footwear=${manifest.coverage.hasFootwear}`,
  ];

  if (manifest.unavailableFields.length) {
    lines.push(
      `unavailableFields: [${manifest.unavailableFields.map((f) => escape(f)).join(', ')}]`,
      '  (not measured for these items — do not infer or invent them)',
    );
  }

  manifest.items.forEach((item, index) => {
    const p = `item[${index + 1}]`;
    const block = [
      `${p}.id: ${escape(item.itemId)}`,
      `${p}.role: ${escape(item.role)}`,
      `${p}.relationship: ${escape(item.relationship)}`,
    ];
    if (item.category) block.push(`${p}.category: ${escape(item.category)}`);
    if (item.subtype) block.push(`${p}.subtype: ${escape(item.subtype)}`);
    if (item.primaryColor) block.push(`${p}.primaryColor: ${escape(item.primaryColor)}`);
    if (item.otherColors.length) {
      block.push(`${p}.otherColors: [${item.otherColors.map(escape).join(', ')}]`);
    }
    if (item.materials.length) {
      block.push(`${p}.materials: [${item.materials.map(escape).join(', ')}]`);
    }
    if (item.silhouette) block.push(`${p}.silhouette: ${escape(item.silhouette)}`);
    if (item.brand) block.push(`${p}.brand: ${escape(item.brand)}`);
    if (item.occasion.length) {
      block.push(`${p}.occasionEvidence: [${item.occasion.map(escape).join(', ')}]`);
    }
    // Stated per item so the model does not assume it can "see" every piece.
    block.push(`${p}.imageAvailable: ${item.hasAuthorizedImage}`);
    lines.push(...block);
  });

  lines.push('', ...groundingRules(manifest));
  return lines.join('\n');
}

/**
 * The reasoning affordance section.
 *
 * Separate from the grounding rules because it is advisory, not a constraint —
 * and because keeping "what you may reason about" apart from "what you may not
 * claim" makes it obvious which lines are safety-bearing.
 */
export function serializeRoomReasoningSection(manifest: RoomManifest): string | null {
  if (!manifest.authorized || manifest.items.length === 0) return null;

  return [
    '[Dressing Room — Styling Frame]',
    'Judge this room as ONE outfit in progress, not a list of separate garments.',
    'Useful dimensions: colour harmony, silhouette and proportion, material and',
    'pattern interplay, formality, occasion where evidence exists, layering, and',
    'overall visual weight and coherence.',
    'Item roles (one_piece, top, bottom, outer_layer, footwear, accessory) are',
    'given per item; a one_piece already covers both upper and lower body.',
    'A piece may act as the anchor that the rest is built around. If asked which',
    'anchors the look, name an item from the list and say why.',
    'Valid conclusions include: it works as-is, remove a piece, swap a piece,',
    'restyle without adding, or add one specific missing piece. Choose whichever',
    'is actually true for this room.',
    'Keep the answer concise and speakable.',
  ].join('\n');
}
