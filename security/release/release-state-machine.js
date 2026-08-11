#!/usr/bin/env node
'use strict';

/**
 * Machine-readable release-state model for K Scan AI backend releases.
 *
 * Phase 2A scope: define states, valid transitions, and who may execute
 * each transition. Nothing in this module deploys, rolls back, or mutates
 * Supabase - it only decides whether a proposed state transition is valid
 * and, if so, produces an auditable transition record. Callers own actually
 * doing the work a transition represents.
 *
 * Node built-ins only.
 */

const { assertNoEmbeddedSecret } = require('../scripts/lib/secret-shape-guard');

const STATES = Object.freeze([
  'DRAFT',
  'FROZEN',
  'STAGING_READY',
  'STAGING_DEPLOYING',
  'STAGING_DEPLOYED',
  'STAGING_VERIFIED',
  'AWAITING_PRODUCTION_APPROVAL',
  'PRODUCTION_DEPLOYING',
  'PRODUCTION_VERIFYING',
  'PRODUCTION_VERIFIED',
  'CLOSED',
  'BLOCKED',
  'STAGING_FAILED',
  'PRODUCTION_FAILED',
  'ROLLBACK_REQUIRED',
  'ROLLBACK_IN_PROGRESS',
  'ROLLED_BACK',
  'FORWARD_FIX_REQUIRED',
  'RECOVERY_REQUIRED',
]);
const STATE_SET = new Set(STATES);

/** Terminal states: no outbound transition exists. */
const TERMINAL_STATES = Object.freeze(['CLOSED']);

const ACTORS = Object.freeze(['AUTOMATION', 'AUTHORIZED_AGENT', 'OWNER']);
const ACTOR_SET = new Set(ACTORS);
const ALL_ACTORS = ACTORS;

/**
 * from -> array of { to, actors, irreversible, note }.
 * `actors` lists who may execute the transition; the caller's supplied actor
 * must be a member. `irreversible` is a hint for future UI/automation - it
 * is not itself enforced here beyond being reported on the transition record.
 */
