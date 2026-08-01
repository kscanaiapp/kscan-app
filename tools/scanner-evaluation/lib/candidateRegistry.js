'use strict';

/**
 * Phase 2A candidate registry — the single explicit boundary between the
 * certified v140 control and any scanner-accuracy candidate.
 *
 * WHY A REGISTRY RATHER THAN A FLAG
 *
 * A boolean "use the candidate" flag has three failure modes this module exists
 * to make impossible:
 *
 *   1. It can be set from mutable global state (an environment variable, a
 *      request field, a module-level `let`) so a production caller drifts onto
 *      candidate behaviour without anyone selecting it. Selection here is a
 *      REQUIRED ARGUMENT. `resolveCandidate()` reads nothing from
 *      `process.env`, nothing from `globalThis`, and holds no mutable state.
 *
 *   2. It cannot express "this candidate is misconfigured". A boolean is always
 *      valid. A registry entry is validated field by field and an incomplete one
 *      is refused rather than half-applied.
 *
 *   3. It gives control and candidate the same identity, so their results,
 *      caches and run directories collide and the comparison silently scores one
 *      execution against itself. Every entry here carries a distinct
 *      `runIdSegment`, and `assertDistinctResultIdentity()` refuses the
 *      collision explicitly.
 *
 * WHAT A CANDIDATE MAY AND MAY NOT CHANGE
 *
 * Phase 2A candidates are PROMPT ENGINEERING plus CANDIDATE-SCOPED
 * POST-VALIDATION. The provider topology — primary model, fallback model,
 * timeouts, retry rules, transport and image selection — is the certified
 * topology for every entry, which is why `modelConfigurationId` is
 * `certified-v140` on the candidate as well as the control. A candidate that
 * needed a different model would be a different phase, not a different registry
 * row.
 *
 * THE CONTROL IS NOT A CANDIDATE
 *
 * `certified-v140` is present so that selection is always explicit — never
 * "whatever you get when you pass nothing" — but it carries no instruction
 * overlay and no candidate post-validation. Resolving it returns the certified
 * path unchanged, and `runIdSegment` is null so certified run identities are
 * byte-identical to the ones the certified runner already produces.
 */

const crypto = require('crypto');

/** The certified v140 control. Not a candidate; the thing candidates are measured against. */
const CONTROL_VERSION = 'certified-v140';

/** The Phase 2A candidate. One identifier, used everywhere, with no aliases. */
const PHASE2A_VERSION = 'phase2a-v1.0.0';

/**
 * The Phase 3 remediation candidate. A DISTINCT immutable identity, not an edit
 * of PHASE2A_VERSION: the recorded live results (42.4% unparseable) belong to
 * v1.0.0's exact instruction text and hash and must stay attributable to it —
 * see phase2a-instruction-overlay.v1.json's `textSha256`, unchanged.
 */
const PHASE2A_V11_VERSION = 'phase2a-v1.1.0';

/** Model topology shared by control and every Phase 2A candidate. */
const CERTIFIED_MODEL_CONFIGURATION_ID = 'certified-v140';

/**
 * A registry entry's lifecycle state — separate from `role`, because "what kind
 * of entry is this" (control vs. candidate) and "what may currently be done
 * with it" (serve production, run in an evaluation, or nothing) are independent
 * questions. Collapsing them into one field is what would have let removing
 * v1.0.0 outright look like the only way to stop it being selected.
 *
 *   production — the control's permanent state. The only status live traffic
 *                may ever resolve to from this module, and only via the
 *                separate, explicitly owner-gated `scannerVersionResolver.ts`
 *                — this registry has no production selector of its own.
 *   rejected   — a candidate whose live evaluation result is on record and
 *                did not meet the release bar. Kept resolvable forever, so
 *                its recorded results, hashes and evidence stay attributable
 *                and reproducible. Refused by `isEligibleForEvaluation()`, so
 *                it can never be launched again under its own identity —
 *                the correction is a NEW identity, not a reopened one.
 *   evaluation — a candidate that has not yet been measured, or is currently
 *                being measured, against the release bar. Eligible to launch.
 *                Certification (freezing it as the source of truth after it
 *                passes every gate) is a separate act this module does not
 *                perform — see docs/scanner-accuracy for the certification
 *                record once a candidate clears evaluation.
 */
