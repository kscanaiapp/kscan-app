#!/usr/bin/env node
/**
 * Dependency reachability gate (B34-DEF-014).
 *
 * `npm audit` severity alone does not tell you whether a finding can affect a
 * shipped build: the Expo/Metro/React Native toolchain carries several
 * build-time-only high-severity advisories (see config/dependency-reachability-exceptions.json)
 * that a naive "fail on any high/critical" rule would either block on forever
 * or force an unsupported major-version jump to silence.
 *
 * This gate:
 *   1. Runs `npm audit --omit=dev --json`.
 *   2. Every critical/high finding must be either fully resolved OR present in
 *      the committed exceptions manifest with a matching dependency path.
 *      Anything else is a hard failure (a genuinely new critical/high finding).
 *   3. An excepted package whose actual dependency path no longer matches the
 *      path recorded in the manifest is also a hard failure — that is exactly
 *      "a known development-only critical path becomes production-reachable"
 *      (the tree shape changed underneath the documented exception).
 *
 * This never runs `npm audit fix` / `npm audit fix --force`.
 *
 * FAIL-CLOSED (B34-DEF-014 follow-up, found by PR #289 CI).
 *
 * The gate used to accept ANY parseable JSON on npm's stdout as an audit
 * report. When the audit endpoint is unreachable or errors, npm still exits
 * non-zero and still prints JSON — but it prints
 *
 *     { "message": "request to .../security/audits/quick failed, ...",
 *       "error": { "summary": "", "detail": "" } }
 *
 * which parses cleanly, has no `vulnerabilities` key, and therefore produced
 * "0 findings, 0 totals, PASS". A gate that cannot reach the advisory database
 * reported the tree as clean: "could not verify" silently became "safe", and
 * whichever negative control happened to land on a failed audit call reported a
 * green gate. An audit report is now VALIDATED before it is trusted, and an
 * audit that cannot be established is an AUDIT_UNAVAILABLE failure (exit 2),
 * never a pass. Transient transport errors are retried a bounded number of
 * times first, so a flaky endpoint costs a retry rather than a false red.
 *
 * Reachability is also no longer conditional on the advisory feed. It used to
 * be checked only for packages that appeared as critical/high in THIS audit
 * run, so a BUILD_DEV_ONLY package that became app-reachable went unchecked for
 * as long as its advisory happened not to be reported. Every package the
 * manifest documents as high/critical BUILD_DEV_ONLY is now checked for a
 * direct app-source import on every run — that claim is what the exception
 * rests on, and it is either true or it is not.
 *
 * Usage:   node scripts/check-dependency-reachability.js
 * Exit 0:  no unapproved critical/high findings, no path drift
 * Exit 1:  unapproved finding or reachability-path drift detected
 * Exit 2:  usage / operational error (audit unavailable, manifest missing)
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, 'config', 'dependency-reachability-exceptions.json');

/** The same source roots the exceptions manifest's evidence was gathered against. */
const APP_SOURCE_ROOTS = ['app', 'components', 'services', 'hooks', 'contexts', 'lib', 'supabase/functions'];

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIR_NAMES = new Set(['node_modules', '__snapshots__', 'fixtures']);

/** Severities this gate blocks on. Moderate/low advisories are out of scope. */
const BLOCKING_SEVERITIES = new Set(['critical', 'high']);

// `npm audit` is a network call whose latency is dominated by the registry, not
// by us: a healthy run against a slow/proxied registry has been observed taking
// several minutes. The per-attempt budget is therefore generous, and the retry
// count small, so a hung endpoint still fails closed inside a sane CI budget
// instead of a slow-but-working audit being killed and misreported as
// unavailable. Both are overridable so CI can bound them explicitly.
const AUDIT_ATTEMPTS = Number(process.env.DEPENDENCY_AUDIT_ATTEMPTS || 2);
const AUDIT_TIMEOUT_MS = Number(process.env.DEPENDENCY_AUDIT_TIMEOUT_MS || 600000);

function walkSourceFiles(dir, out) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (SKIP_DIR_NAMES.has(entry.name)) continue;
      walkSourceFiles(path.join(dir, entry.name), out);
    } else if (SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
      out.push(path.join(dir, entry.name));
    }
  }
}

/**
 * Reads every app-source file once. The previous implementation re-walked and
 * re-read the whole tree for each package examined, which on this repo is ~840
 * files per package and was the reason the CI job spent minutes in this gate.
 */
