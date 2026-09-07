'use strict';

const { canonicalHash, canonicalStringify } = require('../lib/canonicalJson');

/**
 * Build a stable manifest for a corpus (array of fixtures). The manifest
 * hash is part of baseline immutability (spec section 23) - a baseline
 * records the fixture manifest hash it was produced against, and a compare
 * run rejects mixing manifests.
 */
function buildCorpusManifest(fixtures) {
  const entries = fixtures
    .map((f) => ({
      fixtureId: f.fixtureId,
      corpusTier: f.corpusTier,
      captureProfile: f.captureProfile,
      contentHash: canonicalHash(f),
    }))
    .sort((a, b) => (a.fixtureId < b.fixtureId ? -1 : a.fixtureId > b.fixtureId ? 1 : 0));

  const manifest = {
    fixtureCount: entries.length,
    countByTier: entries.reduce((acc, e) => {
      acc[e.corpusTier] = (acc[e.corpusTier] || 0) + 1;
      return acc;
    }, {}),
    countByCaptureProfile: entries.reduce((acc, e) => {
      acc[e.captureProfile] = (acc[e.captureProfile] || 0) + 1;
      return acc;
    }, {}),
    entries,
  };

  return {
    ...manifest,
    manifestHash: canonicalHash(manifest),
  };
}

function manifestsCompatible(a, b) {
  return a && b && a.manifestHash === b.manifestHash;
}

module.exports = { buildCorpusManifest, manifestsCompatible, canonicalStringify };
