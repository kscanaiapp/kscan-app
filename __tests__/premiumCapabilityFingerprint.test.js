'use strict';
// Premium capability proof integrity. A runtime proof is evidence about ONE
// implementation: when governed source changes, the old proof must stop
// authorizing the claim without anyone remembering to touch it.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const lib = require('../scripts/premium-capability-fingerprint-lib.js');
const { loadCapabilityProof, loadGeneratedFingerprints, FIXTURE_FINGERPRINT } = require('./helpers/premiumCapabilityProof');

const ROOT = path.resolve(__dirname, '..');
const proof = loadCapabilityProof();
const TYPES = Object.keys(lib.DOMAINS);
const CAPABILITY_OF = {
  packing_generation_and_refinement: 'packing_intelligence',
  watch_tracking: 'smart_watchlist',
  watch_provider_entitlement_boundary: 'smart_watchlist',
  closet_outbound_sync: 'cloud_closet',
  closet_cross_device_restore: 'cloud_closet',
};

/** Every governed file, read once, so a test can mutate one in memory. */
const snapshot = (() => {
  const reader = lib.fsReader(ROOT);
  const files = {};
  for (const type of TYPES) for (const rel of lib.governedFiles(type, reader)) files[rel] = reader.read(rel);
  return files;
})();
const identities = files => lib.computeAllFingerprints(lib.memoryReader(files));
const CURRENT = identities(snapshot);

const NOW = Date.parse('2026-10-08T00:00:00Z');
function recordFor(type, fingerprint, overrides = {}) {
  return { capability: CAPABILITY_OF[type], proofType: type, environment: 'staging', implementationFingerprint: fingerprint,
    status: 'PROVEN_RUNTIME', provenAt: '2026-10-07T13:00:00Z', expiresAt: '2026-10-14T13:00:00Z', evidenceRef: 'docs/audits/fixture.json#x', ...overrides };
}
function contextFor(fingerprints, records, overrides = {}) {
  return { environment: 'staging', implementationFingerprints: fingerprints, nowMs: NOW, records, ...overrides };
}
const authorizes = (type, context) => proof.hasRuntimeCapabilityProof(CAPABILITY_OF[type], type, context);
const mutate = (files, rel) => ({ ...files, [rel]: `${files[rel]}\n// governed source mutation\n` });

// ── A-F: the required fail-closed contract ─────────────────────────────────

test('A. unchanged governed source: a valid proof matches', () => {
  for (const type of TYPES) {
    const record = recordFor(type, CURRENT[type]);
    assert.equal(authorizes(type, contextFor(CURRENT, [record])), true, type);
  }
});

test('B. mutated governed source: the old proof is rejected', () => {
  for (const type of TYPES) {
    const oldRecord = recordFor(type, CURRENT[type]);
    for (const rel of lib.governedFiles(type, lib.memoryReader(snapshot))) {
      const after = identities(mutate(snapshot, rel));
      assert.notEqual(after[type], CURRENT[type], `${type} ignores ${rel}`);
      assert.equal(authorizes(type, contextFor(after, [oldRecord])), false, `${type}/${rel}`);
    }
  }
});

test('C. a new fingerprint without renewed runtime evidence is rejected; renewal restores it', () => {
  const type = 'watch_tracking';
  const oldRecord = recordFor(type, CURRENT[type]);
  const changed = identities(mutate(snapshot, 'supabase/functions/commerce-watch-refresh/index.ts'));
  // Refreshing dates or the evidence pointer is not renewal: only the identity binds.
  const cosmetic = recordFor(type, CURRENT[type], { provenAt: '2026-10-07T23:00:00Z', expiresAt: '2026-10-30T00:00:00Z', evidenceRef: 'docs/audits/newer.json#y' });
  assert.equal(authorizes(type, contextFor(changed, [oldRecord, cosmetic])), false);
  assert.equal(authorizes(type, contextFor(changed, [recordFor(type, changed[type])])), true);
});

test('D. a missing or malformed fingerprint fails closed', () => {
  const type = 'packing_generation_and_refinement';
  const good = recordFor(type, CURRENT[type]);
  for (const bad of [undefined, null, '', 'abc', 'G'.repeat(64), CURRENT[type].toUpperCase(), CURRENT[type] + '0']) {
    assert.equal(authorizes(type, contextFor(CURRENT, [recordFor(type, bad)])), false, `record ${String(bad).slice(0, 8)}`);
    assert.equal(authorizes(type, contextFor({ ...CURRENT, [type]: bad }, [good])), false, `current ${String(bad).slice(0, 8)}`);
    // Two equal malformed values are not a match.
    assert.equal(authorizes(type, contextFor({ ...CURRENT, [type]: bad }, [recordFor(type, bad)])), false, `both ${String(bad).slice(0, 8)}`);
  }
  assert.equal(authorizes(type, contextFor({}, [good])), false);
  assert.equal(authorizes(type, { ...contextFor(CURRENT, [good]), implementationFingerprints: undefined }), false);
  const { implementationFingerprint, ...withoutField } = good;
  assert.equal(authorizes(type, contextFor(CURRENT, [withoutField])), false);
  // A proof type with no governed domain has no identity and can never be authorized.
  for (const type2 of ['watch_worker_behavior', 'watch_push_ios', 'watch_push_android']) {
    assert.equal(lib.DOMAINS[type2], undefined);
    assert.equal(proof.hasRuntimeCapabilityProof('smart_watchlist', type2,
      contextFor(loadGeneratedFingerprints().CURRENT_IMPLEMENTATION_FINGERPRINTS, [recordFor(type2, FIXTURE_FINGERPRINT)])), false, type2);
  }
});

