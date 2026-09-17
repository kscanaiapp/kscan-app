/**
 * Shared helpers for PRODUCTION deployment scripts (Node ESM, built-ins only).
 *
 * Mirrors scripts/lib/staging-helpers.mjs with the guard direction inverted:
 * staging tooling refuses to let a production reference reach the Supabase
 * CLI, this tooling refuses to let a staging reference reach it. Everything
 * environment-agnostic (migration filename parsing, SQL pattern scanning,
 * JSON/ledger parsing, artifact writers, git helpers) is deliberately NOT
 * duplicated here -- it is imported straight from staging-helpers.mjs, which
 * despite its name has no staging-specific behavior in those functions. A
 * forked copy of migration-reconciliation logic in particular is exactly the
 * kind of drift a "governed backend authority" is supposed to prevent.
 */

import { runWinSafe } from './win-safe-exec.mjs';
import {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_URL,
  PRODUCTION_URL,
  REQUIRED_PRODUCTION_VARS,
} from './staging-constants.mjs';
import { decodeJwtClaims, redactKeyFingerprint } from './staging-helpers.mjs';

export class ProductionGuardError extends Error {
  constructor(message) {
    super(message);
    this.name = 'ProductionGuardError';
  }
}

export function assertProductionTarget({
  projectRef = process.env.SUPABASE_PRODUCTION_PROJECT_REF,
  url = process.env.SUPABASE_PRODUCTION_URL,
  anonKey = process.env.SUPABASE_PRODUCTION_ANON_KEY,
} = {}) {
  const ref = (projectRef || '').trim();
  const productionUrl = (url || '').trim();
  const key = (anonKey || '').trim();

  if (!ref) throw new ProductionGuardError('SUPABASE_PRODUCTION_PROJECT_REF is absent');
  if (ref === STAGING_PROJECT_REF) {
    throw new ProductionGuardError('Production project ref equals staging — refusing');
  }
  if (ref !== PRODUCTION_PROJECT_REF) {
    throw new ProductionGuardError(`Production project ref must be ${PRODUCTION_PROJECT_REF}, got ${ref}`);
  }

  if (!productionUrl) throw new ProductionGuardError('SUPABASE_PRODUCTION_URL is absent');
  if (productionUrl.includes(STAGING_PROJECT_REF) || productionUrl === STAGING_URL) {
    throw new ProductionGuardError('SUPABASE_PRODUCTION_URL points at staging — refusing');
  }
  if (!productionUrl.includes(PRODUCTION_PROJECT_REF)) {
    throw new ProductionGuardError('SUPABASE_PRODUCTION_URL does not contain expected production project ref');
  }

  if (!key) throw new ProductionGuardError('SUPABASE_PRODUCTION_ANON_KEY is absent');
  const claims = decodeJwtClaims(key);
  if (claims) {
    if (claims.ref && claims.ref !== PRODUCTION_PROJECT_REF) {
      throw new ProductionGuardError(
        `Anon key JWT ref claim is ${claims.ref}, expected ${PRODUCTION_PROJECT_REF}`,
      );
    }
    if (claims.role === 'service_role') {
      throw new ProductionGuardError('Service-role key supplied where anon/publishable expected');
    }
  }

  return {
    projectRef: PRODUCTION_PROJECT_REF,
    url: PRODUCTION_URL,
    anonKeyFingerprint: redactKeyFingerprint(key),
  };
}

export function missingRequiredProductionVars(env = process.env, required = REQUIRED_PRODUCTION_VARS) {
  return required.filter((name) => !env[name] || String(env[name]).trim() === '');
}

/**
 * Refuses any Supabase CLI invocation whose argv names the staging project.
 * Symmetric to staging-helpers.mjs's assertNoProductionRef: this tooling only
 * ever builds arguments from PRODUCTION_PROJECT_REF, so nothing legitimate
 * reaches this guard. What it stops is a staging reference arriving through
 * data rather than through code -- an operator-supplied FUNCTION_NAME, a
 * deployment manifest handed to the rollback script, a MIGRATION_FILE path.
 */
function assertNoStagingRef(args) {
  const offending = args.findIndex(
    (arg) => typeof arg === 'string' && arg.includes(STAGING_PROJECT_REF),
  );
  if (offending !== -1) {
    throw new ProductionGuardError(
      `Refusing to invoke the Supabase CLI: argument ${offending} names the staging ` +
        `project (${STAGING_PROJECT_REF}). This tooling targets production only.`,
    );
  }
}

/** Same invocation contract as staging's runSupabase(): real argv, no shell. */
export function runSupabaseProduction(args, { cwd = process.cwd() } = {}) {
  assertNoStagingRef(args);
  return runWinSafe('supabase', args, { cwd });
}

export {
  STAGING_PROJECT_REF,
  PRODUCTION_PROJECT_REF,
  STAGING_URL,
  PRODUCTION_URL,
  REQUIRED_PRODUCTION_VARS,
};
