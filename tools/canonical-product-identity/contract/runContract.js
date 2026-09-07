'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadSyntheticCorpus, buildCorpusManifest } = require('../corpus/corpusLoader');
const { validateCorpus, validateOffer } = require('../schema/identitySchema');
const { scanForPrivacyViolations } = require('../../fashion-match-quality/schema/privacyGuard');
const { resolvePair } = require('../resolver/resolvePair');
const { RESOLVER_VERSION } = require('../resolver/resolverVersion');
const { createBaseline, writeBaseline } = require('../baseline/baselineStore');
const { SCHEMA_VERSION: IDENTITY_SCHEMA_VERSION } = require('../schema/identitySchema');
const { NORMALIZATION_VERSION, DEFAULT_OPERATING_PARAMETERS } = require('../resolver/resolverVersion');
const { GENERATOR_VERSION } = require('../corpus/generator');

/**
 * CONTRACT mode (spec section 42). Completely offline. Every check here is
 * self-contained and produces a PASS/FAIL verdict; nothing touches the
 * network or any provider (spec section 3/43#26).
 */
function runContractControls() {
  const controls = [];
  const record = (name, fn) => {
    try {
      const detail = fn();
      controls.push({ name, verdict: 'PASS', detail: detail ?? null });
    } catch (err) {
      controls.push({ name, verdict: 'FAIL', detail: err.message });
    }
  };

  record('corpus_schema_valid', () => {
    const corpus = loadSyntheticCorpus();
    const { valid, errors } = validateCorpus(corpus);
    if (!valid) throw new Error(errors.join('; '));
    return `${corpus.offers.length} offers validated`;
  });

  record('duplicate_offer_id_rejected', () => {
    const corpus = loadSyntheticCorpus();
    const withDup = { ...corpus, offers: [...corpus.offers, { ...corpus.offers[0] }] };
    const { valid } = validateCorpus(withDup);
    if (valid) throw new Error('validateCorpus accepted a corpus with a duplicate offerId');
    return 'duplicate offerId correctly rejected';
  });

  record('missing_required_offer_field_rejected', () => {
    const { valid, errors } = validateOffer({ offerId: 'x' }); // missing retailer
    if (valid) throw new Error('validateOffer accepted an offer missing retailer');
    return errors[0];
  });

  record('privacy_guard_rejects_prohibited_key', () => {
    const result = scanForPrivacyViolations({ offerId: 'x', user_id: 'abc123' });
    if (result.safe) throw new Error('privacy guard failed to flag a prohibited root key');
    return result.violations[0];
  });

  record('privacy_guard_rejects_nested_prohibited_key', () => {
    const result = scanForPrivacyViolations({ offerId: 'x', nested: { auth_token: 'abc' } });
    if (result.safe) throw new Error('privacy guard failed to flag a nested prohibited key');
    return result.violations[0];
  });

  record('privacy_guard_rejects_data_uri_media', () => {
    const result = scanForPrivacyViolations({ imageUrl: 'data:image/jpeg;base64,/9j/4AAQ' });
    if (result.safe) throw new Error('privacy guard failed to flag a base64 media data URI');
    return result.violations[0];
  });

  record('deterministic_corpus_manifest_hash', () => {
    const corpus = loadSyntheticCorpus();
    const h1 = buildCorpusManifest(corpus).manifestHash;
    const h2 = buildCorpusManifest(corpus).manifestHash;
    if (h1 !== h2) throw new Error('manifest hash was not stable across two calls over identical input');
    return h1;
  });

  record('resolver_deterministic_across_calls', () => {
    const a = { offerId: 'a', retailer: 'X', brand: 'B', title: 'B T black wool', category: 'jacket', color: 'black', material: 'wool', gtin: '00000036000291452' };
    const b = { offerId: 'b', retailer: 'Y', brand: 'B', title: 'B T black wool', category: 'jacket', color: 'black', material: 'wool', gtin: '00000036000291452' };
    const r1 = resolvePair(a, b);
    const r2 = resolvePair(a, b);
    if (JSON.stringify(r1) !== JSON.stringify(r2)) throw new Error('resolvePair produced different output for identical input across two calls');
    return r1.decision;
  });

  record('false_merge_gate_self_test', () => {
    // Two offers with strong supporting evidence but a CONFLICTING validated
    // GTIN must SEPARATE, never AUTO_MERGE (section 25's own gate, tested at
    // the unit the gate actually depends on - Tier 1 conflict handling).
    const a = { offerId: 'a', retailer: 'X', brand: 'B', title: 'B T black wool', category: 'jacket', color: 'black', material: 'wool', gtin: '00000036000291452' };
    const b = { offerId: 'b', retailer: 'Y', brand: 'B', title: 'B T black wool', category: 'jacket', color: 'black', material: 'wool', gtin: '00000012345678905' };
    const result = resolvePair(a, b);
    if (result.decision === 'AUTO_MERGE') throw new Error('resolvePair AUTO_MERGEd two offers with conflicting validated GTINs - section 25 gate violated');
    return result.decision;
  });

  record('baseline_overwrite_protected', () => {
    const corpus = loadSyntheticCorpus();
    const manifest = buildCorpusManifest(corpus);
    const baseline = createBaseline({
      sourceSha: '0'.repeat(40),
      corpus,
      corpusManifest: manifest,
      resolverVersion: RESOLVER_VERSION,
      normalizationVersion: NORMALIZATION_VERSION,
      identitySchemaVersion: IDENTITY_SCHEMA_VERSION,
      operatingParameters: DEFAULT_OPERATING_PARAMETERS,
      metrics: { note: 'self-test baseline, not a real evaluation' },
    });
    const tmpFile = path.join(os.tmpdir(), `cpil-contract-baseline-${process.pid}-${Date.now()}.json`);
    writeBaseline(tmpFile, baseline);
    const differentBaseline = { ...baseline, contentHash: `${baseline.contentHash}-mutated` };
    let threw = false;
    try {
      writeBaseline(tmpFile, differentBaseline);
    } catch {
      threw = true;
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
    if (!threw) throw new Error('writeBaseline silently overwrote an existing different baseline without force:true');
    return 'overwrite correctly refused without force:true';
  });

  record('generator_version_recorded', () => {
    if (!GENERATOR_VERSION) throw new Error('GENERATOR_VERSION is not set');
    return GENERATOR_VERSION;
  });

  record('zero_network_module_surface', () => {
    // Static guard: none of this lab's own modules import a network-capable
    // primitive. fetch/http/https/XMLHttpRequest are never required in
    // tools/canonical-product-identity's own source (spec section 43#26).
    const glob = require('node:fs');
    const dir = path.join(__dirname, '..');
    const offenders = [];
    function walk(d) {
      for (const entry of glob.readdirSync(d, { withFileTypes: true })) {
        if (entry.name === 'node_modules' || entry.name === 'generated' || entry.name === 'fixtures') continue;
        const full = path.join(d, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (entry.name.endsWith('.js') && !entry.name.endsWith('.test.js')) {
          const src = glob.readFileSync(full, 'utf8');
          if (/\brequire\(['"]https?['"]\)|\bfetch\(|new\s+XMLHttpRequest/.test(src)) offenders.push(full);
        }
      }
    }
    walk(dir);
    if (offenders.length > 0) throw new Error(`network-capable call found in: ${offenders.join(', ')}`);
    return 'no network-capable primitive referenced anywhere under tools/canonical-product-identity';
  });

  return controls;
}

function contractPassed(controls) {
  return controls.every((c) => c.verdict !== 'FAIL');
}

module.exports = { runContractControls, contractPassed };
