#!/usr/bin/env node
'use strict';

/**
 * Garment asset QC tool (Section 21).
 *
 * A deliberately small engineering utility, not a production moderation
 * interface. It renders an annotated inspection sheet for a `.ksgarment`
 * asset — source texture, alpha mask, and every declared control point with
 * its canonical UV — and records an AUTO / MANUAL_CORRECTION / REJECTED
 * verdict using the existing asset-pipeline QC composer.
 *
 * Usage (from kscan-live-vto/, after `npm run build`):
 *
 *   node tools/garment-qc.js --fixture plain
 *   node tools/garment-qc.js --fixture logo
 *   node tools/garment-qc.js --fixture logo --correct leftHem=0.26,0.92
 *   node tools/garment-qc.js --fixture logo --reject "sleeve seam unusable"
 *
 * `--correct` applies a deterministic manual control-point correction and
 * records the verdict as MANUAL_CORRECTION, so a corrected fixture is never
 * silently indistinguishable from one that passed on its own.
 */

const fs = require('node:fs');
const path = require('node:path');

const R = require('../packages/static-renderer/dist/index.js');
const { composeQcRecord } = require('../packages/asset-pipeline/dist/index.js');
const { validateKsgarmentManifest } = require('../packages/garment-contract/dist/index.js');

const OUT_DIR = path.resolve(__dirname, '..', 'evidence', 'garment-qc');
fs.mkdirSync(OUT_DIR, { recursive: true });

// ─── Arguments ───────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const argValue = (name) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
};

const fixtureName = argValue('--fixture') ?? 'plain';
const correction = argValue('--correct');
const rejection = argValue('--reject');

const SPECS = { plain: R.PLAIN_TEE, logo: R.LOGO_TEE };
const spec = SPECS[fixtureName];
if (!spec) {
  console.error(`unknown fixture "${fixtureName}" (expected: ${Object.keys(SPECS).join(', ')})`);
  process.exit(2);
}

const fixture = R.generateSyntheticGarment(spec);
const manifest = JSON.parse(JSON.stringify(fixture.manifest));

// ─── Deterministic manual correction ─────────────────────────────────────────

let correctionApplied = null;
if (correction) {
  const match = /^([A-Za-z]+)=([\d.]+),([\d.]+)$/.exec(correction);
  if (!match) {
    console.error('--correct expects <controlPointId>=<u>,<v>, e.g. leftHem=0.26,0.92');
    process.exit(2);
  }
  const [, id, u, v] = match;
  const target = manifest.controlPoints.find((cp) => cp.id === id);
  if (!target) {
    console.error(`control point "${id}" is not declared by this manifest`);
    process.exit(2);
  }
  correctionApplied = { id, from: { u: target.u, v: target.v }, to: { u: Number(u), v: Number(v) } };
  target.u = Number(u);
  target.v = Number(v);
}

// ─── Annotated inspection sheet ──────────────────────────────────────────────

const PANEL_GAP = 16;
const LABEL_BAND = 46;
const panelW = fixture.texture.width;
const panelH = fixture.texture.height;
const sheet = R.createImage(panelW * 2 + PANEL_GAP * 3, panelH + LABEL_BAND + PANEL_GAP * 2, R.rgba(24, 26, 32, 255));

// Checkerboard behind both panels so alpha is visible as alpha rather than as
// whatever color happens to be underneath.
const drawCheckerboard = (originX, originY) => {
  for (let y = 0; y < panelH; y++) {
    for (let x = 0; x < panelW; x++) {
      const light = (Math.floor(x / 12) + Math.floor(y / 12)) % 2 === 0;
      const level = light ? 92 : 70;
      R.setPixel(sheet, originX + x, originY + y, R.rgba(level, level, level, 255));
    }
  }
};

const blit = (image, originX, originY) => {
  for (let y = 0; y < image.height; y++) {
    for (let x = 0; x < image.width; x++) {
      R.blendPixel(sheet, originX + x, originY + y, R.getPixel(image, x, y));
    }
  }
};

const texturePanelX = PANEL_GAP;
const maskPanelX = PANEL_GAP * 2 + panelW;
const panelY = LABEL_BAND;

drawCheckerboard(texturePanelX, panelY);
drawCheckerboard(maskPanelX, panelY);
blit(fixture.texture, texturePanelX, panelY);
blit(fixture.alphaMask, maskPanelX, panelY);