function readAppSource(repoRoot = REPO_ROOT) {
  const files = [];
  for (const root of APP_SOURCE_ROOTS) {
    const absoluteRoot = path.join(repoRoot, root);
    if (fs.existsSync(absoluteRoot)) walkSourceFiles(absoluteRoot, files);
  }
  return files.map((file) => fs.readFileSync(file, 'utf8'));
}

function importPattern(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(from\\s*['"]${escaped}['"]|require\\(\\s*['"]${escaped}['"]\\s*\\))`);
}

/**
 * Returns true if any file under APP_SOURCE_ROOTS directly imports/requires
 * `packageName`. This is a pure-Node re-implementation of the grep check used
 * to build the exceptions manifest's evidence field (kept dependency-free and
 * shell-free so it behaves identically on Windows and in Linux CI), run live
 * so a package that becomes directly imported by shipped app code fails the
 * gate even though it is still listed as an approved build/dev-only exception.
 */
function makeImportChecker(sources) {
  return function isDirectlyImportedByAppSource(packageName) {
    const pattern = importPattern(packageName);
    return sources.some((contents) => pattern.test(contents));
  };
}

/**
 * An `npm audit --json` report is only usable if it actually carries the two
 * structures this gate reads. npm emits a syntactically valid JSON error object
 * on transport failure, so "it parsed" is not evidence that an audit happened.
 */
function isValidAuditReport(report) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) return false;
  // An npm error payload — the exact shape returned when the audit endpoint is
  // unreachable or errors. It parses, and it is not an audit result.
  if (report.error !== undefined && report.vulnerabilities === undefined) return false;
  if (!report.vulnerabilities || typeof report.vulnerabilities !== 'object') return false;
  const metadata = report.metadata;
  if (!metadata || typeof metadata !== 'object') return false;
  if (!metadata.vulnerabilities || typeof metadata.vulnerabilities !== 'object') return false;
  return true;
}

/**
 * Turns raw npm stdout into a discriminated result. Never throws, never exits:
 * the caller decides, so this is directly testable without spawning npm.
 */
function parseAuditOutput(stdout) {
  if (typeof stdout !== 'string' || stdout.trim() === '') {
    return { ok: false, reason: 'AUDIT_UNAVAILABLE', detail: 'npm audit produced no output' };
  }
  let report;
  try {
    report = JSON.parse(stdout);
  } catch (error) {
    return { ok: false, reason: 'AUDIT_UNPARSEABLE', detail: `npm audit produced unparseable JSON: ${error.message}` };
  }
  if (!isValidAuditReport(report)) {
    const npmMessage = report && typeof report === 'object' && typeof report.message === 'string' ? ` npm said: ${report.message}` : '';
    return {
      ok: false,
      reason: 'AUDIT_UNEXPECTED_SHAPE',
      detail:
        'npm audit returned JSON that is not an audit report (no usable vulnerabilities/metadata).' +
        `${npmMessage}`,
    };
  }
  return { ok: true, report };
}

/**
 * Runs `npm audit` with bounded retries. A transient transport error should
 * cost a retry, not a false red — but an audit that still cannot be
 * established after the retries fails closed.
 */
/**
 * Default audit runner. Deliberately NOT execSync: execSync goes through a
 * shell, and its `timeout` kills the shell while npm keeps running and keeps
 * the stdout pipe open — so a hung audit is not actually bounded and the job
 * runs until the CI timeout instead of failing closed. spawnSync with no shell
 * signals npm itself, and SIGKILL means a wedged process cannot ignore it.
 */
function resolveNpmInvocation(
  platform = process.platform,
  env = process.env,
  nodeExecutable = process.execPath,
) {
  if (platform !== 'win32') {
    return { command: 'npm', args: ['audit', '--omit=dev', '--json'] };
  }

  // Windows cannot execute npm.cmd with shell:false on every supported Node
  // runtime. Invoke npm's JavaScript entrypoint with Node so the hard timeout
  // still targets the real process instead of an intermediate command shell.
  const npmCli = env.npm_execpath
    || path.join(path.dirname(nodeExecutable), 'node_modules', 'npm', 'bin', 'npm-cli.js');
  return { command: nodeExecutable, args: [npmCli, 'audit', '--omit=dev', '--json'] };
}

function defaultAuditExec(command, options) {
  const npm = resolveNpmInvocation();
  const result = spawnSync(npm.command, npm.args, {
    cwd: options.cwd,
    timeout: options.timeout,
    killSignal: 'SIGKILL',
    maxBuffer: options.maxBuffer,
    shell: false,
    encoding: 'buffer',
  });

  const timedOut = result.error && result.error.code === 'ETIMEDOUT';
  if (result.error || result.status !== 0) {
    const error = new Error(
      timedOut
        ? `npm audit exceeded ${options.timeout}ms and was killed`
        : (result.error && result.error.message) || `npm audit exited with status ${result.status}`,
    );
    // npm audit exits non-zero whenever vulnerabilities are found, so stdout is
    // still the report in the normal case; the caller tells the cases apart.
    error.stdout = result.stdout;
    error.killed = Boolean(timedOut);
    if (timedOut) error.code = 'ETIMEDOUT';
    throw error;
  }
  return result.stdout;
}

