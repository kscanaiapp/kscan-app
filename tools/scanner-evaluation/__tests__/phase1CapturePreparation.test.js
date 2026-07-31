'use strict';

/**
 * Phase 1 finding F-1 — governed capture-preparation stage.
 *
 * These tests pin the behaviour that makes a Phase 1 baseline meaningful: the
 * bytes sent to the provider must be the bytes the production client would have
 * sent, they must fit the certified ceiling, they must be reproducible, and their
 * provenance must be recorded. The frozen corpus must come out unchanged.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const imagePreparation = require('../lib/imagePreparation');
const capturePreparation = require('../lib/capturePreparation');
const governedStorage = require('../lib/governedStorage');
const prepareDerivatives = require('../prepare-derivatives');
const runBaseline = require('../run-baseline');
const runIdentity = require('../lib/runIdentity');
const { verifyFrozenDataset } = require('../lib/frozenDataset');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const STORAGE_ROOT = process.env.KSCAN_EVAL_STORAGE_ROOT;
const MANIFEST_REL = 'evals/scanner-accuracy/tier-a-manifest.v0.3.1.json';
const PRICING_REL = 'evals/scanner-accuracy/pricing/gemini-pricing.2026-07-29.json';
const FREEZE = path.join(ROOT, 'evals/scanner-accuracy/tier-a-freeze.v0.3.1.json');
const MANIFEST = JSON.parse(fs.readFileSync(path.join(ROOT, MANIFEST_REL), 'utf8'));

/** Derivative roots must live outside every Git worktree; os.tmpdir() does. */
function derivativeRoot(label) {
  return fs.mkdtempSync(path.join(os.tmpdir(), `phase1-deriv-${label}-`));
}

/**
 * Delegates to the one shared resolver.
 *
 * This test previously carried a THIRD copy of the resolution rule, alongside
 * the one in lib/governedStorage.js and one in run-baseline.js. Three copies is
 * how the storage contract drifted out of agreement with the acquirer, so the
 * rule now lives in exactly one place.
 */
function resolveRef(refValue) {
  assert.ok(STORAGE_ROOT, 'KSCAN_EVAL_STORAGE_ROOT is required for capture-preparation tests');
  const candidate = governedStorage.resolveImageRef(refValue, { storageRoot: STORAGE_ROOT });
  if (!fs.existsSync(candidate)) throw new Error(`governed image not resolvable: ${refValue}`);
  return candidate;
}

function firstRef(caseIndex = 0) {
  const caseRecord = MANIFEST.cases[caseIndex];
  return {
    caseRecord,
    refValue: caseRecord.imageReferences[0].refValue,
    sourcePath: resolveRef(caseRecord.imageReferences[0].refValue),
    hash: caseRecord.imageHashes[0],
  };
}

// ── Transform parameters mirror the certified client ─────────────────────────

test('the preparation stage uses the certified client width and quality', () => {
  assert.equal(imagePreparation.TARGET_EDGE_PX, 896);
  assert.equal(imagePreparation.JPEG_QUALITY, 65);
  assert.equal(capturePreparation.CERTIFIED_CONTRACT.scannerImageMaxWidth, 896);
  assert.equal(capturePreparation.CERTIFIED_CONTRACT.scannerImageJpegQuality, 0.65);
  assert.equal(imagePreparation.DEFAULT_POLICY, imagePreparation.POLICY_CERTIFIED_CLIENT_WIDTH);
});

test('the default policy pins WIDTH to 896 and lets height scale, as production does', async () => {
  // The certified client calls resize({ width: 896 }); height is proportional, so
  // a portrait frame legitimately exceeds 896 on its long edge.
  const portrait = MANIFEST.cases
    .flatMap((c) => c.imageReferences.map((r) => r.refValue))
    .map((refValue) => ({ refValue, sourcePath: resolveRef(refValue) }));
  const root = derivativeRoot('width-policy');
  let sawPortrait = false;
  for (const image of portrait) {
    const record = await imagePreparation.prepareImage({
      sourcePath: image.sourcePath,
      viewId: crypto.createHash('sha256').update(image.refValue).digest('hex').slice(0, 12),
      derivativeRoot: root,
    });
    assert.equal(record.derivativeWidth, 896, `${image.refValue} width must be pinned to 896`);
    if (record.derivativeHeight > 896) sawPortrait = true;
  }
  assert.equal(sawPortrait, true, 'the corpus contains portrait frames whose long edge exceeds 896');
});

