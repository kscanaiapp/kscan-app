'use strict';
// Loads the real capability-proof module together with its generated identity
// module, so a test never has to know the proof module's import list.
const { runModule } = require('./componentRenderer');

/** A well-formed identity for fixtures that need a record to match a context. */
const FIXTURE_FINGERPRINT = 'f'.repeat(64);
const GENERATED = './kplusCapabilityFingerprints.generated';

function loadGeneratedFingerprints() {
  return runModule('services/kplus/kplusCapabilityFingerprints.generated.ts', {}, { jsx: false });
}

function loadCapabilityProof({ fingerprints, mutate } = {}) {
  return runModule('services/kplus/kplusCapabilityProof.ts',
    { [GENERATED]: fingerprints ?? loadGeneratedFingerprints() },
    { jsx: false, ...(mutate ? { mutate } : {}) });
}

/** A fixture context + record pair that matches, for one proof type. */
function matchingFixture(proofType, capability, overrides = {}) {
  const record = { capability, proofType, environment: 'staging', implementationFingerprint: FIXTURE_FINGERPRINT,
    status: 'PROVEN_RUNTIME', provenAt: '2026-10-06', expiresAt: '2026-10-08', evidenceRef: 'fixture', ...overrides };
  const context = { environment: 'staging', implementationFingerprints: { [proofType]: FIXTURE_FINGERPRINT },
    nowMs: Date.parse('2026-10-07'), records: [record] };
  return { record, context };
}

module.exports = { FIXTURE_FINGERPRINT, loadCapabilityProof, loadGeneratedFingerprints, matchingFixture };
