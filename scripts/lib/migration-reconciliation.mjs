/**
 * Governed migration reconciliation authority.
 *
 * This module owns the vocabulary and the validation for
 *   config/migration-authority-manifest.json -> ledgerReconciliation
 * and the single place that decides which migration (if any) an invocation is
 * allowed to execute.
 *
 * WHY THIS EXISTS
 *
 * Comparing bare version strings between the local migration tree and a remote
 * ledger reports three very different things as one undifferentiated "drift":
 *
 *   1. a version whose EFFECT IS ALREADY PRESENT under a different ledger
 *      identity (renumber, consolidation, supersession) -- `reconciled`
 *   2. a ledger row the local tree does not carry at all -- `remoteOnly`
 *   3. a version whose effect is GENUINELY ABSENT and which is deliberately
 *      not applied yet -- `knownPending`
 *
 * Staging happens to have converged, so (3) never arises there and the gate can
 * demand "exactly one pending migration". Production has not converged and is
 * not supposed to: it is intentionally many Build 34 migrations behind, and
 * those migrations are legitimate, known, and must NOT execute automatically.
 * Case (3) previously had no truthful representation, which is why the only way
 * to make the gate pass was to lie about case (1).
 *
 * SAFETY MODEL -- the reason this file is small and boring on purpose:
 *
 *   * A declaration is DOCUMENTATION OF REALITY, never a licence to execute.
 *     `knownPending` explains why a version is legitimately unapplied; it never
 *     makes it executable.
 *   * Execution needs a SEPARATE, EXPLICIT approval of that exact version, and
 *     only KNOWN_FUTURE_UNAPPLIED is approvable at all: HOLD and EXCLUDE are
 *     known but permanently non-executable through this path.
 *   * Anything NOT declared here is still unexplained drift and still fails.
 *     An environment with no declarations (production before this change, and
 *     every unknown ref) keeps the original strict behaviour.
 *   * A declaration that has rotted -- names a version that no longer exists,
 *     claims a remote row twice, says "pending" about a version the ledger
 *     already holds -- is a BLOCKER, not a licence.
 */

import fs from 'node:fs';
import path from 'node:path';

/** Classifications valid on `reconciled[]`: the effect is ALREADY PRESENT. */
export const VALID_RECONCILIATION_CLASSIFICATIONS = new Set([
  'EXACT_CONTENT_RENUMBER',
  'EQUIVALENT_RENUMBER',
  'CONSOLIDATED_IN_REMOTE',
  'SUPERSEDED_BY_LATER_MIGRATION',
]);

/**
 * A ledger row whose effect is proven ABSENT and whose migration must never be
 * replayed or carried into source (B34-BE-GOV-004). Nothing local stands in for
 * it, which is why it is not a `reconciled` classification.
 */
export const OBSOLETE_REMOTE_ONLY = 'OBSOLETE_REMOTE_ONLY';

/**
 * A ledger row that is legitimately present in THIS environment's own history
 * and has no governed local file -- an environment-specific convergence or
 * hardening applied directly, or a migration whose only copy is deliberately
 * held outside the governed tree. Its effect is present and intended. Unlike
 * OBSOLETE_REMOTE_ONLY it is not a defect to be cleaned up; it is history to be
 * preserved. Neither classification licences any execution.
 */
export const PRODUCTION_ONLY_HISTORICAL = 'PRODUCTION_ONLY_HISTORICAL';

export const VALID_REMOTE_ONLY_CLASSIFICATIONS = new Set([
  OBSOLETE_REMOTE_ONLY,
  PRODUCTION_ONLY_HISTORICAL,
]);

/**
 * KNOWN FUTURE MIGRATION -- DELIBERATELY UNAPPLIED.
 *
 * The effect is genuinely absent from this environment. The migration is known,
 * legitimate, governed Build 34 work. It is NOT drift, and it is NOT executable
 * on that basis: it becomes executable only when that exact version is supplied
 * as the approved migration for one controlled invocation.
 *
 * This is deliberately NOT expressed as SUPERSEDED_BY_LATER_MIGRATION or any
 * other `reconciled` classification, because those all assert "no execution is
 * needed", and here execution IS still needed -- just not yet, and never
 * automatically.
 */
export const KNOWN_FUTURE_UNAPPLIED = 'KNOWN_FUTURE_UNAPPLIED';

/** Known and classified, but not cleared for execution at this authority SHA. */
export const HOLD = 'HOLD';

