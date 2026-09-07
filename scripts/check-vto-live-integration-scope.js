#!/usr/bin/env node
/**
 * P3-C scope guard.
 *
 * WHY THIS EXISTS AND WHY IT IS NOT THE OLD PROTECTION MODEL. The Live VTO
 * research lanes (#291, #295) treated every production VTO path as immutable
 * and enforced that with a protected-paths validator. P3-C intentionally
 * changes that rule -- this lane IS authorized to modify the VTO client. The
 * wrong response to that is to delete the old protection; the right one is to
 * replace a blanket denial with a narrow, justified allow-list.
 *
 * So this guard fails when the branch's diff touches anything the integration
 * manifest does not authorize. The manifest is the single source: a path
 * becomes authorized by acquiring a table row WITH a reason and a source
 * authority, not by being appended to a list in a script.
 *
 * WHICH LANES THE LIVE DIFF BINDS, AND WHY THAT IS NOW EXPLICIT. This guard
 * has two halves. The STATIC half -- the manifest parser, the matcher, and the
 * protected-boundary refusals -- is a policy control that is true of the whole
 * repository and runs everywhere, on every branch. The LIVE half diffs a
 * branch against the VTO integration base and refuses anything the manifest
 * does not authorize; that one is only meaningful on a lane that is actually
 * derived from, and answerable to, that base.
 *
 * The original implementation conflated the two. It picked a base ref by
 * TRYING A LIST OF CANDIDATES AND TAKING THE FIRST THAT EXISTED, then diffed
 * unconditionally. "This checkout contains the VTO integration commit" is true
 * of every branch in this repository, so every non-VTO branch was judged
 * against the VTO manifest and failed for its own unrelated work -- a
 * notifications branch was told it had touched paths the VTO lane does not
 * authorize. The candidate list is therefore gone: lane membership is now
 * DECLARED, never guessed.
 *
 * The declaration is two environment variables:
 *
 *   KSCAN_VTO_SCOPE_ENFORCE=1                 this execution IS a VTO lane
 *   KSCAN_VTO_SCOPE_BASE_REF=<approved base>  the base authority to judge against
 *
 * With the signal absent, the live diff reports NOT APPLICABLE and the static
 * controls still run. With the signal present, the base ref is MANDATORY: a
 * missing, empty or unresolvable base is a FAILURE, never a skip and never a
 * pass. "The base could not be resolved, so we are fine" is exactly the
 * control this guard must not have -- it would let a real VTO lane escape its
 * own mutation boundary by breaking one ref. A value of the enforcement
 * variable that is neither an ON nor an OFF token also fails closed, so a typo
 * cannot quietly switch enforcement off.
 *
 * Usage:
 *   node scripts/check-vto-live-integration-scope.js [baseRef]
 *
 * A baseRef named on the command line is a deliberate, explicit human act, so
 * it runs the diff without the environment signal (this is the documented
 * local/manual invocation). It is still fail-closed: a base ref that does not
 * resolve is an error, not a skip.
 *
 * Exit codes:
 *   0  every changed path is authorized, OR this is not a VTO enforcement lane
 *      and the live diff reported NOT APPLICABLE (the static manifest controls
 *      ran and passed either way)
 *   1  the diff reached outside the authorized boundary, the manifest is
 *      unparseable / self-inconsistent, or enforcement was declared and could
 *      not be carried out
 */

'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join('docs', 'vto-live-integration-manifest.md');

/** The explicit VTO-lane enforcement signal. See the header. */
const ENFORCE_ENV = 'KSCAN_VTO_SCOPE_ENFORCE';
const BASE_REF_ENV = 'KSCAN_VTO_SCOPE_BASE_REF';

const ENFORCE_ON_VALUES = new Set(['1', 'true']);
const ENFORCE_OFF_VALUES = new Set(['', '0', 'false']);

/**
 * Reads the authorized-path table out of the manifest.
 *
 * A row is only authorized when it carries BOTH a reason and a source
 * authority. That is the whole control: appending a bare path to the table
 * does not widen the boundary, it fails the guard.
 */
