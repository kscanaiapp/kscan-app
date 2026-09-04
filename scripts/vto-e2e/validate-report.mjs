#!/usr/bin/env node
/**
 * Dedicated certification-report validator (repair spec §6 / Control A4).
 *
 * A workflow conclusion is never sufficient proof that a certification run
 * produced a valid artifact (repair spec §37) — this step independently
 * reads the report the harness just wrote and fails the job if it is
 * missing, empty, oversized, malformed, structurally incomplete, stale (a
 * different run's identity), or reports a verdict/spend other than what a
 * genuine zero-spend PASS requires. It deliberately contains no shell
 * pipeline of its own, so its exit code is correct regardless of shell
 * pipefail semantics — see .github/workflows/vto-e2e.yml.
 *
 * Usage:
 *   node scripts/vto-e2e/validate-report.mjs <path-to-report.json>
 *
 * Expected-invocation correlation env vars (all optional; an absent name is
 * not checked — used only by contract-mode tests exercising this file
 * directly, since the workflow always sets all four):
 *   VTO_E2E_EXPECT_RUN_ID
 *   VTO_E2E_EXPECT_PROJECT_REF
 *   VTO_E2E_EXPECT_MODE
 *   VTO_E2E_EXPECT_AUTHORITY_SHA
 */
'use strict';

import fs from 'node:fs';
import { validateReportArtifact, validateReportSize } from './lib/report-schema.mjs';

export function readExpectations(env = process.env) {
  const expectations = {};
  if (env.VTO_E2E_EXPECT_RUN_ID) expectations.runId = env.VTO_E2E_EXPECT_RUN_ID;
  if (env.VTO_E2E_EXPECT_PROJECT_REF) expectations.projectRef = env.VTO_E2E_EXPECT_PROJECT_REF;
  if (env.VTO_E2E_EXPECT_MODE) expectations.mode = env.VTO_E2E_EXPECT_MODE;
  if (env.VTO_E2E_EXPECT_AUTHORITY_SHA) expectations.authoritySha = env.VTO_E2E_EXPECT_AUTHORITY_SHA;
  return expectations;
}

/**
 * Pure validation entry point (no process.exit, no console) so contract-mode
 * tests can exercise every rejection path directly. Returns
 * { ok, code, message }. `code` names ABSENT / EMPTY / OVERSIZED /
 * MALFORMED / STRUCTURAL / STALE / SPEND / VERDICT / VALID.
 */
export function validateReportFile(reportPath, expectations = {}, fsImpl = fs) {
  if (!fsImpl.existsSync(reportPath)) {
    return { ok: false, code: 'ABSENT', message: `CERTIFICATION ARTIFACT MISSING: ${reportPath} does not exist` };
  }

  const stat = fsImpl.statSync(reportPath);
  const sizeCheck = validateReportSize(stat.size);
  if (!sizeCheck.ok) {
    const code = stat.size < 1 ? 'EMPTY' : 'OVERSIZED';
    return { ok: false, code, message: `CERTIFICATION ARTIFACT SIZE INVALID:\n${sizeCheck.errors.map((e) => `- ${e}`).join('\n')}` };
  }

  const raw = fsImpl.readFileSync(reportPath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, code: 'MALFORMED', message: `CERTIFICATION ARTIFACT MALFORMED JSON: ${err.message}` };
  }

  const result = validateReportArtifact(parsed, expectations);
  if (!result.ok) {
    return {
      ok: false,
      code: result.stale ? 'STALE' : 'STRUCTURAL',
      message: `CERTIFICATION ARTIFACT INVALID (${result.stale ? 'STALE' : 'STRUCTURAL'}):\n${result.errors.map((e) => `- ${e}`).join('\n')}`,
    };
  }

  // Hard zero-spend invariant (repair spec §36): independently re-checked
  // here rather than trusting the report's own `verdict`, because the whole
  // point of a dedicated validator is to not take one component's
  // self-reported success on faith.
  if (parsed.mode !== 'staging-full-certification' && (parsed.providerSubmits !== 0 || parsed.paidRequests !== 0)) {
    return {
      ok: false,
      code: 'SPEND',
      message: `ZERO-SPEND INVARIANT VIOLATED: mode=${parsed.mode} providerSubmits=${parsed.providerSubmits} paidRequests=${parsed.paidRequests} (both must be 0 outside staging-full-certification)`,
    };
  }

  if (parsed.verdict !== 'PASS') {
    return { ok: false, code: 'VERDICT', message: `CERTIFICATION VERDICT IS NOT PASS: verdict=${parsed.verdict}` };
  }

  return {
    ok: true,
    code: 'VALID',
    message: `CERTIFICATION ARTIFACT VALID: runId=${parsed.runId} mode=${parsed.mode} verdict=${parsed.verdict} providerSubmits=${parsed.providerSubmits} paidRequests=${parsed.paidRequests}`,
  };
}

function main() {
  const reportPath = process.argv[2];
  if (!reportPath) {
    console.error('Usage: node scripts/vto-e2e/validate-report.mjs <path-to-report.json>');
    process.exit(2);
  }

  const result = validateReportFile(reportPath, readExpectations());
  if (!result.ok) {
    console.error(result.message);
    process.exit(1);
  }
  console.log(result.message);
  process.exit(0);
}

// Only run when invoked as a script; importing must not exit the process.
import { pathToFileURL } from 'node:url';
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