test('the max_dimension policy caps the long edge and is NOT the default', async () => {
  const { sourcePath } = firstRef(0);
  const root = derivativeRoot('maxdim-policy');
  const record = await imagePreparation.prepareImage({
    sourcePath,
    viewId: 'primary',
    derivativeRoot: root,
    policy: imagePreparation.POLICY_MAX_DIMENSION,
  });
  assert.equal(record.policy, 'max_dimension_896');
  assert.ok(Math.max(record.derivativeWidth, record.derivativeHeight) <= 896);
  assert.notEqual(imagePreparation.DEFAULT_POLICY, imagePreparation.POLICY_MAX_DIMENSION);
});

test('an unknown preparation policy is refused rather than defaulted', () => {
  assert.throws(() => imagePreparation.resolvePolicy('shrink_a_bit'), /unknown preparation policy/);
  assert.throws(
    () => prepareDerivatives.parseArgs(['--manifest', 'm', '--derivative-root', 'd', '--policy', 'nope']),
    /unknown preparation policy/
  );
});

test('orientation is baked into pixels and stripped from the output', async () => {
  const { sourcePath } = firstRef(0);
  const root = derivativeRoot('orientation');
  const record = await imagePreparation.prepareImage({ sourcePath, viewId: 'primary', derivativeRoot: root });
  assert.equal(record.transform.orientationApplied, 'exif_baked_then_stripped');
  assert.equal(record.transform.metadataStripped, true);
  // No orientation tag survives, so no viewer-dependent rotation can change what
  // the model receives.
  // eslint-disable-next-line global-require -- codec probe local to this assertion
  const meta = await require('sharp')(fs.readFileSync(record.derivativePath)).metadata();
  assert.ok(meta.orientation === undefined || meta.orientation === 1);
});

// ── Determinism and provenance ──────────────────────────────────────────────

test('preparation is deterministic for a fixed codec version', async () => {
  const { sourcePath, hash } = firstRef(0);
  const rootA = derivativeRoot('det-a');
  const rootB = derivativeRoot('det-b');
  const a = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: rootA, expectedSourceSha256: hash,
  });
  const b = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: rootB, expectedSourceSha256: hash,
  });
  assert.equal(a.derivativeSha256, b.derivativeSha256);
  assert.equal(a.derivativeByteLength, b.derivativeByteLength);
  // Codec versions are recorded, because byte determinism is NOT guaranteed across
  // libvips upgrades and a future run needs to know whether bytes are comparable.
  assert.ok(a.codec.sharp);
  assert.ok(a.codec.libvips);
});

test('a preparation record carries source hash, derivative hash, dimensions and transform', async () => {
  const { sourcePath, hash } = firstRef(0);
  const root = derivativeRoot('provenance');
  const record = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: root, expectedSourceSha256: hash,
  });
  assert.equal(`sha256:${record.sourceSha256}`, hash);
  assert.match(record.derivativeSha256, /^[0-9a-f]{64}$/);
  assert.ok(record.sourceWidth > 0 && record.sourceHeight > 0);
  assert.ok(record.derivativeWidth > 0 && record.derivativeHeight > 0);
  assert.equal(record.transform.format, 'jpeg');
  assert.equal(record.transform.quality, 65);
  assert.equal(record.transform.chromaSubsampling, '4:2:0');
  assert.equal(record.certifiedSourceSha, 'f5f4ed2eda4984db0658c3209fece223acd33188');
});

test('preparation refuses to run against unverified source bytes', async () => {
  const { sourcePath } = firstRef(0);
  const root = derivativeRoot('bad-hash');
  await assert.rejects(
    () => imagePreparation.prepareImage({
      sourcePath,
      viewId: 'primary',
      derivativeRoot: root,
      expectedSourceSha256: `sha256:${'0'.repeat(64)}`,
    }),
    /source hash mismatch/
  );
});

