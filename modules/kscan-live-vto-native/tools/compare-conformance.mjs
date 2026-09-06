/**
 * N1-C cross-runtime conformance comparison (mission sections 8-9, amendments D3/D7).
 *
 * Reads:
 *   build/conformance/native-snapshots.jsonl     (from :kscan-live-vto-native:testDebugUnitTest)
 *   build/conformance/reference-snapshots.jsonl  (from tools/run-reference-oracle.mjs)
 *
 * Writes a per-control-point delta table plus a machine-readable summary.
 *
 * Deliberately does NOT begin from a PASS tolerance. It measures first,
 * reports median / max / worst case per measurement, and then applies the
 * escalation rule the amendment sets: ANY control-point divergence above
 * INVESTIGATION_CEILING_PX must be root-caused before N1-C can pass. That
 * ceiling is an investigation trigger, not a pass mark -- a run whose max is
 * under it is reported as measured, and the frozen tolerance is recorded
 * separately in the docs from the observed deterministic behaviour.
 *
 * Semantic divergences -- a left/right swap, a mirror, a differing refusal
 * decision -- are defects at ANY pixel distance and are reported separately
 * from the numeric deltas so a small number can never launder one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MODULE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CONFORMANCE_DIR = join(MODULE_ROOT, 'build', 'conformance');

/** Amendment D7: investigation/escalation ceiling, NOT an automatic pass tolerance. */
const INVESTIGATION_CEILING_PX = 2.0;

/**
 * Divergences where the native runtime deliberately does NOT match the
 * reference, each with the measured reason it must not.
 *
 * This list is not a suppression mechanism: every entry is still printed and
 * still recorded in the summary, classified as `documented_reference_defect`
 * rather than as an unexplained divergence. Nothing is added here without a
 * measurement in the defect ledger showing the reference is wrong.
 *
 * N1-ENV-008: given a landmark of NaN or Infinity, the reference does not
 * refuse. NaN propagates silently through every stage (`NaN < 1` is false,
 * so the degenerate-span check does not fire), the placement comes out
 * entirely NaN, and `evaluateRigidGate` then returns `passed: true` with
 * ZERO findings -- because every one of its five comparisons against NaN is
 * also false. The reference's own stop gate, whose stated job is "is the
 * garment semantically attached to this body at all", certifies all-NaN
 * geometry as attached. Copying that to satisfy a conformance number would
 * mean shipping a runtime that renders undefined geometry on a faulty
 * perception frame, which mission sections 11 and D13 forbid outright.
 */
const DOCUMENTED_REFERENCE_DEFECTS = [
  {
    cases: ['nan-shoulder', 'infinite-hip'],
    kind: 'refusal_disagreement',
    ledger: 'N1-ENV-008',
    nativeBehaviour: 'refuses with non_finite_landmark',
    referenceBehaviour: 'renders NaN geometry and its rigid gate reports passed:true, findings:[]',
    nativeIsStricter: true,
  },
];

function documentedDefectFor(caseId, kind) {
  return DOCUMENTED_REFERENCE_DEFECTS.find((d) => d.cases.includes(caseId) && d.kind === kind) ?? null;
}

function readJsonl(name) {
  const path = join(CONFORMANCE_DIR, name);
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l));
}

const native = new Map(readJsonl('native-snapshots.jsonl').map((r) => [`${r.fixture}|${r.case}`, r]));
for (const meshRow of readJsonl('native-meshes.jsonl')) {
  const entry = native.get(`${meshRow.fixture}|${meshRow.case}`);
  if (entry) entry.meshRow = meshRow;
}
const reference = new Map(readJsonl('reference-snapshots.jsonl').map((r) => [`${r.fixture}|${r.case}`, r]));

const median = (xs) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
};

const rows = [];
const semanticDivergences = [];
const refusalRows = [];
const placementRows = [];
const documentedDefects = [];
const meshRows = [];