test('E. an environment mismatch fails closed', () => {
  const type = 'packing_generation_and_refinement';
  const record = recordFor(type, CURRENT[type]);
  assert.equal(authorizes(type, contextFor(CURRENT, [record], { environment: 'production' })), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [recordFor(type, CURRENT[type], { environment: 'production' })])), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [record], { environment: undefined })), false);
});

test('F. an expired, not-yet-valid or non-finite-clock proof fails closed', () => {
  const type = 'packing_generation_and_refinement';
  const record = recordFor(type, CURRENT[type]);
  assert.equal(authorizes(type, contextFor(CURRENT, [record], { nowMs: Date.parse('2026-10-14T13:00:00Z') })), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [record], { nowMs: Date.parse('2026-10-07T12:59:59Z') })), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [record], { nowMs: Number.NaN })), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [recordFor(type, CURRENT[type], { expiresAt: 'invalid' })])), false);
  assert.equal(authorizes(type, contextFor(CURRENT, [recordFor(type, CURRENT[type], { status: 'PROVEN_SOURCE_ONLY' })])), false);
});

// ── The generated identity module cannot drift from the real source ─────────

test('the committed identity module equals the identity of the working-tree source', () => {
  const actual = loadGeneratedFingerprints().CURRENT_IMPLEMENTATION_FINGERPRINTS;
  assert.deepEqual({ ...actual }, lib.computeAllFingerprints(lib.fsReader(ROOT)),
    'run `npm run generate:premium-fingerprints` after changing governed source');
  const onDisk = fs.readFileSync(path.join(ROOT, lib.GENERATED_RELATIVE_PATH), 'utf8').replace(/\r\n/g, '\n');
  assert.equal(onDisk, lib.renderGeneratedModule(CURRENT));
  assert.deepEqual(Object.keys(actual).sort(), [...TYPES].sort());
});

test('NC: mutating governed source without regenerating is detected', () => {
  const stale = loadGeneratedFingerprints().CURRENT_IMPLEMENTATION_FINGERPRINTS;
  assert.notDeepEqual({ ...stale }, identities(mutate(snapshot, 'services/packing/packingClient.ts')));
});

test('identity is content-only: CRLF checkout does not change it, a one-byte edit does', () => {
  const crlf = Object.fromEntries(Object.entries(snapshot).map(([rel, text]) => [rel, text.replace(/\n/g, '\r\n')]));
  assert.deepEqual(identities(crlf), CURRENT);
  const edited = { ...snapshot, 'types/packing.ts': snapshot['types/packing.ts'] + ' ' };
  assert.notEqual(identities(edited).packing_generation_and_refinement, CURRENT.packing_generation_and_refinement);
});

test('a deleted or renamed governed file cannot silently yield an identity', () => {
  for (const rel of ['types/packing.ts', 'supabase/functions/stylechat-generate/packingHandler.ts', 'supabase/functions/commerce-watch-refresh/index.ts']) {
    const { [rel]: _removed, ...without } = snapshot;
    assert.throws(() => lib.computeAllFingerprints(lib.memoryReader(without)), /missing|empty/i, rel);
  }
});