test('an existing derivative that disagrees with fresh bytes is refused, not overwritten', async () => {
  const { sourcePath, hash } = firstRef(0);
  const root = derivativeRoot('collision');
  const record = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: root, expectedSourceSha256: hash,
  });
  fs.writeFileSync(record.derivativePath, Buffer.from('not the prepared bytes'));
  await assert.rejects(
    () => imagePreparation.prepareImage({
      sourcePath, viewId: 'primary', derivativeRoot: root, expectedSourceSha256: hash,
    }),
    /differs from the freshly prepared bytes/
  );
  // force is the deliberate escape hatch.
  const forced = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: root, expectedSourceSha256: hash, force: true,
  });
  assert.equal(forced.derivativeSha256, record.derivativeSha256);
});

// ── Derivatives never enter Git ─────────────────────────────────────────────

test('a derivative root inside any Git worktree is refused', () => {
  assert.throws(() => imagePreparation.assertOutsideGit(ROOT), /inside the Git worktree/);
  assert.throws(
    () => imagePreparation.assertOutsideGit(path.join(ROOT, 'tools/scanner-evaluation')),
    /inside the Git worktree/
  );
  // A nested path several levels down is still inside, and must still be refused.
  assert.throws(
    () => imagePreparation.assertOutsideGit(path.join(ROOT, 'evals/scanner-accuracy/curation')),
    /inside the Git worktree/
  );
  assert.equal(imagePreparation.assertOutsideGit(os.tmpdir()), true);
});

test('no prepared derivative is tracked by Git', () => {
  // The governed-storage design keeps image bytes out of Git; derivatives are
  // image bytes and must obey the same rule.
  const tracked = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (/\.(jpg|jpeg|png)$/i.test(entry.name)) tracked.push(path.relative(ROOT, full));
    }
  };
  walk(path.join(ROOT, 'evals'));
  assert.deepEqual(tracked, [], 'no image bytes may live under evals/');
});

// ── The full corpus clears the certified ceiling ─────────────────────────────

test('all 56 governed images prepare to within the certified ceiling', async () => {
  const root = derivativeRoot('full-corpus');
  const records = [];
  for (const caseRecord of MANIFEST.cases) {
    const prepared = await imagePreparation.prepareCase(caseRecord, {
      resolveRef, derivativeRoot: root,
    });
    records.push(...prepared.preparations);
  }
  const summary = imagePreparation.summarizePreparations(records);
  assert.equal(summary.imageCount, 56);
  assert.equal(summary.imagesOverCertifiedCeiling, 0, JSON.stringify(summary.oversizedViewIds));
  assert.equal(summary.allWithinCertifiedCeiling, true);
  // Every prepared payload is below the certified ceiling, and the prepared range
  // OVERLAPS production's documented 120-320 KB typical output. It is not the same
  // band — a substantial share sit below 120 KB — so overlap is what is asserted
  // here and complete band parity is deliberately NOT claimed.
  const PRODUCTION_TYPICAL_MIN = 120 * 1024;
  const PRODUCTION_TYPICAL_MAX = 320 * 1024;
  assert.ok(
    summary.largestDerivativeBase64Length <= PRODUCTION_TYPICAL_MAX,
    `largest prepared payload ${summary.largestDerivativeBase64Length} exceeds production's documented typical maximum`
  );
  assert.ok(
    summary.largestDerivativeBase64Length >= PRODUCTION_TYPICAL_MIN,
    'the prepared range must overlap production\'s documented typical output'
  );
  assert.ok(
    summary.smallestDerivativeBase64Length < PRODUCTION_TYPICAL_MIN,
    'some prepared payloads fall below production\'s typical minimum; band parity must not be claimed'
  );
  // 5 sources are narrower than 896; production upscales them, so this does too.
  assert.equal(summary.upscaledCount, 5);
});

