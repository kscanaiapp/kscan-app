/**
 * Staging v2 write-target guard.
 *
 * Single choke point for EVERY write-capable operation in the Staging v2 rebuild:
 * migration application, Edge Function deployment, Storage configuration, seed
 * execution, workflow dispatch, project reset, and (later) ZAP target validation.
 *
 * Design rules (Phase 1, Step 1):
 *   1. The caller must pass an explicit target project reference.
 *   2. The reference is compared against a source-controlled allow-list.
 *   3. The production reference is always rejected for writes.
 *   4. The old staging reference is rejected for writes; read-only is permitted.
 *   5. Writes require the Staging v2 reference specifically.
 *   6. A missing / empty / unresolved reference fails closed.
 *   7. The resolved safe target is printed before the operation proceeds.
 *   8. The target is NEVER inferred from `supabase link` / the linked project.
 *
 * Production may still be *named* here: this file is the rejection authority, and
 * read-only comparison tooling legitimately needs the production reference.
 */

/** Read-only behavioural and structural source of truth. Never a write target. */
export const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';

/** Preserved reference project. Read-only only; never a write target, never reset. */
export const OLD_STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';

/**
 * K Scan AI Staging v2. Populated by scripts/lib/staging-v2-project.json once the
 * project exists so that the allow-list stays reviewable in source control.
 */
import { STAGING_V2_PROJECT_REF } from './staging-v2-project.mjs';

export { STAGING_V2_PROJECT_REF };

/** The ONLY project references any write-capable operation may resolve to. */
export const WRITE_ALLOW_LIST = Object.freeze(
  [STAGING_V2_PROJECT_REF].filter((ref) => typeof ref === 'string' && ref.length > 0),
);

/** Projects that may be read but never written. */
export const READ_ONLY_ALLOW_LIST = Object.freeze([
  PRODUCTION_PROJECT_REF,
  OLD_STAGING_PROJECT_REF,
  ...WRITE_ALLOW_LIST,
]);

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
 * @param {boolean} [options.readOnly]    True for read-only operations (production/old staging permitted).
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

  // Rule 4 — old staging is preserved; read-only access only.
  if (ref === OLD_STAGING_PROJECT_REF && !readOnly) {
    reject(
      'OLD_STAGING_WRITE_REJECTED',
      `[${operation}] REFUSED: ${OLD_STAGING_PROJECT_REF} is the preserved old staging project. ` +
        'It is retained as a reference and must not be modified.',
    );
  }

  if (readOnly) {
    if (!READ_ONLY_ALLOW_LIST.includes(ref)) {
      reject(
        'READ_TARGET_NOT_ALLOWED',
        `[${operation}] REFUSED: ${ref} is not in the read allow-list ` +
          `(${READ_ONLY_ALLOW_LIST.join(', ') || 'empty'}).`,
      );
    }
  } else {
    // Rule 5 + Rule 2 — writes must land on an allow-listed Staging v2 reference.
    if (WRITE_ALLOW_LIST.length === 0) {
      reject(
        'WRITE_ALLOW_LIST_EMPTY',
        `[${operation}] REFUSED: the Staging v2 write allow-list is empty. ` +
          'Populate scripts/lib/staging-v2-project.mjs with the created project reference first.',
      );
    }
    if (!WRITE_ALLOW_LIST.includes(ref)) {
      reject(
        'WRITE_TARGET_NOT_ALLOWED',
        `[${operation}] REFUSED: ${ref} is not an allow-listed Staging v2 write target ` +
          `(${WRITE_ALLOW_LIST.join(', ')}).`,
      );
    }
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
export function assertStagingV2WriteTarget(operation, projectRef, logger) {
  return resolveTarget({ operation, projectRef, readOnly: false, logger });
}

/** Convenience wrapper: authorize a read-only target or throw. */
export function assertReadOnlyTarget(operation, projectRef, logger) {
  return resolveTarget({ operation, projectRef, readOnly: true, logger });
}

/**
 * Destructive-reset authority. Deliberately narrower than a generic reset command:
 * it can only ever resolve to Staging v2, and additionally demands typed confirmation.
 */
export const RESET_CONFIRMATION_PHRASE = 'RESET-STAGING-V2';

export function assertResetAuthorized({ projectRef, confirmation, logger } = {}) {
  const resolved = resolveTarget({
    operation: 'staging-v2-reset',
    projectRef,
    readOnly: false,
    logger,
  });
  if (confirmation !== RESET_CONFIRMATION_PHRASE) {
    reject(
      'RESET_CONFIRMATION_MISSING',
      `[staging-v2-reset] REFUSED: typed confirmation required (expected "${RESET_CONFIRMATION_PHRASE}").`,
    );
  }
  return resolved;
}
