#!/usr/bin/env node
'use strict';

/**
 * Build 4 Phase 3 live-evaluation launcher.
 *
 * The missing piece run-baseline.js was always designed for but never got:
 * a program that builds a real `{ executor, countTokens }` pair and calls
 * `main()` with it. run-baseline.js's own CLI guard (`if (require.main ===
 * module) main()`) never supplies one, by design ("no built-in model
 * executor... cannot make a paid call by accident").
 *
 * This launcher does not reimplement any certified behaviour. It spawns
 * `deno run .../certifiedHarness.ts` per case -- the same Deno harness
 * already built at d251bb1 (live transport) and extended this session
 * (--provider count-tokens) -- and translates its JSON --out file into the
 * shapes lib/build4Funnel.js already expects from an injected adapter.
 *
 * Usage:
 *   node tools/scanner-evaluation/live-launcher.js <run-baseline args...> \
 *     --candidate-version phase2a-v1.0.0 \
 *     --live-cert-root <snapshot dir> \
 *     --live-harness <path to certifiedHarness.ts> \
 *     --live-engine-root <dir containing run-baseline.js/lib for correct git lineage> \
 *     [--overlay-file <path>] \
 *     [--live-mock]   # substitutes deno --provider mock / synthetic counts, zero network, for pipeline validation
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

// Certified constants (llmModelRouting.ts: SCANNER_PRIMARY_MODEL / SCANNER_FALLBACK_MODEL).
// Hardcoded here rather than imported because this file is plain Node, not
// Deno/TS -- these are re-verified against source in the launcher's own test.
const PRIMARY_MODEL = 'gemini-3.6-flash';
const FALLBACK_MODEL = 'gemini-3.5-flash-lite';

function extractLauncherArgs(argv) {
  const passthrough = [];
  const launcher = {
    certRoot: null,
    harness: null,
    engineRoot: null,
    mock: false,
    candidateVersion: null,
    overlayFile: null,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === '--live-cert-root') { launcher.certRoot = argv[i += 1]; continue; }
    if (arg === '--live-harness') { launcher.harness = argv[i += 1]; continue; }
    if (arg === '--live-engine-root') { launcher.engineRoot = argv[i += 1]; continue; }
    if (arg === '--live-mock') { launcher.mock = true; continue; }
    if (arg === '--candidate-version') { launcher.candidateVersion = argv[i + 1]; passthrough.push(arg, argv[i += 1]); continue; }
    if (arg === '--overlay-file') { launcher.overlayFile = argv[i += 1]; continue; }
    passthrough.push(arg);
  }
  // Required in every mode, including --live-mock: the harness always imports
  // the real certified entry (Deno.serve is intercepted before import so the
  // real handler is captured) -- only the fetch interceptor differs by mode.
  if (!launcher.certRoot) throw new Error('--live-cert-root is required');
  if (!launcher.harness) throw new Error('--live-harness is required');
  if (!launcher.engineRoot) throw new Error('--live-engine-root is required (the correctly-lineaged run-baseline.js/lib location)');
  return { launcher, passthrough };
}

function runDeno(harness, args, { timeoutMs = 30000, allowNet } = {}) {
  const denoArgs = [
    'run',
    '--allow-read', '--allow-env',
    // Scoped to the temp directory only: the harness writes exactly one
    // machine-readable --out file per invocation and nothing else.
    `--allow-write=${os.tmpdir()}`,
    ...(allowNet ? ['--allow-net=generativelanguage.googleapis.com'] : []),
    '--no-lock',
    harness,
    ...args,
  ];
  const result = spawnSync('deno', denoArgs, { encoding: 'utf8', timeout: timeoutMs });
  if (result.error) throw new Error(`deno spawn failed: ${result.error.message}`);
  if (result.status !== 0) {
    throw new Error(`deno exited ${result.status}: ${(result.stderr || '').slice(0, 800)}`);
  }
  return result;
}

function tmpOutFile(prefix) {
  return path.join(os.tmpdir(), `kscan-live-${prefix}-${crypto.randomBytes(6).toString('hex')}.json`);
}

function readAndDeleteJson(file) {
  const text = fs.readFileSync(file, 'utf8');
  fs.unlinkSync(file);
  return JSON.parse(text);
}

/**
 * Build { executor, countTokens } bound to one launch's fixed configuration.
 *
 * candidateVersion is closed over here because build4Funnel.js's countTokens
 * call site (lib/build4Funnel.js countForModel -> countTokens({caseRecord,
 * call, model})) does not pass runIdentityRecord -- unlike executeAdapter,
 * which does. One run-baseline.js invocation is always exactly one
 * candidate version, so this is safe.
 */
