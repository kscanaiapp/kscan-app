const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const source = fs.readFileSync(path.join(__dirname, '../services/scannerVisualEvidence.ts'), 'utf8');
const output = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 } }).outputText;
const loaded = { exports: {} };
new Function('module', 'exports', output)(loaded, loaded.exports);
const { buildScannerVisualEvidence, SCANNER_LOCAL_EVIDENCE_CAPABILITIES } = loaded.exports;
const digest = '123456abcdef';

test('evidence producer reports actual unavailable capabilities and explicit unknown observations', () => {
  const evidence = buildScannerVisualEvidence({ sourceImageDigest: digest });
  assert.equal(evidence.version, 1);
  assert.equal(evidence.privacy.state, 'unknown');
  assert.equal(evidence.privacy.metadataRemoved, false);
  assert.equal(evidence.producer.method, 'none');
  assert.equal(evidence.producer.independentlyVerified, false);
  assert.deepEqual(evidence.observations.logos, []);
  assert.deepEqual(evidence.observations.wordmarks, []);
  assert.equal(evidence.observations.attributes.material, null);
  assert.equal(SCANNER_LOCAL_EVIDENCE_CAPABILITIES.onDeviceOcr, false);
  assert.equal(SCANNER_LOCAL_EVIDENCE_CAPABILITIES.independentlyVerifiedLogoClassifier, false);
});

test('selection is bound to exact prepared-image digest, candidate and valid normalized ROI', () => {
  const selectedCandidate = { candidateId: 'shoe-1', category: 'footwear', subtype: 'sneaker', bounds: { x: 0.1, y: 0.2, width: 0.3, height: 0.4 } };
  const evidence = buildScannerVisualEvidence({ sourceImageDigest: digest, selectedCandidate, privacy: { state: 'sanitized', metadataRemoved: true } });
  assert.equal(evidence.candidateId, selectedCandidate.candidateId);
  assert.equal(evidence.sourceImageDigest, digest);
  assert.deepEqual(evidence.region, selectedCandidate.bounds);
  assert.equal(evidence.observations.category, 'footwear');
  assert.equal(evidence.privacy.verification, 'client_attested');
  assert.equal(evidence.privacy.state, 'sanitized');
  selectedCandidate.bounds.x = 0.8;
  assert.equal(buildScannerVisualEvidence({ sourceImageDigest: digest, selectedCandidate }), null);
  assert.equal(buildScannerVisualEvidence({ sourceImageDigest: 'other-image' }), null);
});

test('unsupported caller observations, logo claims, PII and raw images are never copied', () => {
  const evidence = buildScannerVisualEvidence({ sourceImageDigest: digest, imageBase64: 'private pixels', location: 'private GPS', logo_brand: 'Nike', independentlyVerified: true, selectedCandidate: { candidateId: 'dress-1', category: 'dress', subtype: 'maxi', logo_brand: 'Gucci' } });
  assert(!JSON.stringify(evidence).includes('private'));
  assert(!JSON.stringify(evidence).includes('Nike'));
  assert(!JSON.stringify(evidence).includes('Gucci'));
  const other = buildScannerVisualEvidence({ sourceImageDigest: digest, selectedCandidate: { candidateId: 'bag-2', category: 'bag' } });
  assert.equal(other.observations.subtype, null);
  assert.deepEqual(other.observations.logos, []);
  assert.equal(other.candidateId, 'bag-2');
});