/** Known, and must NEVER execute against this environment. */
export const EXCLUDE = 'EXCLUDE';

export const VALID_KNOWN_PENDING_DISPOSITIONS = new Set([
  KNOWN_FUTURE_UNAPPLIED,
  HOLD,
  EXCLUDE,
]);

/**
 * The ONLY disposition an explicitly approved migration may carry. HOLD and
 * EXCLUDE are known, documented, and still refused.
 */
export const APPROVABLE_DISPOSITIONS = new Set([KNOWN_FUTURE_UNAPPLIED]);

const EMPTY_AUTHORITY = Object.freeze({
  reconciled: [],
  knownPending: [],
  genuinelyUnapplied: [],
  remoteOnly: [],
});

/**
 * Loads the reconciliation authority for one project ref.
 * An unknown ref resolves to an empty authority, so the gate keeps its original
 * strict behaviour wherever nothing was ever proven.
 *
 * @param {string} projectRef
 * @param {string} [manifestPath]
 */
export function loadLedgerReconciliation(projectRef, manifestPath) {
  const file =
    manifestPath || path.join(process.cwd(), 'config', 'migration-authority-manifest.json');
  if (!fs.existsSync(file)) return { ...EMPTY_AUTHORITY };
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (err) {
    throw new Error(`migration authority manifest is unparseable: ${err.message}`);
  }
  const env = manifest?.ledgerReconciliation?.environments?.[projectRef];
  if (!env) return { ...EMPTY_AUTHORITY };
  if (env.remoteOnly !== undefined && !Array.isArray(env.remoteOnly)) {
    throw new Error('migration authority manifest remoteOnly must be an array');
  }
  if (env.knownPending !== undefined && !Array.isArray(env.knownPending)) {
    throw new Error('migration authority manifest knownPending must be an array');
  }
  return {
    reconciled: Array.isArray(env.reconciled) ? env.reconciled : [],
    knownPending: Array.isArray(env.knownPending) ? env.knownPending : [],
    genuinelyUnapplied: Array.isArray(env.genuinelyUnapplied) ? env.genuinelyUnapplied : [],
    remoteOnly: env.remoteOnly ?? [],
  };
}

/**
 * Validates the declared reconciliation against the real local tree and the real
 * remote ledger. A declaration that has rotted (names a version that no longer
 * exists on either side, claims a remote row twice, contradicts itself, or carries
 * an unknown classification) is a blocker, not a licence.
 */
export function validateReconciliation(reconciled, localSet, remoteSet) {
  const problems = [];
  const aliasedLocal = new Map();
  const claimedRemote = new Map();

  for (const item of reconciled) {
    const label = `${item?.localVersion ?? '(no localVersion)'} (${item?.logicalName ?? 'unnamed'})`;

    if (!item || typeof item.localVersion !== 'string' || !item.localVersion) {
      problems.push(`reconciliation entry ${label}: localVersion is missing`);
      continue;
    }
    if (!VALID_RECONCILIATION_CLASSIFICATIONS.has(item.classification)) {
      problems.push(`reconciliation entry ${label}: unknown classification "${item.classification}"`);
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      problems.push(`reconciliation entry ${label}: evidence is required`);
    }
    if (!localSet.has(item.localVersion)) {
      problems.push(
        `reconciliation entry ${label}: localVersion is not present in supabase/migrations — stale authority`,
      );
    }
    if (aliasedLocal.has(item.localVersion)) {
      problems.push(`reconciliation entry ${label}: localVersion declared more than once`);
    } else {
      aliasedLocal.set(item.localVersion, item);
    }

    const remoteVersions = Array.isArray(item.remoteVersions) ? item.remoteVersions : [];
    if (remoteVersions.length === 0 && item.classification !== 'SUPERSEDED_BY_LATER_MIGRATION') {
      problems.push(
        `reconciliation entry ${label}: only SUPERSEDED_BY_LATER_MIGRATION may declare no remoteVersions`,
      );
    }
    for (const remoteVersion of remoteVersions) {
      if (!remoteSet.has(remoteVersion)) {
        problems.push(
          `reconciliation entry ${label}: claims remote version ${remoteVersion}, which the remote ledger does not contain — stale authority`,
        );
        continue;
      }
      if (claimedRemote.has(remoteVersion)) {
        problems.push(
          `reconciliation entry ${label}: remote version ${remoteVersion} is already claimed by ${claimedRemote.get(remoteVersion)}`,
        );
      } else {
        claimedRemote.set(remoteVersion, label);
      }
    }
  }

  return { problems, aliasedLocal, claimedRemote };
}

