#!/usr/bin/env node
'use strict';

/**
 * Source/runtime parity for stylist-speech against the CANONICAL FEATURE tree.
 *
 * The governed parity check compares the deployed function to
 * `staging/production-parity`. That is the right baseline everywhere except
 * here: during this pass the parity branch is intentionally still pre-cue, so
 * comparing against it after deploying cue mode would report drift for a change
 * that is the entire point of the deployment. This compares against the working
 * tree the bundle was actually built from instead.
 *
 * Module COUNT is deliberately not asserted. Cue mode legitimately adds a file,
 * and a check that hard-codes "10 modules" would have to be edited every time
 * the function gains one - which trains people to edit the check rather than
 * explain the drift. What is asserted is stricter: the deployed set and the
 * source set must be the same set, and every shared file must match byte for
 * byte.
 *
 * Reads only. Never prints file contents.
 */

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const FUNCTION_DIR = path.join(
  __dirname, '..', '..', 'supabase', 'functions', 'stylist-speech',
);

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

/** Runtime modules only. Tests are not deployed, so they are not compared. */
function sourceModules() {
  return fs.readdirSync(FUNCTION_DIR)
    .filter((name) => name.endsWith('.ts') && !name.endsWith('.test.ts'))
    .sort();
}

/**
 * Compare a deployed bundle (as returned by the Management API `files` array,
 * whose names may carry a `stylist-speech/` prefix) against the source tree.
 */
function compareBundle(deployedFiles) {
  const deployed = new Map();
  for (const file of deployedFiles || []) {
    const name = String(file.name || '').split('/').pop();
    if (name && name.endsWith('.ts') && !name.endsWith('.test.ts')) {
      deployed.set(name, String(file.content == null ? '' : file.content));
    }
  }

  const source = sourceModules();
  const onlyInSource = source.filter((name) => !deployed.has(name));
  const onlyInDeployed = [...deployed.keys()].filter((name) => !source.includes(name)).sort();

  const modules = [];
  for (const name of source) {
    if (!deployed.has(name)) continue;
    const sourceBytes = fs.readFileSync(path.join(FUNCTION_DIR, name));
    // Normalize newlines only. The deploy transport does not preserve CRLF, and
    // a line-ending difference is a packaging artifact, not source divergence.
    const sourceText = sourceBytes.toString('utf8').replace(/\r\n/g, '\n');
    const deployedText = deployed.get(name).replace(/\r\n/g, '\n');
    modules.push({
      module: name,
      match: sha256(sourceText) === sha256(deployedText),
    });
  }

  const matching = modules.filter((entry) => entry.match).length;
  return {
    modulesCompared: modules.length,
    modulesMatching: matching,
    onlyInSource,
    onlyInDeployed,
    modules,
    parity:
      onlyInSource.length === 0 &&
      onlyInDeployed.length === 0 &&
      modules.length > 0 &&
      matching === modules.length
        ? 'PASS'
        : 'BLOCK',
  };
}

module.exports = { compareBundle, sourceModules };

if (require.main === module) {
  const input = process.argv[2];
  if (!input) {
    process.stderr.write('usage: verify-stylist-speech-feature-parity.js <deployed-bundle.json>\n');
    process.exit(2);
  }
  const bundle = JSON.parse(fs.readFileSync(input, 'utf8'));
  const result = compareBundle(bundle.files);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  process.exit(result.parity === 'PASS' ? 0 : 1);
}