function runAudit({
  attempts = AUDIT_ATTEMPTS,
  exec = defaultAuditExec,
  cwd = REPO_ROOT,
  timeout = AUDIT_TIMEOUT_MS,
} = {}) {
  let last = { ok: false, reason: 'AUDIT_UNAVAILABLE', detail: 'npm audit was never attempted' };
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    let stdout = null;
    try {
      stdout = exec('npm audit --omit=dev --json', {
        cwd,
        maxBuffer: 1024 * 1024 * 64,
        timeout,
      });
    } catch (error) {
      // npm audit exits non-zero whenever vulnerabilities are found — that is
      // the normal case, not an operational failure. stdout still has the
      // report. It ALSO exits non-zero on a transport error, where stdout
      // carries an error object instead; parseAuditOutput tells them apart.
      const timedOut = error.killed === true || error.signal === 'SIGTERM' || error.code === 'ETIMEDOUT';
      stdout = error.stdout ?? null;
      if (stdout === null || stdout.toString().trim() === '') {
        last = {
          ok: false,
          reason: 'AUDIT_UNAVAILABLE',
          detail: timedOut
            ? `npm audit timed out after ${timeout}ms: ${error.message}`
            : `npm audit could not run: ${error.message}`,
        };
        continue;
      }
    }
    const result = parseAuditOutput(stdout === null ? '' : stdout.toString());
    if (result.ok) return result;
    last = result;
  }
  return { ...last, attempts };
}

function loadExceptions(exceptionsPath = EXCEPTIONS_PATH) {
  if (!fs.existsSync(exceptionsPath)) {
    return { ok: false, reason: 'MANIFEST_MISSING', detail: `${path.relative(REPO_ROOT, exceptionsPath)} is missing.` };
  }
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(exceptionsPath, 'utf8'));
  } catch (error) {
    return { ok: false, reason: 'MANIFEST_UNPARSEABLE', detail: `exceptions manifest is unparseable: ${error.message}` };
  }
  if (!manifest || !Array.isArray(manifest.exceptions)) {
    return { ok: false, reason: 'MANIFEST_UNPARSEABLE', detail: 'exceptions manifest has no `exceptions` array.' };
  }
  const byPackage = new Map();
  for (const entry of manifest.exceptions) {
    for (const name of entry.packages || []) byPackage.set(name, entry);
  }
  return { ok: true, manifest, byPackage };
}

/**
 * Resolve the blocking direct-advisory leaves behind one npm-audit finding.
 * npm audit propagates a leaf advisory's severity to every parent in the
 * dependency chain. In audit v2, direct advisories are objects in `via`; parent
 * findings normally point at another vulnerable package by string name.
 *
 * This distinction matters for packages such as react-native: the package is
 * part of the shipped runtime, but an aggregate HIGH can still be inherited
 * solely through its bundled Jest/Metro build tooling. We must not label the
 * runtime package BUILD_DEV_ONLY; we instead prove the audit's `via` graph ends
 * at an explicitly approved build/dev-only advisory leaf.
 */
function resolveBlockingAdvisoryLeaves(report, packageName, stack = new Set(), stopAt = null) {
  const vulnerabilities = report.vulnerabilities || {};
  const finding = vulnerabilities[packageName];
  const leaves = new Set();
  const unresolved = new Set();

  if (!finding || typeof finding !== 'object') {
    unresolved.add(packageName);
    return { leaves, unresolved };
  }
  if (stack.has(packageName)) {
    unresolved.add(packageName);
    return { leaves, unresolved };
  }

  // A caller may nominate already-governed direct exceptions as trust
  // boundaries. This prevents aggregate parents from recursively reopening a
  // BUILD_DEV_ONLY package whose own advisory/reachability has already been
  // separately approved and checked.
  if (stack.size > 0 && typeof stopAt === 'function' && stopAt(packageName)) {
    leaves.add(packageName);
    return { leaves, unresolved };
  }

  const nextStack = new Set(stack);
  nextStack.add(packageName);
  const via = Array.isArray(finding.via) ? finding.via : [];

  for (const item of via) {
    if (typeof item === 'string') {
      const nested = resolveBlockingAdvisoryLeaves(report, item, nextStack, stopAt);
      for (const leaf of nested.leaves) leaves.add(leaf);
      for (const missing of nested.unresolved) unresolved.add(missing);
      continue;
    }
    if (!item || typeof item !== 'object' || !BLOCKING_SEVERITIES.has(item.severity)) continue;
    const dependency =
      (typeof item.dependency === 'string' && item.dependency) ||
      (typeof item.name === 'string' && item.name) ||
      packageName;
    leaves.add(dependency);
  }

  // A blocking finding with no usable `via` metadata is never assumed to be an
  // aggregate. Treat the package itself as the direct leaf so it still needs an
  // explicit exception (or remediation) and therefore fails closed by default.
  if (leaves.size === 0 && unresolved.size === 0 && BLOCKING_SEVERITIES.has(finding.severity)) {
    leaves.add(packageName);
  }

  return { leaves, unresolved };
}

