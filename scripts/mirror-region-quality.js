#!/usr/bin/env node
/**
 * Mirror Selfie region-geometry evaluation (Build 2.5 Step 3, owner §3).
 *
 * ── READ THIS BEFORE READING THE NUMBERS ────────────────────────────────────
 *
 * This measures the GEOMETRY LAYER ONLY: given landmarks, what regions come
 * out, how they are bucketed, how much of each crop is padding, and whether a
 * garment gets cut off.
 *
 * It does NOT measure, and no number below should be read as:
 *   - person-detection accuracy      (needs ML Kit / Vision on real photos)
 *   - landmark placement accuracy    (same)
 *   - whether a crop contains one garment or three
 *   - latency, memory, or binary size
 *
 * The landmark fixtures are HAND-CONSTRUCTED to represent the fixture classes
 * the Step 3 brief requires. They are stand-ins for a detector's output, not
 * samples of one. Real rates require a physical-device pass over real
 * photographs, which this build is not authorized to run.
 *
 * Usage:  node scripts/mirror-region-quality.js
 */

const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const cache = new Map();

function load(rel) {
  if (cache.has(rel)) return cache.get(rel);
  const mod = { exports: {} };
  cache.set(rel, mod.exports);
  const out = ts.transpileModule(fs.readFileSync(path.join(ROOT, rel), 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020, esModuleInterop: true },
  }).outputText;
  const req = (request) => {
    const resolved = path
      .relative(ROOT, path.resolve(path.dirname(path.join(ROOT, rel)), request))
      .split(path.sep)
      .join('/');
    for (const c of [`${resolved}.ts`, `${resolved}.js`]) {
      if (fs.existsSync(path.join(ROOT, c))) return load(c);
    }
    return {};
  };
  vm.runInThisContext(`(function (exports, module, require) {\n${out}\n})`, { filename: rel })(
    mod.exports,
    mod,
    req,
  );
  cache.set(rel, mod.exports);
  return mod.exports;
}

const adapter = load('services/mirror/mirrorExtractionAdapter.ts');
const regions = load('services/mirror/mirrorGarmentRegions.ts');
const resolution = load('services/mirror/mirrorPersonResolution.ts');

const L = (type, x, y, confidence = 0.9) => ({ type, x, y, confidence });

function figure({ top = 0.08, bottom = 0.94, cx = 0.5, halfWidth = 0.11, omit = [], weak = [], conf = 0.9 }) {
  const span = bottom - top;
  const at = (f) => top + span * f;
  const all = [
    L('nose', cx, at(0.03), conf),
    L('left_shoulder', cx - halfWidth, at(0.14), conf),
    L('right_shoulder', cx + halfWidth, at(0.14), conf),
    L('left_hip', cx - halfWidth * 0.75, at(0.48), conf),
    L('right_hip', cx + halfWidth * 0.75, at(0.48), conf),
    L('left_knee', cx - halfWidth * 0.7, at(0.71), conf),
    L('right_knee', cx + halfWidth * 0.7, at(0.71), conf),
    L('left_ankle', cx - halfWidth * 0.65, at(0.95), conf),
    L('right_ankle', cx + halfWidth * 0.65, at(0.95), conf),
  ];
  return all
    .filter((l) => !omit.includes(l.type))
    .map((l) => (weak.includes(l.type) ? { ...l, confidence: 0.2 } : l));
}

function person(landmarks, box) {
  return adapter.normalizeDetectedPerson({
    bounds: box ?? { x: 0.3, y: 0.05, width: 0.4, height: 0.92 },
    rankingExtent: { x: 0.44, y: 0.06, width: 0.12, height: 0.1 },
    confidence: 0.95,
    maskCoverage: null,
    landmarks,
  });
}