for (const [key, ref] of reference) {
  const nat = native.get(key);
  const [fixture, caseId] = key.split('|');
  if (!nat) {
    semanticDivergences.push({ key, kind: 'missing_native_snapshot' });
    continue;
  }
  const r = ref.snapshot;
  const n = nat.snapshot;

  // ── Refusal agreement. Both runtimes must make the SAME decision about
  //    whether this pose is renderable at all. A divergence here matters far
  //    more than any pixel: one runtime would show a garment the other refuses.
  const refRefused = r.failure !== null && r.failure !== undefined;
  const natRefused = n.failure !== null && n.failure !== undefined;
  if (refRefused !== natRefused) {
    const documented = documentedDefectFor(caseId, 'refusal_disagreement');
    const record = {
      key,
      kind: documented ? 'documented_reference_defect' : 'refusal_disagreement',
      reference: r.failure ?? '(rendered)',
      native: n.failure ?? '(rendered)',
    };
    if (documented) {
      record.ledger = documented.ledger;
      record.why = documented.referenceBehaviour;
      documentedDefects.push(record);
    } else {
      semanticDivergences.push(record);
    }
  }
  if (refRefused || natRefused) {
    refusalRows.push({ fixture, case: caseId, reference: r.failure ?? null, native: n.failure ?? null, agree: refRefused === natRefused });
    continue;
  }

  // ── Gate agreement.
  if (r.gatePassed !== n.gatePassed) {
    semanticDivergences.push({ key, kind: 'gate_disagreement', reference: r.gateFindings, native: n.gateFindings });
  }
  const refFindings = [...(r.gateFindings ?? [])].sort().join(',');
  const natFindings = [...(n.gateFindings ?? [])].sort().join(',');
  if (refFindings !== natFindings) {
    semanticDivergences.push({ key, kind: 'gate_findings_differ', reference: refFindings, native: natFindings });
  }

  // ── Per-control-point deltas.
  const ids = [...new Set([...Object.keys(r.controlPoints), ...Object.keys(n.controlPoints)])].sort();
  for (const id of ids) {
    const rp = r.controlPoints[id];
    const np = n.controlPoints[id];
    if (!rp || !np) {
      semanticDivergences.push({ key, kind: 'control_point_presence_differs', id, reference: !!rp, native: !!np });
      continue;
    }
    const dx = np[0] - rp[0];
    const dy = np[1] - rp[1];
    rows.push({
      fixture,
      case: caseId,
      id,
      refX: rp[0],
      refY: rp[1],
      natX: np[0],
      natY: np[1],
      dx,
      dy,
      euclidean: Math.hypot(dx, dy),
    });
  }

  // ── Whole-placement measurements.
  const scaleDelta = Math.abs(n.scale - r.scale);
  const rotationDelta = Math.abs(n.rotationRadians - r.rotationRadians);
  const boundsDelta = Math.max(
    Math.abs(n.bounds.minX - r.bounds.minX),
    Math.abs(n.bounds.minY - r.bounds.minY),
    Math.abs(n.bounds.maxX - r.bounds.maxX),
    Math.abs(n.bounds.maxY - r.bounds.maxY),
  );
  placementRows.push({ fixture, case: caseId, scaleDelta, rotationDelta, boundsDelta, refScale: r.scale, natScale: n.scale });

  // ── Mesh deformation. The control points can agree perfectly while the
  //    surface between them is wrong -- N1-ENV-010 is exactly that failure,
  //    so deformation is measured, not inferred from the control points.
  const natMesh = nat.meshRow?.snapshot?.meshVertices ?? null;
  const refMesh = r.mesh;
  if (refMesh && natMesh) {
    const refCells = { w: refMesh.columns - 1, h: refMesh.rows - 1 };
    const natCells = { w: nat.meshRow.snapshot.meshWidth, h: nat.meshRow.snapshot.meshHeight };
    if (refCells.w !== natCells.w || refCells.h !== natCells.h) {
      semanticDivergences.push({
        key,
        kind: 'mesh_grid_shape_differs',
        reference: refCells,
        native: natCells,
      });
    } else if (refMesh.vertices.length !== natMesh.length) {
      semanticDivergences.push({
        key,
        kind: 'mesh_vertex_count_differs',
        reference: refMesh.vertices.length / 2,
        native: natMesh.length / 2,
      });
    } else {
      let maxDelta = 0;
      const deltas = [];
      for (let i = 0; i < natMesh.length; i += 2) {
        const d = Math.hypot(natMesh[i] - refMesh.vertices[i], natMesh[i + 1] - refMesh.vertices[i + 1]);
        deltas.push(d);
        if (d > maxDelta) maxDelta = d;
      }
      meshRows.push({ fixture, case: caseId, vertices: deltas.length, median: median(deltas), max: maxDelta });
    }
  }

  // ── Orientation: a sign flip is a defect regardless of magnitude.
  const refLeftFirst = r.controlPoints.leftShoulder[0] < r.controlPoints.rightShoulder[0];
  const natLeftFirst = n.controlPoints.leftShoulder[0] < n.controlPoints.rightShoulder[0];
  if (refLeftFirst !== natLeftFirst) {
    semanticDivergences.push({ key, kind: 'left_right_orientation_differs', reference: refLeftFirst, native: natLeftFirst });
  }
}

const euclideans = rows.map((r) => r.euclidean);
const worst = rows.length ? rows.reduce((a, b) => (b.euclidean > a.euclidean ? b : a)) : null;
const overCeiling = rows.filter((r) => r.euclidean > INVESTIGATION_CEILING_PX);

const perPoint = {};
for (const r of rows) {
  (perPoint[r.id] ??= []).push(r.euclidean);
}

