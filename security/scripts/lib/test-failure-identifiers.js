'use strict';

/**
 * Parses failing-test identifiers out of `node --test` output, in either of
 * its two reporter formats.
 *
 * Empirically verified against real `node --test`/`--test-reporter=tap`
 * output (Node v24.14.0) rather than assumed from documentation — the
 * defaults did not match this repo's own prior TAP-recognition bug on a
 * different branch, so nothing here is taken on faith:
 *
 * - spec reporter: `▶ <name>` opens a nested block; each of its children is
 *   printed indented two spaces deeper; the block closes with a `✖`/`✔`
 *   result line for `<name>` AT THE SAME INDENTATION AS THE `▶` THAT OPENED
 *   IT. That closing line is a rollup of its children, not a distinct leaf
 *   failure — counting it too would both double-count and destabilize
 *   identity (its presence depends on which children exist, not on any
 *   single stable test).
 * - tap reporter: every `not ok` block — leaf or aggregate — carries
 *   `type: 'test'` (there is no `type: 'suite'` marker despite what that
 *   might suggest); the real distinguishing YAML field is `failureType`.
 *   An aggregate rollup (a `describe`/nested `test` block that failed only
 *   because a child failed) is always `failureType: 'subtestsFailed'`; a
 *   genuine leaf failure carries some other value (`testCodeFailure`,
 *   `cancelledByParent`, ...) or, defensively, none at all — either way it
 *   is treated as a real leaf so a failure mode this parser doesn't
 *   recognize is never silently dropped.
 *
 * run-project-checks-regression.js always requests
 * `--test-reporter=tap --test-reporter-destination=stdout` explicitly so it
 * never depends on ambiguous reporter-selection defaults; the spec-format
 * path here exists as a defensive fallback for any other caller.
 */

const SPEC_OPEN_LINE = /^(\s*)▶ (.+)$/;
const SPEC_RESULT_LINE = /^(\s*)[✖✔] (.+?) \(\d+(?:\.\d+)?ms\)\s*$/;
const SPEC_FAIL_MARK = /^\s*✖ /;
const TAP_SUBTEST_LINE = /^(\s*)# Subtest: (.+)$/;
const TAP_RESULT_LINE = /^(\s*)(ok|not ok) \d+ - (.+?)\s*$/;
const TAP_FAILURE_TYPE_FIELD = /^\s*failureType: '?([\w]+)'?\s*$/;
const TAP_BLOCK_OPEN = /^(\s*)---\s*$/;
// The YAML diagnostic block closes with `...` (three literal dots), NOT a
// second `---` — using the same fence for both left the scan unterminated,
// so it ran past the intended block and used whichever `failureType` it
// last saw anywhere later in the file.
const TAP_BLOCK_CLOSE = /^(\s*)\.\.\.\s*$/;

function depthOf(prefix) {
  return prefix.length;
}

function qualify(stack, depth, ownName) {
  const context = stack.filter((frame) => frame.depth < depth).map((frame) => frame.name);
  return [...context, ownName].filter(Boolean).join(' > ');
}

const SPEC_RECAP_HEADING = /^\s*✖ failing tests:\s*$/;

function parseSpecFormat(lines) {
  const identifiers = new Set();
  const stack = [];

  for (const line of lines) {
    // Past this point the spec reporter re-prints each failure's result
    // line a second time (flattened, without its original nesting) inside
    // a human-readable recap section — not new information, and without
    // context to correctly (re-)qualify it against the stack above.
    if (SPEC_RECAP_HEADING.test(line)) break;

    const openMatch = line.match(SPEC_OPEN_LINE);
    if (openMatch) {
      stack.push({ depth: depthOf(openMatch[1]), name: openMatch[2].trim() });
      continue;
    }

    const resultMatch = line.match(SPEC_RESULT_LINE);
    if (!resultMatch) continue;
    const depth = depthOf(resultMatch[1]);
    const name = resultMatch[2].trim();

    const top = stack[stack.length - 1];
    if (top && top.depth === depth && top.name === name) {
      // Closing rollup line for the block `▶ <name>` opened above — a
      // summary of its children, not a leaf result in its own right.
      stack.pop();
      continue;
    }

    if (SPEC_FAIL_MARK.test(line)) {
      identifiers.add(qualify(stack, depth, name));
    }
  }

  return identifiers;
}

function parseTapFormat(lines) {
  const identifiers = new Set();
  const stack = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    const subtestMatch = line.match(TAP_SUBTEST_LINE);
    if (subtestMatch) {
      const depth = depthOf(subtestMatch[1]);
      while (stack.length > 0 && stack[stack.length - 1].depth >= depth) stack.pop();
      stack.push({ depth, name: subtestMatch[2].trim() });
      continue;
    }

    const resultMatch = line.match(TAP_RESULT_LINE);
    if (!resultMatch || resultMatch[2] !== 'not ok') continue;
    const depth = depthOf(resultMatch[1]);
    const ownName = resultMatch[3].trim();

    let failureType = null;
    const fenceMatch = lines[i + 1] && lines[i + 1].match(TAP_BLOCK_OPEN);
    if (fenceMatch && depthOf(fenceMatch[1]) > depth) {
      for (let j = i + 2; j < lines.length; j++) {
        const closeMatch = lines[j].match(TAP_BLOCK_CLOSE);
        if (closeMatch && depthOf(closeMatch[1]) === depthOf(fenceMatch[1])) break;
        const typeMatch = lines[j].match(TAP_FAILURE_TYPE_FIELD);
        if (typeMatch) failureType = typeMatch[1];
      }
    }

    if (failureType === 'subtestsFailed') continue; // aggregate rollup, not a leaf

    identifiers.add(qualify(stack, depth, ownName));
  }

  return identifiers;
}

/**
 * @param {string} rawOutput combined stdout of a `node --test` invocation,
 *   in either the spec or tap reporter format
 * @returns {string[]} stable, deduplicated failing-test identifiers
 */
function parseFailureIdentifiers(rawOutput) {
  if (!rawOutput) return [];
  const lines = rawOutput.split(/\r?\n/);

  const isTap = lines.some((l) => l.startsWith('TAP version'));
  const identifiers = isTap ? parseTapFormat(lines) : parseSpecFormat(lines);

  // A spec-format file with zero ▶/✖ lines at all (e.g. genuinely all
  // passing, or an unrecognized format) never falls back to TAP parsing —
  // an empty result is a legitimate "no failures", not evidence of a wrong
  // format guess. Format detection above (the `TAP version` banner) is the
  // only branch point.
  return [...identifiers];
}

module.exports = { parseFailureIdentifiers, SPEC_RESULT_LINE, TAP_RESULT_LINE };
