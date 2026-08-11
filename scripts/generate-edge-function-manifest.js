#!/usr/bin/env node
/**
 * Generates `config/edge-function-manifest.json` — the canonical description of
 * the deployable Edge Function source for the image-identification loop.
 *
 * Run this from the CANONICAL tree after any intentional backend change, then
 * commit the regenerated manifest on both platform branches. The checker
 * (`scripts/check-edge-function-parity.js`) refuses to pass while the committed
 * manifest and the working tree disagree, so "forgot to regenerate" fails loudly
 * instead of silently widening the drift IMG-006 documented.
 *
 * Usage:
 *   node scripts/generate-edge-function-manifest.js            # write manifest
 *   node scripts/generate-edge-function-manifest.js --check     # verify only
 *   node scripts/generate-edge-function-manifest.js --print     # stdout only
 *
 * Exit codes:
 *   0  manifest written, or (with --check) already up to date
 *   1  --check requested and the manifest is stale
 *   2  usage / resolution error
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const {
  CONFIG_RELATIVE_PATH,
  buildParity,
  resolveCheckoutEnvironment,
  serializeManifest,
} = require('./edge-function-manifest-lib.js');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_RELATIVE_PATH = path.join('config', 'edge-function-manifest.json');
const MANIFEST_ABSOLUTE_PATH = path.join(REPO_ROOT, MANIFEST_RELATIVE_PATH);

/**
 * Provenance is informational only.
 *
 * It is stored in its own top-level key and is deliberately excluded from every
 * parity comparison: the Git SHA and generation time necessarily differ between
 * the Android and iOS branches, and gating on them would make two correctly
 * synchronized trees report as drifted forever.
 */
function readProvenance() {
  let gitSha = 'unknown';
  try {
    gitSha = execFileSync('git', ['-C', REPO_ROOT, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
  } catch {
    /* Manifest generation must work in an exported tarball with no Git. */
  }
  return {
    note: 'Informational only. Excluded from every parity comparison because it differs per branch.',
    generatedAtUtc: new Date().toISOString(),
    generatedFromGitSha: gitSha,
  };
}

function main() {
  const args = new Set(process.argv.slice(2));
  const checkOnly = args.has('--check');
  const printOnly = args.has('--print');

  // The manifest is environment-neutral, so it may legitimately be generated
  // from a staging-targeting or a production-targeting checkout. What is NOT
  // acceptable is generating from a checkout whose environment cannot be
  // proven — that would mint an artifact record of unknown origin.
  const checkout = resolveCheckoutEnvironment(REPO_ROOT);
  if (!checkout.ok) {
    const configPath = CONFIG_RELATIVE_PATH.split(path.sep).join('/');
    if (checkout.code === 'MISSING_ENVIRONMENT_IDENTITY') {
      console.error(
        `FAIL  ${configPath} is missing.\n` +
          '      Without it a checkout cannot prove which Supabase project a deploy would reach.',
      );
    } else {
      console.error(
        `FAIL  Unknown environment identity.\n` +
          `      config.toml declares : ${checkout.ref}\n` +
          `      resolution           : ${checkout.code}`,
      );
    }
    process.exit(2);
  }

  let parity;
  try {
    parity = buildParity(REPO_ROOT);
  } catch (error) {
    console.error(`FAIL  ${error.message}`);
    process.exit(2);
  }

  const existingRaw = fs.existsSync(MANIFEST_ABSOLUTE_PATH)
    ? fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8')
    : null;

  // Reuse the committed provenance when the parity section is unchanged, so a
  // no-op regeneration does not produce a spurious diff.
  let provenance = readProvenance();
  if (existingRaw !== null) {
    try {
      const existing = JSON.parse(existingRaw);
      if (JSON.stringify(existing.parity) === JSON.stringify(parity) && existing.provenance) {
        provenance = existing.provenance;
      }
    } catch {
      /* Unparseable manifest is simply replaced. */
    }
  }

  const serialized = serializeManifest({ provenance, parity });

  if (printOnly) {
    process.stdout.write(serialized);
    return;
  }

  if (checkOnly) {
    if (existingRaw === serialized) {
      console.log('PASS  Edge Function manifest is up to date.');
      return;
    }
    console.error(
      'FAIL  Edge Function manifest is stale.\n' +
        '      Run: node scripts/generate-edge-function-manifest.js',
    );
    process.exit(1);
  }

  fs.mkdirSync(path.dirname(MANIFEST_ABSOLUTE_PATH), { recursive: true });
  fs.writeFileSync(MANIFEST_ABSOLUTE_PATH, serialized);

  console.log(`Wrote ${MANIFEST_RELATIVE_PATH.split(path.sep).join('/')}`);
  console.log(`  manifest version : ${parity.manifestVersion}`);
  console.log(`  artifact scope   : ${parity.environmentScope}`);
  console.log(`  generated from   : ${checkout.environment} checkout (${checkout.ref})`);
  console.log(`  source Git SHA   : ${provenance.generatedFromGitSha}`);
  for (const fn of parity.functions) {
    console.log(`  ${fn.name}`);
    console.log(`    bundle files ${String(fn.bundleFileCount).padStart(3)}  hash ${fn.bundleHash}`);
    console.log(`    tree files   ${String(fn.treeFileCount).padStart(3)}  hash ${fn.treeHash}`);
  }
}

main();
