#!/usr/bin/env node
/**
 * Writes `services/kplus/kplusCapabilityFingerprints.generated.ts`, the current
 * implementation identity of every governed Premium Value proof type.
 *
 * Usage:
 *   node scripts/generate-premium-capability-fingerprints.js              # write
 *   node scripts/generate-premium-capability-fingerprints.js --check      # verify only
 *   node scripts/generate-premium-capability-fingerprints.js --at <rev>   # print a historical identity
 *   node scripts/generate-premium-capability-fingerprints.js --files      # print governed files per type
 *
 * Exit codes: 0 ok, 1 --check found a stale file, 2 usage or resolution error.
 */

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  GENERATED_RELATIVE_PATH, REPO_ROOT, computeAllFingerprints, computeFingerprint,
  DOMAINS, fsReader, gitReader, renderGeneratedModule,
} = require('./premium-capability-fingerprint-lib.js');

const args = process.argv.slice(2);
const target = path.join(REPO_ROOT, GENERATED_RELATIVE_PATH);

try {
  const at = args.indexOf('--at');
  if (at !== -1) {
    const rev = args[at + 1];
    if (!rev) throw new Error('--at requires a git revision');
    console.log(JSON.stringify(computeAllFingerprints(gitReader(rev)), null, 2));
  } else if (args.includes('--files')) {
    for (const name of Object.keys(DOMAINS).sort()) {
      const { fingerprint, files } = computeFingerprint(name, fsReader());
      console.log(`${name} ${fingerprint}`);
      files.forEach((file) => console.log(`  ${file.path}`));
    }
  } else {
    const expected = renderGeneratedModule(computeAllFingerprints(fsReader()));
    if (args.includes('--check')) {
      const actual = fs.existsSync(target) ? fs.readFileSync(target, 'utf8').replace(/\r\n/g, '\n') : null;
      if (actual !== expected) {
        console.error(`${GENERATED_RELATIVE_PATH} is stale. Run: npm run generate:premium-fingerprints`);
        process.exit(1);
      }
      console.log('Premium capability fingerprints are current.');
    } else {
      fs.writeFileSync(target, expected);
      console.log(`Wrote ${GENERATED_RELATIVE_PATH}`);
    }
  }
} catch (error) {
  console.error(error.message);
  process.exit(2);
}