// Control points, annotated on the texture panel with canonical UVs.
const scale = 2;
for (const cp of manifest.controlPoints) {
  const px = texturePanelX + cp.u * panelW;
  const py = panelY + cp.v * panelH;
  const isCorrected = correctionApplied && correctionApplied.id === cp.id;
  const color = isCorrected ? R.rgba(255, 120, 200, 255) : R.rgba(255, 196, 0, 255);
  R.drawMarker(sheet, px, py, 7, color);
  R.drawText(sheet, `${cp.id.toUpperCase()} ${cp.u.toFixed(3)},${cp.v.toFixed(3)}`, px + 10, py - 4, {
    scale: 1,
    color,
    background: R.rgba(0, 0, 0, 190),
  });
  // Mirror the marker onto the mask panel so shoulders/neckline/sleeves/hem
  // can be checked against the silhouette edge, which is where a bad
  // control point actually shows.
  R.drawMarker(sheet, maskPanelX + cp.u * panelW, py, 7, color);
}

const validation = validateKsgarmentManifest(manifest);
const headerLines = [
  `GARMENT QC  ${manifest.productId}  ASSET V${manifest.assetVersion}  SCHEMA ${manifest.version}`,
  `TEXTURE ${panelW}X${panelH}  MESH ${manifest.meshDefinition.width}X${manifest.meshDefinition.height}  ` +
    `PROPORTION ${R.garmentProportionRatio(panelW, panelH).toFixed(3)}  SCHEMA ${validation.valid ? 'VALID' : 'INVALID'}`,
  'LEFT PANEL TEXTURE      RIGHT PANEL ALPHA MASK      AMBER CONTROL POINT      PINK MANUALLY CORRECTED',
];
headerLines.forEach((line, i) => {
  R.drawText(sheet, line, PANEL_GAP, 6 + i * 13, { scale: 1, color: R.rgba(226, 232, 240, 255) });
});

const sheetPath = path.join(OUT_DIR, `qc-${fixtureName}${correctionApplied ? '-corrected' : ''}.png`);
fs.writeFileSync(sheetPath, R.encodePng(sheet));

// ─── QC record ───────────────────────────────────────────────────────────────

// Confidences are stated honestly: this fixture is synthetic and its geometry
// is authored, not detected, so segmentation/control-point/normalization
// "confidence" is 1 by construction. A real catalog asset run through a real
// pipeline would carry measured values here instead — see
// evidence/garment-qc/README.md.
const record = composeQcRecord(manifest.productId, {
  shotClass: 'A_FLAT_LAY',
  shotClassConfidence: 1,
  segmentationConfidence: 1,
  controlPointConfidence: 1,
  normalizationConfidence: 1,
  logoOrPatternDetected: fixture.isDirectionalCanary,
  colorPreservationScore: null,
  manualAdjustmentApplied: Boolean(correctionApplied),
});

let status = correctionApplied ? 'MANUAL_CORRECTION' : 'AUTO';
if (rejection) {
  status = 'REJECTED';
  record.verdict = 'REJECTED';
  record.reason = rejection;
}
if (!validation.valid) {
  status = 'REJECTED';
  record.verdict = 'REJECTED';
  record.reason = `manifest schema invalid: ${validation.issues.map((i) => `${i.field} ${i.message}`).join('; ')}`;
}

const qcOut = {
  status,
  record,
  correctionApplied,
  schemaValidation: validation,
  syntheticFixture: true,
  evidenceClass: 'MECHANICS EVIDENCE ONLY — synthetic garment. Says nothing about real retailer-catalog asset viability.',
  sheet: path.basename(sheetPath),
};
const recordPath = path.join(OUT_DIR, `qc-${fixtureName}${correctionApplied ? '-corrected' : ''}.json`);
fs.writeFileSync(recordPath, JSON.stringify(qcOut, null, 2) + '\n');

console.log(`[garment-qc] ${manifest.productId}: ${status} (${record.verdict}) — ${record.reason}`);
console.log(`[garment-qc] sheet  ${path.relative(process.cwd(), sheetPath)}`);
console.log(`[garment-qc] record ${path.relative(process.cwd(), recordPath)}`);
