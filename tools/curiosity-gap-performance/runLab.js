#!/usr/bin/env node
'use strict';
/**
 * Curiosity Gap Performance Lab — runner.
 *
 * OFFLINE BY CONSTRUCTION. This process opens no socket, calls no provider,
 * contacts no Supabase project and spends nothing. It reads committed source,
 * hashes it, and evaluates a pure graph.
 *
 * Modes:
 *   contract   — L0: bindings + artifact validation. Suitable for CI.
 *   model      — L1S: run both scenarios across bands and sweeps.
 *   baseline   — write an immutable versioned baseline artifact.
 *   compare    — compare two baselines.
 *   experiments— run the lab-only structural experiments.
 */

const fs = require('node:fs');
const path = require('node:path');

const { verifyBindings } = require('./lib/sourceBinding');
const { loadRegister, paramsAtBand } = require('./lib/params');
const { runScenario, sweepScenario } = require('./lib/model');
const { scanRequestPayloadBytes, uploadDominanceThresholdMbps } = require('./lib/network');
const { readFixture, applyScannerResize } = require('./lib/jpeg');
const { assertPrivacySafe } = require('./lib/privacy');
const { writeBaseline, readBaseline, compareBaselines } = require('./lib/baseline');

const LAB_DIR = __dirname;
const REPO_ROOT = path.resolve(LAB_DIR, '..', '..');

const MODEL_VERSION = 'model-v1';
const TRACE_SCHEMA_VERSION = 'trace-schema-v1';
const BENCHMARK_STATUS =
  'INTERNAL ENGINEERING ANALYSIS ONLY. SIMULATED TTFAR IS NOT A MEASUREMENT OF REAL-WORLD K SCAN SPEED.';

function readJson(rel) {
  return JSON.parse(fs.readFileSync(path.join(LAB_DIR, rel), 'utf8'));
}

function loadScenarios() {
  return {
    'scan-funnel-on': readJson('scenarios/scan-funnel-on.json'),
    'scan-funnel-off': readJson('scenarios/scan-funnel-off.json'),
  };
}