test('the unprepared corpus would have breached the ceiling — the defect F-1 fixed', () => {
  // Kept as a live assertion so the reason this stage exists cannot be forgotten.
  const images = MANIFEST.cases.flatMap((c) => c.imageReferences.map((r) => ({
    byteLength: fs.statSync(resolveRef(r.refValue)).size,
  })));
  const summary = capturePreparation.summarize(images, {
    mode: capturePreparation.MODE_CERTIFIED_CLIENT_EQUIVALENT,
  });
  assert.equal(summary.imageCount, 56);
  assert.equal(summary.imagesOverCertifiedCeiling, 25);
});

test('the frozen dataset is unchanged after preparing every derivative', () => {
  // Preparation belongs to the pipeline: it must not touch the source corpus and
  // must not require a dataset patch version.
  const report = verifyFrozenDataset(path.join(ROOT, MANIFEST_REL), FREEZE);
  assert.equal(report.ok, true, JSON.stringify(report.errors));
  // Pinned literal so silent corpus drift fails loudly. This value changed once,
  // from c3b68956…, when the governed text digests were corrected to LF-normalised
  // bytes so the freeze reproduces from a fresh clone. No case, label, split or
  // source image changed, which is why v0.3.1 was not superseded.
  assert.equal(report.aggregateSha256, '77e90edfe33d013285616ab1fa591112254b119be13620b606bfb57f37924883');
  assert.equal(report.imageHashVerified, 56);
  assert.equal(report.imagesInGit, 0);
  const versionFile = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/dataset-version.json'), 'utf8')
  );
  assert.equal(versionFile.datasetVersion, '0.3.1', 'preparation must not create a new dataset version');
});

// ── Preparation manifest integrity ──────────────────────────────────────────

test('the preparation manifest hash reproduces and detects tampering', async () => {
  const root = derivativeRoot('manifest-hash');
  const result = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL,
    '--derivative-root', root,
    '--split', 'holdout',
  ]);
  assert.equal(result.ok, true);
  assert.equal(result.imageCount, 9, 'the holdout has 7 cases and 9 images');
  assert.equal(result.imagesOverCertifiedCeiling, 0);

  const record = JSON.parse(fs.readFileSync(result.preparationManifest, 'utf8'));
  assert.equal(
    prepareDerivatives.preparationManifestHash(record),
    record.preparationManifestSha256,
    'the recorded hash must describe the manifest contents'
  );

  // A regenerated manifest with a new timestamp still matches; substance is hashed.
  const restamped = { ...record, generatedAt: '2099-01-01T00:00:00.000Z' };
  assert.equal(prepareDerivatives.preparationManifestHash(restamped), record.preparationManifestSha256);

  // An edited derivative hash does not.
  const tampered = JSON.parse(JSON.stringify(record));
  tampered.images[0].derivativeSha256 = 'f'.repeat(64);
  assert.notEqual(prepareDerivatives.preparationManifestHash(tampered), record.preparationManifestSha256);
});

test('the preparation manifest records fidelity limits rather than claiming parity', async () => {
  const root = derivativeRoot('fidelity');
  const result = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL, '--derivative-root', root, '--split', 'holdout',
  ]);
  const record = JSON.parse(fs.readFileSync(result.preparationManifest, 'utf8'));
  assert.ok(Array.isArray(record.fidelityLimitations) && record.fidelityLimitations.length >= 3);
  const joined = record.fidelityLimitations.join(' ');
  assert.match(joined, /not expo-image-manipulator/);
  assert.match(joined, /No byte-level parity is asserted/);
  assert.match(joined, /not guaranteed across libvips upgrades/);
  assert.equal(record.derivativesInGit, 0);
  assert.equal(record.datasetVersion, '0.3.1');
});

test('a derivative root inside the repository is refused by the preparation command', async () => {
  await assert.rejects(
    () => prepareDerivatives.main([
      '--manifest', MANIFEST_REL,
      '--derivative-root', path.join(ROOT, 'evals/scanner-accuracy'),
    ]),
    /inside the Git worktree/
  );
});

// ── Runner integration ──────────────────────────────────────────────────────

test('a declared preparation mode without a manifest is refused as notional', () => {
  const seed = JSON.parse(
    fs.readFileSync(path.join(ROOT, 'evals/scanner-accuracy/manifests/seed-qa-fixtures.v0.1.0.json'), 'utf8')
  );
  const preflight = runBaseline.preflightCase(seed.cases[0], {
    capturePreparation: 'certified_client_equivalent',
    preparations: new Map(),
  });
  assert.equal(preflight.ok, false);
  assert.ok(preflight.findings.some((f) => f.check === 'preparation_record_missing'));
});