/** Required fixture classes from the Step 3 brief. */
const FIXTURES = [
  { id: 'F1  one person, all garments visible', people: [person(figure({}))] },
  {
    id: 'F2  one person, upper body only in frame',
    people: [person(figure({ omit: ['left_knee', 'right_knee', 'left_ankle', 'right_ankle'] }))],
  },
  {
    id: 'F3  two people, one clearly dominant',
    people: [
      adapter.normalizeDetectedPerson({
        bounds: { x: 0.3, y: 0.05, width: 0.4, height: 0.92 },
        rankingExtent: { x: 0.43, y: 0.06, width: 0.16, height: 0.13 },
        confidence: 0.95,
        maskCoverage: null,
        landmarks: figure({}),
      }),
      adapter.normalizeDetectedPerson({
        bounds: { x: 0.02, y: 0.3, width: 0.1, height: 0.4 },
        rankingExtent: { x: 0.04, y: 0.31, width: 0.05, height: 0.04 },
        confidence: 0.9,
        maskCoverage: null,
        landmarks: figure({ top: 0.3, bottom: 0.7, cx: 0.07, halfWidth: 0.03 }),
      }),
    ],
  },
  {
    id: 'F4  two ambiguous people',
    people: [
      adapter.normalizeDetectedPerson({
        bounds: { x: 0.05, y: 0.08, width: 0.4, height: 0.85 },
        rankingExtent: { x: 0.2, y: 0.09, width: 0.13, height: 0.11 },
        confidence: 0.95,
        maskCoverage: null,
        landmarks: figure({ cx: 0.26 }),
      }),
      adapter.normalizeDetectedPerson({
        bounds: { x: 0.55, y: 0.08, width: 0.4, height: 0.85 },
        rankingExtent: { x: 0.68, y: 0.09, width: 0.125, height: 0.11 },
        confidence: 0.95,
        maskCoverage: null,
        landmarks: figure({ cx: 0.74 }),
      }),
    ],
  },
  { id: 'F5  no person', people: [] },
  {
    id: 'F6  low quality — every landmark weak',
    people: [person(figure({ conf: 0.15 }))],
  },
  {
    id: 'F7  rotated / landscape framing',
    people: [person(figure({ top: 0.2, bottom: 0.8, cx: 0.35, halfWidth: 0.07 }))],
  },
  {
    id: 'F8  overlapping detections — feet together',
    people: [
      person([
        ...figure({ omit: ['left_ankle', 'right_ankle'] }),
        L('left_ankle', 0.5, 0.9),
        L('right_ankle', 0.503, 0.9),
      ]),
    ],
  },
  {
    id: 'F9  partial — no hips detected',
    people: [person(figure({ omit: ['left_hip', 'right_hip'] }))],
  },
  {
    id: 'F10 weak ankles, knees usable',
    people: [person(figure({ weak: ['left_ankle', 'right_ankle'] }))],
  },
];

/**
 * Landmarks that define each region's extent.
 *
 * Restated here rather than exported from the production module: this is an
 * EVALUATION concern, and widening the module's API to let a script inspect its
 * internals would be the tail wagging the dog. Kept in step with
 * deriveGarmentRegions by the region-derivation tests, which assert the same
 * edges from the other side.
 */
const DEFINING = {
  upper_body: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip'],
  lower_body: ['left_hip', 'right_hip', 'left_knee', 'right_knee', 'left_ankle', 'right_ankle'],
  full_length: ['left_shoulder', 'right_shoulder', 'left_hip', 'right_hip', 'left_ankle', 'right_ankle'],
  left_foot: ['left_ankle'],
  right_foot: ['right_ankle'],
};

/**
 * Empty padding: the fraction of the crop lying outside the box spanned by that
 * region's OWN defining landmarks.
 *
 * Some padding is intended and documented — landmarks sit on the skeleton,
 * inside the sleeve and above the hem, so a crop pinned exactly to the joints
 * would slice the garment. What this number is for is spotting a region that is
 * MOSTLY empty space.
 *
 * A single-landmark region (a foot) has a zero-area reference box and is
 * reported as `-` rather than as 100% padding, which would be arithmetic
 * masquerading as a finding.
 */
function paddingFraction(region, landmarks) {
  const defining = (DEFINING[region.regionClass] ?? []).map((type) =>
    landmarks.find((l) => l.type === type),
  ).filter(Boolean);
  if (defining.length < 2) return null;
  const xs = defining.map((l) => l.x);
  const ys = defining.map((l) => l.y);
  const ref = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  if (!(ref.width > 0) || !(ref.height > 0)) return null;

  const left = Math.max(region.bounds.x, ref.x);
  const top = Math.max(region.bounds.y, ref.y);
  const right = Math.min(region.bounds.x + region.bounds.width, ref.x + ref.width);
  const bottom = Math.min(region.bounds.y + region.bounds.height, ref.y + ref.height);
  const covered = right > left && bottom > top ? (right - left) * (bottom - top) : 0;
  const cropArea = region.bounds.width * region.bounds.height;
  return cropArea > 0 ? Math.max(0, 1 - covered / cropArea) : null;
}

/**
 * Major cutoff: the fraction of the defining-landmark box that falls OUTSIDE
 * the crop. Anything above zero means the crop clipped part of the body span
 * it was supposed to contain.
 */
