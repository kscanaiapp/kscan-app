'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { loadFullCorpus, loadSyntheticCorpus } = require('../corpus/corpusLoader');
const { validateCorpus, validateFixture } = require('../schema/fixtureSchema');
const { scanForPrivacyViolations } = require('../schema/privacyGuard');
const { buildCorpusManifest } = require('../fixtures/manifest');
const { FASHION_COMPONENT_WEIGHT_SUM, RUBRIC_VERSION } = require('../evaluator/rubric');
const { createBaseline, writeBaseline, SCHEMA_VERSION: BASELINE_SCHEMA_VERSION } = require('../baseline/baselineStore');

/**
 * L0 - CONTRACT mode (spec section 22). Completely offline. Every check
 * here is self-contained and produces a PASS/FAIL verdict; nothing here
 * touches the network, Supabase, or any provider.
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
    const fixtures = loadFullCorpus();
    const { valid, errors } = validateCorpus(fixtures);
    if (!valid) throw new Error(errors.join('; '));
    return `${fixtures.length} fixtures validated`;
  });

  record('duplicate_fixture_id_rejected', () => {
    const fixtures = loadSyntheticCorpus();
    if (fixtures.length < 2) throw new Error('need >=2 fixtures to test duplicate rejection');
    const withDup = [...fixtures, { ...fixtures[0] }];
    const { valid } = validateCorpus(withDup);
    if (valid) throw new Error('validateCorpus accepted a corpus with a duplicate fixtureId');
    return 'duplicate fixtureId correctly rejected';
  });

  record('missing_provenance_rejected', () => {
    const fixtures = loadSyntheticCorpus();
    const broken = { ...fixtures[0], groundTruth: { ...fixtures[0].groundTruth, source: undefined } };
    const { valid, errors } = validateFixture(broken);
    if (valid) throw new Error('validateFixture accepted a fixture with missing groundTruth.source');
    return errors[0];
  });

  record('privacy_guard_rejects_prohibited_key', () => {
    const result = scanForPrivacyViolations({ fixtureId: 'x', user_id: 'abc123' });
    if (result.safe) throw new Error('privacy guard failed to flag a prohibited root key');
    return result.violations[0];
  });

  record('privacy_guard_rejects_nested_prohibited_key', () => {
    const result = scanForPrivacyViolations({ fixtureId: 'x', nested: { auth_token: 'abc' } });
    if (result.safe) throw new Error('privacy guard failed to flag a nested prohibited key');
    return result.violations[0];
  });

  record('privacy_guard_rejects_data_uri_media', () => {
    const result = scanForPrivacyViolations({ img: 'data:image/jpeg;base64,/9j/4AAQ' });
    if (result.safe) throw new Error('privacy guard failed to flag a base64 media data URI');
    return result.violations[0];
  });

  record('deterministic_corpus_manifest_hash', () => {
    const fixtures = loadSyntheticCorpus();
    const h1 = buildCorpusManifest(fixtures).manifestHash;
    const h2 = buildCorpusManifest(fixtures).manifestHash;
    if (h1 !== h2) throw new Error('manifest hash was not stable across two calls over identical input');
    return h1;
  });

  record('rubric_weights_versioned_and_normalized', () => {
    if (Math.abs(FASHION_COMPONENT_WEIGHT_SUM - 1) > 1e-9) {
      throw new Error(`FASHION_COMPONENTS weights sum to ${FASHION_COMPONENT_WEIGHT_SUM}, expected 1.0`);
    }
    if (!RUBRIC_VERSION) throw new Error('RUBRIC_VERSION is not set');
    return RUBRIC_VERSION;
  });

  record('baseline_overwrite_protected', () => {
    const fixtures = loadSyntheticCorpus();
    const manifest = buildCorpusManifest(fixtures);
    const baseline = createBaseline({
      sourceSha: '0'.repeat(40),
      fixtureManifest: manifest,
      rubricVersion: RUBRIC_VERSION,
      evaluationMode: 'CONTRACT_SELF_TEST',
      metrics: { note: 'self-test baseline, not a real evaluation' },
      perFixtureScore: {},
    });
    const tmpFile = path.join(os.tmpdir(), `fmql-contract-baseline-${process.pid}-${Date.now()}.json`);
    writeBaseline(tmpFile, baseline);
    const mutated = { ...baseline, metrics: { note: 'mutated' }, contentHash: `${baseline.contentHash}-different` };
    let refused = false;
    try {
      writeBaseline(tmpFile, mutated);
    } catch {
      refused = true;
    }
    fs.unlinkSync(tmpFile);
    if (!refused) throw new Error('writeBaseline allowed a silent overwrite without { force: true }');
    return 'overwrite correctly refused without force';
  });

  record('baseline_schema_version_present', () => BASELINE_SCHEMA_VERSION);

  record('l1_harness_source_has_no_network_call', () => {
    const source = fs.readFileSync(path.join(__dirname, '..', 'l1', 'runL1.deno.ts'), 'utf8');
    if (/\bfetch\s*\(/.test(source) || /Deno\.connect/.test(source)) {
      throw new Error('L1 harness source contains a network-capable call - offline mode must never reach the network');
    }
    return 'no fetch()/Deno.connect() call present in L1 harness source';
  });

  return controls;
}

function contractPassed(controls) {
  return controls.every((c) => c.verdict === 'PASS');
}

module.exports = { runContractControls, contractPassed };
