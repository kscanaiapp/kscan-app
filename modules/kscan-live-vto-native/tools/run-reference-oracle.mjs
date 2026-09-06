/**
 * Reference half of the N1-C cross-runtime conformance measurement.
 *
 * Runs the P3-A static renderer's OWN compiled attachment geometry over the
 * same committed golden BodyFrames and the same committed garment fixtures
 * the native JVM conformance test consumes, and writes one JSONL record per
 * (fixture, case).
 *
 * Why the compiled output and not the .ts source: N1-ENV-006. The `.d.ts`
 * carries signatures and prose, not arithmetic, and porting from it produced
 * three real algorithmic divergences. `dist/attachment.js` is what the
 * reference actually executes.
 *
 * The reference package is a DISJOINT, UNMERGED git history. It is not
 * imported by any app or module code -- `scripts/check-vto-live-integration-scope.js`
 * forbids that mechanically. This tool reaches it only as an out-of-tree
 * measurement oracle, by explicit path, and nothing it produces is shipped.
 *
 * Usage:
 *   node tools/run-reference-oracle.mjs --reference <path-to-kscan-live-vto> [--out <dir>]
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { execFileSync } from 'node:child_process';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CANVAS_W = 720;
const CANVAS_H = 960;
const FIXTURES = ['n1b-fixture', 'n1c-asym-fixture'];

function arg(name, fallback) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const referenceRoot = arg('reference', process.env.KSCAN_LIVE_VTO_REFERENCE);
const outDir = resolve(arg('out', join(MODULE_ROOT, 'build', 'conformance')));

if (!referenceRoot) {
  console.error(
    'ERROR: the reference oracle checkout path is required.\n' +
      '  --reference <path>   or   KSCAN_LIVE_VTO_REFERENCE=<path>\n\n' +
      'It must point at a `kscan-live-vto` workspace built from the P3-A reference SHA,\n' +
      'with packages/static-renderer/dist present (run its own build first).',
  );
  process.exit(2);
}

const attachmentPath = resolve(referenceRoot, 'packages/static-renderer/dist/attachment.js');

/**
 * Records exactly which reference commit this measurement was taken against
 * (amendment D5: every ported algorithm names its reference SHA). Read from
 * the reference checkout itself, never asserted from a prompt or from memory.
 */
function referenceProvenance() {
  const run = (args) => {
    try {
      return execFileSync('git', args, { cwd: referenceRoot, encoding: 'utf8' }).trim();
    } catch {
      return null;
    }
  };
  return {
    checkout: referenceRoot,
    headSha: run(['rev-parse', 'HEAD']),
    attachmentSourceSha: run(['hash-object', 'packages/static-renderer/src/attachment.ts']),
    attachmentDistSha: run(['hash-object', '--no-filters', attachmentPath]),
    dirty: run(['status', '--porcelain', '--', 'packages/static-renderer']) || '',
  };
}

const attachment = await import(pathToFileURL(attachmentPath).href);

/** Golden landmark encoding -> the reference's own Landmark discriminated union. */
function toLandmark(raw) {
  if (raw === null || raw === undefined) return { present: false };
  const decode = (v) => {
    if (typeof v === 'number') return v;
    if (v === 'NaN') return Number.NaN;
    if (v === 'Infinity') return Number.POSITIVE_INFINITY;
    if (v === '-Infinity') return Number.NEGATIVE_INFINITY;
    throw new Error(`unsupported coordinate encoding: ${JSON.stringify(v)}`);
  };
  return { present: true, point: { u: decode(raw[0]), v: decode(raw[1]) }, confidence: 1 };
}

function toBodyFrame(landmarks) {
  const at = (name) => toLandmark(landmarks[name] ?? null);
  return {
    timestamp: 0,
    headCenter: at('headCenter'),
    noseOrHeadDirection: { present: false },
    neckCenter: at('neckCenter'),
    leftShoulder: at('leftShoulder'),
    rightShoulder: at('rightShoulder'),
    leftElbow: at('leftElbow'),
    rightElbow: at('rightElbow'),
    leftWrist: at('leftWrist'),
    rightWrist: at('rightWrist'),
    chestCenter: { present: false },
    waistCenter: { present: false },
    leftHip: at('leftHip'),
    rightHip: at('rightHip'),
    torsoCenter: { present: false },
    torsoWidth: null,
    torsoHeight: null,
    torsoRotation: null,
    trackingConfidence: 1,
  };
}

/** PNG IHDR read -- no image decoding needed, only dimensions. */
function pngDimensions(path) {
  const b = readFileSync(path);
  return { width: b.readUInt32BE(16), height: b.readUInt32BE(20) };
}

function computeReferenceSnapshot(manifest, frame, dims) {
  const extracted = attachment.extractBodyAnchors(frame, CANVAS_W, CANVAS_H);
  if (!extracted.ok) return { failure: extracted.reason };

  const anchors = extracted.anchors;
  const targets = attachment.computeControlPointTargets(manifest, anchors, dims.width, dims.height);
  if (!targets || Object.keys(targets).length === 0) {
    // The reference signals every stage-2 refusal by returning {}. Native
    // distinguishes the causes; here they collapse, so the comparison tool
    // treats "reference returned {}" as "reference refused, cause unstated".
    return { failure: 'reference_returned_no_targets' };
  }

  const fit = attachment.fitRigidPlacement(manifest, dims.width, dims.height, targets);
  if (!fit.ok) return { failure: fit.reason };

  const gate = attachment.evaluateRigidGate(manifest, fit.transform, dims.width, dims.height, anchors);

  const points = Object.entries(targets);
  const xs = points.map(([, p]) => p.x);
  const ys = points.map(([, p]) => p.y);

  return {
    failure: null,
    gatePassed: gate.passed,
    gateFindings: gate.findings,
    scale: fit.transform.scale,
    rotationRadians: fit.transform.rotationRadians,
    controlPoints: Object.fromEntries(points.sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, p]) => [k, [p.x, p.y]])),
    bounds: { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) },
    measurements: gate.measurements,
  };
}

const goldens = JSON.parse(readFileSync(join(MODULE_ROOT, 'goldens', 'bodyframes.json'), 'utf8'));
const allCases = [...goldens.cases, ...goldens.refusalCases];

mkdirSync(outDir, { recursive: true });

const lines = [];
for (const fixtureName of FIXTURES) {
  const dir = join(MODULE_ROOT, 'android', 'src', 'main', 'assets', fixtureName);
  const assetManifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  const manifest = assetManifest.ksgarment;
  const dims = pngDimensions(join(dir, manifest.texture));

  for (const testCase of allCases) {
    const snapshot = computeReferenceSnapshot(manifest, toBodyFrame(testCase.landmarks), dims);
    lines.push(
      JSON.stringify({
        fixture: fixtureName,
        case: testCase.id,
        textureWidth: dims.width,
        textureHeight: dims.height,
        snapshot,
      }),
    );
  }
}

writeFileSync(join(outDir, 'reference-snapshots.jsonl'), lines.join('\n') + '\n');
writeFileSync(
  join(outDir, 'reference-provenance.json'),
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      reference: referenceProvenance(),
      attachmentModule: attachmentPath,
      canvas: { width: CANVAS_W, height: CANVAS_H },
      goldensSchema: goldens.schema,
      caseCount: allCases.length,
      fixtures: FIXTURES,
    },
    null,
    2,
  ) + '\n',
);

console.log(`wrote ${lines.length} reference snapshots to ${outDir}`);