const STATUSES = Object.freeze(['production', 'rejected', 'evaluation']);

class UnknownCandidateVersion extends Error {
  constructor(received, known) {
    super(
      `unknown candidate version ${JSON.stringify(received)}; `
      + `selection must name one of: ${known.join(', ')}`
    );
    this.name = 'UnknownCandidateVersion';
    this.received = received;
  }
}

class CandidateConfigurationIncomplete extends Error {
  constructor(candidateVersion, missing) {
    super(`candidate ${candidateVersion} configuration is incomplete: ${missing.join(', ')}`);
    this.name = 'CandidateConfigurationIncomplete';
    this.candidateVersion = candidateVersion;
    this.missing = missing;
  }
}

class ResultIdentityCollision extends Error {
  constructor(detail) {
    super(`control and candidate results would share one identity: ${detail}`);
    this.name = 'ResultIdentityCollision';
  }
}

/**
 * Fields every entry must carry. Named explicitly so an entry added later
 * cannot be half-specified and still resolve.
 *
 * `instructionOverlayId` is null for the control and a non-empty id for a
 * candidate — the two are checked separately below, because "null" is a
 * complete configuration for a control and an incomplete one for a candidate.
 */
const REQUIRED_FIELDS = Object.freeze([
  'candidateVersion',
  'role',
  'status',
  'modelConfigurationId',
  'postValidationPolicy',
  'description',
]);

const ROLES = Object.freeze(['control', 'candidate']);

const REGISTRY = Object.freeze({
  [CONTROL_VERSION]: Object.freeze({
    candidateVersion: CONTROL_VERSION,
    role: 'control',
    status: 'production',
    modelConfigurationId: CERTIFIED_MODEL_CONFIGURATION_ID,
    /** No overlay: the certified prompt reaches the provider verbatim. */
    instructionOverlayId: null,
    /** Certified validation only. No candidate-scoped rule may run on this path. */
    postValidationPolicy: 'certified_only',
    /**
     * Null, not 'certified-v140'. A control run id must stay byte-identical to
     * the certified runner's existing output, so certified runs recorded before
     * Phase 2A remain resumable and comparable.
     */
    runIdSegment: null,
    description:
      'Certified v140 as deployed. The control. No prompt overlay and no candidate post-validation.',
  }),
  [PHASE2A_VERSION]: Object.freeze({
    candidateVersion: PHASE2A_VERSION,
    role: 'candidate',
    /**
     * REJECTED, not deleted. Phase 3 live evaluation measured a 42.4%
     * unparseable-response rate against the control's 18.2% and returned
     * REVISE_CANDIDATE (docs/scanner-accuracy/build4-phase3-live-evaluation-
     * 2026-07-31.md). The entry stays so that result, its hashes, and its
     * fixture-level evidence remain resolvable and reproducible — but
     * `isEligibleForEvaluation()` refuses it, so it can never be launched
     * again under this identity. The correction is phase2a-v1.1.0 below.
     */
    status: 'rejected',
    modelConfigurationId: CERTIFIED_MODEL_CONFIGURATION_ID,
    instructionOverlayId: 'phase2a-fashion-specificity-v1',
    postValidationPolicy: 'phase2a_evidence_discipline',
    runIdSegment: PHASE2A_VERSION,
    description:
      'Phase 2A candidate: certified topology, certified request structure, plus a deterministic '
      + 'fashion-specificity instruction overlay and candidate-scoped evidence-discipline validation. '
      + 'REJECTED by live evaluation (274d40b): 42.4% unparseable vs. control 18.2%. Preserved as '
      + 'evidence; not eligible for evaluation or release.',
  }),
  [PHASE2A_V11_VERSION]: Object.freeze({
    candidateVersion: PHASE2A_V11_VERSION,
    role: 'candidate',
    /**
     * EVALUATION, not production. Passing the governed live evaluation makes
     * this candidate eligible for certification; it does not make it
     * production-selected. Production selection is owned entirely by
     * supabase/functions/_shared/scannerVersionResolver.ts, whose committed
     * default stays the certified control until a separate, explicit,
     * owner-approved activation phase — this registry has no production
     * selector and cannot grant one by editing a status string.
     */
    status: 'evaluation',
    modelConfigurationId: CERTIFIED_MODEL_CONFIGURATION_ID,
    instructionOverlayId: 'phase2a-fashion-specificity-v1_1',
    postValidationPolicy: 'phase2a_evidence_discipline',
    runIdSegment: PHASE2A_V11_VERSION,
    description:
      'Phase 2A remediation candidate: identical to phase2a-v1.0.0 except that STRICT STRUCTURED '
      + 'OUTPUT moves from last to first and one negative example is added, addressing the measured '
      + 'schema-reliability regression. Eligible for the governed live evaluation; not yet certified.',
  }),
});