const TRANSITIONS = Object.freeze({
  DRAFT: [
    { to: 'FROZEN', actors: ALL_ACTORS, irreversible: false, note: 'manifest freeze binds identity material' },
    { to: 'BLOCKED', actors: ALL_ACTORS, irreversible: false },
  ],
  FROZEN: [
    { to: 'STAGING_READY', actors: ALL_ACTORS, irreversible: false },
    { to: 'DRAFT', actors: ALL_ACTORS, irreversible: false, note: 'candidate mutated after freeze; freeze invalidated' },
    { to: 'BLOCKED', actors: ALL_ACTORS, irreversible: false },
  ],
  STAGING_READY: [
    { to: 'STAGING_DEPLOYING', actors: ['AUTOMATION', 'AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
    { to: 'BLOCKED', actors: ALL_ACTORS, irreversible: false },
  ],
  STAGING_DEPLOYING: [
    { to: 'STAGING_DEPLOYED', actors: ['AUTOMATION'], irreversible: false },
    { to: 'STAGING_FAILED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false },
  ],
  STAGING_DEPLOYED: [
    { to: 'STAGING_VERIFIED', actors: ['AUTOMATION'], irreversible: false },
    { to: 'STAGING_FAILED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false },
  ],
  STAGING_VERIFIED: [
    { to: 'AWAITING_PRODUCTION_APPROVAL', actors: ['AUTOMATION', 'AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
    { to: 'STAGING_FAILED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false, note: 'post-verification regression detected' },
  ],
  AWAITING_PRODUCTION_APPROVAL: [
    {
      to: 'PRODUCTION_DEPLOYING',
      actors: ['OWNER'],
      irreversible: true,
      note: 'the one owner-gated, irreversible transition in this model - Phase 2A implements no code path that can execute it against real production',
    },
    { to: 'BLOCKED', actors: ALL_ACTORS, irreversible: false },
  ],
  PRODUCTION_DEPLOYING: [
    { to: 'PRODUCTION_VERIFYING', actors: ['AUTOMATION'], irreversible: true },
    { to: 'PRODUCTION_FAILED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false },
  ],
  PRODUCTION_VERIFYING: [
    { to: 'PRODUCTION_VERIFIED', actors: ['AUTOMATION'], irreversible: false },
    { to: 'PRODUCTION_FAILED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false },
  ],
  PRODUCTION_VERIFIED: [
    { to: 'CLOSED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false, note: 'eligible to become Last Known Good once closed - see security/release/last-known-good.js' },
  ],
  CLOSED: [],
  BLOCKED: [
    { to: 'DRAFT', actors: ALL_ACTORS, irreversible: false, note: 'blocker resolved; candidate restarts from draft' },
  ],
  STAGING_FAILED: [
    { to: 'ROLLBACK_REQUIRED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
    { to: 'FORWARD_FIX_REQUIRED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
  ],
  PRODUCTION_FAILED: [
    { to: 'ROLLBACK_REQUIRED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
    { to: 'FORWARD_FIX_REQUIRED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
  ],
  ROLLBACK_REQUIRED: [
    { to: 'ROLLBACK_IN_PROGRESS', actors: ['AUTOMATION', 'AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
  ],
  ROLLBACK_IN_PROGRESS: [
    { to: 'ROLLED_BACK', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false },
    { to: 'RECOVERY_REQUIRED', actors: ['AUTOMATION', 'AUTHORIZED_AGENT'], irreversible: false, note: 'rollback itself failed' },
  ],
  ROLLED_BACK: [
    { to: 'CLOSED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false },
    { to: 'DRAFT', actors: ALL_ACTORS, irreversible: false, note: 'new candidate supersedes the rolled-back one' },
  ],
  FORWARD_FIX_REQUIRED: [
    { to: 'RECOVERY_REQUIRED', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false, note: 'forward-fix itself needs escalation' },
    { to: 'DRAFT', actors: ['AUTHORIZED_AGENT', 'OWNER'], irreversible: false, note: 'forward-fix becomes a new candidate release' },
  ],
  RECOVERY_REQUIRED: [
    { to: 'CLOSED', actors: ['OWNER'], irreversible: false, note: 'owner closes out after manual recovery' },
  ],
});

for (const from of Object.keys(TRANSITIONS)) {
  if (!STATE_SET.has(from)) throw new Error(`TRANSITIONS references unknown state: ${from}`);
  for (const t of TRANSITIONS[from]) {
    if (!STATE_SET.has(t.to)) throw new Error(`TRANSITIONS[${from}] references unknown target state: ${t.to}`);
  }
}
for (const s of STATES) {
  if (!(s in TRANSITIONS)) throw new Error(`state missing from TRANSITIONS table: ${s}`);
}

class ReleaseStateError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'ReleaseStateError';
    this.code = code;
  }
}

/** Concurrency: only one release may sit in AWAITING_PRODUCTION_APPROVAL at a time (single-owner repo, no release queuing). */
const SINGLE_FLIGHT_STATES = Object.freeze(['AWAITING_PRODUCTION_APPROVAL', 'PRODUCTION_DEPLOYING', 'PRODUCTION_VERIFYING']);

function findTransition(from, to) {
  const options = TRANSITIONS[from];
  if (!options) return null;
  return options.find((t) => t.to === to) || null;
}

/** Pure check: is `from -> to` a defined transition at all (ignoring actor authorization)? */
function isValidTransition(from, to) {
  return Boolean(findTransition(from, to));
}

/**
 * Validates and records a state transition.
 *
 * @param {object} input
 * @param {string} input.releaseId
 * @param {string} input.from
 * @param {string} input.to
 * @param {'AUTOMATION'|'AUTHORIZED_AGENT'|'OWNER'} input.actor
 * @param {string} [input.actorId] - non-secret identifier (username/handle), never a credential
 * @param {string} [input.reason]
 * @param {string} [input.timestamp] - ISO 8601; caller-supplied for determinism, defaults to now
 * @param {Array<object>} [input.otherActiveReleaseStates] - states of other in-flight releases, for the single-flight check
 * @returns {{ok: true, entry: object}}
 * @throws {ReleaseStateError}
 */
function applyTransition(input) {
  const { releaseId, from, to, actor, actorId = null, reason = null, timestamp, otherActiveReleaseStates = [] } = input || {};

  if (!releaseId || typeof releaseId !== 'string') {
    throw new ReleaseStateError('releaseId is required', 'MISSING_RELEASE_ID');
  }
  if (!STATE_SET.has(from)) {
    throw new ReleaseStateError(`unknown "from" state: ${from}`, 'INVALID_STATE');
  }
  if (!STATE_SET.has(to)) {
    throw new ReleaseStateError(`unknown "to" state: ${to}`, 'INVALID_STATE');
  }
  if (!ACTOR_SET.has(actor)) {
    throw new ReleaseStateError(`unknown actor category: ${actor}`, 'INVALID_ACTOR');
  }
  if (TERMINAL_STATES.includes(from)) {
    throw new ReleaseStateError(`${from} is terminal; no transition is possible`, 'TERMINAL_STATE');
  }

  const transition = findTransition(from, to);
  if (!transition) {
    throw new ReleaseStateError(`invalid transition ${from} -> ${to}`, 'INVALID_TRANSITION');
  }
  if (!transition.actors.includes(actor)) {
    throw new ReleaseStateError(
      `actor "${actor}" is not authorized for ${from} -> ${to} (requires one of: ${transition.actors.join(', ')})`,
      transition.actors.includes('OWNER') && transition.actors.length === 1 ? 'OWNER_REQUIRED' : 'UNAUTHORIZED_ACTOR',
    );
  }

  if (SINGLE_FLIGHT_STATES.includes(to)) {
    const conflict = otherActiveReleaseStates.find((s) => SINGLE_FLIGHT_STATES.includes(s));
    if (conflict) {
      throw new ReleaseStateError(
        `another release is already in ${conflict}; only one release may be in production approval/deploy at a time`,
        'SINGLE_FLIGHT_VIOLATION',
      );
    }
  }

  assertNoEmbeddedSecret(actorId, 'actorId');
  assertNoEmbeddedSecret(reason, 'reason');

  const entry = Object.freeze({
    releaseId,
    from,
    to,
    actor,
    actorId,
    reason,
    irreversible: transition.irreversible,
    timestamp: timestamp || new Date().toISOString(),
  });

  return { ok: true, entry };
}

module.exports = {
  STATES,
  TERMINAL_STATES,
  ACTORS,
  TRANSITIONS,
  SINGLE_FLIGHT_STATES,
  ReleaseStateError,
  isValidTransition,
  applyTransition,
};
