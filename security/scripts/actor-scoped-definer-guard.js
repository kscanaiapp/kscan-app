#!/usr/bin/env node
'use strict';

/**
 * Cross-actor drift detection for SECURITY DEFINER functions, one role over
 * from `anon-grant-guard.js`.
 *
 * THE CLASS THIS CATCHES. A `SECURITY DEFINER` function bypasses RLS. When it
 * also takes the owner it should scope to as a PARAMETER (`p_user_id`,
 * `p_owner_id`, ...) and is executable by `authenticated`, PostgREST exposes it
 * at /rest/v1/rpc/<name> and the parameter becomes the only thing standing
 * between User A and User B's rows. A valid session plus a guessed or observed
 * id is then enough: the classic "valid A token + B record id" read.
 *
 * `anon-grant-guard.js` closed the unauthenticated half of this perimeter. It
 * says nothing about `authenticated`, which is where the User A / User B class
 * actually lives -- `build_owned_item_snapshot` sat in exactly that gap and was
 * reachable cross-actor until
 * supabase/migrations/20260914120000_close_authenticated_cross_actor_owned_item_snapshot.sql.
 *
 * THE RULE. A definer function that takes an actor parameter and is callable by
 * `authenticated` must either verify that parameter against `auth.uid()` in its
 * own body, or be on the reviewed allowlist below. Holding no grant at all is
 * the third, preferred answer: an internal helper should not be callable.
 *
 * Pure functions only -- no DB access here. A CI step reads the live catalogue
 * (prosecdef, argument names, has_function_privilege('authenticated', ...), and
 * whether the body references auth.uid()) and passes the rows in.
 */

/**
 * Argument-name fragments that mean "this parameter names an actor".
 *
 * `target_user` is deliberately included: a function that acts on another user
 * by design (blocking, for instance) still has to prove it checked the caller.
 */
const ACTOR_PARAM_PATTERNS = [
  'user_id',
  'owner_id',
  'actor_id',
  'profile_id',
  'target_user',
  'subject_ref',
];

/**
 * Definer functions that take an actor parameter, are callable by
 * `authenticated`, and do NOT check auth.uid() -- yet are still correct.
 *
 * Empty by design. Adding a name here is a reviewable one-line diff that has to
 * carry its own argument for why a caller-supplied actor is safe when RLS is
 * bypassed. "It is only called from our own code" is not one: the Data API does
 * not know that.
 */
const ACTOR_UNCHECKED_DEFINER_ALLOWLIST = [];

/** Does this argument signature name an actor the function scopes to? */
function hasActorParameter(args, patterns = ACTOR_PARAM_PATTERNS) {
  if (typeof args !== 'string' || !args) return false;
  const haystack = args.toLowerCase();
  return patterns.some((p) => haystack.includes(p));
}

/**
 * liveFunctions: [{ functionName, args, securityDefiner, authenticatedCanExecute,
 *                   bodyChecksAuthUid }]
 *
 * Returns the functions that are reachable by a signed-in user, bypass RLS,
 * take the actor as input, and never check it -- the exact shape of the
 * build_owned_item_snapshot defect.
 */
function detectActorUncheckedDefiners(liveFunctions, allowlist = ACTOR_UNCHECKED_DEFINER_ALLOWLIST) {
  const approved = new Set(allowlist);
  return (liveFunctions || [])
    .filter((fn) =>
      fn.securityDefiner &&
      fn.authenticatedCanExecute &&
      hasActorParameter(fn.args) &&
      !fn.bodyChecksAuthUid &&
      !approved.has(fn.functionName))
    .map((fn) => fn.functionName);
}

/**
 * Allowlist entries that no longer match the risky shape live -- not a failure,
 * but worth surfacing so the allowlist stays an accurate picture of reality
 * rather than an accumulating list of past exceptions.
 */
function detectStaleActorAllowlistEntries(liveFunctions, allowlist = ACTOR_UNCHECKED_DEFINER_ALLOWLIST) {
  const stillRisky = new Set(detectActorUncheckedDefiners(liveFunctions, []));
  return allowlist.filter((name) => !stillRisky.has(name));
}

/** The catalogue query a CI step runs to produce `liveFunctions`. */
const LIVE_INVENTORY_SQL = `
select p.proname                                                   as "functionName",
       pg_get_function_identity_arguments(p.oid)                   as args,
       p.prosecdef                                                 as "securityDefiner",
       has_function_privilege('authenticated', p.oid, 'EXECUTE')   as "authenticatedCanExecute",
       (pg_get_functiondef(p.oid) ~* 'auth\\.uid\\(\\)')             as "bodyChecksAuthUid"
from pg_proc p
join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public' and p.prokind = 'f'
order by p.proname;
`.trim();

module.exports = {
  ACTOR_PARAM_PATTERNS,
  ACTOR_UNCHECKED_DEFINER_ALLOWLIST,
  LIVE_INVENTORY_SQL,
  hasActorParameter,
  detectActorUncheckedDefiners,
  detectStaleActorAllowlistEntries,
};