/** Every registered version, control first. Order is stable for reporting. */
function versions() {
  return Object.keys(REGISTRY);
}

function isKnown(candidateVersion) {
  return typeof candidateVersion === 'string'
    && Object.prototype.hasOwnProperty.call(REGISTRY, candidateVersion);
}

/**
 * Validate one entry. Exported so a registry addition is checked by the same
 * rules the resolver applies, rather than by review alone.
 */
function assertConfigurationComplete(entry) {
  const label = entry && entry.candidateVersion ? entry.candidateVersion : '<unnamed>';
  const missing = [];
  if (!entry || typeof entry !== 'object') {
    throw new CandidateConfigurationIncomplete(label, ['entry is not an object']);
  }
  for (const field of REQUIRED_FIELDS) {
    const value = entry[field];
    if (typeof value !== 'string' || value.trim() === '') missing.push(field);
  }
  if (entry.role !== undefined && !ROLES.includes(entry.role)) {
    missing.push(`role must be one of ${ROLES.join('|')}`);
  }
  if (entry.status !== undefined && !STATUSES.includes(entry.status)) {
    missing.push(`status must be one of ${STATUSES.join('|')}`);
  }
  if (!('instructionOverlayId' in entry)) missing.push('instructionOverlayId');
  if (!('runIdSegment' in entry)) missing.push('runIdSegment');

  if (entry.role === 'candidate') {
    // A candidate with no overlay and no candidate policy is a renamed control.
    // Refusing it here is what stops "Phase 2A" from silently being v140.
    if (typeof entry.instructionOverlayId !== 'string' || entry.instructionOverlayId.trim() === '') {
      missing.push('instructionOverlayId is required for a candidate');
    }
    if (typeof entry.runIdSegment !== 'string' || entry.runIdSegment.trim() === '') {
      missing.push('runIdSegment is required for a candidate');
    }
    if (entry.postValidationPolicy === 'certified_only') {
      missing.push('a candidate may not declare the certified-only validation policy');
    }
    // A candidate may never claim the control's lifecycle state. Production
    // selection is granted only by scannerVersionResolver.ts's own committed
    // default, never by this registry — see PHASE2A_V11_VERSION's comment.
    if (entry.status === 'production') {
      missing.push('a candidate may not declare production status');
    }
  }
  if (entry.role === 'control') {
    if (entry.instructionOverlayId !== null) missing.push('a control may not carry an instruction overlay');
    if (entry.runIdSegment !== null) missing.push('a control may not carry a run-id segment');
    if (entry.status !== 'production') missing.push('the control must declare production status');
  }

  if (missing.length) throw new CandidateConfigurationIncomplete(label, missing);
  return entry;
}

/**
 * Resolve an explicitly named candidate version.
 *
 * There is deliberately NO default. Passing null, undefined, '' or an unknown
 * string throws — the caller must state which execution it wants, so a
 * production or mobile caller cannot fall through to a candidate, and a typo
 * cannot silently become the control.
 *
 * @param {string} candidateVersion
 */
function resolveCandidate(candidateVersion) {
  if (!isKnown(candidateVersion)) {
    throw new UnknownCandidateVersion(candidateVersion, versions());
  }
  return assertConfigurationComplete(REGISTRY[candidateVersion]);
}

