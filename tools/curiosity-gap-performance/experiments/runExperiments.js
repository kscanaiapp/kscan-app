'use strict';
/**
 * LAB-ONLY EXPERIMENTS. Maximum three (§32).
 *
 * These modify NOTHING in production. Each one takes the bound scenario graph,
 * applies a structural edit IN THE MODEL ONLY, and reports what changes.
 *
 * A faster number here is a statement about STRUCTURE, never a statement that
 * the change is safe to ship. Every experiment therefore carries explicit
 * correctness, quality and UX flags, and none may be classified
 * PRODUCTION_READY inside this lane (§34).
 *
 * SELECTION (§32: likely TTFAR impact x source confidence x low complexity):
 *   EXP-1 chosen because it is PROVEN, trivially reversible, and it BOUNDS
 *         every other optimisation — no backend win below the floor is visible
 *         to a customer at all.
 *   EXP-2 chosen because the four-round-trip serial prefix is PROVEN serial and
 *         is PROVEN to repeat in full on the second request under funnel ON.
 *   EXP-3 chosen because §25 requires the progressive-delivery question to be
 *         answered before any progressive timing may be modelled, and it is the
 *         highest-ceiling structural change available.
 */

const fs = require('node:fs');
const path = require('node:path');

const { runScenario } = require('../lib/model');
const { loadRegister, paramsAtBand } = require('../lib/params');
const { scanRequestPayloadBytes } = require('../lib/network');

const LAB_DIR = path.resolve(__dirname, '..');

function loadScenario(id) {
  return JSON.parse(fs.readFileSync(path.join(LAB_DIR, 'scenarios', `${id}.json`), 'utf8'));
}

function iosPayload() {
  // MODELED mid payload: 896x672 at the mid bytes-per-pixel band.
  return scanRequestPayloadBytes({ compressedImageBytes: Math.round(896 * 672 * 0.15), envelopeBytes: 320 });
}

function clone(o) { return JSON.parse(JSON.stringify(o)); }

function stage(scenario, id) {
  const s = scenario.stages.find((x) => x.id === id);
  if (!s) throw new Error(`experiment targets a stage that does not exist: ${id}`);
  return s;
}