/**
 * Validates declaration-only remote exclusions against the real local tree, the
 * real remote ledger, and the `reconciled` claims. An exclusion is accepted only
 * when it carries a valid remote-only classification, a name and evidence, names
 * a version the remote ledger really holds, names a version NO local file carries
 * (otherwise it is not remote-only), and is not also claimed by a reconciliation.
 * Anything else is a blocker, never a licence.
 */
export function validateRemoteOnlyExclusions(remoteOnly, localSet, remoteSet, claimedRemote) {
  const problems = [];
  const excludedRemote = new Map();

  for (const item of remoteOnly) {
    const label = `${item?.remoteVersion ?? '(no remoteVersion)'} (${item?.logicalName ?? 'unnamed'})`;
    if (!item || typeof item.remoteVersion !== 'string' || !/^\d{14}$/.test(item.remoteVersion)) {
      problems.push(`remote-only exclusion ${label}: remoteVersion must be a 14-digit version`);
      continue;
    }
    if (!VALID_REMOTE_ONLY_CLASSIFICATIONS.has(item.classification)) {
      problems.push(
        `remote-only exclusion ${label}: classification must be ${OBSOLETE_REMOTE_ONLY} or ${PRODUCTION_ONLY_HISTORICAL}, got "${item.classification}"`,
      );
    }
    if (typeof item.logicalName !== 'string' || item.logicalName.trim() === '') {
      problems.push(`remote-only exclusion ${label}: logicalName is required`);
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      problems.push(`remote-only exclusion ${label}: evidence is required`);
    }
    if (!remoteSet.has(item.remoteVersion)) {
      problems.push(
        `remote-only exclusion ${label}: the remote ledger does not contain it — stale authority`,
      );
    }
    if (localSet.has(item.remoteVersion)) {
      problems.push(
        `remote-only exclusion ${label}: a local migration carries this version, so it is not remote-only`,
      );
    }
    if (claimedRemote.has(item.remoteVersion)) {
      problems.push(
        `remote-only exclusion ${label}: also claimed by reconciliation ${claimedRemote.get(item.remoteVersion)}`,
      );
    }
    if (excludedRemote.has(item.remoteVersion)) {
      problems.push(`remote-only exclusion ${label}: declared more than once`);
    } else {
      excludedRemote.set(item.remoteVersion, item);
    }
  }

  return { problems, excludedRemote };
}

/**
 * Validates `knownPending[]`.
 *
 * A known-pending declaration says "this local version is genuinely unapplied
 * here, and that is expected". It is a lie -- and a blocker -- if a `reconciled`
 * entry simultaneously claims the effect is already present.
 *
 * THE LIFECYCLE, and why it is asymmetric
 *
 * A production migration campaign applies one approved migration at a time, over
 * days. If a KNOWN_FUTURE_UNAPPLIED entry became "stale authority" the moment its
 * version landed in the remote ledger, every successful migration would invalidate
 * the manifest and require a source edit before the next one could run. Editing
 * governed authority between every production write is worse than the problem it
 * would solve, so a KNOWN_FUTURE_UNAPPLIED entry has two legitimate states:
 *
 *   STATE A  version absent from the ledger   -> KNOWN_PENDING (approvable)
 *   STATE B  that exact version now present   -> FULFILLED
 *
 * A FULFILLED entry stops being pending, is never selected again, does not fail
 * the gate, stays visible in reporting, and lets the next migration be approved --
 * with the manifest untouched.
 *
 * This tolerance is deliberately NOT extended to HOLD or EXCLUDE. Those say the
 * migration must not run here. If one of them turns up in the ledger anyway,
 * something applied it outside this gate, which is exactly the unexplained
 * production mutation the whole authority exists to catch. That fails closed.
 */
