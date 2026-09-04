/**
 * Structural guard over .github/workflows/vto-e2e.yml (repair spec §5
 * Control A3, §25). A purpose-built indentation-aware line scanner for this
 * repository's own consistent 2-space-per-level workflow style — not a
 * general YAML+bash parser, and no YAML/bash-parsing dependency was added
 * for one file. The job is narrow: never again let a certification-critical
 * `command | tee` step lose its upstream exit code, and never let the live
 * staging jobs run without their concurrency guard.
 *
 * checkWorkflowPipefailSafety() and checkConcurrencyContract() are pure
 * functions over the workflow YAML's TEXT, exercised directly by
 * __tests__/vtoE2eHarnessIntegrity.test.js against both the real file (must
 * pass) and synthetic "reintroduced defect" fixtures (must fail) — so this
 * guard is proven to actually catch the defect class it exists for, not
 * just to exist.
 */
'use strict';

function indentOf(line) {
  const match = /^ */.exec(line);
  return match[0].length;
}

/** True if `line` contains a POSIX shell pipe used as a command separator
 *  (i.e. a bare `|`, not a `||` logical-or). Deliberately does not attempt
 *  to understand quoting — this repo's actual workflow scripts never put a
 *  literal `|` character inside a quoted string, and erring toward flagging
 *  more lines as "contains a pipe" is the safe-direction mistake to make in
 *  a guard like this. */
function lineHasShellPipe(line) {
  return /\|/.test(line.replace(/\|\|/g, ''));
}

/** True if `shellValue` (a `shell:` key's value, trimmed) is GitHub
 *  Actions' pipefail-safe named bash shell. A raw custom shell command
 *  override (rare, unused in this repo) is treated as safe only if it
 *  itself names pipefail — see `blockIsPipefailSafe`. */
function shellNameIsPipefailSafeBash(shellValue) {
  if (!shellValue) return false;
  const v = shellValue.trim().replace(/^['"]|['"]$/g, '');
  return v === 'bash' || v.includes('pipefail');
}

/**
 * Finds the workflow-level `defaults: / run: / shell: <value>` shell name,
 * if present, by scanning top-level (column-0) YAML keys.
 */
function findWorkflowDefaultShell(lines) {
  for (let i = 0; i < lines.length; i += 1) {
    if (/^defaults:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < lines.length && indentOf(lines[j]) > 0; j += 1) {
        const runMatch = /^ {2}run:\s*$/.exec(lines[j]);
        if (runMatch) {
          for (let k = j + 1; k < lines.length && indentOf(lines[k]) > 2; k += 1) {
            const shellMatch = /^ {4}shell:\s*(.+)$/.exec(lines[k]);
            if (shellMatch) return shellMatch[1].trim();
          }
        }
      }
    }
  }
  return null;
}

/** Extracts { name, bodyStart, bodyEnd } for every job under `jobs:`
 *  (2-space-indented keys directly under a column-0 `jobs:`). */
function findJobs(lines) {
  const jobsIdx = lines.findIndex((l) => /^jobs:\s*$/.test(l));
  if (jobsIdx === -1) return [];
  const jobs = [];
  for (let i = jobsIdx + 1; i < lines.length; i += 1) {
    const match = /^ {2}([a-zA-Z0-9_-]+):\s*$/.exec(lines[i]);
    if (match) {
      if (jobs.length > 0) jobs[jobs.length - 1].bodyEnd = i;
      jobs.push({ name: match[1], bodyStart: i + 1, bodyEnd: lines.length });
    }
  }
  return jobs;
}

/** Job-level `defaults: / run: / shell:` at 4/6/8-space indent, scoped to
 *  one job's line range. */
function findJobDefaultShell(lines, bodyStart, bodyEnd) {
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    if (/^ {4}defaults:\s*$/.test(lines[i])) {
      for (let j = i + 1; j < bodyEnd && indentOf(lines[j]) > 4; j += 1) {
        if (/^ {6}run:\s*$/.test(lines[j])) {
          for (let k = j + 1; k < bodyEnd && indentOf(lines[k]) > 6; k += 1) {
            const shellMatch = /^ {8}shell:\s*(.+)$/.exec(lines[k]);
            if (shellMatch) return shellMatch[1].trim();
          }
        }
      }
    }
  }
  return null;
}

/** Every step (`- name:` at 6-space indent) within one job's line range,
 *  with its own `shell:` (8-space, sibling of `run:`) and its `run:`
 *  script body (inline remainder, or the joined lines of a block scalar). */