// ─────────────────────────────────────────────────────────────────────────────
// EXP-1 — How much of a backend improvement do the client floors absorb?
// ─────────────────────────────────────────────────────────────────────────────
function exp1ClientFloorAbsorption() {
  const register = loadRegister();
  const payload = iosPayload();
  const base = loadScenario('scan-funnel-on');

  // Structural edit: remove the two artificial client floors from the graph.
  const noFloors = clone(base);
  noFloors.stages = noFloors.stages.filter(
    (s) => s.id !== 'client.floor_min_analysis' && s.id !== 'client.floor_analyzing_display',
  );
  for (const s of noFloors.stages) {
    s.deps = s.deps.filter((d) => d !== 'client.floor_min_analysis' && d !== 'client.floor_analyzing_display');
  }

  // Sweep the identification term down toward zero: this is the question a
  // future model/prompt/schema optimisation actually poses.
  const geminiPoints = [7256, 4909, 3000, 2000, 1200, 600, 200, 0];
  const rows = geminiPoints.map((ms) => {
    const params = { ...paramsAtBand(register, 'mid'), gemini_ms: { value: ms, evidence_class: 'MODELED' } };
    const withFloors = runScenario(base, params, { payload });
    const without = runScenario(noFloors, params, { payload });
    const identPaintWith = withFloors.stage_timings['client.paint_identification'].finish_ms;
    const identPaintWithout = without.stage_timings['client.paint_identification'].finish_ms;
    return {
      gemini_ms: ms,
      identification_paint_ms_with_floors: identPaintWith,
      identification_paint_ms_without_floors: identPaintWithout,
      absorbed_by_floors_ms: Number((identPaintWith - identPaintWithout).toFixed(2)),
      first_actionable_ms_with_floors: withFloors.first_result.total_ms,
      first_actionable_ms_without_floors: without.first_result.total_ms,
      floor_is_binding: identPaintWith > identPaintWithout + 0.01,
    };
  });

  const firstBinding = rows.find((r) => r.floor_is_binding);
  // The floor binds only once the WHOLE non-floor path drops below it, so the
  // useful number is the non-identification remainder, not the Gemini value.
  const zeroRow = rows[rows.length - 1];
  const nonIdentificationPathMs = zeroRow.identification_paint_ms_without_floors;
  const floorHeadroomMs = Number((1500 - nonIdentificationPathMs).toFixed(2));

  return {
    id: 'EXP-1',
    title: 'Client-side artificial display floors absorb backend latency wins',
    hypothesis:
      'MIN_DISPLAY_MS=1500 (AnalyzingScan.tsx:28) stacked over MIN_ANALYSIS_MS=600 (useKScan.js:31) sets a hard lower bound on time-to-identification-paint that no backend improvement can cross.',
    structural_edit: 'Removed client.floor_min_analysis and client.floor_analyzing_display from the model graph.',
    evidence_class_of_the_structure: 'PROVEN',
    evidence_class_of_the_timing: 'MODELED',
    rows,
    non_identification_path_ms: nonIdentificationPathMs,
    floor_headroom_ms: floorHeadroomMs,
    finding:
      firstBinding
        ? `The floors only begin absorbing improvement once identification falls below roughly ${floorHeadroomMs} ms — because the rest of the path (client compression, upload, the serial server prefix, download, render) already costs about ${nonIdentificationPathMs} ms on its own at mid parameters, leaving only that much headroom under the 1500 ms floor.`
        : 'The floors never bind across the tested range.',
    hypothesis_verdict: 'PARTIALLY REFUTED',
    hypothesis_verdict_detail:
      'The floor is real and PROVEN, but it is NOT a meaningful constraint at any plausible operating point. Identification would have to become essentially free before the floor cost the customer anything. The experiment is reported as a refuted hypothesis rather than quietly dropped, because the number it did surface is the more useful one: the non-identification remainder is already close to the floor.',
    robust_conclusion:
      `Two things are true and only one of them was expected. (1) Time-to-identification-paint cannot fall below 1500 ms on the shipped build — eas.json enables EXPO_PUBLIC_SCAN_ROOM_V2_UI in all four profiles including production — so that is a genuine hard floor on any future latency programme. (2) It does not matter today, and will not matter for a long time, because the non-identification path alone is already about ${nonIdentificationPathMs} ms at mid parameters. The floor is a ceiling on ambition, not a current cost.`,
    ttfar_impact: 'ZERO TODAY',
    ttfar_impact_reason:
      `Identification is OBSERVED at 4909-7256 ms (audit doc:288). The floor cannot bind until the whole path drops under 1500 ms, and the non-identification remainder alone is ~${nonIdentificationPathMs} ms.`,
    completion_impact: 'None today, for the same reason.',
    quality_validation_required: false,
    quality_validation_reason: 'Removing a display floor changes no data, no query and no ranking. It is behaviour-identical with respect to what is shown.',
    ux_decision_required: true,
    ux_decision_reason:
      'The floors exist for a reason: they stop the analyzing animation flashing. Removing them is a deliberate UX trade, not a free win.',
    correctness_validation_required: false,
    complexity: 'LOW',
    risk: 'LOW',
    classification: 'NO_MATERIAL_STRUCTURAL_GAIN',
    classification_reason:
      'Reclassified after the run. The hypothesis predicted the floor was absorbing real backend wins; the model shows it cannot bind at any plausible operating point. Reported as a refuted hypothesis with the constraint recorded for future reference, rather than presented as an opportunity it is not.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXP-2 — The serial auth/quota prefix, and its full repetition on MODE B
// ─────────────────────────────────────────────────────────────────────────────
function exp2SerialPrefix() {
  const register = loadRegister();
  const payload = iosPayload();
  const base = loadScenario('scan-funnel-on');

  // Arm A: make the two INDEPENDENT auth reads concurrent instead of serial.
  // assertAccountActiveIfAuthenticated and resolveAuthContext both read auth
  // state; neither consumes the other's output.
  const armA = clone(base);
  stage(armA, 'server.a.auth_context').deps = ['net.upload_a'];
  stage(armA, 'server.a.fingerprint').deps = ['server.a.account_gate', 'server.a.auth_context'];
  stage(armA, 'server.b.auth_context').deps = ['net.upload_b'];
  stage(armA, 'server.b.ratelimit').deps = ['server.b.account_gate', 'server.b.auth_context'];

  // Arm B: elide the DUPLICATE prefix on MODE B only (the client already holds
  // a verified session from MODE A moments earlier).
  const armB = clone(base);
  stage(armB, 'server.b.account_gate').duration = { kind: 'zero' };
  stage(armB, 'server.b.auth_context').duration = { kind: 'zero' };

  // Arm C: both.
  const armC = clone(armA);
  stage(armC, 'server.b.account_gate').duration = { kind: 'zero' };
  stage(armC, 'server.b.auth_context').duration = { kind: 'zero' };

  const results = {};
  for (const band of ['low', 'mid', 'high']) {
    const params = paramsAtBand(register, band);
    const b = runScenario(base, params, { payload });
    const a = runScenario(armA, params, { payload });
    const bb = runScenario(armB, params, { payload });
    const c = runScenario(armC, params, { payload });
    results[band] = {
      baseline_first_actionable_ms: b.first_result.total_ms,
      armA_concurrent_auth_ms: a.first_result.total_ms,
      armA_saving_ms: Number((b.first_result.total_ms - a.first_result.total_ms).toFixed(2)),
      armB_no_duplicate_prefix_ms: bb.first_result.total_ms,
      armB_saving_ms: Number((b.first_result.total_ms - bb.first_result.total_ms).toFixed(2)),
      armC_both_ms: c.first_result.total_ms,
      armC_saving_ms: Number((b.first_result.total_ms - c.first_result.total_ms).toFixed(2)),
    };
  }

  return {
    id: 'EXP-2',
    title: 'The four-round-trip serial prefix, paid twice under the deferred-commerce funnel',
    hypothesis:
      'Before any useful work begins, scan-identify performs four sequential network round trips (requireUser, assertAccountActive, hasValidProjectAccess, auth.getUser) plus a quota RPC — and under funnel ON the entire prefix runs AGAIN on the MODE B commerce request.',
    proven_structure: [
      'index.ts:1832 assertAccountActiveIfAuthenticated runs BEFORE req.json() and contains two serial awaits',
      'index.ts:1966 resolveAuthContext contains two more serial awaits (index.ts:1223, index.ts:1239)',
      'index.ts:2534 the quota RPC follows them',
      'index.ts:2004 MODE B enters the same handler and repeats the whole prefix',
    ],
    evidence_class_of_the_structure: 'PROVEN',
    evidence_class_of_the_timing: 'MODELED',
    arms: {
      A: 'run the two independent auth reads concurrently',
      B: 'elide the duplicate prefix on the MODE B request only',
      C: 'both',
    },
    results,
    robust_conclusion:
      'The saving is bounded and roughly constant across the whole tested latency envelope, because the prefix is a fixed serial cost that does not scale with provider or model latency. It is a small absolute win against a 6-14 s path today — but it is one of the very few terms on that path that K Scan fully controls.',
    ttfar_impact: 'SMALL BUT FULLY OWNED',
    completion_impact: 'Same absolute saving, proportionally smaller.',
    quality_validation_required: false,
    quality_validation_reason: 'No query, ranking or provider behaviour changes.',
    ux_decision_required: false,
    correctness_validation_required: true,
    correctness_validation_detail: {
      shared_state: 'Arm A assumes assertAccountActive and hasValidProjectAccess share no ordering dependency. That must be proven, not inferred from the fact that they look unrelated.',
      ordering_dependency:
        'assertAccountActiveIfAuthenticated currently runs BEFORE req.json(). That ordering is a deliberate security property: a deactivated account is rejected before its body is even parsed. Arm A must preserve it.',
      side_effects:
        'The quota RPC INCREMENTS. It must remain strictly after every gate that can reject the request, or a rejected scan could consume quota. Arm A does not move it; any future variant must not either.',
      failure_coupling:
        'scanQuota.ts:56 fails CLOSED on an unverified result. Concurrency must not turn a gate failure into a race that resolves as allow.',
      rate_limit_effect: 'None: the fingerprint and rate-limit windows are unchanged.',
      result_order_effect: 'None.',
      arm_b_specific:
        'Arm B weakens a real security boundary — MODE B would no longer independently re-verify account state. A deleted or deactivated account could still fetch commerce for the few seconds between the two requests. This is a SECURITY trade, not a performance free lunch, and should not be pursued without that being the explicit decision.',
    },
    complexity: 'MEDIUM',
    risk: 'MEDIUM',
    classification: 'PERFORMANCE_PROMISING',
    classification_qualifier: 'Arm A only. Arm B is recorded as REQUIRES_SECURITY_DECISION and is not recommended on latency grounds alone.',
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// EXP-3 — Progressive first-N delivery (SPECULATIVE ARCHITECTURE MODEL)
// ─────────────────────────────────────────────────────────────────────────────
function exp3Progressive() {
  const register = loadRegister();
  const payload = iosPayload();
  const base = loadScenario('scan-funnel-on');

  // Speculative edit: a transport that can emit the first usable candidate as
  // soon as ONE provider returns it, without waiting for the whole-array
  // ranking pass. Modelled by (a) letting discovery close on the first child
  // and (b) removing the ranking stage from the FIRST-result path only.
  const progressive = clone(base);
  const disc = stage(progressive, 'server.b.discovery');
  disc.duration.sufficient_after_children = 1;
  // First result no longer waits on the whole-array ranker.
  stage(progressive, 'server.b.serialize').deps = ['server.b.discovery'];

  const rows = {};
  for (const band of ['low', 'mid', 'high']) {
    const params = paramsAtBand(register, band);
    const b = runScenario(base, params, { payload });
    const p = runScenario(progressive, params, { payload });
    rows[band] = {
      current_first_actionable_ms: b.first_result.total_ms,
      MODELED_TTFAR_1: p.first_result.total_ms,
      MODELED_TTFAR_3: b.first_result.total_ms,
      MODELED_TTFAR_5: b.first_result.total_ms,
      MODELED_FULL_COMPLETION: b.complete_response.total_ms,
      saving_vs_current_ms: Number((b.first_result.total_ms - p.first_result.total_ms).toFixed(2)),
    };
  }

  return {
    id: 'EXP-3',
    title: 'Progressive first-N commerce delivery',
    label: 'SPECULATIVE ARCHITECTURE MODEL',
    label_reason:
      'The current transport CANNOT do this. index.ts:1091 json() returns one buffered Response(JSON.stringify(body)); a repo-wide search of scan-identify/ and _shared/ for ReadableStream, text/event-stream, TransformStream, Transfer-Encoding and streamGenerateContent returns zero non-test hits. The client mirrors that: supabase.functions.invoke buffers, and the result commits in a single setState (useKScan.js:488-492).',
    progressive_delivery_status: 'ARCHITECTURE CHANGE REQUIRED',
    feasibility_findings: {
      transport: 'NO — single buffered JSON response, both directions. PROVEN.',
      client: 'PARTIAL — the client already has partial-result STATE (commerceStatus, multiItemCommerce, useKScan.js:123-134) and already patches a rendered shelf after the fact (useKScan.js:1083). What it lacks is an incremental TRANSPORT, not incremental state.',
      ranking: 'BLOCKING — ranking is whole-array and synchronous: global sort (qualityTuneCommerce.ts:531), one shared cross-provider dedupe set (:498), coverage bands and retailer-diversity caps computed over the entire selected set (commerceRelevanceDiversity.ts:96-124). An early item emitted before the full set exists could legitimately be outranked, deduped away, or diversity-demoted afterwards.',
      ux_risk: 'HIGH — because ranking is whole-array, progressive emission means results can REORDER after the customer can already see and tap them. That is items moving under the user finger, and weaker products briefly appearing first.',
    },
    already_partially_realised:
      'IMPORTANT: K Scan already implements the coarse-grained version of this idea. The v127 funnel takes commerce off the scan critical path entirely so identification paints first and commerce arrives after (commerceFunnelConfig.ts:13-15: "COMMERCE MAY LOAD AFTER THE SCAN. COMMERCE MUST NOT HOLD THE SCAN HOSTAGE."). EXP-3 is about going finer-grained than that, within the commerce shelf itself.',
    rows,
    robust_conclusion:
      'The modelled saving is small and is bounded by the fast-path deadline that already caps this fan-out at 1900 ms. Progressive delivery inside the commerce shelf buys at most a fraction of that 1.9 s, while costing a transport rewrite on both sides and accepting visible result reordering. On the evidence, this is NOT where the TTFAR budget is.',
    ttfar_impact: 'SMALL',
    completion_impact: 'NONE — completion still waits for the full set.',
    quality_validation_required: true,
    ux_decision_required: true,
    correctness_validation_required: true,
    complexity: 'HIGH',
    risk: 'HIGH',
    classification: 'NO_MATERIAL_STRUCTURAL_GAIN',
    classification_reason:
      'The gain is capped by FAST_COMMERCE_DEADLINE_MS=1900 while identification is OBSERVED at 4909-7256 ms. Optimising a 1.9 s bounded tail while a 5-7 s serial term sits upstream of it is the wrong target.',
  };
}

function runExperiments() {
  return {
    benchmark_status:
      'INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.',
    experiment_limit: 3,
    experiments_run: 3,
    production_code_modified: false,
    experiments: [exp1ClientFloorAbsorption(), exp2SerialPrefix(), exp3Progressive()],
  };
}

module.exports = { runExperiments, exp1ClientFloorAbsorption, exp2SerialPrefix, exp3Progressive };
