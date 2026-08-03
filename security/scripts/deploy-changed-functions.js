#!/usr/bin/env node
'use strict';

/**
 * Deploys only the Edge Functions a PR candidate actually changed (or that
 * import a shared module the PR changed) — never every directory under
 * supabase/functions/.
 *
 * Usage:
 *   node security/scripts/deploy-changed-functions.js <baseSha> <headSha> <projectRef>
 *
 * Requires SUPABASE_ACCESS_TOKEN in the environment and the project already
 * `supabase link`-ed in the current working directory.
 */

const { execFileSync } = require('node:child_process');
const { computeFunctionManifest } = require('./select-changed-functions');
const { assertNotProductionRef } = require('./select-candidate-migrations');
const { filterToApproved } = require('./staging-deployment-allowlist');

// shell:true only on Windows, where the npm-installed CLI resolves through a
// .cmd shim that execFileSync cannot invoke directly; CI's Linux runner gets
// a real binary from supabase/setup-cli and does not need it.
function deployOne(fnName, projectRef) {
  execFileSync('supabase', ['functions', 'deploy', fnName, '--project-ref', projectRef], {
    encoding: 'utf8',
    shell: process.platform === 'win32',
  });
}

function main() {
  const [baseSha, headSha, projectRef] = process.argv.slice(2);
  if (!baseSha || !headSha || !projectRef) {
    console.error('Usage: deploy-changed-functions.js <baseSha> <headSha> <projectRef>');
    process.exit(2);
  }

  try {
    assertNotProductionRef(projectRef);
  } catch (err) {
    console.log(JSON.stringify({ outcome: 'OPERATIONAL_FAILURE', error: err.message }, null, 2));
    process.exit(1);
  }

  const computed = computeFunctionManifest(baseSha, headSha);
  const { approved, heldBack } = filterToApproved(computed.manifest);
  const result = { ...computed, heldBack };

  // Print the manifest before deploying anything, per the required "print
  // the final function manifest before deploying" behavior.
  console.error(`Function deployment manifest: ${computed.manifest.length ? computed.manifest.join(', ') : '(none)'}`);
  console.error(`Approved for automatic deployment: ${approved.length ? approved.join(', ') : '(none)'}`);
  if (heldBack.length > 0) {
    console.error(`Changed in source but held back — not on the staging deployment allowlist: ${heldBack.join(', ')}`);
  }
  if (result.refused.length > 0) {
    console.error(`Refused (not on disk, not a valid deploy target): ${result.refused.join(', ')}`);
  }

  if (approved.length === 0) {
    console.log(JSON.stringify({ ...result, projectRef, deployed: [], outcome: computed.manifest.length ? 'DEPLOYMENT_BLOCKED' : 'NO_CHANGED_FUNCTIONS' }, null, 2));
    return;
  }

  const deployed = [];
  for (const fnName of approved) {
    try {
      deployOne(fnName, projectRef);
      deployed.push(fnName);
    } catch (err) {
      console.log(JSON.stringify({
        ...result,
        projectRef,
        deployed,
        outcome: 'OPERATIONAL_FAILURE',
        error: `failed to deploy ${fnName}: ${err.message}`,
      }, null, 2));
      process.exit(1);
    }
  }

  console.log(JSON.stringify({ ...result, projectRef, deployed }, null, 2));
}

if (require.main === module) {
  main();
}

module.exports = { deployOne };
