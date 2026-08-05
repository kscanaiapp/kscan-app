/**
 * Staging write-target guard for the in-place K Scan AI Staging rebuild.
 *
 * Single choke point for EVERY write-capable operation: migration application,
 * Edge Function deployment, Storage configuration, seed execution, workflow
 * dispatch, scoped schema rebuild, and (later) ZAP target validation.
 *
 * Design rules:
 *   1. The caller must pass an explicit target project reference.
 *   2. The reference is compared against a source-controlled allow-list.
 *   3. The production reference is always rejected for writes.
 *   4. Any reference outside the allow-list is rejected for writes.
 *   5. Writes require the K Scan AI Staging reference specifically.
 *   6. A missing / empty / unresolved reference fails closed.
 *   7. The resolved safe target is printed before the operation proceeds.
 *   8. The target is NEVER inferred from `supabase link` / the linked project.
 *
 * Production is *named* here deliberately: this file is the rejection authority,
 * and read-only parity tooling legitimately needs the production reference.
 */

import fs from 'node:fs';
import path from 'node:path';

import {
  STAGING_PROJECT_REF,
  STAGING_PROJECT_NAME,
  STAGING_PROJECT_URL,
  PROTECTED_TABLES,
} from './staging-v2-project.mjs';

/** Read-only behavioural and structural source of truth. Never a write target. */
export const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

export { STAGING_PROJECT_REF, STAGING_PROJECT_NAME, STAGING_PROJECT_URL, PROTECTED_TABLES };

/** The ONLY project reference any write-capable operation may resolve to. */
export const WRITE_ALLOW_LIST = Object.freeze([STAGING_PROJECT_REF]);

/** Projects that may be read. Production is readable for parity comparison only. */
export const READ_ONLY_ALLOW_LIST = Object.freeze([PRODUCTION_PROJECT_REF, STAGING_PROJECT_REF]);

const PROJECT_REF_RE = /^[a-z]{20}$/;

export class TargetRejectedError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'TargetRejectedError';
    this.code = code;
  }
}

function reject(code, message) {
  throw new TargetRejectedError(message, code);
}

/**
 * Normalize a caller-supplied reference. Accepts a bare ref or a project URL so
 * that callers reading `SUPABASE_URL`-shaped values still fail closed correctly.
 */
export function normalizeProjectRef(value) {
  if (value === null || value === undefined) return '';
  const raw = String(value).trim();
  if (raw === '') return '';
  const urlMatch = raw.match(/^https?:\/\/([a-z]{20})\.supabase\.(co|in)\/?$/i);
  if (urlMatch) return urlMatch[1].toLowerCase();
  return raw.toLowerCase();
}

/**
 * Resolve and authorize a target project reference.
 *
 * @param {object} options
 * @param {string} options.operation      Human-readable operation name (required, for the audit line).
 * @param {string} options.projectRef     Explicit target reference (required; no fallback, no inference).
 * @param {boolean} [options.readOnly]    True for read-only operations (production permitted).
 * @param {(msg: string) => void} [options.logger]
 * @returns {{ projectRef: string, operation: string, readOnly: boolean, url: string }}
 */
export function resolveTarget({ operation, projectRef, readOnly = false, logger = console.log } = {}) {
  if (!operation || typeof operation !== 'string') {
    reject('OPERATION_MISSING', 'Guard misuse: every guarded call must name its operation.');
  }

  const ref = normalizeProjectRef(projectRef);

  // Rule 6 — fail closed on a missing or unresolved reference.
  if (ref === '') {
    reject(
      'TARGET_MISSING',
      `[${operation}] No target project reference supplied. Pass an explicit ref; ` +
        'the linked Supabase project is never used as a fallback.',
    );
  }
  if (!PROJECT_REF_RE.test(ref)) {
    reject(
      'TARGET_UNRESOLVED',
      `[${operation}] Target project reference "${ref}" is not a valid Supabase project ref.`,
    );
  }

  // Rule 3 — production is never a write target.
  if (ref === PRODUCTION_PROJECT_REF && !readOnly) {
    reject(
      'PRODUCTION_WRITE_REJECTED',
      `[${operation}] REFUSED: ${PRODUCTION_PROJECT_REF} is the production project. ` +
        'Production is read-only behavioural and structural authority and must never be written to.',
    );
  }

  if (readOnly) {
    if (!READ_ONLY_ALLOW_LIST.includes(ref)) {
      reject(
        'READ_TARGET_NOT_ALLOWED',
        `[${operation}] REFUSED: ${ref} is not in the read allow-list ` +
          `(${READ_ONLY_ALLOW_LIST.join(', ')}).`,
      );
    }
  } else if (!WRITE_ALLOW_LIST.includes(ref)) {
    // Rules 2, 4, 5 — writes land on K Scan AI Staging or nowhere.
    reject(
      'WRITE_TARGET_NOT_ALLOWED',
      `[${operation}] REFUSED: ${ref} is not the allow-listed staging write target ` +
        `(${WRITE_ALLOW_LIST.join(', ')}).`,
    );
  }

  const resolved = {
    projectRef: ref,
    operation,
    readOnly: Boolean(readOnly),
    url: `https://${ref}.supabase.co`,
  };

  // Rule 7 — always print the safe target before proceeding.
  if (typeof logger === 'function') {
    logger(
      `[guard] ${operation}: ${resolved.readOnly ? 'READ-ONLY' : 'WRITE'} target ${resolved.projectRef} authorized`,
    );
  }

  return resolved;
}