test('a preparation record derived from different source bytes is refused', async () => {
  const root = derivativeRoot('source-mismatch');
  const { caseRecord, refValue, sourcePath } = firstRef(0);
  const record = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: root,
  });
  const preparations = new Map([[refValue, { ...record, sourceSha256: 'a'.repeat(64) }]]);
  const preflight = runBaseline.preflightCase(caseRecord, {
    capturePreparation: 'certified_client_equivalent',
    preparations,
  });
  assert.equal(preflight.ok, false);
  assert.ok(preflight.findings.some((f) => f.check === 'preparation_source_mismatch'));
});

test('a recorded derivative that is absent on disk is refused', async () => {
  const root = derivativeRoot('missing-derivative');
  const { caseRecord, refValue, sourcePath } = firstRef(0);
  const record = await imagePreparation.prepareImage({
    sourcePath, viewId: 'primary', derivativeRoot: root,
  });
  fs.rmSync(record.derivativePath);
  const preflight = runBaseline.preflightCase(caseRecord, {
    capturePreparation: 'certified_client_equivalent',
    preparations: new Map([[refValue, record]]),
  });
  assert.equal(preflight.ok, false);
  assert.ok(preflight.findings.some((f) => f.check === 'derivative_missing'));
});

test('the ceiling is checked against the PREPARED derivative, not the original', async () => {
  const root = derivativeRoot('prepared-ceiling');
  // Pick a case whose original breaches the ceiling but whose derivative does not.
  const oversized = MANIFEST.cases.find((c) => c.imageReferences.some(
    (r) => capturePreparation.base64Length(fs.statSync(resolveRef(r.refValue)).size)
      > capturePreparation.CERTIFIED_CONTRACT.maxImageBase64Bytes
  ));
  assert.ok(oversized, 'the corpus must contain an oversized original for this test to mean anything');

  const prepared = await imagePreparation.prepareCase(oversized, { resolveRef, derivativeRoot: root });
  const preparations = new Map();
  oversized.imageReferences.forEach((ref, i) => preparations.set(ref.refValue, prepared.preparations[i]));

  const withPreparation = runBaseline.preflightCase(oversized, {
    capturePreparation: 'certified_client_equivalent',
    preparations,
  });
  assert.equal(
    withPreparation.findings.some((f) => f.check === 'certified_payload_ceiling'),
    false,
    'the prepared derivative fits, so the ceiling finding must not fire'
  );

  const withoutPreparation = runBaseline.preflightCase(oversized, {
    capturePreparation: 'governed_original',
  });
  assert.ok(
    withoutPreparation.findings.some((f) => f.check === 'certified_payload_ceiling'),
    'the unprepared original breaches the ceiling and must be blocked'
  );
});

test('execute mode requires a production-equivalent preparation mode and a manifest', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-exec-prep-'));
  const base = [
    '--execute',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--max-calls', '10',
    '--max-usd', '10',
    '--pricing-record', PRICING_REL,
    '--split', 'development',
  ];
  const executor = () => ({ observations: [], consolidated: {} });

  assert.throws(
    () => runBaseline.main(base, { executor }),
    /production-equivalent --capture-preparation mode/
  );
  assert.throws(
    () => runBaseline.main([...base, '--capture-preparation', 'governed_original'], { executor }),
    /production-equivalent --capture-preparation mode/
  );
  assert.throws(
    () => runBaseline.main([...base, '--capture-preparation', 'certified_client_equivalent'], { executor }),
    /requires --preparation-manifest/
  );
});