export function validateKnownPending(knownPending, localSet, remoteSet, aliasedLocal) {
  const problems = [];
  const declaredPending = new Map();
  const fulfilled = new Map();
  const seen = new Set();

  for (const item of knownPending) {
    const label = `${item?.localVersion ?? '(no localVersion)'} (${item?.logicalName ?? 'unnamed'})`;

    if (!item || typeof item.localVersion !== 'string' || !item.localVersion) {
      problems.push(`known-pending entry ${label}: localVersion is missing`);
      continue;
    }
    if (!VALID_KNOWN_PENDING_DISPOSITIONS.has(item.disposition)) {
      problems.push(
        `known-pending entry ${label}: disposition must be one of ${[...VALID_KNOWN_PENDING_DISPOSITIONS].join(', ')}, got "${item.disposition}"`,
      );
    }
    if (typeof item.logicalName !== 'string' || item.logicalName.trim() === '') {
      problems.push(`known-pending entry ${label}: logicalName is required`);
    }
    if (typeof item.evidence !== 'string' || item.evidence.trim() === '') {
      problems.push(`known-pending entry ${label}: evidence is required`);
    }
    if (!localSet.has(item.localVersion)) {
      problems.push(
        `known-pending entry ${label}: localVersion is not present in supabase/migrations — stale authority`,
      );
    }
    if (aliasedLocal.has(item.localVersion)) {
      problems.push(
        `known-pending entry ${label}: also declared reconciled, which asserts its effect is already present — contradictory authority`,
      );
    }
    if (seen.has(item.localVersion)) {
      problems.push(`known-pending entry ${label}: declared more than once`);
      continue;
    }
    seen.add(item.localVersion);

    const presentRemotely = remoteSet.has(item.localVersion);
    if (presentRemotely && item.disposition !== KNOWN_FUTURE_UNAPPLIED) {
      // HOLD / EXCLUDE must never be present. Something applied it outside this
      // gate. Fail closed and say so plainly.
      problems.push(
        `known-pending entry ${label}: declared ${item.disposition}, which must never be applied here, but the remote ledger contains it — unexplained production mutation`,
      );
      continue;
    }

    if (presentRemotely) {
      fulfilled.set(item.localVersion, item);
    } else {
      declaredPending.set(item.localVersion, item);
    }
  }

  return { problems, declaredPending, fulfilled };
}

/**
 * The CREDENTIAL-FREE half of the approval decision.
 *
 * Everything here is answerable from the local tree and the declared authority
 * alone -- no production credentials, no remote ledger read. It exists so the
 * pre-approval preflight can show a reviewer exactly which migration is being
 * proposed, and refuse an obviously illegitimate one, WITHOUT holding
 * production credentials outside the `environment: production` gate.
 *
 * What it deliberately CANNOT decide, and must never imply it has:
 *   - whether the version is already applied on production
 *   - whether the pending set is what the authority expects
 *   - whether unexplained remote drift exists
 *
 * Those need the live ledger, so they stay in resolveApprovedMigration(), which
 * the applier runs inside the environment gate immediately before the write.
 * This check narrows what can reach that gate; it never substitutes for it.
 *
 * @returns {{ok: boolean, blockers: string[], disposition: string|null, migration: object|null}}
 */
export function staticApprovalCheck({ local, approvedVersion, reconciliation }) {
  const blockers = [];
  const version = String(approvedVersion || '').trim();
  const push = (reason) => blockers.push(`APPROVED_MIGRATION_VERSION=${version} ${reason}`);

  if (!version) {
    return { ok: false, blockers: ['No approved migration version was supplied'], disposition: null, migration: null };
  }
  if (!/^\d{12,14}$/.test(version)) {
    return {
      ok: false,
      blockers: [`APPROVED_MIGRATION_VERSION=${version} is not a 12-14 digit migration version`],
      disposition: null,
      migration: null,
    };
  }

  const matches = local.filter((m) => m.version === version);
  if (matches.length === 0) {
    push('names no migration in supabase/migrations — it does not exist');
    return { ok: false, blockers, disposition: null, migration: null };
  }
  if (matches.length > 1) {
    push(`matches ${matches.length} local migration files — refusing ambiguous execution`);
    return { ok: false, blockers, disposition: null, migration: null };
  }

  const reconciled = (reconciliation?.reconciled ?? []).find((r) => r.localVersion === version);
  if (reconciled) {
    push(
      `is declared reconciled (${reconciled.classification}) — its effect is already present, so it must not execute`,
    );
    return { ok: false, blockers, disposition: null, migration: matches[0] };
  }

  const declarations = reconciliation?.knownPending ?? [];
  const declaration = declarations.find((k) => k.localVersion === version) || null;

  // An environment that declares a knownPending authority must declare THIS
  // version too, exactly as the gated check requires.
  if (declarations.length > 0) {
    if (!declaration) {
      push('carries no knownPending declaration in the reconciliation authority');
      return { ok: false, blockers, disposition: null, migration: matches[0] };
    }
    if (!APPROVABLE_DISPOSITIONS.has(declaration.disposition)) {
      push(`is declared ${declaration.disposition} — ${declaration.disposition} migrations never execute through this path`);
      return { ok: false, blockers, disposition: declaration.disposition, migration: matches[0] };
    }
  }

  return {
    ok: true,
    blockers: [],
    disposition: declaration ? declaration.disposition : null,
    migration: matches[0],
  };
}

