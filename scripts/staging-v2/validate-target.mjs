#!/usr/bin/env node
/**
 * Generic guarded target validator.
 *
 * Two consumers:
 *   - manual workflow dispatch (`--operation workflow-dispatch`), which must fail
 *     closed when a dispatch input names anything other than Staging v2;
 *   - future ZAP target validation (`--operation zap-target`), so that a scan can
 *     never be pointed at production even before ZAP itself is installed.
 *
 * Usage:
 *   node scripts/staging-v2/validate-target.mjs --operation <name> --project-ref <ref> [--target-url <url>]
 */

import { parseArgs, resolveCliTarget, runGuarded } from '../lib/staging-v2-cli.mjs';
import { normalizeProjectRef } from '../lib/staging-v2-guard.mjs';

const ALLOWED_OPERATIONS = new Set([
  'workflow-dispatch',
  'zap-target',
  'storage-admin',
  'auth-config',
]);

await runGuarded('staging-v2-validate-target', async () => {
  const args = parseArgs(process.argv.slice(2));
  const operation = typeof args.operation === 'string' ? args.operation : '';
  if (!ALLOWED_OPERATIONS.has(operation)) {
    throw new Error(
      `--operation must be one of: ${[...ALLOWED_OPERATIONS].join(', ')} (got "${operation}")`,
    );
  }

  // A URL-shaped input is normalized to a ref and validated identically, so a ZAP
  // target URL pointing at production is rejected by the same allow-list.
  if (typeof args['target-url'] === 'string' && args['target-url']) {
    const derived = normalizeProjectRef(args['target-url'].replace(/\/(rest|auth|functions|storage)\/v1.*$/, ''));
    if (derived && (!args['project-ref'] || normalizeProjectRef(args['project-ref']) !== derived)) {
      args['project-ref'] = derived;
    }
  }

  const target = resolveCliTarget(operation, args);
  console.log(`OK ${operation} -> ${target.projectRef}`);
});