test('a preparation manifest for a different dataset version is refused', async () => {
  const root = derivativeRoot('wrong-dataset');
  const result = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL, '--derivative-root', root, '--split', 'holdout',
  ]);
  const record = JSON.parse(fs.readFileSync(result.preparationManifest, 'utf8'));
  record.datasetVersion = '0.9.9';
  record.preparationManifestSha256 = prepareDerivatives.preparationManifestHash(record);
  const wrongPath = path.join(root, 'wrong.json');
  fs.writeFileSync(wrongPath, JSON.stringify(record, null, 2), 'utf8');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-wrong-dataset-'));
  const out = runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
    '--preparation-manifest', path.relative(ROOT, wrongPath).replace(/\\/g, '/'),
  ], { now: '2026-07-29T00:00:00.000Z' });
  process.exitCode = 0;
  assert.equal(out.ok, false);
  assert.equal(out.stage, 'capture_preparation');
  assert.ok(out.errors.some((e) => e.check === 'preparation_dataset_version'));
});

test('a tampered preparation manifest is refused by the runner', async () => {
  const root = derivativeRoot('tampered-manifest');
  const result = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL, '--derivative-root', root, '--split', 'development',
  ]);
  const record = JSON.parse(fs.readFileSync(result.preparationManifest, 'utf8'));
  // Change substance but keep the recorded hash: the runner must recompute.
  record.images[0].derivativeBase64Length = 1;
  const tamperedPath = path.join(root, 'tampered.json');
  fs.writeFileSync(tamperedPath, JSON.stringify(record, null, 2), 'utf8');

  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-tampered-'));
  const out = runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
    '--preparation-manifest', path.relative(ROOT, tamperedPath).replace(/\\/g, '/'),
  ], { now: '2026-07-29T00:00:00.000Z' });
  process.exitCode = 0;
  assert.equal(out.ok, false);
  assert.ok(out.errors.some((e) => e.check === 'preparation_manifest_hash'));
});

test('codec, transform, policy and manifest hash are all part of the run identity', () => {
  // Owner requirement: because this stage is production-EQUIVALENT rather than
  // byte-for-byte identical to production, each of these must stay in the
  // immutable run identity so a mismatch names the component that changed.
  for (const field of [
    'preparationManifestSha256',
    'preparationPolicy',
    'preparationCodec',
    'preparationTransformSignature',
  ]) {
    assert.ok(runIdentity.IDENTITY_FIELDS.includes(field), `${field} must be an identity field`);
  }
});

test('a changed preparation manifest, policy, codec or transform invalidates a resume', () => {
  const prior = {
    runId: 'baseline-v0.3.0-v140-20260729-1345-4c398e4-development-exec',
    datasetVersion: '0.3.0',
    datasetAggregateSha256: 'agg',
    adapterId: 'v140',
    certifiedBundleSha256: 'bundle',
    split: 'development',
    scoringContractVersion: '0.2.0',
    capturePreparationMode: 'certified_client_equivalent',
    preparationManifestSha256: 'prep-a',
    preparationPolicy: 'certified_client_width_896',
    preparationCodec: 'sharp@0.35.3+libvips@8.18.3',
    preparationTransformSignature: 'w896/q65/cap2097152',
    hardCallCeiling: 200,
    spendCeilingUsd: 10,
  };
  assert.equal(runIdentity.assertResumable(prior, { ...prior }).ok, true);
  // Different bytes reached the provider, so the two halves are not comparable.
  for (const [field, changed] of Object.entries({
    preparationManifestSha256: 'prep-b',
    preparationPolicy: 'max_dimension_896',
    preparationCodec: 'sharp@0.36.0+libvips@8.19.0',
    preparationTransformSignature: 'w896/q80/cap2097152',
  })) {
    assert.throws(
      () => runIdentity.assertResumable(prior, { ...prior, [field]: changed }),
      new RegExp(field),
      `${field} must invalidate a resume`
    );
  }
});

test('the preparation manifest hash covers the codec, the policy and every derivative hash', async () => {
  const root = derivativeRoot('identity-coverage');
  const result = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL, '--derivative-root', root, '--split', 'holdout',
  ]);
  const record = JSON.parse(fs.readFileSync(result.preparationManifest, 'utf8'));
  const baseline = prepareDerivatives.preparationManifestHash(record);

  const withCodec = JSON.parse(JSON.stringify(record));
  withCodec.codec.libvips = '9.9.9';
  assert.notEqual(prepareDerivatives.preparationManifestHash(withCodec), baseline, 'codec must be covered');

  const withPolicy = JSON.parse(JSON.stringify(record));
  withPolicy.policy = 'max_dimension_896';
  assert.notEqual(prepareDerivatives.preparationManifestHash(withPolicy), baseline, 'policy must be covered');

  const withContract = JSON.parse(JSON.stringify(record));
  withContract.certifiedContract.jpegQuality = 80;
  assert.notEqual(prepareDerivatives.preparationManifestHash(withContract), baseline, 'transform must be covered');
});