const summary = {
  generatedAt: new Date().toISOString(),
  investigationCeilingPx: INVESTIGATION_CEILING_PX,
  investigationCeilingIsNotAPassTolerance: true,
  comparedCases: reference.size,
  comparedControlPoints: rows.length,
  controlPointDeltaPx: {
    median: median(euclideans),
    max: euclideans.length ? Math.max(...euclideans) : null,
    worstCase: worst && { fixture: worst.fixture, case: worst.case, id: worst.id, euclidean: worst.euclidean },
    overCeilingCount: overCeiling.length,
    overCeiling: overCeiling.map((r) => ({ fixture: r.fixture, case: r.case, id: r.id, euclidean: r.euclidean })),
  },
  perControlPointMaxPx: Object.fromEntries(
    Object.entries(perPoint)
      .map(([id, xs]) => [id, { median: median(xs), max: Math.max(...xs) }])
      .sort(([a], [b]) => (a < b ? -1 : 1)),
  ),
  scaleDelta: {
    median: median(placementRows.map((r) => r.scaleDelta)),
    max: placementRows.length ? Math.max(...placementRows.map((r) => r.scaleDelta)) : null,
  },
  rotationDeltaRadians: {
    median: median(placementRows.map((r) => r.rotationDelta)),
    max: placementRows.length ? Math.max(...placementRows.map((r) => r.rotationDelta)) : null,
  },
  boundsDeltaPx: {
    median: median(placementRows.map((r) => r.boundsDelta)),
    max: placementRows.length ? Math.max(...placementRows.map((r) => r.boundsDelta)) : null,
  },
  refusalAgreement: {
    compared: refusalRows.length,
    disagreements: refusalRows.filter((r) => !r.agree).length,
    documentedReferenceDefectDisagreements: documentedDefects.length,
    unexplainedDisagreements: refusalRows.filter((r) => !r.agree).length - documentedDefects.length,
    rows: refusalRows,
  },
  meshDeltaPx: {
    comparedCases: meshRows.length,
    comparedVertices: meshRows.reduce((a, r) => a + r.vertices, 0),
    median: median(meshRows.flatMap((r) => [r.median])),
    max: meshRows.length ? Math.max(...meshRows.map((r) => r.max)) : null,
    worstCase: meshRows.length ? meshRows.reduce((a, b) => (b.max > a.max ? b : a)) : null,
    rows: meshRows,
  },
  semanticDivergences,
  documentedReferenceDefects: documentedDefects,
  referenceDefectPolicy: DOCUMENTED_REFERENCE_DEFECTS,
};

writeFileSync(join(CONFORMANCE_DIR, 'conformance-summary.json'), JSON.stringify(summary, null, 2) + '\n');
writeFileSync(
  join(CONFORMANCE_DIR, 'control-point-deltas.csv'),
  'fixture,case,controlPoint,refX,refY,nativeX,nativeY,dx,dy,euclidean\n' +
    rows
      .map((r) =>
        [r.fixture, r.case, r.id, r.refX, r.refY, r.natX, r.natY, r.dx, r.dy, r.euclidean]
          .map((v) => (typeof v === 'number' ? v.toFixed(6) : v))
          .join(','),
      )
      .join('\n') +
    '\n',
);

console.log(`compared ${reference.size} (fixture, case) pairs, ${rows.length} control points`);
console.log(`control-point delta px  median=${summary.controlPointDeltaPx.median}  max=${summary.controlPointDeltaPx.max}`);
console.log(`scale delta             median=${summary.scaleDelta.median}  max=${summary.scaleDelta.max}`);
console.log(`rotation delta (rad)    median=${summary.rotationDeltaRadians.median}  max=${summary.rotationDeltaRadians.max}`);
console.log(`bounds delta px         median=${summary.boundsDeltaPx.median}  max=${summary.boundsDeltaPx.max}`);
console.log(`mesh delta px           median=${summary.meshDeltaPx.median}  max=${summary.meshDeltaPx.max}  (${summary.meshDeltaPx.comparedVertices} vertices over ${summary.meshDeltaPx.comparedCases} cases)`);
console.log(`refusal disagreements   ${summary.refusalAgreement.disagreements} of ${summary.refusalAgreement.compared}`);
console.log(`semantic divergences    ${semanticDivergences.length} (unexplained)`);
console.log(`documented ref defects  ${documentedDefects.length} (native deliberately stricter)`);
console.log(`over ${INVESTIGATION_CEILING_PX}px investigation ceiling: ${overCeiling.length}`);

if (documentedDefects.length) {
  console.log('\nDOCUMENTED REFERENCE DEFECTS (native deliberately does not match):');
  for (const d of documentedDefects) console.log(`  ${d.key}  ${d.ledger}: native=${d.native}, reference=${d.reference}`);
}
if (semanticDivergences.length) {
  console.log('\nSEMANTIC DIVERGENCES (defects at any pixel distance):');
  for (const d of semanticDivergences.slice(0, 40)) console.log('  ' + JSON.stringify(d));
}
if (overCeiling.length) {
  console.log(`\nOVER CEILING (must be root-caused before N1-C PASS):`);
  for (const r of overCeiling.slice(0, 40)) {
    console.log(`  ${r.fixture}/${r.case}/${r.id}  ${r.euclidean.toFixed(4)}px  (dx=${r.dx.toFixed(4)} dy=${r.dy.toFixed(4)})`);
  }
}

process.exitCode = semanticDivergences.length || overCeiling.length ? 1 : 0;
