#!/usr/bin/env node
// Governed invoker for the staging orphan-owner media reconciler (B34-BE-STO-001).
//
// WHY THIS EXISTS. `reconcile-orphan-media` (B33-STO-002) was deployed to staging
// secret-gated, dry-run by default and fail-closed -- but nothing ever called it,
// which left the orphan inventory unobserved: the same "correct worker, no
// invoker" defect class as the watchlist sweep and the deletion worker. This
// script is the one caller, run by .github/workflows/staging-orphan-media-reconciler.yml.
//
// DRY-RUN ONLY, BY CONSTRUCTION. This invoker has no live mode, no input that
// selects one, and nothing it sends can select one: the function reads no request
// body, and its mode comes only from server-side switches
// (app_config.orphan_media_sweep_enabled, app_config.orphan_media_sweep_dry_run,
// and the ORPHAN_MEDIA_SWEEP_DRY_RUN function secret). The invoker then REFUSES any
// response that is not a dry run with the kill switch off, so a server-side change
// that arms deletion turns every scheduled run red instead of passing silently.
//
// DELIBERATELY NARROW, like the staging deletion worker:
//   * the project ref and function slug are literals, not inputs;
//   * the production ref is an explicit deny checked before any request is built;
//   * the only credential is ORPHAN_MEDIA_SWEEP_SECRET, sent as a header and never
//     printed; the anon/publishable key is not used and is rejected by the function;
//   * only a sanitized projection (mode, flags, counts, byte total) is emitted --
//     never an object path, owner id, or raw response body.
//
// Usage (CI): ORPHAN_MEDIA_SWEEP_SECRET=... node scripts/invoke-orphan-media-reconciler.mjs [--summary-file <path>]
//
// Exit codes:
//   0  dry run completed and every invariant held
//   1  configuration refused (missing secret, wrong target) -- no request was sent
//   2  transport failure, non-200 status, or unparseable/invalid response
//   3  DRY-RUN INVARIANT VIOLATED -- the function reported a live or armed sweep

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export const STAGING_REF = 'yzqjvdfgefveprobvvyw';
export const PRODUCTION_REF = 'wyyuqfdxucjksghsmhry';
export const FUNCTION_SLUG = 'reconcile-orphan-media';
export const REQUEST_TIMEOUT_MS = 120_000;

export const EXIT = Object.freeze({ OK: 0, CONFIG: 1, RESPONSE: 2, INVARIANT: 3 });

export class InvokerError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'InvokerError';
    this.exitCode = code;
  }
}

export function targetUrl(ref = STAGING_REF) {
  if (ref === PRODUCTION_REF) {
    throw new InvokerError(EXIT.CONFIG, 'Target ref is the production project. Refusing.');
  }
  if (ref !== STAGING_REF) {
    throw new InvokerError(EXIT.CONFIG, 'Unrecognised target project ref. Refusing.');
  }
  return `https://${ref}.supabase.co/functions/v1/${FUNCTION_SLUG}`;
}

function isCount(value) {
  return Number.isSafeInteger(value) && value >= 0;
}

// Validates the reconciler's response and returns the only fields ever reported.
// Any deviation from "dry run, kill switch off, zero removals" is an invariant
// violation, distinct from an ordinary malformed response.
export function projectDryRunResponse(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new InvokerError(EXIT.RESPONSE, 'Reconciler response was not a JSON object.');
  }
  const armed =
    body.mode !== 'dry_run' ||
    body.dryRun !== true ||
    body.killSwitchEnabled !== false ||
    Object.prototype.hasOwnProperty.call(body, 'removed');
  if (armed) {
    const removed = isCount(body.removed) ? body.removed : null;
    throw new InvokerError(
      EXIT.INVARIANT,
      `DRY-RUN INVARIANT VIOLATED: mode=${String(body.mode)} dryRun=${String(body.dryRun)} ` +
        `killSwitchEnabled=${String(body.killSwitchEnabled)} removed=${removed === null ? 'n/a' : removed}. ` +
        'Set app_config.orphan_media_sweep_enabled to false and investigate before the next run.',
    );
  }
  for (const key of ['candidateCount', 'distinctOwners', 'totalBytes']) {
    if (!isCount(body[key])) {
      throw new InvokerError(EXIT.RESPONSE, `Reconciler response field ${key} is not a non-negative integer.`);
    }
  }
  if (typeof body.hasMore !== 'boolean') {
    throw new InvokerError(EXIT.RESPONSE, 'Reconciler response field hasMore is not a boolean.');
  }
  return {
    mode: 'dry_run',
    dryRun: true,
    killSwitchEnabled: false,
    candidateCount: body.candidateCount,
    distinctOwners: body.distinctOwners,
    totalBytes: body.totalBytes,
    hasMore: body.hasMore,
    objectsDeleted: 0,
  };
}

export async function invokeReconciler({
  secret,
  ref = STAGING_REF,
  fetchImpl = globalThis.fetch,
  timeoutMs = REQUEST_TIMEOUT_MS,
} = {}) {
  // Target first: a production ref is refused even when no secret is present.
  const url = targetUrl(ref);
  if (typeof secret !== 'string' || secret.trim() === '') {
    throw new InvokerError(EXIT.CONFIG, 'ORPHAN_MEDIA_SWEEP_SECRET is not set. Refusing to invoke.');
  }

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-orphan-sweep-secret': secret.trim(),
      },
      // The function ignores the body; it is empty so no caller-side contract is implied.
      body: '{}',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    throw new InvokerError(EXIT.RESPONSE, `Reconciler invocation failed at the transport layer (${error?.name ?? 'Error'}).`);
  }

  // The body of a non-200 response is never read into the log: an error body from
  // an authenticated internal endpoint is not guaranteed to be free of detail.
  if (response.status !== 200) {
    throw new InvokerError(EXIT.RESPONSE, `Reconciler returned HTTP ${response.status}.`);
  }

  let body;
  try {
    body = await response.json();
  } catch {
    throw new InvokerError(EXIT.RESPONSE, 'Reconciler response was not valid JSON.');
  }
  return { httpStatus: response.status, ...projectDryRunResponse(body) };
}

function parseArgs(argv) {
  const args = { summaryFile: null };
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--summary-file' && argv[i + 1]) {
      args.summaryFile = argv[i + 1];
      i += 1;
    } else {
      throw new InvokerError(EXIT.CONFIG, `Unknown argument: ${argv[i]}`);
    }
  }
  return args;
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  try {
    const { summaryFile } = parseArgs(argv);
    const summary = await invokeReconciler({ secret: env.ORPHAN_MEDIA_SWEEP_SECRET });
    const line = JSON.stringify(summary);
    console.log(line);
    if (summaryFile) fs.writeFileSync(summaryFile, `${JSON.stringify(summary, null, 2)}\n`);
    return EXIT.OK;
  } catch (error) {
    if (error instanceof InvokerError) {
      console.error(`::error::${error.message}`);
      return error.exitCode;
    }
    console.error(`::error::Unexpected invoker failure (${error?.name ?? 'Error'}).`);
    return EXIT.RESPONSE;
  }
}

function isEntrypoint() {
  try {
    return Boolean(process.argv[1]) && fileURLToPath(import.meta.url) === fs.realpathSync(process.argv[1]);
  } catch {
    return false;
  }
}

if (isEntrypoint()) {
  process.exitCode = await main();
}
