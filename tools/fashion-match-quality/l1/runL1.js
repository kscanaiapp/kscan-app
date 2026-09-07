'use strict';

/**
 * Node-side wrapper around the Deno L1 harness (runL1.deno.ts).
 *
 * Why Deno: the production ranking/normalization logic this lab evaluates
 * at L1 lives in Supabase Edge Functions, written as Deno-safe TypeScript
 * (no Node APIs - see supabase/functions/_shared/scanHelpers.ts header
 * comment). The repository's own CI already runs these files under
 * `deno test`/`deno check` (see scripts/phase2b4-mutation-battery.js). This
 * wrapper shells out to the same `deno` binary so the lab imports and runs
 * the REAL production module, unmodified, rather than re-implementing its
 * logic in JS (which would silently drift from production over time and
 * would not satisfy spec section 22's "if pure production logic is already
 * separable, reuse it").
 */

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const DENO_SCRIPT = path.join(__dirname, 'runL1.deno.ts');

let _denoAvailable;
function isDenoAvailable() {
  if (_denoAvailable !== undefined) return _denoAvailable;
  const probe = spawnSync('deno', ['--version'], { encoding: 'utf8' });
  _denoAvailable = probe.status === 0;
  return _denoAvailable;
}

/**
 * Run the real production normalize+rank+dedup pipeline (L1) against one
 * fixture's garmentIdentification + candidateProducts.
 *
 * Returns { ok: true, normalized, mergedCandidateCount, ranked } on success,
 * or { ok: false, blocker: string, detail: string } if Deno is unavailable
 * or the subprocess fails - callers must treat this as a recorded blocker
 * (spec section 34), not a thrown exception, so one missing fixture never
 * aborts the whole offline evaluation pass.
 */
function runL1ForFixture(fixture) {
  if (!isDenoAvailable()) {
    return {
      ok: false,
      blocker: 'DENO_UNAVAILABLE',
      detail: "'deno' binary not found on PATH; L1 offline pipeline mode cannot execute the real production module in this environment.",
    };
  }

  const tmpFile = path.join(
    os.tmpdir(),
    `fmql-l1-${fixture.fixtureId}-${process.pid}-${Date.now()}.json`,
  );
  try {
    fs.writeFileSync(
      tmpFile,
      JSON.stringify({
        garmentIdentification: fixture.garmentIdentification,
        candidateProducts: fixture.candidateProducts,
      }),
      'utf8',
    );

    const result = spawnSync(
      'deno',
      ['run', '--no-check', `--allow-read=${tmpFile}`, DENO_SCRIPT, tmpFile],
      { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );

    if (result.status !== 0) {
      return {
        ok: false,
        blocker: 'DENO_SUBPROCESS_FAILED',
        detail: (result.stderr || result.error?.message || 'unknown deno failure').slice(0, 2000),
      };
    }

    const parsed = JSON.parse(result.stdout.trim());
    return { ok: true, ...parsed };
  } catch (err) {
    return { ok: false, blocker: 'L1_WRAPPER_EXCEPTION', detail: err.message };
  } finally {
    try {
      fs.unlinkSync(tmpFile);
    } catch {
      // best-effort cleanup
    }
  }
}

module.exports = { runL1ForFixture, isDenoAvailable };
