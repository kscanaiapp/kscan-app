#!/usr/bin/env node
/**
 * Phase 2B.4 deliberate drift proofs.
 *
 * A green gate proves nothing until it has been shown to go red for the right
 * reason and to name the thing that drifted. This introduces four bounded,
 * fully reverted drifts and requires each gate to fail, to identify the exact
 * file or field, and to return to PASS after restoration.
 *
 *   A  cross-platform shared-core drift  → the parity gate names the FILE
 *   B  Scanner-versus-Elise identity drift → the comparator names the FIELD
 *   C  scan-identify bundle drift        → parity AND the deploy guard exit nonzero
 *   D  stylechat-generate bundle drift   → parity AND the deploy guard exit nonzero
 *
 * NOTHING IS DEPLOYED. The deploy guard is invoked without --confirm-deploy, so
 * it can only ever reach its dry run; proofs C and D require it to abort before
 * even that.
 *
 * Exit codes:
 *   0  every drift was detected, named and reverted; every gate is green again
 *   1  a drift went undetected, was reported without naming the target, or the
 *      tree did not return to green
 */

'use strict';

const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function run(command, args) {
  return spawnSync(command, args, { cwd: ROOT, encoding: 'utf8' });
}

function node(script, args = []) {
  return run(process.execPath, [path.join(ROOT, 'scripts', script), ...args]);
}

