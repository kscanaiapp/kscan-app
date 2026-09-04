#!/usr/bin/env node
'use strict';

/**
 * Renders the Section 19 five-case static-preview review package.
 *
 * Deterministic: same commit + same fixtures ⇒ byte-identical PNGs. Run from
 * kscan-live-vto/ after building:
 *
 *   npm run build -w @kscan-live-vto/static-renderer
 *   node tools/render-static-review.js
 *
 * Output lands in evidence/static-preview/ as PNG + JSON sidecar pairs, plus
 * a machine-readable summary.json the review document quotes from.
 */

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const R = require('../packages/static-renderer/dist/index.js');

const OUT_DIR = path.resolve(__dirname, '..', 'evidence', 'static-preview');
fs.mkdirSync(OUT_DIR, { recursive: true });

const GIT_SHA = (() => {
  try {
    return execFileSync('git', ['rev-parse', 'HEAD'], { cwd: path.resolve(__dirname, '..', '..') })
      .toString()
      .trim();
  } catch {
    return 'unknown';
  }
})();

function writePng(name, image) {
  const file = path.join(OUT_DIR, `${name}.png`);
  fs.writeFileSync(file, R.encodePng(image));
  return { file: path.basename(file), bytes: fs.statSync(file).size, width: image.width, height: image.height };
}