/**
 * An unexcepted parent may be accepted only when ALL of its blocking advisory
 * leaves are explicitly approved BUILD_DEV_ONLY exceptions and each leaf's
 * manifest entry explicitly names this parent in `aggregateParents`.
 *
 * This is deliberately stricter than "the leaf has an exception": it prevents
 * a broad leaf waiver from automatically blessing unrelated runtime parents.
 */
function evaluateApprovedAggregate({ report, name, byPackage, isImported }) {
  const stopAtApprovedBoundary = (candidate) => {
    const finding = (report.vulnerabilities || {})[candidate];
    const exception = byPackage.get(candidate);
    return Boolean(
      finding &&
      exception &&
      exception.classification === 'BUILD_DEV_ONLY' &&
      exception.severity === finding.severity,
    );
  };
  const { leaves, unresolved } = resolveBlockingAdvisoryLeaves(
    report,
    name,
    new Set(),
    stopAtApprovedBoundary,
  );
  const leafNames = [...leaves].sort();
  const unresolvedNames = [...unresolved].sort();
  if (unresolved.size > 0 || leaves.size === 0 || leaves.has(name)) {
    return { ok: false, leaves: leafNames, unresolved: unresolvedNames, reason: 'not-a-pure-aggregate' };
  }

  for (const leaf of leaves) {
    const leafFinding = (report.vulnerabilities || {})[leaf];
    const exception = byPackage.get(leaf);
    if (!leafFinding || !exception) {
      return { ok: false, leaves: leafNames, unresolved: unresolvedNames, reason: `leaf-${leaf}-unapproved` };
    }
    if (exception.classification !== 'BUILD_DEV_ONLY') {
      return { ok: false, leaves: leafNames, unresolved: unresolvedNames, reason: `leaf-${leaf}-not-build-dev-only` };
    }
    // A severity escalation is new risk. Do not let yesterday's HIGH waiver
    // silently cover tomorrow's CRITICAL advisory.
    if (exception.severity !== leafFinding.severity) {
      return { ok: false, leaves: leafNames, unresolved: unresolvedNames, reason: `leaf-${leaf}-severity-mismatch` };
    }
    if (!Array.isArray(exception.aggregateParents) || !exception.aggregateParents.includes(name)) {
      return { ok: false, leaves: leafNames, unresolved: unresolvedNames, reason: `leaf-${leaf}-parent-not-approved` };
    }
    if (isImported(leaf)) {
      return {
        ok: false,
        failure:
          `${name} (${report.vulnerabilities[name].severity}): inherited advisory leaf ${leaf} is now directly imported ` +
          `from shipped app source — the documented BUILD_DEV_ONLY leaf exception no longer holds.`,
      };
    }
  }

  return { ok: true, leaves: leafNames, unresolved: unresolvedNames };
}

/**
 * Pure evaluation: given a validated audit report, the exceptions manifest and
 * an import oracle, decide what fails. Separated from process/IO so every
 * negative control can be exercised from a deterministic fixture instead of a
 * live, flaky `npm audit` call.
 */
