#!/usr/bin/env node
// @ts-check
'use strict';

/**
 * CLI entrypoint for the E4.1 live probe.
 *
 * WHY THIS EXISTS AS A FILE: the workflow previously inlined this through
 * `node -e "..."` inside a double-quoted bash string, so bash expanded
 * `${error.status}` before node ever saw it and produced a syntax error in the
 * generated JS. Shell interpolation and JavaScript template literals cannot
 * safely share a quoting context, and the failure looked like a probe failure
 * rather than a workflow one. A real file removes the entire class of bug.
 *
 * Exit codes:
 *   0  every mandatory scenario passed
 *   1  a scenario failed, or the probe could not run
 *
 * Prints the summary and the failure classification only. Raw prompts and raw
 * model responses never reach stdout, stderr, or the report file.
 */

const fs = require('node:fs');
const probe = require('./run-e41-room-intelligence-live-probe.js');

const REPORT_PATH = process.env.E41_REPORT_PATH || 'e41-probe-report.json';

probe
  .run()
  .then((report) => {
    fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));
    console.log(JSON.stringify(report.summary, null, 2));
    if (report.summary.verdict !== 'PASS') {
      // Named individually so a failure is never hidden inside a count.
      for (const failure of report.summary.failedScenarios) {
        console.error(`FAILED ${failure.group}/${failure.scenario}: ${failure.reasonCode}`);
      }
    }
    process.exit(report.summary.verdict === 'PASS' ? 0 : 1);
  })
  .catch((error) => {
    // Classification and HTTP status only. An error message can carry a
    // response body, and a response body can carry room contents.
    const status = Number.isFinite(error && error.status) ? ` http=${error.status}` : '';
    console.error(`E4.1 probe failed: ${(error && error.code) || 'UNKNOWN'}${status}`);
    process.exit(1);
  });