function writeJson(name, value) {
  const file = path.join(OUT_DIR, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
  return path.basename(file);
}

// ─── Fixtures ────────────────────────────────────────────────────────────────

const plainTee = R.generateSyntheticGarment(R.PLAIN_TEE);
const logoTee = R.generateSyntheticGarment(R.LOGO_TEE);

const assetOf = (fixture) => ({
  manifest: fixture.manifest,
  texture: fixture.texture,
  alphaMask: fixture.alphaMask,
  logoBoxTexturePx: fixture.logoBoxTexturePx,
});

const personSpecs = {
  neutral: { ...R.NEUTRAL_PERSON },
  narrow: {
    ...R.NEUTRAL_PERSON,
    fixtureId: 'synthetic-person-narrow',
    shoulderWidthNorm: 0.26,
    torsoHeightNorm: 0.33,
    centerXNorm: 0.455,
    tiltRadians: -0.05,
    shoulderAsymmetryNorm: 0.012,
    backgroundLevel: 205,
    currentGarmentTone: R.rgba(112, 104, 96, 255),
    seed: 23,
  },
  broad: {
    ...R.NEUTRAL_PERSON,
    fixtureId: 'synthetic-person-broad',
    shoulderWidthNorm: 0.43,
    torsoHeightNorm: 0.27,
    centerXNorm: 0.535,
    tiltRadians: 0.06,
    shoulderAsymmetryNorm: -0.014,
    backgroundLevel: 128,
    skinTone: R.rgba(122, 88, 66, 255),
    currentGarmentTone: R.rgba(62, 70, 60, 255),
    seed: 41,
  },
  armsAway: {
    ...R.NEUTRAL_PERSON,
    fixtureId: 'synthetic-person-arms-away',
    armPose: 'away',
    tiltRadians: 0.03,
    backgroundLevel: 190,
    seed: 57,
  },
  crossed: {
    ...R.NEUTRAL_PERSON,
    fixtureId: 'synthetic-person-forearm-crossing',
    armPose: 'crossed',
    backgroundLevel: 168,
    maskEdgeNoise: 2.5,
    seed: 73,
  },
};

// ─── Cases (Section 19 rubric) ───────────────────────────────────────────────

const CASES = [
  {
    caseId: 'case-1-neutral-plain-tee',
    title: 'CASE 1 — NEUTRAL + PLAIN TEE',
    person: personSpecs.neutral,
    garment: plainTee,
    useForeground: false,
  },
  {
    caseId: 'case-2-logo-tee-canary',
    title: 'CASE 2 — LOGO TEE (CANARY)',
    person: personSpecs.neutral,
    garment: logoTee,
    useForeground: false,
  },
  {
    caseId: 'case-3a-narrow-torso',
    title: 'CASE 3A — BODY PROPORTION: NARROW',
    person: personSpecs.narrow,
    garment: logoTee,
    useForeground: false,
  },
  {
    caseId: 'case-3b-broad-torso',
    title: 'CASE 3B — BODY PROPORTION: BROAD',
    person: personSpecs.broad,
    garment: logoTee,
    useForeground: false,
  },
  {
    caseId: 'case-4-arms-away',
    title: 'CASE 4 — ARMS AWAY',
    person: personSpecs.armsAway,
    garment: plainTee,
    useForeground: false,
  },
  {
    caseId: 'case-5-forearm-crossing',
    title: 'CASE 5 — FOREARM CROSSING (OCCLUSION)',
    person: personSpecs.crossed,
    garment: plainTee,
    useForeground: true,
  },
];

const summary = {
  generatedFrom: { gitSha: GIT_SHA, rendererVersion: R.RENDERER_VERSION, deformationAlgorithm: R.DEFORMATION_ALGORITHM },
  segmentationEngine: 'NOT YET IMPLEMENTED — PRECOMPUTED TEST MASK',
  fixtureClass: 'SYNTHETIC — NOT HUMAN',
  cases: [],
};

for (const testCase of CASES) {
  const person = R.generateSyntheticPerson(testCase.person);
  const asset = assetOf(testCase.garment);

  const input = {
    fixtureId: person.spec.fixtureId,
    caseId: testCase.caseId,
    personImage: person.image,
    bodyFrame: person.bodyFrame,
    descriptor: testCase.garment.descriptor,
    asset,
    foregroundMask: testCase.useForeground ? person.foregroundMask : null,
    maskProvenance: testCase.useForeground ? 'precomputed' : 'none',
    gitSha: GIT_SHA,
  };

  const record = { caseId: testCase.caseId, title: testCase.title, garment: asset.manifest.productId, images: {} };

  const rigid = R.renderRigidStage(input);
  if (!rigid.ok) {
    record.status = 'FAILED_BEFORE_RIGID';
    record.failure = { stage: rigid.stage, reason: rigid.reason };
    summary.cases.push(record);
    console.error(`[${testCase.caseId}] FAILED at ${rigid.stage}: ${rigid.reason}`);
    continue;
  }

  record.images.person = writePng(`${testCase.caseId}-00-person-fixture`, person.image);
  record.images.rigid = writePng(`${testCase.caseId}-01-rigid`, rigid.result.image);
  record.images.rigidOverlay = writePng(`${testCase.caseId}-02-rigid-overlay`, rigid.result.overlay);
  record.rigidGate = rigid.result.gate;

  const deformed = R.renderDeformedStage(input, rigid.result);
  if (!deformed.ok) {
    record.status = 'STOPPED_AT_RIGID_GATE';
    record.failure = { reason: deformed.reason, findings: deformed.gate.findings };
    summary.cases.push(record);
    console.error(`[${testCase.caseId}] STOP GATE: ${deformed.gate.findings.join(', ')}`);
    continue;
  }

  record.status = 'RENDERED';
  record.images.preview = writePng(`${testCase.caseId}-03-preview-lighting-adjusted`, deformed.result.image);
  record.images.previewUnadjusted = writePng(`${testCase.caseId}-04-preview-unadjusted`, deformed.result.unadjustedImage);
  if (deformed.result.occlusionControlImage) {
    record.images.occlusionControl = writePng(
      `${testCase.caseId}-05-occlusion-control-wrong-layer-order`,
      deformed.result.occlusionControlImage,
    );
  }
  record.manifestFile = writeJson(`${testCase.caseId}-manifest`, deformed.result.manifest);
  record.metrics = {
    controlPointMaxPx: deformed.result.metrics.controlPoint.maxPixels,
    controlPointMaxNormalized: deformed.result.metrics.controlPoint.maxNormalized,
    torsoCoverage: deformed.result.metrics.coverage.torsoCoverage,
    spillFraction: deformed.result.metrics.coverage.spillFraction,
    jacobian: deformed.result.metrics.jacobian,
    logo: deformed.result.metrics.logo,
    foregroundOverGarmentPixels: deformed.result.metrics.foregroundOverGarmentPixels,
    lighting: deformed.result.manifest.lightingParameters,
  };

  summary.cases.push(record);
  console.log(
    `[${testCase.caseId}] rendered  gate=${rigid.result.gate.passed ? 'PASS' : 'FAIL'}` +
      `  cpMaxPx=${deformed.result.metrics.controlPoint.maxPixels.toFixed(2)}` +
      `  coverage=${(deformed.result.metrics.coverage.torsoCoverage * 100).toFixed(1)}%` +
      `  jac=[${deformed.result.metrics.jacobian.minDeterminant.toFixed(2)}, ${deformed.result.metrics.jacobian.maxDeterminant.toFixed(2)}]` +
      `  foldover=${deformed.result.metrics.jacobian.foldoverCells}` +
      (deformed.result.metrics.logo
        ? `  logoAspect=${deformed.result.metrics.logo.aspectRatioChange.toFixed(3)} mirrored=${deformed.result.metrics.logo.mirrored}`
        : ''),
  );
}

// Garment asset references, written once rather than per case.
writePng('asset-tee-plain-texture', plainTee.texture);
writePng('asset-tee-plain-alpha', plainTee.alphaMask);
writePng('asset-tee-logo-texture', logoTee.texture);
writePng('asset-tee-logo-alpha', logoTee.alphaMask);
writeJson('asset-tee-plain-manifest', plainTee.manifest);
writeJson('asset-tee-logo-manifest', logoTee.manifest);

writeJson('summary', summary);

const totalBytes = fs
  .readdirSync(OUT_DIR)
  .reduce((sum, f) => sum + fs.statSync(path.join(OUT_DIR, f)).size, 0);
console.log(`\n[render-static-review] ${summary.cases.length} cases -> ${OUT_DIR}`);
console.log(`[render-static-review] total artifact bytes: ${(totalBytes / 1024 / 1024).toFixed(2)} MB (budget 5 MB)`);
