/**
 * Free Tier Utility Expansion — rules-based outfit generator.
 * Pure local logic over saved items. No AI, no backend. Suggestions only.
 */

import type {
  NormalizedItem,
  OutfitFeedbackEntry,
  SuggestedOutfit,
} from './wardrobeUtilityTypes';

export type CategoryBucket =
  | 'top'
  | 'bottom'
  | 'dress'
  | 'outerwear'
  | 'footwear'
  | 'bag'
  | 'accessory'
  | 'other';

const BUCKET_KEYWORDS: Array<[CategoryBucket, string[]]> = [
  ['outerwear', ['jacket', 'coat', 'blazer', 'outerwear', 'parka', 'trench', 'cardigan']],
  ['dress', ['dress', 'gown', 'jumpsuit', 'romper']],
  ['top', ['top', 'shirt', 'tee', 't-shirt', 'blouse', 'sweater', 'hoodie', 'knit', 'polo', 'tank']],
  ['bottom', ['bottom', 'jean', 'pant', 'trouser', 'skirt', 'short', 'chino', 'legging', 'denim']],
  ['footwear', ['shoe', 'sneaker', 'boot', 'heel', 'loafer', 'sandal', 'footwear', 'trainer']],
  ['bag', ['bag', 'tote', 'backpack', 'purse', 'clutch', 'crossbody']],
  ['accessory', ['accessor', 'hat', 'scarf', 'belt', 'jewel', 'watch', 'sunglass', 'cap', 'glove', 'tie']],
];

export function bucketForCategory(category?: string): CategoryBucket {
  if (!category) return 'other';
  const lower = category.toLowerCase();
  for (const [bucket, keywords] of BUCKET_KEYWORDS) {
    if (keywords.some((k) => lower.includes(k))) return bucket;
  }
  return 'other';
}

// ── Color compatibility (intentionally forgiving) ────────────────────────────
const NEUTRAL_KEYWORDS = ['black', 'white', 'grey', 'gray', 'beige', 'cream', 'ivory', 'tan', 'navy', 'denim', 'khaki', 'brown', 'charcoal', 'camel', 'off-white', 'neutral'];

const COLOR_FAMILIES: Array<[string, string[]]> = [
  ['red', ['red', 'burgundy', 'maroon', 'wine', 'crimson']],
  ['pink', ['pink', 'rose', 'blush', 'fuchsia']],
  ['orange', ['orange', 'rust', 'coral', 'peach', 'terracotta']],
  ['yellow', ['yellow', 'mustard', 'gold']],
  ['green', ['green', 'olive', 'sage', 'emerald', 'mint', 'forest']],
  ['blue', ['blue', 'teal', 'turquoise', 'cobalt', 'sky']],
  ['purple', ['purple', 'plum', 'lavender', 'violet', 'lilac', 'aubergine']],
];

export function isNeutralColor(color?: string): boolean {
  if (!color) return true; // unknown color should not block pairing
  const lower = color.toLowerCase();
  return NEUTRAL_KEYWORDS.some((k) => lower.includes(k));
}

/**
 * Exported additively so the private Dressing Room composer can reuse this
 * vocabulary instead of declaring a parallel one. Behaviour is unchanged.
 */
export function colorFamily(color?: string): string | null {
  if (!color) return null;
  const lower = color.toLowerCase();
  for (const [family, keywords] of COLOR_FAMILIES) {
    if (keywords.some((k) => lower.includes(k))) return family;
  }
  return null;
}

/** Obvious-clash-only check: neutrals pair broadly; same family pairs; the rest is allowed once. */
export function colorsCompatible(a?: string, b?: string): boolean {
  if (isNeutralColor(a) || isNeutralColor(b)) return true;
  const familyA = colorFamily(a);
  const familyB = colorFamily(b);
  if (!familyA || !familyB) return true;
  if (familyA === familyB) return true;
  const clashes = new Set(['red|green', 'green|red', 'red|pink', 'pink|red', 'orange|pink', 'pink|orange']);
  return !clashes.has(familyA + '|' + familyB);
}

// ── Feedback helpers ─────────────────────────────────────────────────────────
function feedbackFor(
  feedback: Record<string, OutfitFeedbackEntry> | undefined,
  itemId: string
): OutfitFeedbackEntry | undefined {
  return feedback ? feedback[itemId] : undefined;
}

function isNegative(entry?: OutfitFeedbackEntry): boolean {
  if (!entry) return false;
  return (entry.tags || []).some(
    (t) => t === 'Would not wear' || t === 'Not practical'
  );
}

function isPositive(entry?: OutfitFeedbackEntry): boolean {
  if (!entry) return false;
  if ((entry.tags || []).includes('Would wear again')) return true;
  return typeof entry.rating === 'number' && entry.rating >= 4;
}

