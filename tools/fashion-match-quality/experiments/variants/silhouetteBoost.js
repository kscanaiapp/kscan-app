'use strict';

/**
 * LAB-ONLY experimental ranking variant (spec section 28). Never wired into
 * production. Deliberately a re-implementation, NOT a modified copy of
 * supabase/functions/_shared/scanHelpers.ts scoreRecommendedProduct - that
 * production file is never edited by this lab.
 *
 * HYPOTHESIS: production under-weights silhouette relative to category
 * (0.10 vs 0.35 - see authority/pipelineMap.json SCORING_RANKING stage),
 * which can let a category-correct/silhouette-wrong item outrank a
 * same-category item with a better silhouette match, contradicting the
 * "silhouette failure should not be hidden" principle (spec section 14).
 * This variant raises the silhouette weight and lowers category slightly,
 * keeping every other weight identical to production, so any measured
 * effect is attributable to that one change.
 */

const WEIGHTS = Object.freeze({
  category: 0.27, // production: 0.35
  color: 0.20,
  feature: 0.15,
  silhouette: 0.18, // production: 0.10
  material: 0.08,
  style: 0.07,
  imageAndUrl: 0.03,
  inStock: 0.02,
});

function scoreCandidate(product, normalized) {
  if (!normalized) return { score: 0, reasons: {} };
  let score = 0;
  const reasons = {};

  const text = [
    product.canonical_category, product.category, product.itemType,
    ...(product.tags || []), ...(product.styleTags || []), ...(product.style_tags || []),
    ...(product.material_tags || []), product.brand, product.name, product.title,
    product.product_name, product.displayName, product.color, product.color_normalized,
    ...(product.colorPalette || []),
  ].filter(Boolean).join(' ').toLowerCase();

  if (normalized.canonicalCategory && text.includes(normalized.canonicalCategory)) {
    score += WEIGHTS.category;
    reasons.category_match = true;
  }
  if (normalized.canonicalColor && text.includes(normalized.canonicalColor)) {
    score += WEIGHTS.color;
    reasons.color_match = true;
  }
  const features = normalized.normalizedFeatures || [];
  if (features.some((f) => text.includes(String(f).toLowerCase()))) {
    score += WEIGHTS.feature;
    reasons.feature_overlap = true;
  }
  const silhouette = (product.silhouette || product.fit || '').toLowerCase();
  const canonicalSil = (normalized.canonicalSilhouette || '').toLowerCase();
  if (silhouette && canonicalSil) {
    const pTokens = silhouette.split(/[\s/]+/).filter(Boolean);
    const cTokens = canonicalSil.split(/[\s/]+/).filter(Boolean);
    if (pTokens.some((t) => cTokens.includes(t))) {
      score += WEIGHTS.silhouette;
      reasons.silhouette_match = true;
    }
  }
  const matText = `${product.material || ''} ${product.materialEstimate || ''} ${(product.material_tags || []).join(' ')}`.toLowerCase();
  if (normalized.canonicalMaterial && matText.includes(normalized.canonicalMaterial)) {
    score += WEIGHTS.material;
    reasons.material_match = true;
  }
  const styleTags = [...(product.tags || []), ...(product.styleTags || []), ...(product.style_tags || [])].map((t) => String(t).toLowerCase());
  if ((normalized.normalizedStyleTags || []).some((st) => styleTags.includes(String(st).toLowerCase()))) {
    score += WEIGHTS.style;
    reasons.style_match = true;
  }
  if ((product.imageUrl || product.image_url) && (product.purchaseUrl || product.purchase_url || product.url)) {
    score += WEIGHTS.imageAndUrl;
    reasons.has_image_and_url = true;
  }
  if (product.availability === 'in_stock' || product.availability === 'in stock') {
    score += WEIGHTS.inStock;
    reasons.in_stock = true;
  }

  return { score: Math.min(1, score), reasons };
}

function rank(products, normalized) {
  if (!Array.isArray(products) || !normalized) return [];
  const scored = products.map((p) => {
    const { score, reasons } = scoreCandidate(p, normalized);
    return { ...p, matchScore: score, similarityPercentage: Math.round(score * 100), matchReasons: reasons };
  });
  scored.sort((a, b) => (b.matchScore ?? 0) - (a.matchScore ?? 0));
  return scored;
}

module.exports = {
  id: 'silhouette-boost-v1',
  hypothesis:
    'Raising the silhouette weight (0.10 -> 0.18) and lowering category (0.35 -> 0.27) improves substitute quality on fixtures where the top production match has the right category but the wrong silhouette, without materially harming identity metrics.',
  why:
    'authority/pipelineMap.json documents production silhouette weight (0.10) as roughly a third of category weight (0.35); K-SCAN memory (DEF-CON-002 shared layering taxonomy) records a related class of ranking defects where a strong single-token match outranks a better overall garment match.',
  weights: WEIGHTS,
  rank,
};