function text(result) {
  return `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
}

const failures = [];

function check(label, condition, detail) {
  if (condition) {
    console.log(`    ok    ${label}`);
  } else {
    console.log(`    FAIL  ${label}${detail ? `\n          ${detail}` : ''}`);
    failures.push(label);
  }
}

/**
 * Applies a bounded edit, runs the proof body, and restores byte-for-byte.
 *
 * Restoration happens in a finally block and is verified: a drift proof that
 * left the tree dirty would be worse than no proof at all.
 */
function withDrift(relativePath, find, replace, body) {
  const absolute = path.join(ROOT, relativePath);
  const original = fs.readFileSync(absolute, 'utf8');
  if (!original.includes(find)) {
    failures.push(`anchor not found in ${relativePath}`);
    console.log(`    FAIL  anchor not found in ${relativePath}`);
    return;
  }
  try {
    fs.writeFileSync(absolute, original.replace(find, replace));
    body();
  } finally {
    fs.writeFileSync(absolute, original);
  }
  if (fs.readFileSync(absolute, 'utf8') !== original) {
    failures.push(`${relativePath} was not restored`);
  }
}

// ── Proof A: cross-platform shared-core drift ────────────────────────────────

console.log('\n── Proof A  cross-platform shared-core drift ───────────────────');
withDrift(
  'services/fashionIdentificationV2Core.ts',
  "if (count <= 3) return '2-3';",
  "if (count <= 3) return '2_3';",
  () => {
    const gate = node('generate-cross-path-parity-manifest.js', ['--check']);
    check('parity gate exits nonzero', gate.status !== 0, `exit ${gate.status}`);
    check(
      'parity gate names the drifted file',
      /services\/fashionIdentificationV2Core\.ts/.test(text(gate)),
      'the gate must identify which governed file diverged',
    );
    check('parity gate reports it as DRIFTED', /DRIFTED/.test(text(gate)));

    const suite = run(process.execPath, [
      '--test', '--test-name-pattern', 'parity: every governed file exists and matches its recorded hash',
      '__tests__/phase2b4CrossPlatformParity.test.js',
    ]);
    check('named parity test fails', suite.status !== 0);
    check(
      'named parity test names the file',
      /fashionIdentificationV2Core\.ts/.test(text(suite)),
    );
  },
);
check('parity gate is green again', node('generate-cross-path-parity-manifest.js', ['--check']).status === 0);

// ── Proof B: Scanner-versus-Elise identity drift ─────────────────────────────

console.log('\n── Proof B  Scanner-versus-Elise identity drift ────────────────');
withDrift(
  'services/style-chat/eliseIdentificationV2.ts',
  '        metadata: {\n          schemaVersion: \'image-metadata-v1\',',
  '        metadata: {\n          schemaVersion: \'image-metadata-v2\',',
  () => {
    const suite = run(process.execPath, [
      '--test', '--test-name-pattern',
      'request equivalence: detect_items differs ONLY by intent and entryPath',
      '__tests__/phase2b4CrossPathCertification.test.js',
    ]);
    check('cross-path comparator fails', suite.status !== 0);
    check(
      'comparator names the exact field path',
      /evidence\[0\]\.metadata\.schemaVersion/.test(text(suite)),
      'the comparator must report the field, not just "not equal"',
    );
    check(
      'comparator reports both sides',
      /image-metadata-v1/.test(text(suite)) && /image-metadata-v2/.test(text(suite)),
    );
  },
);

console.log('\n── Proof B2  canonical identity drift between the two paths ────');
withDrift(
  'services/style-chat/eliseFashionContextV2.ts',
  '  const category = nz(item.category);\n  const subtype = nz(item.subtype);',
  "  const category = nz(item.category) ?? 'outerwear';\n  const subtype = nz(item.subtype);",
  () => {
    const suite = run(process.execPath, [
      '--test', '--test-name-pattern', 'projection \\[negative/non-fashion\\]',
      '__tests__/phase2b4CrossPathCertification.test.js',
    ]);
    check('projection gate fails on an invented identity', suite.status !== 0);
    check(
      'failure names the invented-identity invariant',
      /altered or invented category|groundable identity/.test(text(suite)),
    );
  },
);

// ── Proofs C and D: deployable bundle drift, per governed function ───────────

function bundleDriftProof(label, relativePath, find, replace, expectedName) {
  console.log(`\n── ${label} ───────────────────────`);
  withDrift(relativePath, find, replace, () => {
    const parity = node('check-edge-function-parity.js');
    check('edge parity exits nonzero', parity.status !== 0, `exit ${parity.status}`);
    check(
      'edge parity names the drifted function',
      new RegExp(expectedName).test(text(parity)),
    );

    const guard = node('deploy-edge-functions.js');
    check('deploy guard exits nonzero', guard.status !== 0, `exit ${guard.status}`);
    check(
      'deploy guard aborts before any deployment step',
      /ABORTED/.test(text(guard)),
    );
    check(
      'deploy guard never reached the dry run',
      !/DRY RUN/.test(text(guard)),
      'a drifted tree must not be reported as verified',
    );
    check(
      'nothing was deployed',
      !/Deployment complete/.test(text(guard)) && !/functions deploy/.test(text(guard)),
    );
  });
  check(`${label}: edge parity is green again`, node('check-edge-function-parity.js').status === 0);
}

bundleDriftProof(
  'Proof C  scan-identify bundle drift',
  'supabase/functions/_shared/fashionIdentificationV2.ts',
  "export const COMMERCE_SKIPPED_STYLE_INTENT = 'style_intent';",
  "export const COMMERCE_SKIPPED_STYLE_INTENT = 'style_intent_drift';",
  'scan-identify',
);

bundleDriftProof(
  'Proof D  stylechat-generate bundle drift',
  'supabase/functions/stylechat-generate/fashionContextV2.ts',
  'export const MAX_FASHION_CONTEXT_ITEMS = 6;',
  'export const MAX_FASHION_CONTEXT_ITEMS = 7;',
  'stylechat-generate',
);

// ── Final state ──────────────────────────────────────────────────────────────

console.log('\n── Post-proof state ────────────────────────────────────────────');
const finalParity = node('check-edge-function-parity.js');
check('edge parity PASS', finalParity.status === 0);
const finalManifest = node('generate-edge-function-manifest.js', ['--check']);
check('edge manifest current', finalManifest.status === 0);
const finalCrossPath = node('generate-cross-path-parity-manifest.js', ['--check']);
check('cross-path parity manifest current', finalCrossPath.status === 0);
const finalGuard = node('deploy-edge-functions.js');
check('deploy guard reaches its DRY RUN and deploys nothing',
  finalGuard.status === 0 && /DRY RUN/.test(text(finalGuard)) && !/Deployment complete/.test(text(finalGuard)));

const gitStatus = run('git', ['status', '--porcelain', '--', 'supabase/functions', 'services', 'config']);
const dirtyTracked = (gitStatus.stdout ?? '')
  .split(/\r?\n/)
  .filter((line) => line.trim() && !line.startsWith('??'));
console.log(`    tracked changes after proofs: ${dirtyTracked.length}`);
for (const line of dirtyTracked) console.log(`      ${line}`);

console.log('\n' + '─'.repeat(64));
if (failures.length > 0) {
  console.error(`FAIL  ${failures.length} drift proof assertion(s) did not hold:`);
  for (const failure of failures) console.error(`  - ${failure}`);
  process.exit(1);
}
console.log('PASS  Every deliberate drift was detected and named, and every gate is green again.');
console.log('      No deployment occurred at any point.');
