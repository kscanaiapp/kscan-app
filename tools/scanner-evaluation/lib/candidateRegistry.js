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
 * Phase 6 Candidate A.
 *
 * Same instruction CONTENT family as Phase 2A — name the specific fashion term —
 * at roughly a fifth of the length, plus an explicit instruction to answer
 * without deliberating. Length is the variable under test, not a side effect:
 * Phase 2A's ~1,000 added prompt tokens correlated with invalid output rising
 * from 18.2% to 42.4%, and every invalid case in both runs terminated within
 * ~20 tokens of the certified 2,048 output ceiling that response and thinking
 * share. This entry exists to separate the instruction's accuracy effect from
 * its length's reliability cost.
 */
const PHASE6_A_VERSION = 'phase6-scanner-v1.0-a';

/** Model topology shared by control and every Phase 2A candidate. */
const CERTIFIED_MODEL_CONFIGURATION_ID = 'certified-v140';

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
  'modelConfigurationId',
  'postValidationPolicy',
  'description',
]);

const ROLES = Object.freeze(['control', 'candidate']);

const REGISTRY = Object.freeze({
  [CONTROL_VERSION]: Object.freeze({
    candidateVersion: CONTROL_VERSION,
    role: 'control',
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
    modelConfigurationId: CERTIFIED_MODEL_CONFIGURATION_ID,
    instructionOverlayId: 'phase2a-fashion-specificity-v1',
    postValidationPolicy: 'phase2a_evidence_discipline',
    runIdSegment: PHASE2A_VERSION,
    description:
      'Phase 2A candidate: certified topology, certified request structure, plus a deterministic '
      + 'fashion-specificity instruction overlay and candidate-scoped evidence-discipline validation.',
  }),
  [PHASE6_A_VERSION]: Object.freeze({
    candidateVersion: PHASE6_A_VERSION,
    role: 'candidate',
    modelConfigurationId: CERTIFIED_MODEL_CONFIGURATION_ID,
    instructionOverlayId: 'phase6-decisive-specificity-v1',
    postValidationPolicy: 'phase6_evidence_discipline',
    runIdSegment: PHASE6_A_VERSION,
    description:
      'Phase 6 Candidate A: certified topology and certified request structure, plus a '
      + 'length-constrained fashion-specificity overlay that also instructs the model to answer '
      + 'without deliberating. Tests whether Phase 2A\'s accuracy gains survive when the overlay is '
      + 'small enough not to push the shared output/thinking budget past its ceiling.',
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
  }
  if (entry.role === 'control') {
    if (entry.instructionOverlayId !== null) missing.push('a control may not carry an instruction overlay');
    if (entry.runIdSegment !== null) missing.push('a control may not carry a run-id segment');
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
  CERTIFIED_MODEL_CONFIGURATION_ID,
  REQUIRED_FIELDS,
  ROLES,
  UnknownCandidateVersion,
  CandidateConfigurationIncomplete,
  ResultIdentityCollision,
  versions,
  isKnown,
  isControl,
  assertConfigurationComplete,
  resolveCandidate,
  runIdSegment,
  candidateIdentity,
  registryHash,
  assertDistinctResultIdentity,
};