test('governed sets cover the deployable closure and exclude test files', () => {
  const reader = lib.fsReader(ROOT);
  const packing = lib.governedFiles('packing_generation_and_refinement', reader);
  for (const rel of ['types/packing.ts', 'services/packing/packingClient.ts', 'supabase/functions/stylechat-generate/index.ts',
    'supabase/functions/stylechat-generate/packingHandler.ts', 'supabase/functions/stylechat-generate/packingContract.ts']) assert.ok(packing.includes(rel), rel);
  const watch = lib.governedFiles('watch_tracking', reader);
  for (const rel of ['services/watchlist/watchlistClient.ts', 'supabase/functions/commerce-watch-refresh/index.ts',
    'supabase/functions/commerce-watch-refresh/watchEntitlementGuard.ts', 'supabase/functions/scan-identify/shoppingProvider.ts']) assert.ok(watch.includes(rel), rel);
  for (const type of TYPES) assert.ok(lib.governedFiles(type, reader).every(rel => !/\.test\.(ts|tsx|js)$/.test(rel)), type);
  // Hooks and screens never earned these proofs; the harness drove the real clients directly.
  for (const type of TYPES) assert.ok(lib.governedFiles(type, reader).every(rel => !/^(hooks|app|components)\//.test(rel)), type);
});

test('import discovery follows multi-line, type-only, re-export and dynamic imports', () => {
  const source = "import {\n  a,\n  b,\n} from './one.ts';\nimport type { T } from '../two.ts';\nexport * from './three.ts';\nimport './four.ts';\nconst x = await import('./five.ts');\nimport z from 'npm:zod';";
  assert.deepEqual(lib.localImports(source).sort(), ['../two.ts', './five.ts', './four.ts', './one.ts', './three.ts']);
});

// ── The shipped proof ledger, pinned ───────────────────────────────────────

const GENERATED = loadGeneratedFingerprints().CURRENT_IMPLEMENTATION_FINGERPRINTS;
const shipping = (type) => proof.hasRuntimeCapabilityProof(CAPABILITY_OF[type] ?? 'smart_watchlist', type,
  { environment: 'staging', implementationFingerprints: GENERATED, nowMs: NOW, records: proof.PREMIUM_VALUE_PROOFS });

test('PINNED: exactly which claims the shipped records authorize against the shipping source', () => {
  // Update this table in the same change that records fresh runtime evidence.
  assert.deepEqual(Object.fromEntries(['packing_generation_and_refinement', 'watch_tracking', 'watch_provider_entitlement_boundary',
    'closet_outbound_sync', 'closet_cross_device_restore'].map(type => [type, shipping(type)])), {
    packing_generation_and_refinement: true, // identical governed source to the run that earned it
    watch_tracking: false, // earned against the pre-recheck backend; shipping Watch source differs
    watch_provider_entitlement_boundary: false, // never runtime-proven
    closet_outbound_sync: false, // source proof only
    closet_cross_device_restore: false, // never proven
  });
  for (const type of ['watch_worker_behavior', 'watch_push_ios', 'watch_push_android']) assert.equal(shipping(type), false, type);
});

test('every shipped record carries a well-formed identity and a basis commit', () => {
  for (const record of proof.PREMIUM_VALUE_PROOFS) {
    assert.match(record.implementationFingerprint, /^[0-9a-f]{64}$/, record.proofType);
    assert.ok(record.fingerprintBasisCommit, record.proofType);
    assert.ok(lib.DOMAINS[record.proofType], `${record.proofType} has no governed domain`);
  }
});

const revisionAvailable = rev => { try { execFileSync('git', ['-C', ROOT, 'cat-file', '-e', `${rev}^{commit}`], { stdio: 'ignore' }); return true; } catch { return false; } };
for (const record of proof.PREMIUM_VALUE_PROOFS) {
  const skip = !record.fingerprintBasisCommit || !revisionAvailable(record.fingerprintBasisCommit) ? 'basis commit is not in this clone' : false;
  test(`the ${record.proofType} identity is reproducible from its recorded basis commit`, { skip }, () => {
    assert.equal(lib.computeFingerprint(record.proofType, lib.gitReader(record.fingerprintBasisCommit)).fingerprint, record.implementationFingerprint);
  });
}

// ── Negative controls: the guards above go red when the check is removed ────

function removeFromProof(fragment) {
  return loadCapabilityProof({ mutate: source => {
    assert.ok(source.includes(fragment), `fragment missing: ${fragment}`);
    return source.replace(fragment, '');
  } });
}
function mutatedSourceIsRejected(subject) {
  const type = 'watch_tracking';
  const oldRecord = recordFor(type, CURRENT[type]);
  const changed = identities(mutate(snapshot, 'supabase/functions/commerce-watch-refresh/index.ts'));
  assert.equal(subject.hasRuntimeCapabilityProof(CAPABILITY_OF[type], type, contextFor(changed, [oldRecord])), false);
}
function malformedIdentityIsRejected(subject) {
  const type = 'packing_generation_and_refinement';
  assert.equal(subject.hasRuntimeCapabilityProof(CAPABILITY_OF[type], type, contextFor({ [type]: 'abc' }, [recordFor(type, 'abc')])), false);
}

test('NC-PV-FP-01: removing the fingerprint equality lets a stale proof authorize', () => {
  mutatedSourceIsRejected(proof);
  assert.throws(() => mutatedSourceIsRejected(removeFromProof('&& record.implementationFingerprint === current')), assert.AssertionError);
});

test('NC-PV-FP-02: removing the identity shape check lets two equal malformed values authorize', () => {
  malformedIdentityIsRejected(proof);
  assert.throws(() => malformedIdentityIsRejected(removeFromProof(" || !FINGERPRINT_SHAPE.test(current)")), assert.AssertionError);
});

test('NC-PV-FP-03: the expiry hook shares the authority predicate, not a private copy', () => {
  const hook = fs.readFileSync(path.join(ROOT, 'hooks/useKPlusLiveCapabilitySignals.ts'), 'utf8');
  assert.match(hook, /isProofRecordCurrent\(record, context\)/);
  assert.doesNotMatch(hook, /record\.environment|record\.status/);
});

test('the static build label cannot return as a proof authority', () => {
  for (const rel of ['services/kplus/kplusCapabilityProof.ts', 'hooks/useKPlusLiveCapabilitySignals.ts', 'services/kplus/kplusActivationCatalog.ts']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, rel), 'utf8'), /buildAuthority|PREMIUM_VALUE_BUILD_AUTHORITY/, rel);
  }
});
