/**
 * Shared CLI plumbing for guarded Staging v2 operations.
 *
 * Every write-capable entry point in scripts/staging-v2/ resolves its target
 * through this module, which in turn resolves through staging-v2-guard.mjs.
 * There is deliberately no other path to a target reference: no env fallback to
 * a "current" project, no `supabase link` inspection, no default.
 */

import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { resolveTarget, TargetRejectedError, assertLinkedProjectSafe } from './staging-v2-guard.mjs';

/** Parse `--key value` / `--key=value` / `--flag` argv into a plain object. */
export function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token.startsWith('--')) {
      out._.push(token);
      continue;
    }
    const body = token.slice(2);
    const eq = body.indexOf('=');
    if (eq !== -1) {
      out[body.slice(0, eq)] = body.slice(eq + 1);
      continue;
    }
    const next = argv[i + 1];
    if (next !== undefined && !next.startsWith('--')) {
      out[body] = next;
      i += 1;
    } else {
      out[body] = true;
    }
  }
  return out;
}

/**
 * Resolve the target project reference for a guarded operation.
 *
 * Precedence is explicit-only: `--project-ref`, then the pre-existing
 * SUPABASE_STAGING_PROJECT_REF variable (kept under its established name — this
 * rebuild renames nothing). Both are validated against the source-controlled
 * allow-list, so a wrong value fails closed rather than widening authority. The
 * linked Supabase project is never consulted.
 */
export function resolveCliTarget(operation, args, { readOnly = false } = {}) {
  const explicit =
    (typeof args['project-ref'] === 'string' ? args['project-ref'] : '') ||
    process.env.SUPABASE_STAGING_PROJECT_REF ||
    '';
  return resolveTarget({ operation, projectRef: explicit, readOnly });
}

/**
 * Run a guarded entry point, converting guard rejections into exit code 2.
 *
 * Before the operation runs, the working directory's Supabase link is checked.
 * Commands like `db push` / `db dump` / `db reset` take no `--project-ref` and
 * act on the linked project, so a directory linked to production is refused
 * outright — the link can veto a target, never choose one.
 */
export async function runGuarded(operation, main, { root } = {}) {
  try {
    // The spawned `supabase` process inherits this cwd, so cwd is what the CLI
    // will actually resolve a link from. The script's own repo root is checked
    // too when it differs, since that is where supabase/.temp lives for a script
    // invoked by absolute path from elsewhere.
    const dirs = new Set([process.cwd()]);
    if (root) dirs.add(root);
    for (const dir of dirs) assertLinkedProjectSafe({ root: dir, operation });
    await main();
  } catch (err) {
    if (err instanceof TargetRejectedError) {
      console.error(`GUARD_REJECTED ${err.code}: ${err.message}`);
      process.exit(2);
    }
    console.error(`${operation} failed: ${err && err.message ? err.message : err}`);
    process.exit(1);
  }
}

function runSupabase(argv, { stdio = 'pipe' } = {}) {
  const result = spawnSync('supabase', argv, {
    encoding: 'utf8',
    stdio,
    shell: process.platform === 'win32',
    env: process.env,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`supabase ${argv.join(' ')} exited ${result.status}\n${detail}`);
  }
  return result.stdout || '';
}

/**
 * Invoke the Supabase CLI with an explicit `--project-ref`.
 *
 * `--project-ref` is appended by this helper from an already-guarded target, so a
 * caller cannot accidentally omit it and fall through to the linked project.
 */
export function runSupabaseForTarget(target, argv, { stdio = 'pipe' } = {}) {
  if (!target || !target.projectRef) {
    throw new Error('runSupabaseForTarget called without a guarded target');
  }
  return runSupabase([...argv, '--project-ref', target.projectRef], { stdio });
}

/**
 * Invoke a Supabase CLI command that only accepts `--linked` (notably `db push`,
 * which has no `--project-ref` flag).
 *
 * The link is *constrained by* the guarded target, never a source of it: the
 * project is linked to the already-authorized reference, the on-disk link marker
 * is then read back and asserted to equal that reference, and the command runs
 * only if they match. A pre-existing link to any other project — production
 * included — is overwritten by the authorized target rather than honoured, and a
 * link that fails to settle on the guarded reference aborts the operation.
 */
export function runSupabaseLinkedTo(target, argv, { stdio = 'pipe', root } = {}) {
  if (!target || !target.projectRef) {
    throw new Error('runSupabaseLinkedTo called without a guarded target');
  }

  runSupabase(['link', '--project-ref', target.projectRef, '--yes']);

  const markerPath = path.join(root || process.cwd(), 'supabase', '.temp', 'project-ref');
  let linked = '';
  try {
    linked = fs.readFileSync(markerPath, 'utf8').trim();
  } catch {
    throw new Error(`Could not read the link marker at ${markerPath}; refusing to run ${argv[0]}.`);
  }
  if (linked !== target.projectRef) {
    throw new Error(
      `LINK_MISMATCH: linked project is ${linked} but the authorized target is ${target.projectRef}. Refusing.`,
    );
  }
  console.log(`[guard] link verified: ${linked} === authorized target`);

  return runSupabase([...argv, '--linked'], { stdio });
}