function occasionOverlap(a: NormalizedItem, b: NormalizedItem): boolean {
  const tagsA = a.occasionTags ?? [];
  const tagsB = b.occasionTags ?? [];
  if (tagsA.length === 0 || tagsB.length === 0) return false;
  const setA = new Set(tagsA.map((t) => t.toLowerCase()));
  return tagsB.some((t) => setA.has(t.toLowerCase()));
}

// ── Generation ───────────────────────────────────────────────────────────────
export interface GenerateOutfitsOptions {
  feedback?: Record<string, OutfitFeedbackEntry>;
  maxOutfits?: number;
}

const OUTFIT_TEMPLATES: Array<{ slots: CategoryBucket[]; label: string }> = [
  { slots: ['top', 'bottom'], label: 'Style this together' },
  { slots: ['outerwear', 'top', 'bottom'], label: 'Layered look from your saves' },
  { slots: ['dress', 'footwear'], label: 'Try this saved look' },
  { slots: ['top', 'bottom', 'footwear'], label: 'You have the pieces for this look' },
  { slots: ['outerwear', 'dress'], label: 'Suggested from your saved items' },
];

interface Candidate {
  items: NormalizedItem[];
  score: number;
  label: string;
  reasons: string[];
}

function scoreCombo(
  items: NormalizedItem[],
  feedback?: Record<string, OutfitFeedbackEntry>
): Candidate | null {
  const reasons: string[] = [];
  let score = 0;
  for (const item of items) {
    if (isNegative(feedbackFor(feedback, item.id))) return null;
    if (isPositive(feedbackFor(feedback, item.id))) {
      score += 2;
      if (!reasons.includes('Includes a piece you rated highly')) {
        reasons.push('Includes a piece you rated highly');
      }
    }
  }
  for (let i = 0; i < items.length; i += 1) {
    for (let j = i + 1; j < items.length; j += 1) {
      if (!colorsCompatible(items[i].color, items[j].color)) return null;
      score += 1;
      if (occasionOverlap(items[i], items[j])) {
        score += 2;
        if (!reasons.includes('Matching occasion')) reasons.push('Matching occasion');
      }
    }
  }
  if (items.every((it) => isNeutralColor(it.color))) {
    reasons.push('Easy neutral palette');
  }
  reasons.push('Suggested from your saved items');
  return { items, score, label: '', reasons };
}

/**
 * Generate up to `maxOutfits` rule-based outfit suggestions from saved items.
 * Deterministic for a given input ordering. Never throws; returns [] when
 * there is not enough compatible material to combine.
 */
export function generateOutfits(
  items: NormalizedItem[],
  options?: GenerateOutfitsOptions
): SuggestedOutfit[] {
  if (!Array.isArray(items) || items.length < 2) return [];
  const maxOutfits = options?.maxOutfits ?? 4;
  const byBucket = new Map<CategoryBucket, NormalizedItem[]>();
  for (const item of items) {
    const bucket = bucketForCategory(item.category);
    const list = byBucket.get(bucket) ?? [];
    if (list.length < 6) list.push(item); // cap per bucket to bound combinations
    byBucket.set(bucket, list);
  }

  const candidates: Candidate[] = [];
  for (const template of OUTFIT_TEMPLATES) {
    const pools = template.slots.map((slot) => byBucket.get(slot) ?? []);
    if (pools.some((pool) => pool.length === 0)) continue;
    // Bounded cross-product walk (pools are capped at 6 each, templates ≤ 3 slots).
    const walk = (slotIndex: number, chosen: NormalizedItem[]) => {
      if (candidates.length >= 40) return;
      if (slotIndex === pools.length) {
        const scored = scoreCombo(chosen, options?.feedback);
        if (scored) candidates.push({ ...scored, label: template.label });
        return;
      }
      for (const item of pools[slotIndex]) {
        if (chosen.some((c) => c.id === item.id)) continue;
        walk(slotIndex + 1, [...chosen, item]);
      }
    };
    walk(0, []);
  }

  candidates.sort((a, b) => b.score - a.score);

  const used = new Set<string>();
  const results: SuggestedOutfit[] = [];
  for (const candidate of candidates) {
    if (results.length >= maxOutfits) break;
    const key = candidate.items.map((i) => i.id).sort().join('+');
    if (used.has(key)) continue;
    used.add(key);
    results.push({
      id: 'outfit_' + key,
      title: candidate.label,
      itemIds: candidate.items.map((i) => i.id),
      items: candidate.items,
      reasonLabels: candidate.reasons.slice(0, 3),
      occasion: candidate.items.find((i) => i.occasionTags?.length)?.occasionTags?.[0],
    });
  }
  return results;
}