function cutoffFraction(region, landmarks) {
  const defining = (DEFINING[region.regionClass] ?? []).map((type) =>
    landmarks.find((l) => l.type === type),
  ).filter(Boolean);
  if (defining.length < 2) return null;
  const xs = defining.map((l) => l.x);
  const ys = defining.map((l) => l.y);
  const ref = {
    x: Math.min(...xs),
    y: Math.min(...ys),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
  const refArea = ref.width * ref.height;
  if (!(refArea > 0)) return null;
  const left = Math.max(region.bounds.x, ref.x);
  const top = Math.max(region.bounds.y, ref.y);
  const right = Math.min(region.bounds.x + region.bounds.width, ref.x + ref.width);
  const bottom = Math.min(region.bounds.y + region.bounds.height, ref.y + ref.height);
  const covered = right > left && bottom > top ? (right - left) * (bottom - top) : 0;
  return Math.max(0, 1 - covered / refArea);
}

const rows = [];
let zeroRegion = 0;
let ambiguous = 0;
let separated = 0;
let processed = 0;
let duplicateSuspects = 0;
let reviewFlagged = 0;
let totalRegions = 0;
let majorCutoff = 0;

for (const fixture of FIXTURES) {
  const resolved = resolution.resolvePrimaryPerson(fixture.people);
  if (resolved.kind === 'none') {
    rows.push({ fixture: fixture.id, outcome: 'no_person', regions: '-', buckets: '-' });
    zeroRegion += 1;
    continue;
  }
  if (resolved.kind === 'ambiguous') {
    rows.push({ fixture: fixture.id, outcome: 'ambiguous', regions: '-', buckets: '-' });
    ambiguous += 1;
    continue;
  }

  processed += 1;
  const derived = regions.deriveGarmentRegions(resolved.person);
  if (derived.length === 0) {
    zeroRegion += 1;
    rows.push({ fixture: fixture.id, outcome: 'no_regions', regions: '0', buckets: '-' });
    continue;
  }

  const classes = derived.map((r) => r.regionClass);
  if (classes.includes('upper_body') && classes.includes('lower_body')) separated += 1;
  totalRegions += derived.length;
  reviewFlagged += derived.filter((r) => r.confidenceBucket !== 'high').length;

  // Pairs left above HALF the dedup threshold. Not defects — two shoes are
  // adjacent, and a torso band abuts a leg band — but a rising number here is
  // the early warning that dedup is about to start merging real garments or
  // stop catching real duplicates.
  for (let i = 0; i < derived.length; i += 1) {
    for (let j = i + 1; j < derived.length; j += 1) {
      if (regions.intersectionOverUnion(derived[i].bounds, derived[j].bounds) >= 0.25) {
        duplicateSuspects += 1;
      }
    }
  }

  const pads = derived
    .map((r) => paddingFraction(r, resolved.person.landmarks))
    .filter((v) => v !== null);
  const cuts = derived
    .map((r) => cutoffFraction(r, resolved.person.landmarks))
    .filter((v) => v !== null);
  if (cuts.some((c) => c > 0.001)) majorCutoff += 1;

  rows.push({
    fixture: fixture.id,
    outcome: 'extracted',
    regions: String(derived.length),
    buckets: derived.map((r) => `${r.regionClass}:${r.confidenceBucket}`).join(' '),
    maxPad: pads.length ? Math.max(...pads).toFixed(2) : '-',
    maxCut: cuts.length ? Math.max(...cuts).toFixed(2) : '-',
    inFrame: derived.every(
      (r) => r.bounds.x >= 0 && r.bounds.y >= 0 && r.bounds.x + r.bounds.width <= 1 && r.bounds.y + r.bounds.height <= 1,
    ),
  });
}

console.log('MIRROR REGION-GEOMETRY EVALUATION (Build 2.5 Step 3)');
console.log('GEOMETRY ONLY — not detection accuracy. See the header of this file.\n');
for (const row of rows) {
  console.log(
    `${row.fixture.padEnd(42)} ${row.outcome.padEnd(11)} regions=${String(row.regions).padEnd(3)} ${
      row.maxPad ? `maxPad=${row.maxPad} maxCut=${row.maxCut} inFrame=${row.inFrame} ` : ''
    }${row.buckets}`,
  );
}

console.log('\n── bounded rates over the controlled fixture set ──');
console.log(`fixtures                       ${FIXTURES.length}`);
console.log(`reached extraction             ${processed}`);
console.log(`stopped to ask (ambiguous)     ${ambiguous}`);
console.log(`zero-region / no-person        ${zeroRegion}`);
console.log(`upper/lower separated          ${separated}/${processed}`);
console.log(`regions emitted                ${totalRegions}`);
console.log(`flagged for review             ${reviewFlagged}/${totalRegions}`);
console.log(`fixtures with any cutoff        ${majorCutoff}/${processed}`);
console.log(`adjacent pairs above IoU 0.25  ${duplicateSuspects} (expected: shoes, torso/leg abutment)`);
console.log('\nNOT MEASURED HERE, and not measurable without a physical device:');
console.log('  person-region accuracy, landmark accuracy, garments-per-crop,');
console.log('  latency, peak memory, binary-size delta.');