function evaluateReachability({ report, manifest, byPackage, isImported }) {
  const failures = [];
  const accepted = [];
  const checkedForImport = new Set();

  for (const [name, finding] of Object.entries(report.vulnerabilities || {})) {
    if (!BLOCKING_SEVERITIES.has(finding.severity)) continue;

    const exception = byPackage.get(name);
    if (!exception) {
      const aggregate = evaluateApprovedAggregate({ report, name, byPackage, isImported });
      if (aggregate.ok) {
        accepted.push({
          name,
          severity: finding.severity,
          classification: 'TRANSITIVE_BUILD_DEV_ONLY',
          via: aggregate.leaves.join(','),
        });
        continue;
      }
      if (aggregate.failure) {
        failures.push(aggregate.failure);
        continue;
      }
      const aggregateTrace =
        aggregate.leaves || aggregate.unresolved
          ? ` Aggregate trace: reason=${aggregate.reason || 'not-approved'}; leaves=[${(aggregate.leaves || []).join(',')}]; unresolved=[${(aggregate.unresolved || []).join(',')}].`
          : '';
      failures.push(
        `${name} (${finding.severity}): no approved exception on file. ` +
          'Either this is genuinely new, or it must be triaged and added to ' +
          'config/dependency-reachability-exceptions.json with evidence.' +
          aggregateTrace,
      );
      continue;
    }

    if (exception.classification === 'BUILD_DEV_ONLY' && isImported(name)) {
      checkedForImport.add(name);
      failures.push(
        `${name} (${finding.severity}): now directly imported from shipped app source ` +
          `(one of ${APP_SOURCE_ROOTS.join(', ')}) — the documented BUILD_DEV_ONLY exception ` +
          'no longer holds. This is reachability-path drift, not a stale exception.',
      );
      continue;
    }
    checkedForImport.add(name);

    accepted.push({ name, severity: finding.severity, classification: exception.classification });
  }

  // Reachability is a claim the manifest makes, not a property of today's
  // advisory feed. Every package documented as high/critical BUILD_DEV_ONLY is
  // checked even when this run's audit does not mention it — otherwise the
  // control silently switches off whenever an advisory drops out of the report.
  for (const entry of manifest.exceptions || []) {
    if (entry.classification !== 'BUILD_DEV_ONLY') continue;
    if (!BLOCKING_SEVERITIES.has(entry.severity)) continue;
    for (const name of entry.packages || []) {
      if (checkedForImport.has(name)) continue;
      checkedForImport.add(name);
      if (isImported(name)) {
        failures.push(
          `${name} (${entry.severity}, declared BUILD_DEV_ONLY): directly imported from shipped ` +
            `app source (one of ${APP_SOURCE_ROOTS.join(', ')}) — the manifest's documented ` +
            'reachability evidence is no longer true, whether or not this run\'s audit reports it.',
        );
      }
    }
  }

  return { failures, accepted };
}

function main() {
  const exceptions = loadExceptions();
  if (!exceptions.ok) {
    console.error(`FAIL  ${exceptions.reason} — ${exceptions.detail}`);
    process.exit(2);
  }

  const audit = runAudit();
  if (!audit.ok) {
    console.error('DEPENDENCY REACHABILITY GATE');
    console.error(`FAIL  ${audit.reason} — the current critical/high dependency state could not be established.`);
    console.error(`    ${audit.detail}`);
    if (audit.attempts) console.error(`    attempts: ${audit.attempts}`);
    console.error('');
    console.error('  Failing closed: an audit that cannot be established is NOT evidence that the tree is clean.');
    process.exit(2);
  }

  const isImported = makeImportChecker(readAppSource());
  const { failures, accepted } = evaluateReachability({
    report: audit.report,
    manifest: exceptions.manifest,
    byPackage: exceptions.byPackage,
    isImported,
  });

  const meta = (audit.report.metadata || {}).vulnerabilities || {};
  console.log('DEPENDENCY REACHABILITY GATE');
  console.log(
    `  audit totals: critical=${meta.critical || 0} high=${meta.high || 0} ` +
      `moderate=${meta.moderate || 0} low=${meta.low || 0}`,
  );
  console.log(`  approved exceptions matched: ${accepted.length}`);
  for (const item of accepted) {
    console.log(`    OK    ${item.name.padEnd(24)} ${item.severity.padEnd(8)} ${item.classification}`);
  }

  if (failures.length > 0) {
    console.error('');
    console.error('FAIL  Unapproved critical/high findings or reachability drift:');
    for (const failure of failures) console.error(`    ${failure}`);
    console.error('');
    console.error(`  ${failures.length} problem(s) found. Do not silence with a broader exception without evidence.`);
    process.exit(1);
  }

  console.log('');
  console.log('PASS  No unapproved critical/high findings. No reachability-path drift.');
}

module.exports = {
  APP_SOURCE_ROOTS,
  BLOCKING_SEVERITIES,
  evaluateReachability,
  isValidAuditReport,
  loadExceptions,
  makeImportChecker,
  parseAuditOutput,
  readAppSource,
  resolveBlockingAdvisoryLeaves,
  resolveNpmInvocation,
  runAudit,
};

if (require.main === module) {
  main();
}