/**
 * The single selection gate.
 *
 * Returns the migration -- at most ONE -- that this invocation may execute, and
 * why anything else was refused. Every refusal is explicit and fails closed; the
 * only way out of this function with a selection is to satisfy every condition.
 *
 * @param {object} args
 * @param {string} args.approvedVersion       APPROVED_MIGRATION_VERSION, '' when unset
 * @param {Array<{version:string}>} args.pending  legitimately pending migrations
 * @param {Map} args.declaredPending          validated knownPending declarations
 * @param {Map} args.aliasedLocal             validated reconciled declarations
 * @param {Set<string>} args.remoteSet        versions the remote ledger holds
 * @param {Set<string>} args.localSet         versions the local tree holds
 * @param {boolean} [args.requireDeclaration] when true (production posture) a
 *        pending migration must carry a knownPending declaration to be approvable
 */
export function resolveApprovedMigration({
  approvedVersion,
  pending,
  declaredPending,
  aliasedLocal,
  remoteSet,
  localSet,
  requireDeclaration = false,
}) {
  const version = String(approvedVersion || '').trim();
  if (!version) {
    return { selected: null, alreadyApplied: null, blockers: [] };
  }

  const blockers = [];
  const push = (reason) => blockers.push(`APPROVED_MIGRATION_VERSION=${version} ${reason}`);

  // 10. it must not be already physically reconciled
  if (aliasedLocal.has(version)) {
    const entry = aliasedLocal.get(version);
    push(
      `is declared reconciled (${entry.classification}) — its effect is already present, so it must not execute`,
    );
    return { selected: null, alreadyApplied: null, blockers };
  }

  // 5. it must be legitimately pending. An approved version the ledger already
  // holds is a SATISFIED approval, never a selection: the governed workflow
  // re-runs this preflight after the apply step carrying the same value
  // through. It is reported, and it selects nothing.
  if (remoteSet.has(version)) {
    return { selected: null, alreadyApplied: version, blockers: [] };
  }

  const pendingMatches = pending.filter((m) => m.version === version);

  // 4/12. The approved version names nothing this invocation could run. The two
  // diagnostics below are deliberately distinct, because conflating them is what
  // made the old gate misleading: a version that really IS pending among several
  // others used to be reported as "neither pending nor present". That case now
  // never reaches here -- it is selected above -- so these messages only ever
  // describe what they say.
  if (pendingMatches.length === 0) {
    if (pending.length > 0) {
      // Name a few, then count. Production legitimately carries dozens of
      // pending migrations, and a blocker that prints all of them is unreadable
      // in a CI summary.
      const shown = pending.slice(0, 5).map((m) => m.version).join(', ');
      const rest = pending.length > 5 ? ` (+${pending.length - 5} more)` : '';
      blockers.push(
        `pending migration ${shown}${rest} does not match APPROVED_MIGRATION_VERSION=${version}`,
      );
    } else if (!localSet.has(version)) {
      push('is neither pending nor present in the remote ledger — no such migration exists');
    } else {
      push('is neither pending nor present in the remote ledger');
    }
    return { selected: null, alreadyApplied: null, blockers };
  }
  if (pendingMatches.length > 1) {
    push(`matches ${pendingMatches.length} pending migrations — the local tree has duplicate versions`);
    return { selected: null, alreadyApplied: null, blockers };
  }

  const declaration = declaredPending.get(version) || null;

  if (requireDeclaration && !declaration) {
    push('is pending but carries no knownPending declaration in the reconciliation authority');
    return { selected: null, alreadyApplied: null, blockers };
  }

  // 6/7/8/9. approved, and not HOLD / EXCLUDE / anything else non-executable
  if (declaration && !APPROVABLE_DISPOSITIONS.has(declaration.disposition)) {
    push(`is declared ${declaration.disposition} — ${declaration.disposition} migrations never execute through this path`);
    return { selected: null, alreadyApplied: null, blockers };
  }

  return { selected: pendingMatches[0], alreadyApplied: null, blockers: [], declaration };
}
