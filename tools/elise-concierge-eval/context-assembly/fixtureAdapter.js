'use strict';

/**
 * Converts this harness's fixture Closet items into the exact shape
 * production's EliseWardrobeCandidate / EliseScoredCandidate types expect
 * (supabase/functions/stylechat-generate/eliseAdviceTypes.ts), so L1.5 can
 * feed synthetic-but-correctly-shaped data into REAL production functions.
 */

function toProductionCandidate(item, { sourceType = 'closet', actorRelationship = 'owned' } = {}) {
  return {
    candidateId: item.id,
    sourceType,
    actorRelationship,
    title: item.title || null,
    category: item.category || null,
    subcategory: item.subcategory || null,
    colors: item.colors || [],
    colorFamilies: item.colorFamilies || [],
    materials: item.materials || [],
    textures: [],
    patterns: [],
    silhouette: null,
    fit: null,
    proportionRole: null,
    layeringRole: item.layeringRole || null,
    formality: item.formality || null,
    seasons: item.seasons || [],
    occasions: [],
    styleAttributes: [],
    brand: item.brand || null,
    confidence: 0.9,
    canonicalResourceIds: { itemId: item.id },
  };
}

function toScoredCandidate(item, opts, role = 'alternative') {
  return {
    candidate: toProductionCandidate(item, opts),
    score: {
      total: 0.8,
      dimensions: {
        categoryRole: 0.8,
        colorHarmony: 0.8,
        silhouetteBalance: 0.8,
        materialTexture: 0.8,
        formality: 0.8,
        season: 0.8,
        occasion: 0.8,
        signatureStyle: 0.8,
        ownershipPriority: 1,
        redundancyPenalty: 0.9,
      },
      reasons: ['instrument_validation_synthetic'],
      warnings: [],
    },
    recommendationRole: role,
  };
}

function toFocusedItem(item, opts) {
  if (!item) return { evidenceId: null, actorRelationship: 'unknown', candidate: null, resolution: 'none' };
  return {
    evidenceId: null,
    actorRelationship: opts && opts.actorRelationship ? opts.actorRelationship : 'owned',
    candidate: toProductionCandidate(item, opts),
    resolution: 'closet_text_match',
  };
}

module.exports = { toProductionCandidate, toScoredCandidate, toFocusedItem };
