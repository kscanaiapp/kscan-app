/**
 * Compact per-family visual discriminator packs (Phase 7.2 §6).
 *
 * A pack names the construction evidence that separates SIMILAR members of one
 * garment family — the geometry a second look should examine once the family is
 * already established.
 *
 * WHERE THESE ARE USED, AND WHERE THEY ARE NOT:
 *   - The RECHECK prompt receives exactly one pack, chosen from the family the
 *     first pass already identified. That is the whole point: after pass one the
 *     family is known, so the second look can ask a specific question instead of
 *     "look again".
 *   - The PRIMARY prompt does NOT receive these packs. Emitting every family's
 *     cues on every scan would be hundreds of tokens of irrelevant categories on
 *     work that is already paid for (§4). The primary prompt instead carries one
 *     short attention block covering all families.
 *
 * KEYED ON THE REPOSITORY'S ACTUAL TAXONOMY, not a new theoretical one. The
 * level-1 vocabulary is whatever `normalizeCategory` returns: blazer, outerwear,
 * dress, pants, top, footwear, bag, accessory. Inventing a family outside that
 * set would produce a pack that no scan can ever select.
 *
 * THESE ARE ATTENTION CUES, NOT CLASSIFICATION RULES. Nothing here maps evidence
 * to an answer; no pack says "wide leg ⇒ wide_leg_jeans". A deterministic
 * mapping would be a hard-coded ontology, which §24 forbids and which would
 * override the model on exactly the cases it can see better than a rule can.
 */

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { normalizeCategory } from '../_shared/scanHelpers.ts';

/** The level-1 families `normalizeCategory` can actually return. */
export const DISCRIMINATOR_FAMILIES = [
  'pants',
  'top',
  'outerwear',
  'blazer',
  'dress',
  'footwear',
  'bag',
  'accessory',
] as const;

export type DiscriminatorFamily = typeof DISCRIMINATOR_FAMILIES[number];

/**
 * One line per family. Kept to a single sentence each because the entire pack is
 * injected into a prompt whose output budget is shared with reasoning tokens —
 * the Phase 6 constraint. Verbosity here is paid for twice: once on input, and
 * again by crowding the structured answer.
 */
const PACKS: Readonly<Record<DiscriminatorFamily, string>> = {
  pants:
    'leg width and taper, flare point, rise and waistband construction, denim vs tailored vs technical fabric, pocket style (patch, slash, cargo), pleats, cuff and hem finish, and overall length (cropped, full, stacked).',
  top:
    'neckline and collar shape, sleeve length and cut, placket or button stand, knit vs woven construction, ribbing at cuff and hem, body shape (fitted, boxy, cropped), and any hood or drawcord.',
  outerwear:
    'collar or lapel type, closure (zip, snap, button, double-breasted), body length, insulation and quilting pattern, hood presence, pocket construction, cuff finish, and whether the shoulder is tailored or dropped.',
  blazer:
    'lapel type (notch, peak, shawl), button stance and single vs double-breasted, shoulder structure and padding, vent count, pocket style (flap, patch, jetted), and body length and suppression at the waist.',
  dress:
    'waist placement (empire, natural, drop, none), hem length, skirt flare and pleating, slit, neckline, sleeve treatment, and whether the fabric is structured or draped.',
  footwear:
    'toe shape, sole profile and tread, heel type and height, shaft height, lacing or closure system, upper construction and paneling, and whether the silhouette reads as sneaker, boot, loafer, derby, sandal or heel.',
  bag:
    'body shape and structure, closure (zip, flap, drawstring, magnetic), handle and strap configuration, gusset and base construction, hardware style, and overall scale relative to the wearer.',
  accessory:
    'the object\'s actual form and function, material and surface finish, hardware and fastening, and the construction details that separate it from visually similar accessory types.',
};

/**
 * Resolves the family for a pack from whatever taxonomy values the first pass
 * produced.
 *
 * Tries category first, then clothingType, then subtype — broad to narrow,
 * because `normalizeCategory` is most reliable on the broad label and the
 * narrower tiers are exactly the ones under dispute when a recheck runs. Returns
 * null when no level maps to a known family, which is an honest "no pack
 * applies" rather than a default pack that would point the recheck at the wrong
 * evidence.
 */
export function resolveDiscriminatorFamily(identity: {
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
}): DiscriminatorFamily | null {
  for (const candidate of [identity.category, identity.clothingType, identity.subtype]) {
    if (typeof candidate !== 'string' || !candidate.trim()) continue;
    const normalized = normalizeCategory(candidate);
    if ((DISCRIMINATOR_FAMILIES as readonly string[]).includes(normalized)) {
      return normalized as DiscriminatorFamily;
    }
  }
  return null;
}

/** The pack text for a family, or null when the family is unknown. */
export function getDiscriminatorPack(family: DiscriminatorFamily | null): string | null {
  if (family === null) return null;
  return PACKS[family] ?? null;
}

/**
 * The line injected into the recheck prompt.
 *
 * Returns null when no family resolved, so the caller sends the generic recheck
 * rather than a fabricated focus. A recheck aimed at the wrong family's evidence
 * is worse than one aimed at nothing in particular.
 */
export function buildDiscriminatorFocus(identity: {
  category: string | null;
  clothingType: string | null;
  subtype: string | null;
}): { family: DiscriminatorFamily; focus: string } | null {
  const family = resolveDiscriminatorFamily(identity);
  const pack = getDiscriminatorPack(family);
  if (family === null || pack === null) return null;
  return { family, focus: pack };
}