/** Convenience wrapper: authorize a write target or throw. */
export function assertStagingWriteTarget(operation, projectRef, logger) {
  return resolveTarget({ operation, projectRef, readOnly: false, logger });
}

/** Convenience wrapper: authorize a read-only target or throw. */
export function assertReadOnlyTarget(operation, projectRef, logger) {
  return resolveTarget({ operation, projectRef, readOnly: true, logger });
}

/**
 * Destructive-rebuild authority.
 *
 * Deliberately NOT a generic reset command: the target can only ever resolve to
 * the allow-listed staging reference, the confirmation phrase is bound to that
 * reference so it cannot be replayed against another project, and the caller must
 * declare that protected-table evidence has been captured first.
 */
export const RESET_CONFIRMATION_PHRASE = `REBUILD-${STAGING_PROJECT_REF}`;

export function assertRebuildAuthorized({
  projectRef,
  confirmation,
  protectedBackupVerified,
  logger,
} = {}) {
  const resolved = resolveTarget({
    operation: 'staging-scoped-rebuild',
    projectRef,
    readOnly: false,
    logger,
  });
  if (confirmation !== RESET_CONFIRMATION_PHRASE) {
    reject(
      'REBUILD_CONFIRMATION_MISSING',
      `[staging-scoped-rebuild] REFUSED: typed confirmation required (expected "${RESET_CONFIRMATION_PHRASE}").`,
    );
  }
  if (protectedBackupVerified !== true) {
    reject(
      'PROTECTED_BACKUP_UNVERIFIED',
      `[staging-scoped-rebuild] REFUSED: a verified backup of ${PROTECTED_TABLES.join(', ')} ` +
        'must exist before any destructive staging action.',
    );
  }
  return resolved;
}

/**
 * Linked-project safety.
 *
 * Several Supabase CLI database commands — `db push`, `db dump`, `db reset`,
 * `migration list` — accept no `--project-ref` and act on whatever project the
 * working directory is linked to. That makes a stale link an execution hazard
 * independent of anything the caller passes.
 *
 * This is the inverse of the resolveTarget rule and does not contradict it: the
 * link is never used to *choose* a target, only to *veto* one. A directory
 * linked to production cannot run a guarded command at all.
 *
 * Unlinked is safe and permitted: commands that genuinely need a link establish
 * it themselves through runSupabaseLinkedTo, which links to the already-
 * authorized target and verifies the marker before proceeding.
 */
export function readLinkedProjectRef(root = process.cwd()) {
  try {
    return fs.readFileSync(path.join(root, 'supabase', '.temp', 'project-ref'), 'utf8').trim();
  } catch {
    return '';
  }
}

export function assertLinkedProjectSafe({ root, operation = 'guarded-command', linkedRef } = {}) {
  const linked = normalizeProjectRef(
    linkedRef !== undefined ? linkedRef : readLinkedProjectRef(root),
  );

  if (linked === '') return { linked: '', state: 'UNLINKED' };

  if (linked === PRODUCTION_PROJECT_REF) {
    reject(
      'LINKED_PROJECT_IS_PRODUCTION',
      `[${operation}] REFUSED: this directory is linked to production (${PRODUCTION_PROJECT_REF}). ` +
        'Supabase database commands act on the linked project when no --project-ref is accepted, ' +
        'so no guarded command may run here. Unlink it first.',
    );
  }

  if (!WRITE_ALLOW_LIST.includes(linked)) {
    reject(
      'LINKED_PROJECT_NOT_STAGING',
      `[${operation}] REFUSED: this directory is linked to ${linked}, which is not the ` +
        `allow-listed staging project (${WRITE_ALLOW_LIST.join(', ')}).`,
    );
  }

  return { linked, state: 'STAGING' };
}

/**
 * Statement-level protection for the Waitlist and website privacy tables.
 *
 * Applied to any SQL a rebuild step is about to run, so that a hand-written or
 * generated statement cannot drop/truncate/alter a protected table even when the
 * target project itself is correctly authorized.
 */
export function assertDoesNotTouchProtectedTables(sql, { operation = 'sql' } = {}) {
  const text = String(sql || '');
  for (const qualified of PROTECTED_TABLES) {
    const bare = qualified.split('.')[1];
    const namePattern = `(?:public\\.)?"?${bare}"?`;
    const rules = [
      { id: 'DROP', regex: new RegExp(`\\bdrop\\s+table\\s+(?:if\\s+exists\\s+)?${namePattern}`, 'i') },
      { id: 'TRUNCATE', regex: new RegExp(`\\btruncate\\s+(?:table\\s+)?${namePattern}`, 'i') },
      { id: 'DELETE', regex: new RegExp(`\\bdelete\\s+from\\s+${namePattern}`, 'i') },
      { id: 'ALTER', regex: new RegExp(`\\balter\\s+table\\s+(?:if\\s+exists\\s+)?${namePattern}`, 'i') },
      { id: 'UPDATE', regex: new RegExp(`\\bupdate\\s+${namePattern}\\s+set\\b`, 'i') },
    ];
    for (const rule of rules) {
      if (rule.regex.test(text)) {
        reject(
          'PROTECTED_TABLE_TOUCHED',
          `[${operation}] REFUSED: statement performs ${rule.id} on protected table ${qualified}. ` +
            'Waitlist and website privacy data must remain untouched.',
        );
      }
    }
  }
  return true;
}