function parseAuthorizedPatterns(markdown) {
  const patterns = [];
  const problems = [];
  const lines = markdown.split('\n');
  let inTable = false;

  for (const line of lines) {
    if (/^\|\s*AUTHORIZED PATH\s*\|/.test(line)) {
      inTable = true;
      continue;
    }
    if (!inTable) continue;
    if (!line.startsWith('|')) break;
    if (/^\|\s*-+\s*\|/.test(line)) continue;

    const cells = line.split('|').slice(1, -1).map((cell) => cell.trim());
    if (cells.length < 3) continue;

    const [rawPath, why, authority] = cells;
    const match = rawPath.match(/^`([^`]+)`$/);
    if (!match) {
      problems.push(`row path is not a single backtick-quoted path: ${rawPath}`);
      continue;
    }
    if (!why) problems.push(`${match[1]} has no WHY MUTATION IS REQUIRED`);
    if (!authority) problems.push(`${match[1]} has no SOURCE AUTHORITY`);
    patterns.push(match[1]);
  }

  return { patterns, problems };
}

/**
 * Deliberately tiny matcher: `**` means "this prefix and everything under it",
 * a trailing `*` means "this prefix", and anything else is an exact path.
 *
 * Not a general glob library, on purpose. A guard whose matching rules are
 * hard to reason about is a guard nobody can audit, and every pattern this
 * manifest needs is one of those three shapes.
 */
function matchesPattern(changedPath, pattern) {
  if (pattern.endsWith('/**')) {
    return changedPath.startsWith(pattern.slice(0, -2));
  }
  if (pattern.endsWith('*')) {
    return changedPath.startsWith(pattern.slice(0, -1));
  }
  return changedPath === pattern;
}

function classifyChangedPaths(changedPaths, patterns) {
  const authorized = [];
  const unauthorized = [];
  for (const changedPath of changedPaths) {
    if (patterns.some((pattern) => matchesPattern(changedPath, pattern))) {
      authorized.push(changedPath);
    } else {
      unauthorized.push(changedPath);
    }
  }
  return { authorized, unauthorized };
}

function git(args) {
  return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8' }).trim();
}

/** True when `ref` names a commit reachable in this checkout. */
function refExistsInCheckout(ref) {
  try {
    execFileSync('git', ['rev-parse', '--verify', `${ref}^{commit}`], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    });
    return true;
  } catch {
    return false;
  }
}

/** The changed paths between an approved base authority and HEAD. */
function diffChangedPaths(baseRef) {
  const output = git(['diff', '--name-only', `${baseRef}...HEAD`]);
  return output ? output.split('\n').filter(Boolean) : [];
}

/**
 * Reads the enforcement signal. Three outcomes, never two:
 *
 *   { enforced: true }              a VTO lane declared itself
 *   { enforced: false }             no declaration, or an explicit OFF
 *   { enforced: null, reason }      the variable is set to something that is
 *                                   neither -- fail closed rather than guess
 *
 * The third case is the point. If an unrecognised value read as "off", then
 * `KSCAN_VTO_SCOPE_ENFORCE=ture` would silently disarm a real VTO lane's
 * mutation guard and the run would still be green.
 */
function readEnforcementSignal(env) {
  const raw = env[ENFORCE_ENV];
  if (raw === undefined) return { enforced: false };

  const value = String(raw).trim().toLowerCase();
  if (ENFORCE_ON_VALUES.has(value)) return { enforced: true };
  if (ENFORCE_OFF_VALUES.has(value)) return { enforced: false };
  return {
    enforced: null,
    reason:
      `${ENFORCE_ENV} is set to ${JSON.stringify(raw)}, which is neither an ON value ` +
      `(${[...ENFORCE_ON_VALUES].join(', ')}) nor an OFF value ` +
      `(${[...ENFORCE_OFF_VALUES].filter(Boolean).join(', ')}). ` +
      'Refusing to guess: a VTO lane must not be able to disarm its own mutation guard with a typo.',
  };
}

/**
 * Decides whether the LIVE half of this guard runs on this execution, and
 * against which base authority. Exactly one of:
 *
 *   { decision: 'ENFORCE', baseRef }  run the diff; unauthorized paths FAIL
 *   { decision: 'SKIP', reason }      not a VTO lane; static controls only
 *   { decision: 'FAIL', reason }      enforcement declared but not carriable
 *
 * Every dependency is injectable so the fail-closed branches can be proven
 * without mutating a real checkout -- see
 * __tests__/vtoScopeGuardEnforcementMode.test.js.
 */
function resolveScopeMode({
  env = process.env,
  explicitBaseRef = null,
  refExists = refExistsInCheckout,
} = {}) {
  const signal = readEnforcementSignal(env);
  if (signal.enforced === null) return { decision: 'FAIL', reason: signal.reason };

  const declared = typeof env[BASE_REF_ENV] === 'string' ? env[BASE_REF_ENV].trim() : '';
  const explicit = typeof explicitBaseRef === 'string' ? explicitBaseRef.trim() : '';

  if (!signal.enforced) {
    if (!explicit) {
      return {
        decision: 'SKIP',
        reason:
          `${ENFORCE_ENV} is not set, so this execution is NOT a VTO enforcement lane and the ` +
          'live mutation-boundary diff does not apply to it. The static boundary controls ' +
          '(manifest justification, matcher, protected-path refusal) ran regardless.',
      };
    }
    // An explicit command-line base ref is a deliberate manual invocation.
    // Still fail-closed: a ref that does not resolve is an error, not a pass.
    if (!refExists(explicit)) {
      return {
        decision: 'FAIL',
        reason: `base ref ${JSON.stringify(explicit)} was named on the command line but does not resolve to a commit in this checkout.`,
      };
    }
    return { decision: 'ENFORCE', baseRef: explicit };
  }

  // Enforcement declared. From here, every unusable input is a FAILURE.
  if (explicit && declared && explicit !== declared) {
    return {
      decision: 'FAIL',
      reason:
        `${ENFORCE_ENV} is on but two different base authorities were supplied: ` +
        `${BASE_REF_ENV}=${JSON.stringify(declared)} and command-line ${JSON.stringify(explicit)}. ` +
        'Refusing to pick one.',
    };
  }

  const baseRef = declared || explicit;
  if (!baseRef) {
    return {
      decision: 'FAIL',
      reason:
        `${ENFORCE_ENV} is on but ${BASE_REF_ENV} is unset or empty. An enforcing lane must name ` +
        'the base authority it is judged against; enforcement cannot degrade to a skip.',
    };
  }
  if (!refExists(baseRef)) {
    return {
      decision: 'FAIL',
      reason:
        `${ENFORCE_ENV} is on but the declared base authority ${JSON.stringify(baseRef)} does not ` +
        'resolve to a commit in this checkout. An unrunnable guard on an enforcing lane is a ' +
        'failure, never a pass.',
    };
  }
  return { decision: 'ENFORCE', baseRef };
}

function main() {
  const markdownPath = path.join(ROOT, MANIFEST);
  if (!fs.existsSync(markdownPath)) {
    console.error(`FAIL: ${MANIFEST} is missing -- the authorized boundary is undefined.`);
    process.exit(1);
  }

  const { patterns, problems } = parseAuthorizedPatterns(fs.readFileSync(markdownPath, 'utf8'));
  if (problems.length > 0) {
    console.error('FAIL: the authorized-path table is incomplete:');
    for (const problem of problems) console.error(`  - ${problem}`);
    process.exit(1);
  }
  if (patterns.length === 0) {
    console.error(`FAIL: ${MANIFEST} declares no authorized paths.`);
    process.exit(1);
  }

  const mode = resolveScopeMode({ explicitBaseRef: process.argv[2] || null });

  if (mode.decision === 'FAIL') {
    console.error(`FAIL: ${mode.reason}`);
    process.exit(1);
  }

  if (mode.decision === 'SKIP') {
    // Reported, never silent, and never dressed up as a pass of the live
    // check: the static half genuinely passed, the live half did not run.
    console.log('─'.repeat(64));
    console.log('LIVE MUTATION-BOUNDARY DIFF: NOT APPLICABLE');
    console.log('─'.repeat(64));
    console.log(mode.reason);
    console.log(`Authorized patterns parsed: ${patterns.length}`);
    console.log(`To enforce, set ${ENFORCE_ENV}=1 and ${BASE_REF_ENV}=<approved base>,`);
    console.log('or name a base ref on the command line.');
    process.exit(0);
  }

  const { baseRef } = mode;
  let changedPaths = [];
  try {
    changedPaths = diffChangedPaths(baseRef);
  } catch (err) {
    console.error(`FAIL: could not diff against ${baseRef}: ${err.message}`);
    process.exit(1);
  }

  const { authorized, unauthorized } = classifyChangedPaths(changedPaths, patterns);

  console.log('─'.repeat(64));
  console.log(`Base ref:              ${baseRef}`);
  console.log(`Authorized patterns:   ${patterns.length}`);
  console.log(`Changed paths:         ${changedPaths.length}`);
  console.log(`Within boundary:       ${authorized.length}`);
  console.log(`Outside boundary:      ${unauthorized.length}`);
  console.log('─'.repeat(64));

  if (unauthorized.length > 0) {
    console.error('FAIL: this lane touched paths the integration manifest does not authorize:');
    for (const changedPath of unauthorized) console.error(`  - ${changedPath}`);
    console.error('');
    console.error(`Either revert them, or add a row to ${MANIFEST} with a real reason and`);
    console.error('source authority. Do not widen the boundary to make a diff pass.');
    process.exit(1);
  }

  console.log('PASS: every changed path is inside the authorized P3-C boundary.');
  process.exit(0);
}

module.exports = {
  parseAuthorizedPatterns,
  matchesPattern,
  classifyChangedPaths,
  readEnforcementSignal,
  resolveScopeMode,
  diffChangedPaths,
  refExistsInCheckout,
  MANIFEST,
  ENFORCE_ENV,
  BASE_REF_ENV,
};

if (require.main === module) main();