function isControl(candidateVersion) {
  return resolveCandidate(candidateVersion).role === 'control';
}

/**
 * Whether a version may be launched in a live evaluation run — as the
 * comparison baseline (the control, always) or as the thing being measured
 * (a candidate, only while its status is 'evaluation').
 *
 * A 'rejected' candidate fails this even though `isKnown()` still returns
 * true for it: it stays resolvable as evidence, but is refused a second
 * launch under its own identity. This is the boundary run-baseline.js's
 * --candidate-version enforces, in addition to isKnown().
 */
function isEligibleForEvaluation(candidateVersion) {
  const entry = resolveCandidate(candidateVersion);
  return entry.status === 'production' || entry.status === 'evaluation';
}

/** Whether a version is preserved rejected evidence rather than an active entry. */
function isRejected(candidateVersion) {
  return resolveCandidate(candidateVersion).status === 'rejected';
}

/**
 * The run-id segment for a version: null for the control, the version string for
 * a candidate. Callers pass this into `runIdentity.buildRunId`, which appends it
 * only when it is a non-empty string.
 */
function runIdSegment(candidateVersion) {
  return resolveCandidate(candidateVersion).runIdSegment;
}

/**
 * The identity block every run manifest, case record, cache key and comparison
 * row must quote. Deterministic: same version in, same object out.
 */
function candidateIdentity(candidateVersion) {
  const entry = resolveCandidate(candidateVersion);
  return Object.freeze({
    candidateVersion: entry.candidateVersion,
    role: entry.role,
    modelConfigurationId: entry.modelConfigurationId,
    instructionOverlayId: entry.instructionOverlayId,
    postValidationPolicy: entry.postValidationPolicy,
  });
}

/** A stable hash over the frozen registry, so a silent edit is detectable. */
function registryHash() {
  const canonical = JSON.stringify(
    versions()
      .slice()
      .sort()
      .map((version) => {
        const entry = REGISTRY[version];
        const picked = {};
        for (const key of Object.keys(entry).sort()) picked[key] = entry[key];
        return picked;
      })
  );
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

/**
 * Refuse a control result and a candidate result that share a write target.
 *
 * Two different executions writing one identity is the failure that makes a
 * comparison meaningless while still looking like it ran: the second write
 * overwrites the first and the report scores one execution against itself.
 *
 * Both records must name their candidate version, so an unversioned record —
 * which would collide with everything — is rejected rather than assumed to be
 * the control.
 *
 * @param {{candidateVersion?: string, runId?: string, outputRoot?: string}} a
 * @param {{candidateVersion?: string, runId?: string, outputRoot?: string}} b
 */
function assertDistinctResultIdentity(a, b) {
  for (const [label, record] of [['first', a], ['second', b]]) {
    if (!record || !isKnown(record.candidateVersion)) {
      throw new ResultIdentityCollision(
        `the ${label} record does not name a known candidate version`
      );
    }
  }
  if (a.candidateVersion === b.candidateVersion) return true; // same execution, not a collision

  if (a.runId && b.runId && a.runId === b.runId) {
    throw new ResultIdentityCollision(`both name runId ${a.runId}`);
  }
  if (a.outputRoot && b.outputRoot && a.outputRoot === b.outputRoot) {
    throw new ResultIdentityCollision('both write to one output root');
  }
  return true;
}

module.exports = {
  CONTROL_VERSION,
  PHASE2A_VERSION,
  PHASE2A_V11_VERSION,
  CERTIFIED_MODEL_CONFIGURATION_ID,
  REQUIRED_FIELDS,
  ROLES,
  STATUSES,
  UnknownCandidateVersion,
  CandidateConfigurationIncomplete,
  ResultIdentityCollision,
  versions,
  isKnown,
  isControl,
  isEligibleForEvaluation,
  isRejected,
  assertConfigurationComplete,
  resolveCandidate,
  runIdSegment,
  candidateIdentity,
  registryHash,
  assertDistinctResultIdentity,
};