/** Payload geometry from a platform profile — PROVEN transform, MODELED bpp. */
function payloadForProfile(profile, bppBand = 'mid') {
  const post = profile.post_resize || profile.modeled_capture_geometry.post_resize;
  const pixels = post.width * post.height;
  const bpp = profile.modeled_bytes_per_pixel_at_quality_065[bppBand];
  const compressedImageBytes = Math.round(pixels * bpp);
  return {
    ...scanRequestPayloadBytes({ compressedImageBytes, envelopeBytes: 320 }),
    post_resize: post,
    pixels,
    bytes_per_pixel: bpp,
    bpp_band: bppBand,
    evidence: {
      resize_target: 'PROVEN (services/imageUtils.js:45, width 896)',
      base64_expansion: 'PROVEN (exact arithmetic, 4/3 with padding)',
      bytes_per_pixel: 'MODELED (anchored on the OBSERVED bpp range of the committed qa_fixtures)',
      overall: 'MODELED',
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// contract (L0)
// ─────────────────────────────────────────────────────────────────────────────
function runContract() {
  const failures = [];
  const bindings = readJson('authority/source-bindings.json');
  const verification = verifyBindings(REPO_ROOT, bindings);
  if (!verification.ok) {
    failures.push({
      check: 'source_bindings',
      detail: { drifted: verification.drifted.map((d) => d.file), missing: verification.missing },
      meaning: 'bound production source changed since these findings were derived; re-derive before trusting them',
    });
  }
  if (!verification.binding_hash_consistent) {
    failures.push({ check: 'binding_hash_consistency', detail: 'binding_hash does not match its own file map' });
  }

  const artifacts = {
    ttfar: readJson('authority/ttfar-definition.json'),
    actionable: readJson('authority/actionable-result-schema.json'),
    assumptions: readJson('authority/assumptions-register.json'),
    ios: readJson('platformProfiles/ios.json'),
    android: readJson('platformProfiles/android.json'),
  };
  for (const [name, a] of Object.entries(artifacts)) {
    try { assertPrivacySafe(a, name); } catch (err) {
      failures.push({ check: 'privacy', artifact: name, detail: err.message });
    }
  }
  if (artifacts.ttfar.t_zero.evidence_class !== 'PROVEN') {
    failures.push({ check: 'ttfar_t_zero_grounded', detail: 'TTFAR t=0 must be PROVEN from source' });
  }

  const scenarios = loadScenarios();
  const register = loadRegister();
  for (const [id, scenario] of Object.entries(scenarios)) {
    try {
      runScenario(scenario, paramsAtBand(register, 'mid'), {
        payload: payloadForProfile(artifacts.ios),
      });
    } catch (err) {
      failures.push({ check: 'scenario_evaluates', scenario: id, detail: err.message });
    }
  }

  return {
    mode: 'contract',
    benchmark_status: BENCHMARK_STATUS,
    network_calls_made: 0,
    provider_calls_made: 0,
    source_binding_hash: bindings.binding_hash,
    bindings_ok: verification.ok,
    failures,
    pass: failures.length === 0,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// model (L1S)
// ─────────────────────────────────────────────────────────────────────────────
function runModel() {
  const register = loadRegister();
  const scenarios = loadScenarios();
  const ios = readJson('platformProfiles/ios.json');
  const android = readJson('platformProfiles/android.json');

  const payloads = {
    ios: { low: payloadForProfile(ios, 'low'), mid: payloadForProfile(ios, 'mid'), high: payloadForProfile(ios, 'high') },
    android: { low: payloadForProfile(android, 'low'), mid: payloadForProfile(android, 'mid'), high: payloadForProfile(android, 'high') },
  };

  const out = { mode: 'model', benchmark_status: BENCHMARK_STATUS, model_version: MODEL_VERSION, scenarios: {}, payloads, sweeps: {} };

  for (const [id, scenario] of Object.entries(scenarios)) {
    const bands = {};
    for (const band of ['low', 'mid', 'high']) {
      const params = paramsAtBand(register, band);
      const run = runScenario(scenario, params, { payload: payloads.ios[band === 'high' ? 'high' : band === 'low' ? 'low' : 'mid'] });
      bands[band] = {
        first_result_ms: run.first_result.total_ms,
        first_result_chain: run.first_result.chain,
        first_result_evidence: run.first_result.evidence_class,
        complete_response_ms: run.complete_response.total_ms,
        complete_response_chain: run.complete_response.chain,
        complete_response_evidence: run.complete_response.evidence_class,
        timed_out_stages: run.timed_out_stages,
        request_body_bytes: run.payload.request_body_bytes,
      };
    }
    out.scenarios[id] = bands;
  }

  // ── Network sensitivity sweep ────────────────────────────────────────────
  const uplinkSweep = [0.5, 1, 2, 5, 10, 25, 50];
  const rttSweep = [20, 50, 100, 200, 400];
  out.sweeps.uplink = {};
  out.sweeps.rtt = {};
  for (const [id, scenario] of Object.entries(scenarios)) {
    const base = paramsAtBand(register, 'mid');
    out.sweeps.uplink[id] = sweepScenario(
      scenario, base, 'uplink_mbps',
      uplinkSweep.map((v) => ({ value: v, evidence_class: 'MODELED' })),
      { payload: payloads.ios.mid },
    );
    out.sweeps.rtt[id] = sweepScenario(
      scenario, base, 'rtt_ms',
      rttSweep.map((v) => ({ value: v, evidence_class: 'MODELED' })),
      { payload: payloads.ios.mid },
    );
  }

  // ── Provider latency sensitivity ─────────────────────────────────────────
  out.sweeps.provider_poshmark = sweepScenario(
    scenarios['scan-funnel-on'], paramsAtBand(register, 'mid'), 'provider_poshmark_ms',
    [400, 900, 1500, 1900, 3000, 6000, 13900].map((v) => ({ value: v, evidence_class: 'MODELED' })),
    { payload: payloads.ios.mid },
  );
  out.sweeps.provider_serper = sweepScenario(
    scenarios['scan-funnel-on'], paramsAtBand(register, 'mid'), 'provider_serper_ms',
    [400, 900, 1500, 1900, 3000, 6000].map((v) => ({ value: v, evidence_class: 'MODELED' })),
    { payload: payloads.ios.mid },
  );
  out.sweeps.gemini = sweepScenario(
    scenarios['scan-funnel-on'], paramsAtBand(register, 'mid'), 'gemini_ms',
    [1000, 2500, 4909, 6100, 7256, 10000, 14000, 20000].map((v) => ({ value: v, evidence_class: 'OBSERVED_RANGE_EXTENDED' === '' ? 'OBSERVED' : 'MODELED' })),
    { payload: payloads.ios.mid },
  );

  // ── Upload dominance thresholds ──────────────────────────────────────────
  out.upload_dominance = {};
  for (const band of ['low', 'mid', 'high']) {
    const p = payloads.ios[band];
    const nonUploadMs = out.scenarios['scan-funnel-on'].mid.first_result_ms;
    out.upload_dominance[band] = uploadDominanceThresholdMbps({
      bytes: p.request_body_bytes,
      otherPathMs: nonUploadMs,
      shareOfBudget: 0.25,
      rttMs: 100,
    });
  }

  return out;
}

// ─────────────────────────────────────────────────────────────────────────────
// baseline
// ─────────────────────────────────────────────────────────────────────────────
function buildBaselineArtifact(baselineId) {
  const bindings = readJson('authority/source-bindings.json');
  const ttfar = readJson('authority/ttfar-definition.json');
  const actionable = readJson('authority/actionable-result-schema.json');
  const ios = readJson('platformProfiles/ios.json');
  const scenarios = loadScenarios();
  const model = runModel();

  const first = model.scenarios['scan-funnel-on'].mid;
  const timeoutExposure = Object.entries(model.scenarios)
    .flatMap(([id, bands]) => Object.entries(bands)
      .flatMap(([band, r]) => r.timed_out_stages.map((t) => `${id}/${band}:${t.stage}`)));

  return {
    artifact: 'PERFORMANCE_BASELINE',
    baseline_id: baselineId,
    benchmark_status: BENCHMARK_STATUS,
    generated_offline: true,
    network_calls_made: 0,
    provider_spend_usd: 0,

    source_sha: '909df8646a690b55c5af6b7b8c80193df64a2ec8',
    source_binding_hash: bindings.binding_hash,
    trace_schema_version: TRACE_SCHEMA_VERSION,
    ttfar_definition_version: ttfar.ttfar_start_version,
    actionable_result_version: actionable.actionable_result_version,
    scenario_version: scenarios['scan-funnel-on'].scenario_version,
    platform_profile_version: ios.platform_profile_version,
    model_version: MODEL_VERSION,

    structural_findings: {
      transport_supports_progressive_delivery: false,
      transport_evidence: 'PROVEN — index.ts:1091 json() returns one buffered new Response(JSON.stringify(body)); zero non-test hits for ReadableStream|text/event-stream|TransformStream|streamGenerateContent across scan-identify/ and _shared/',
      client_awaits_full_body: true,
      client_awaits_full_result_set: true,
      client_re_sorts_results: false,
      client_re_sort_evidence: 'PROVEN — services/commerceHydration.ts:243-262 states backend ordering is preserved exactly; zero .sort( in the client result path',
      image_load_blocks_actionability: false,
      secondary_fields_block_card: false,
      ranking_requires_complete_candidate_set: true,
      ranking_evidence: 'PROVEN — qualityTuneCommerce.ts:531 global sort, :498 shared cross-provider dedupe set, commerceRelevanceDiversity.ts:96-124 retailer counts over the whole selected set',
      slowest_provider_gates_complete_response_funnel_off: true,
      slowest_provider_gates_first_result_funnel_on: 'BOUNDED_BY_DEADLINE',
      serial_prefix_round_trips_before_useful_work: 4,
      serial_prefix_repeats_on_mode_b: true,
      client_artificial_floor_ms: 1500,
      client_artificial_floor_evidence: 'PROVEN — AnalyzingScan.tsx:28 MIN_DISPLAY_MS=1500 stacked over useKScan.js:31 MIN_ANALYSIS_MS=600; both measured from scan commit so the binding floor is 1500',
      round_trips_to_first_actionable_commerce_result: { funnel_on: 2, funnel_off: 1 },
      privacy_preprocessing_is_passthrough: true,
      platform_code_paths_identical: true,
      platform_evidence: 'PROVEN — zero Platform.OS / Platform.select on the scanner client path',
    },

    modeled_timing_findings: {
      disclaimer: 'Every number in this block is MODELED unless its evidence_class says otherwise. None is a measurement of K Scan.',
      scenarios: model.scenarios,
      payload_bytes: model.payloads,
      network_exposure: {
        uplink_sweep_mbps: model.sweeps.uplink['scan-funnel-on'].map((r) => ({ uplink_mbps: r.uplink_mbps, first_result_ms: r.first_result_ms })),
        rtt_sweep_ms: model.sweeps.rtt['scan-funnel-on'].map((r) => ({ rtt_ms: r.rtt_ms, first_result_ms: r.first_result_ms })),
        upload_dominance: model.upload_dominance,
      },
      provider_exposure: {
        poshmark: model.sweeps.provider_poshmark.map((r) => ({ ms: r.provider_poshmark_ms, first_result_ms: r.first_result_ms, timed_out: r.timed_out })),
        serper: model.sweeps.provider_serper.map((r) => ({ ms: r.provider_serper_ms, first_result_ms: r.first_result_ms, timed_out: r.timed_out })),
      },
      identification_exposure: model.sweeps.gemini.map((r) => ({ ms: r.gemini_ms, first_result_ms: r.first_result_ms, timed_out: r.timed_out })),
      timeout_exposure: [...new Set(timeoutExposure)],
      retry_exposure: {
        max_extra_attempts: 1,
        evidence: 'PROVEN — llmModelRouting.ts:33 SCANNER_MAX_ATTEMPTS=2',
        structural_note: 'PROVEN — index.ts:2770 arms ONE AbortController for the whole attempt loop, so a retry consumes the same 14s budget rather than extending it. Retries cannot make the request longer than 14s; they can only make it more likely to be truncated.',
      },
      first_result_critical_path: first.first_result_chain,
      complete_response_critical_path: model.scenarios['scan-funnel-on'].mid.complete_response_chain,
    },
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// CLI
// ─────────────────────────────────────────────────────────────────────────────
function main(argv) {
  const mode = argv[2] || 'contract';

  if (mode === 'contract') {
    const r = runContract();
    console.log(JSON.stringify(r, null, 2));
    if (!r.pass) { process.exitCode = 1; }
    return;
  }
  if (mode === 'model') {
    console.log(JSON.stringify(runModel(), null, 2));
    return;
  }
  if (mode === 'baseline') {
    const id = argv[3] || 'baseline-v1';
    const artifact = buildBaselineArtifact(id);
    assertPrivacySafe(artifact, 'baseline');
    const file = path.join(LAB_DIR, 'baseline', `${id}.json`);
    writeBaseline(file, artifact);
    console.log(`baseline written: ${path.relative(REPO_ROOT, file)}`);
    return;
  }
  if (mode === 'compare') {
    const a = readBaseline(path.resolve(argv[3]));
    const b = readBaseline(path.resolve(argv[4]));
    console.log(JSON.stringify(compareBaselines(a, b), null, 2));
    return;
  }
  if (mode === 'experiments') {
    const { runExperiments } = require('./experiments/runExperiments');
    console.log(JSON.stringify(runExperiments(), null, 2));
    return;
  }
  if (mode === 'fixtures') {
    const dir = path.join(REPO_ROOT, 'assets', 'qa_fixtures');
    const rows = fs.readdirSync(dir).filter((f) => f.endsWith('.jpg')).sort().map((f) => {
      const r = readFixture(path.join(dir, f));
      const t = applyScannerResize(r, 896);
      return { file: f, source_bytes: r.bytes, source: `${r.width}x${r.height}`,
        bytes_per_pixel: Number(r.bytes_per_pixel.toFixed(4)),
        post_resize: `${t.width}x${t.height}`, upscaled: t.upscaled,
        pixel_ratio: Number((t.pixels / r.pixels).toFixed(3)) };
    });
    console.log(JSON.stringify({ evidence_class: 'PROVEN', note: 'source geometry read from real JPEG SOF markers', rows }, null, 2));
    return;
  }
  console.error(`unknown mode "${mode}". Use: contract | model | baseline | compare | experiments | fixtures`);
  process.exitCode = 2;
}

if (require.main === module) main(process.argv);

module.exports = { runContract, runModel, buildBaselineArtifact, payloadForProfile, MODEL_VERSION, TRACE_SCHEMA_VERSION, BENCHMARK_STATUS, LAB_DIR, REPO_ROOT };