function createBridge({ certRoot, harness, mock, candidateVersion, overlayFile }) {
  // caseId -> { [PRIMARY_MODEL]: tokens, [FALLBACK_MODEL]: tokens }. Keyed by
  // the real model name, not call order, so which model countForModel asks
  // for first never matters.
  const countTokensCache = new Map();

  function commonArgs(caseId, call) {
    const image = mock
      ? []
      : [
        '--image-file', call.preparation.derivativePath,
        '--image-width', String(call.preparation.derivativeWidth),
        '--image-height', String(call.preparation.derivativeHeight),
      ];
    const overlay = candidateVersion !== 'certified-v140' && overlayFile ? ['--overlay-file', overlayFile] : [];
    return [
      '--cert-root', certRoot,
      '--case-id', caseId,
      '--mode', call.mode || 'identify_selected_item',
      '--candidate-version', candidateVersion,
      ...image,
      ...overlay,
    ];
  }

  function executor(plan, caseRecord, { runIdentityRecord }) {
    const call = plan.calls[0];
    const resolvedVersion = runIdentityRecord.candidateVersion || 'certified-v140';
    if (resolvedVersion !== candidateVersion) {
      throw new Error(`executor bound to ${candidateVersion} but run identity resolved ${resolvedVersion}`);
    }
    const out = tmpOutFile(`exec-${caseRecord.caseId}`);
    try {
      const providerFlag = mock ? ['--provider', 'mock', '--scenario', 'completed'] : ['--provider', 'live'];
      const args = [...commonArgs(caseRecord.caseId, call), ...providerFlag, '--out', out];
      runDeno(harness, args, { timeoutMs: 30000, allowNet: !mock });
      return readAndDeleteJson(out);
    } finally {
      if (fs.existsSync(out)) fs.unlinkSync(out);
    }
  }

  // lib/preflightReservation.exactRequestIdentity requires ALL of these fields
  // non-empty -- it hashes them together into a cache-identity fingerprint, it
  // does not use them for anything else. serializedRequestPayload is given the
  // hash of the captured body, never the body itself; systemInstruction and
  // toolDeclarations use a fixed sentinel because the certified request never
  // carries either.
  const SENTINEL_SHA256 = 'absent-field-sha256-placeholder-not-a-real-digest';

  function syntheticIdentity(inputTokens) {
    return {
      inputTokens,
      serializedRequestPayload: 'mock-serialized-request-payload',
      promptSha256: 'mock-prompt-sha256',
      systemInstructionSha256: SENTINEL_SHA256,
      toolDeclarationsSha256: SENTINEL_SHA256,
      generationConfigSha256: 'mock-generation-config-sha256',
    };
  }

  function fetchTokenCounts(caseRecord, call) {
    if (mock) {
      // Deterministic, clearly-synthetic counts. Never used for a real
      // reservation decision -- --live-mock never reaches --execute against
      // real spend, only validates the orchestration pipeline.
      return { [PRIMARY_MODEL]: syntheticIdentity(111), [FALLBACK_MODEL]: syntheticIdentity(111) };
    }
    const out = tmpOutFile(`count-${caseRecord.caseId}`);
    let lastError = null;
    for (let attempt = 1; attempt <= 2; attempt += 1) {
      try {
        const args = [...commonArgs(caseRecord.caseId, call), '--provider', 'count-tokens', '--out', out];
        runDeno(harness, args, { timeoutMs: 20000, allowNet: true });
        const parsed = readAndDeleteJson(out);
        if (!parsed.ok) throw new Error(`count-tokens refused: ${parsed.error || 'unknown'}`);
        const shared = {
          serializedRequestPayload: parsed.serializedRequestPayloadSha256,
          promptSha256: parsed.promptSha256,
          systemInstructionSha256: parsed.systemInstructionSha256,
          toolDeclarationsSha256: parsed.toolDeclarationsSha256,
          generationConfigSha256: parsed.generationConfigSha256,
        };
        return {
          [PRIMARY_MODEL]: { inputTokens: parsed.primaryInputTokens, ...shared },
          [FALLBACK_MODEL]: { inputTokens: parsed.fallbackInputTokens, ...shared },
        };
      } catch (error) {
        lastError = error;
        if (fs.existsSync(out)) fs.unlinkSync(out);
      }
    }
    throw lastError;
  }

  function countTokens({ caseRecord, call, model }) {
    let cached = countTokensCache.get(caseRecord.caseId);
    if (!cached) {
      cached = fetchTokenCounts(caseRecord, call);
      countTokensCache.set(caseRecord.caseId, cached);
    }
    if (!(model in cached)) {
      throw new Error(`countTokens has no entry for model ${model} (case ${caseRecord.caseId}); known: ${Object.keys(cached).join(', ')}`);
    }
    return cached[model];
  }

  return { executor, countTokens };
}

function main() {
  const { launcher, passthrough } = extractLauncherArgs(process.argv.slice(2));
  const runBaseline = require(path.join(launcher.engineRoot, 'tools/scanner-evaluation/run-baseline.js'));
  const { executor, countTokens } = createBridge({
    certRoot: launcher.certRoot,
    harness: launcher.harness,
    mock: launcher.mock,
    candidateVersion: launcher.candidateVersion || 'certified-v140',
    overlayFile: launcher.overlayFile,
  });
  const result = runBaseline.main(passthrough, { executor, countTokens });
  process.exitCode = result && result.ok === false ? 1 : 0;
}

main();