function findSteps(lines, bodyStart, bodyEnd) {
  const steps = [];
  for (let i = bodyStart; i < bodyEnd; i += 1) {
    const stepMatch = /^ {6}- name:\s*(.*)$/.exec(lines[i]);
    if (!stepMatch) continue;
    let stepEnd = bodyEnd;
    for (let j = i + 1; j < bodyEnd; j += 1) {
      if (/^ {6}- name:/.test(lines[j])) { stepEnd = j; break; }
    }
    let shellValue = null;
    const scriptLines = [];
    for (let j = i + 1; j < stepEnd; j += 1) {
      const shellMatch = /^ {8}shell:\s*(.+)$/.exec(lines[j]);
      if (shellMatch) shellValue = shellMatch[1].trim();

      const inlineRun = /^ {8}run:\s*(.+)$/.exec(lines[j]);
      if (inlineRun && !/^[|>][+-]?\s*$/.test(inlineRun[1].trim())) {
        scriptLines.push(inlineRun[1]);
        continue;
      }
      const blockRun = /^ {8}run:\s*[|>][+-]?\s*$/.exec(lines[j]);
      if (blockRun) {
        for (let k = j + 1; k < stepEnd && (indentOf(lines[k]) > 8 || lines[k].trim() === ''); k += 1) {
          scriptLines.push(lines[k]);
        }
      }
    }
    steps.push({ name: stepMatch[1].trim(), shellValue, scriptLines, line: i + 1 });
    i = stepEnd - 1;
  }
  return steps;
}

/**
 * Fails if any step's `run:` script contains a shell pipe that is not
 * protected by pipefail-safe semantics (an effective `shell: bash`
 * inherited from the step, job, or workflow `defaults`, or an explicit
 * `set -o/-eo/-euo pipefail` inside the script itself).
 *
 * Returns { ok, violations, workflowDefaultShell }.
 */
export function checkWorkflowPipefailSafety(yamlText) {
  const lines = yamlText.split('\n');
  const workflowDefaultShell = findWorkflowDefaultShell(lines);
  const jobs = findJobs(lines);
  const violations = [];

  for (const job of jobs) {
    const jobDefaultShell = findJobDefaultShell(lines, job.bodyStart, job.bodyEnd);
    const steps = findSteps(lines, job.bodyStart, job.bodyEnd);
    for (const step of steps) {
      if (!step.scriptLines.some(lineHasShellPipe)) continue;
      const effectiveShell = step.shellValue || jobDefaultShell || workflowDefaultShell;
      const scriptText = step.scriptLines.join('\n');
      const safe = shellNameIsPipefailSafeBash(effectiveShell) || scriptText.includes('pipefail');
      if (!safe) {
        violations.push({
          job: job.name,
          step: step.name,
          line: step.line,
          reason: `pipeline without pipefail-safe shell (effective shell: ${effectiveShell ?? 'GitHub Actions UNDECLARED default — bash -e, NO pipefail'})`,
        });
      }
    }
  }

  return { ok: violations.length === 0, violations, workflowDefaultShell };
}

/**
 * Fails unless every job that mutates live staging state (staging-dryrun,
 * staging-full-certification, cleanup) declares
 * `concurrency: { group: vto-e2e-certification, cancel-in-progress: false }`
 * — repair spec §25: two live staging VTO certification runs must never be
 * permitted to interleave.
 */
export function checkConcurrencyContract(yamlText, requiredJobs = ['staging-dryrun', 'staging-full-certification', 'cleanup']) {
  const lines = yamlText.split('\n');
  const jobs = findJobs(lines);
  const violations = [];

  for (const jobName of requiredJobs) {
    const job = jobs.find((j) => j.name === jobName);
    if (!job) {
      violations.push({ job: jobName, reason: 'job not found in workflow' });
      continue;
    }
    const body = lines.slice(job.bodyStart, job.bodyEnd).join('\n');
    const hasGroup = /concurrency:\s*\n\s*group:\s*vto-e2e-certification\s*$/m.test(body)
      || /group:\s*vto-e2e-certification/.test(body);
    const hasCancelFalse = /cancel-in-progress:\s*false/.test(body);
    if (!hasGroup || !hasCancelFalse) {
      violations.push({
        job: jobName,
        reason: `missing concurrency guard (group=vto-e2e-certification: ${hasGroup}, cancel-in-progress=false: ${hasCancelFalse})`,
      });
    }
  }

  return { ok: violations.length === 0, violations };
}
