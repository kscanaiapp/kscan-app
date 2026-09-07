'use strict';

/**
 * Duplicate-product classification (spec section 20).
 *
 * This is explicitly NOT the full Canonical Product Identity system - it is
 * a conservative, documented heuristic for MEASURING duplication in a
 * ranked result set, layered on top of (not replacing) production's own
 * exact-match dedup (mergeProductCandidates in catalogRetrieval.ts, which
 * only dedupes by exact id or exact normalized URL - see
 * authority/pipelineMap.json DEDUPLICATION stage).
 *
 * Conservative hierarchy (highest confidence first):
 *   CONFIRMED_DUPLICATE  - same durable SKU/style identifier (identitySku),
 *                          or exact normalized product URL.
 *   LIKELY_DUPLICATE     - same normalized brand + same normalized
 *                          title/style + same category, no SKU evidence
 *                          either way (may legitimately be the same product
 *                          at two retailers, or two different products from
 *                          the same brand/line - the label reflects that
 *                          uncertainty rather than merging automatically).
 *   DISTINCT_VARIANT     - same normalized brand + category, but a
 *                          documented distinguishing attribute differs
 *                          (color, silhouette, or material) - a colorway or
 *                          style variant, not a duplicate.
 *   UNKNOWN              - insufficient evidence to classify either way.
 *
 * Image hash equality (imageUrl string equality here, since this lab has no
 * real image bytes to hash) is treated only as SUPPORTING evidence that can
 * raise LIKELY_DUPLICATE -> CONFIRMED_DUPLICATE when combined with a brand+
 * title+category match, per spec section 20 - it never triggers a merge on
 * its own.
 */

function norm(value) {
  return typeof value === 'string' ? value.trim().toLowerCase() : '';
}

function urlKey(product) {
  const u = product.purchaseUrl || product.purchase_url || product.product_url || product.url;
  return typeof u === 'string' && u.trim() ? u.trim().toLowerCase() : null;
}

function classifyPair(a, b) {
  if (!a || !b) return { classification: 'UNKNOWN', evidence: ['missing_candidate'] };
  if (a === b || a.id === b.id) return { classification: 'UNKNOWN', evidence: ['same_object_not_a_pair'] };

  const evidence = [];

  // 1. Durable SKU identity - strongest possible evidence.
  const aSku = a.identitySku ?? a.sku ?? null;
  const bSku = b.identitySku ?? b.sku ?? null;
  if (aSku && bSku && aSku === bSku) {
    evidence.push('identical_identity_sku');
    return { classification: 'CONFIRMED_DUPLICATE', evidence };
  }

  // 2. Exact normalized URL match.
  const aUrl = urlKey(a);
  const bUrl = urlKey(b);
  if (aUrl && bUrl && aUrl === bUrl) {
    evidence.push('identical_normalized_url');
    return { classification: 'CONFIRMED_DUPLICATE', evidence };
  }

  const aBrand = norm(a.brandNormalized || a.brand);
  const bBrand = norm(b.brandNormalized || b.brand);
  const aTitle = norm(a.titleNormalized || a.title || a.name || a.product_name);
  const bTitle = norm(b.titleNormalized || b.title || b.name || b.product_name);
  const aCategory = norm(a.category || a.canonical_category);
  const bCategory = norm(b.category || b.canonical_category);

  const brandMatch = aBrand && bBrand && aBrand === bBrand;
  const categoryMatch = aCategory && bCategory && aCategory === bCategory;
  const titleMatch = aTitle && bTitle && aTitle === bTitle;

  if (!brandMatch || !categoryMatch) {
    return { classification: 'UNKNOWN', evidence: ['insufficient_brand_or_category_evidence'] };
  }

  // Distinguishing-attribute check - a real colorway/variant, not a duplicate.
  const distinguishers = ['color', 'color_normalized', 'silhouette', 'material'];
  const differing = distinguishers.filter((key) => {
    const av = norm(a[key]);
    const bv = norm(b[key]);
    return av && bv && av !== bv;
  });

  if (titleMatch && brandMatch && categoryMatch) {
    evidence.push('brand_title_category_match');
    // Supporting-only image-hash-equivalent evidence can raise confidence,
    // never trigger a merge by itself (section 20).
    const aImage = a.imageUrl || a.image_url;
    const bImage = b.imageUrl || b.image_url;
    if (aImage && bImage && aImage === bImage) {
      evidence.push('identical_image_reference_supporting_only');
      return { classification: 'CONFIRMED_DUPLICATE', evidence };
    }
    return { classification: 'LIKELY_DUPLICATE', evidence };
  }

  if (differing.length > 0) {
    evidence.push(`distinguishing_attributes_differ:${differing.join(',')}`);
    return { classification: 'DISTINCT_VARIANT', evidence };
  }

  evidence.push('brand_category_match_title_inconclusive');
  return { classification: 'LIKELY_DUPLICATE', evidence };
}

/**
 * Classify every pair within a ranked/candidate list. Returns an array of
 * { aId, bId, classification, evidence }. O(n^2) - fine for lab-scale
 * result sets (tens of candidates per scan, not thousands).
 */
function classifyDuplicatesInSet(products) {
  const pairs = [];
  for (let i = 0; i < products.length; i += 1) {
    for (let j = i + 1; j < products.length; j += 1) {
      const { classification, evidence } = classifyPair(products[i], products[j]);
      if (classification !== 'UNKNOWN') {
        pairs.push({ aId: products[i].id, bId: products[j].id, classification, evidence });
      }
    }
  }
  return pairs;
}

/** Summary counts, and retailer concentration/diversity (spec section 21). */
function summarizeDuplicatesAndRetailers(products) {
  const pairs = classifyDuplicatesInSet(products);
  const counts = { CONFIRMED_DUPLICATE: 0, LIKELY_DUPLICATE: 0, DISTINCT_VARIANT: 0 };
  for (const p of pairs) counts[p.classification] = (counts[p.classification] || 0) + 1;

  const retailerCounts = {};
  for (const p of products) {
    const r = norm(p.retailer) || 'unknown';
    retailerCounts[r] = (retailerCounts[r] || 0) + 1;
  }
  const retailers = Object.keys(retailerCounts);
  const totalItems = products.length || 1;
  const maxShare = retailers.length ? Math.max(...retailers.map((r) => retailerCounts[r])) / totalItems : 0;

  return {
    totalCandidates: products.length,
    duplicatePairCounts: counts,
    pairs,
    retailerDiversity: {
      distinctRetailers: retailers.length,
      retailerCounts,
      // Herfindahl-style concentration: 1/n at perfect diversity, 1 at full
      // concentration. Reported neutrally per spec section 21 - concentration
      // is not automatically flagged as bad.
      concentrationIndex: retailers.reduce((sum, r) => sum + (retailerCounts[r] / totalItems) ** 2, 0),
      largestRetailerShare: maxShare,
    },
  };
}

module.exports = { classifyPair, classifyDuplicatesInSet, summarizeDuplicatesAndRetailers };