test('the owner authorization record states the approved ceilings and remaining credential blocker', () => {
  const auth = JSON.parse(fs.readFileSync(
    path.join(ROOT, 'evals/scanner-accuracy/authorization/phase1-execution-authorization.json'), 'utf8'
  ));
  assert.equal(auth.ceilings.maximumProviderAttempts.value, 200);
  assert.equal(auth.ceilings.maximumProviderAttempts.status, 'APPROVED');
  assert.equal(auth.ceilings.maximumProviderSpendUsd.value, 10.0);
  assert.equal(auth.ceilings.maximumProviderSpendUsd.status, 'APPROVED');

  // Capture preparation is accepted as production-EQUIVALENT only.
  assert.equal(auth.capturePreparation.acceptedAs, 'production-equivalent pilot preparation stage');
  assert.equal(auth.capturePreparation.explicitlyNotAcceptedAs, 'byte-for-byte production parity');
  assert.equal(auth.capturePreparation.defaultPolicy, imagePreparation.DEFAULT_POLICY);

  // Review blockers are closed; the dedicated credential remains open.
  const open = auth.remainingBlockers.filter((b) => b.status === 'OPEN').map((b) => b.blocker);
  assert.equal(open.length, 1);
  assert.match(open.join(' | '), /evaluation credential/);

  assert.deepEqual(
    auth.closedBlockers.filter((b) => ['RB-1', 'RB-2'].includes(b.id)).map((b) => b.id).sort(),
    ['RB-1', 'RB-2']
  );

  assert.equal(auth.verdict, 'BUILD 4 PHASE 1 BLOCKED — DEDICATED EVALUATION CREDENTIAL GATE REMAINS');
});

test('the run artifact records preparation provenance and the certified contract', () => {
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-prep-artifact-'));
  const result = runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
  ], { now: '2026-07-29T00:00:00.000Z' });
  process.exitCode = 0;
  const plan = result.planDocument;
  assert.equal(plan.capturePreparation.mode, 'certified_client_equivalent');
  assert.equal(plan.capturePreparation.productionEquivalent, true);
  assert.equal(plan.certifiedPayloadContract.maxImageBase64Bytes, 2 * 1024 * 1024);
  assert.equal(plan.certifiedPayloadContract.scannerImageMaxWidth, 896);
  assert.equal(plan.certifiedPayloadContract.scannerImageJpegQuality, 0.65);
  assert.equal(plan.runIdentity.capturePreparationMode, 'certified_client_equivalent');
});

test('the run artifact preserves derivative ceiling status when summarizing prepared payloads', async () => {
  const root = derivativeRoot('summary-status');
  const prepared = await prepareDerivatives.main([
    '--manifest', MANIFEST_REL, '--derivative-root', root, '--split', 'development',
  ]);
  const outputDir = fs.mkdtempSync(path.join(os.tmpdir(), 'phase1-prep-summary-'));
  const result = runBaseline.main([
    '--dry-run',
    '--manifest', MANIFEST_REL,
    '--output-dir', outputDir,
    '--split', 'development',
    '--capture-preparation', 'certified_client_equivalent',
    '--preparation-manifest', prepared.preparationManifest,
  ], { now: '2026-07-30T00:00:00.000Z' });
  process.exitCode = 0;
  assert.equal(result.ok, true);
  assert.equal(result.blockedCaseCount, 0);
  assert.equal(result.capturePreparation.preparedPayloads.allWithinCertifiedCeiling, true);
  assert.equal(result.capturePreparation.preparedPayloads.imagesOverCertifiedCeiling, 0);
  assert.deepEqual(result.capturePreparation.preparedPayloads.oversizedViewIds, []);
});
