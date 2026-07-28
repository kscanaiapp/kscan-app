#!/usr/bin/env node
/**
 * Generates `config/cross-path-parity-manifest.json` — the canonical hash list
 * for every source file that MUST be byte-identical on the Android and iOS
 * lines because it implements the shared fashion-identification-v2 core, the two
 * consumer intents, or the governed downstream contract.
 *
 * WHY THIS EXISTS: Phase 2B.4 certifies that Scanner and Elise share ONE
 * identification core across BOTH platform branches. A one-off hash comparison
 * proves that on the day it is run and nothing afterwards. Committing the hashes
 * turns it into a gate: a governed file edited on one line and not the other
 * makes the two committed manifests disagree, and a governed file edited without
 * regenerating makes the working tree disagree with its own manifest.
 *
 * The manifest is deliberately provenance-free. The edge-function manifest
 * carries a Git SHA in a separate key that every comparison excludes; here there
 * is nothing to exclude, because the file must be byte-identical on both
 * branches for the cross-platform assertion to mean anything.
 *
 * Usage:
 *   node scripts/generate-cross-path-parity-manifest.js           # write
 *   node scripts/generate-cross-path-parity-manifest.js --check   # verify only
 *   node scripts/generate-cross-path-parity-manifest.js --print   # stdout only
 *
 * Exit codes:
 *   0  written, or (with --check) already up to date
 *   1  --check requested and the manifest is stale, or a governed file is missing
 *   2  usage error
 */

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const MANIFEST_RELATIVE_PATH = path.join('config', 'cross-path-parity-manifest.json');
const MANIFEST_ABSOLUTE_PATH = path.join(REPO_ROOT, MANIFEST_RELATIVE_PATH);

const MANIFEST_VERSION = 'cross-path-parity-manifest-v1';

/**
 * Governed shared source, grouped by the role each file plays.
 *
 * A file belongs here when BOTH platform lines must run the same bytes for
 * cross-path equivalence to hold. Platform-specific intake (Android single-photo
 * capture, the iOS header gallery, native pickers, platform storage) is
 * deliberately absent: those are real platform surfaces that converge on the
 * contract rather than implement it.
 */
const GOVERNED = {
  contract: [
    'contracts/fashion-identification-v2.schema.json',
    'types/fashionIdentificationV2.ts',
  ],
  sharedCore: [
    'services/fashionEvidenceGateway.ts',
    'services/fashionIdentificationV2Core.ts',
    'services/identificationSnapshot.ts',
  ],
  scannerIntent: [
    'services/scannerEvidenceGateway.ts',
    'services/scannerIdentificationV2.ts',
    'services/scannerScanRequest.ts',
  ],
  eliseIntent: [
    'services/style-chat/eliseAttachmentRouting.ts',
    // Shared by BOTH platform intakes: Android's single-photo modal and the iOS
    // header gallery each converge here before the V2 orchestrator.
    'services/style-chat/eliseDirectImageIdentification.ts',
    'services/style-chat/eliseFashionContextV2.ts',
    'services/style-chat/eliseSendContext.ts',
    'services/style-chat/eliseIdentificationV2.ts',
    'services/style-chat/eliseIdentifyForStyle.ts',
    'services/style-chat/eliseVisualContextV2Projection.ts',
  ],
  backend: [
    'supabase/functions/_shared/fashionIdentificationV2.ts',
    'supabase/functions/scan-identify/index.ts',
    'supabase/functions/scan-identify/v2Activation.ts',
    'supabase/functions/stylechat-generate/fashionContextV2.ts',
    'supabase/functions/stylechat-generate/index.ts',
  ],
};

function sha256(absolutePath) {
  // Hashed as raw BYTES. Reading as text and normalizing newlines would let a
  // real line-ending divergence between the two branches pass as identical.
  return crypto.createHash('sha256').update(fs.readFileSync(absolutePath)).digest('hex');
}

function buildManifest() {
  const groups = {};
  const missing = [];
  let fileCount = 0;

  for (const groupName of Object.keys(GOVERNED).sort()) {
    const entries = [];
    for (const relative of [...GOVERNED[groupName]].sort()) {
      const absolute = path.join(REPO_ROOT, relative);
      if (!fs.existsSync(absolute)) {
        missing.push(relative);
        continue;
      }
      entries.push({ path: relative, sha256: sha256(absolute) });
      fileCount += 1;
    }
    groups[groupName] = entries;
  }

  return {
    manifest: {
      manifestVersion: MANIFEST_VERSION,
      note:
        'Every file below must be byte-identical on the Android and iOS lines. '
        + 'Regenerate on the canonical tree and commit the identical manifest on both branches.',
      fileCount,
      groups,
    },
    missing,
  };
}

function serialize(manifest) {
  return `${JSON.stringify(manifest, null, 2)}\n`;
}

function main() {
  const argv = process.argv.slice(2);
  const check = argv.includes('--check');
  const print = argv.includes('--print');
  const unknown = argv.filter((arg) => arg !== '--check' && arg !== '--print');
  if (unknown.length > 0) {
    console.error(`FAIL  Unknown argument: ${unknown.join(', ')}`);
    process.exit(2);
  }

  const { manifest, missing } = buildManifest();
  if (missing.length > 0) {
    console.error('FAIL  Governed files are missing from this tree:');
    for (const relative of missing) console.error(`    ${relative}`);
    process.exit(1);
  }

  const serialized = serialize(manifest);

  if (print) {
    process.stdout.write(serialized);
    return;
  }

  if (check) {
    if (!fs.existsSync(MANIFEST_ABSOLUTE_PATH)) {
      console.error(`FAIL  ${MANIFEST_RELATIVE_PATH} is missing.`);
      process.exit(1);
    }
    const committed = fs.readFileSync(MANIFEST_ABSOLUTE_PATH, 'utf8');
    if (committed !== serialized) {
      console.error('FAIL  Cross-path parity manifest is stale.');
      const committedManifest = JSON.parse(committed);
      const committedByPath = new Map();
      for (const entries of Object.values(committedManifest.groups || {})) {
        for (const entry of entries) committedByPath.set(entry.path, entry.sha256);
      }
      for (const entries of Object.values(manifest.groups)) {
        for (const entry of entries) {
          const previous = committedByPath.get(entry.path);
          if (previous !== entry.sha256) {
            console.error(`    DRIFTED  ${entry.path}`);
            console.error(`        manifest    ${previous ?? '(absent)'}`);
            console.error(`        working tree ${entry.sha256}`);
          }
        }
      }
      console.error('\n  Regenerate with: node scripts/generate-cross-path-parity-manifest.js');
      process.exit(1);
    }
    console.log(`PASS  Cross-path parity manifest is up to date (${manifest.fileCount} governed files).`);
    return;
  }

  fs.writeFileSync(MANIFEST_ABSOLUTE_PATH, serialized);
  console.log(`Wrote ${MANIFEST_RELATIVE_PATH} (${manifest.fileCount} governed files).`);
}

main();
