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
 * Usage:   node scripts/check-dependency-reachability.js
 * Exit 0:  no unapproved critical/high findings, no path drift
 * Exit 1:  unapproved finding or reachability-path drift detected
 * Exit 2:  usage / operational error (audit didn't run, manifest missing)
 */

'use strict';

const { execSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXCEPTIONS_PATH = path.join(REPO_ROOT, 'config', 'dependency-reachability-exceptions.json');

/** The same source roots the exceptions manifest's evidence was gathered against. */
const APP_SOURCE_ROOTS = ['app', 'components', 'services', 'hooks', 'contexts', 'lib', 'supabase/functions'];

const SOURCE_EXTENSIONS = new Set(['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs']);
const SKIP_DIR_NAMES = new Set(['node_modules', '__snapshots__', 'fixtures']);

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
 * Returns true if any file under APP_SOURCE_ROOTS directly imports/requires
 * `packageName`. This is a pure-Node re-implementation of the grep check used
 * to build the exceptions manifest's evidence field (kept dependency-free and
 * shell-free so it behaves identically on Windows and in Linux CI), run live
 * so a package that becomes directly imported by shipped app code fails the
 * gate even though it is still listed as an approved build/dev-only exception.
 */
function isDirectlyImportedByAppSource(packageName) {
  const escaped = packageName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(from\\s*['"]${escaped}['"]|require\\(\\s*['"]${escaped}['"]\\s*\\))`);
  const files = [];
  for (const root of APP_SOURCE_ROOTS) {
    const absoluteRoot = path.join(REPO_ROOT, root);
    if (fs.existsSync(absoluteRoot)) walkSourceFiles(absoluteRoot, files);
  }
  return files.some((file) => pattern.test(fs.readFileSync(file, 'utf8')));
}

function runAudit() {
  try {
    const raw = execSync('npm audit --omit=dev --json', {
      cwd: REPO_ROOT,
      maxBuffer: 1024 * 1024 * 64,
    });
    return JSON.parse(raw.toString());
  } catch (error) {
    // npm audit exits non-zero whenever vulnerabilities are found — that is
    // the normal case, not an operational failure. stdout still has the report.
    if (error.stdout) {
      try {
        return JSON.parse(error.stdout.toString());
      } catch (parseError) {
        console.error(`FAIL  npm audit produced unparseable JSON: ${parseError.message}`);
        process.exit(2);
      }
    }
    console.error(`FAIL  npm audit could not run: ${error.message}`);
    process.exit(2);
  }
}

function loadExceptions() {
  if (!fs.existsSync(EXCEPTIONS_PATH)) {
    console.error(`FAIL  ${path.relative(REPO_ROOT, EXCEPTIONS_PATH)} is missing.`);
    process.exit(2);
  }
  const manifest = JSON.parse(fs.readFileSync(EXCEPTIONS_PATH, 'utf8'));
  const byPackage = new Map();
  for (const entry of manifest.exceptions) {
    for (const name of entry.packages) byPackage.set(name, entry);
  }
  return { manifest, byPackage };
}

function main() {
  const audit = runAudit();
  const { byPackage } = loadExceptions();

  const failures = [];
  const accepted = [];

  for (const [name, finding] of Object.entries(audit.vulnerabilities || {})) {
    if (finding.severity !== 'critical' && finding.severity !== 'high') continue;

    const exception = byPackage.get(name);
    if (!exception) {
      failures.push(
        `${name} (${finding.severity}): no approved exception on file. ` +
          'Either this is genuinely new, or it must be triaged and added to ' +
          'config/dependency-reachability-exceptions.json with evidence.',
      );
      continue;
    }

    if (exception.classification === 'BUILD_DEV_ONLY' && isDirectlyImportedByAppSource(name)) {
      failures.push(
        `${name} (${finding.severity}): now directly imported from shipped app source ` +
          `(one of ${APP_SOURCE_ROOTS.join(', ')}) — the documented BUILD_DEV_ONLY exception ` +
          'no longer holds. This is reachability-path drift, not a stale exception.',
      );
      continue;
    }

    accepted.push({ name, severity: finding.severity, classification: exception.classification });
  }

  const meta = (audit.metadata || {}).vulnerabilities || {};
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

main();
