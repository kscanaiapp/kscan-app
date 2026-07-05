/**
 * Free Tier Utility Expansion — wardrobe duplicate hints.
 * Attribute-based similarity only ("possible duplicate"). Never claims an
 * exact or visual match.
 */

import type { DuplicateHintResult, NormalizedItem } from './wardrobeUtilityTypes';

const STOP_WORDS = new Set(['the', 'a', 'an', 'and', 'with', 'for', 'match', 'style']);

function titleKeywords(title?: string): Set<string> {
  if (!title) return new Set();
  return new Set(
    title
      .toLowerCase()
      .split(/[^a-z0-9]+/)
      .filter((w) => w.length > 2 && !STOP_WORDS.has(w))
  );
}

function same(a?: string, b?: string): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

/**
 * Compare a candidate item against saved items. Score per match:
 * category +2 (required for any hint), color +2, brand +2, material +1,
 * silhouette +1, style-tag overlap +1, title keyword overlap +1.
 */
export function findPossibleDuplicates(
  candidate: NormalizedItem | null | undefined,
  savedItems: NormalizedItem[]
): DuplicateHintResult {
  const none: DuplicateHintResult = {
    hasPossibleDuplicate: false,
    confidence: 'low',
    reasonLabels: [],
    matchingItemIds: [],
  };
  if (!candidate || !Array.isArray(savedItems) || savedItems.length === 0) return none;

  const candidateKeywords = titleKeywords(candidate.title);
  let bestScore = 0;
  const reasons = new Set<string>();
  const matchingIds: string[] = [];

  for (const item of savedItems) {
    if (!item || item.id === candidate.id) continue;
    if (!same(item.category, candidate.category)) continue; // category gate
    let score = 2;
    const localReasons: string[] = ['Same category'];
    if (same(item.color, candidate.color)) {
      score += 2;
      localReasons.push('Same color');
    }
    if (same(item.brand, candidate.brand)) {
      score += 2;
      localReasons.push('Same brand');
    }
    if (same(item.material, candidate.material)) {
      score += 1;
      localReasons.push('Similar material');
    }
    if (same(item.silhouette, candidate.silhouette)) {
      score += 1;
      localReasons.push('Similar silhouette');
    }
    const tagOverlap = (item.styleTags ?? []).some((t) =>
      (candidate.styleTags ?? []).some((c) => same(t, c))
    );
    if (tagOverlap) {
      score += 1;
      localReasons.push('Shared style tags');
    }
    const keywords = titleKeywords(item.title);
    let keywordHit = false;
    for (const word of keywords) {
      if (candidateKeywords.has(word)) {
        keywordHit = true;
        break;
      }
    }
    if (keywordHit) {
      score += 1;
      localReasons.push('Similar title');
    }

    if (score >= 4) {
      matchingIds.push(item.id);
      localReasons.forEach((r) => reasons.add(r));
      if (score > bestScore) bestScore = score;
    }
  }

  if (matchingIds.length === 0) return none;
  const confidence: DuplicateHintResult['confidence'] =
    bestScore >= 7 ? 'high' : bestScore >= 5 ? 'medium' : 'low';
  return {
    hasPossibleDuplicate: true,
    confidence,
    reasonLabels: Array.from(reasons).slice(0, 4),
    matchingItemIds: matchingIds.slice(0, 5),
  };
}
