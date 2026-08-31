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
 *
 * FILE DISAMBIGUATION (found by an independent hostile audit, reproduced
 * before fixing): when `node --test` is given several files in one
 * invocation — exactly what run-project-checks-regression.js does for a
 * multi-file `npm run test:*` script like `test:privacy` — the TAP output
 * does NOT wrap each file in its own top-level subtest. Two identically
 * named tests in two different files are therefore indistinguishable from
 * the `# Subtest:` nesting chain alone: a PR that fixes test "X" in file A
 * while introducing a genuinely new, unrelated failure also named "X" in
 * file B would net to zero identifier change and be silently scored
 * PASS_PRE_EXISTING_BASE_FAILURE. Every TAP leaf/aggregate block carries its
 * own `location: '<file>:<line>:<col>'` field regardless of nesting depth,
 * so the leaf's own source file is read from there and prefixed onto its
 * identifier — this is why the leaf/aggregate lookahead below now captures
 * `location` alongside `failureType` instead of just the latter.
 *
 * CWD-RELATIVE, NOT ABSOLUTE (a second independent-audit round caught this
 * before it shipped): Node resolves `location:` to an ABSOLUTE path from
 * the process's cwd. run-project-checks-regression.js runs the base suite
 * from a throwaway `os.tmpdir()` worktree and the head suite from the real
 * checkout — two different absolute directories BY DESIGN, every single
 * run. Prefixing with the raw absolute path therefore made every
 * *unmodified* pre-existing failure look like a different file at base vs.
 * head — worse than the original bug, since it fires on essentially every
 * real PR with any unrelated pre-existing red test, not just an exact
 * cross-file name collision. `parseFailureIdentifiers`/`parseTapFormat`/
 * `parseSpecFormat` therefore take an optional `cwd` and relativize the
 * extracted path against it (`path.relative`) before using it — the caller
 * MUST pass its own run's cwd for the identifier to be stable across two
 * differently-rooted runs of the same logical file. Omitting `cwd` falls
 * back to the raw (absolute) path, which is only safe for a caller that
 * never compares identifiers across two different working directories.
 */

const path = require('node:path');

const SPEC_OPEN_LINE = /^(\s*)▶ (.+)$/;
const SPEC_RESULT_LINE = /^(\s*)[✖✔] (.+?) \(\d+(?:\.\d+)?ms\)\s*$/;
const SPEC_FAIL_MARK = /^\s*✖ /;
const TAP_SUBTEST_LINE = /^(\s*)# Subtest: (.+)$/;
const TAP_RESULT_LINE = /^(\s*)(ok|not ok) \d+ - (.+?)\s*$/;
const TAP_FAILURE_TYPE_FIELD = /^\s*failureType: '?([\w]+)'?\s*$/;
const TAP_LOCATION_FIELD = /^\s*location: '(.+)'\s*$/;
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

// Strips the trailing `:<line>:<col>` off a TAP `location:` value, leaving
// just the source file path. Greedy `.+` backtracking correctly finds the
// LAST `:digits:digits` pair even when the path itself contains colons
// (e.g. a Windows drive letter, `C:\...`).
const LOCATION_LINE_COL = /^(.+):\d+:\d+$/;

function fileFromLocation(location, cwd) {
  if (!location) return null;
  const match = location.match(LOCATION_LINE_COL);
  const filePath = match ? match[1] : location;
  if (!cwd) return filePath;
  // Normalize to forward slashes so an identifier computed on Windows (this
  // repo's primary dev environment) and one computed on Linux CI describe
  // the same logical file identically, and so the separator itself can
  // never be the reason two runs' identifiers fail to match.
  return path.relative(cwd, filePath).split(path.sep).join('/');
}

const SPEC_RECAP_HEADING = /^\s*✖ failing tests:\s*$/;

function parseSpecFormat(lines, cwd) {
  const identifiers = new Set();
  const stack = [];
  // The recap section below prints "test at <file>:<line>:<col>" once per
  // leaf failure, in the same top-to-bottom order the main body reports
  // them — used only to recover the source file per failure (see the FILE
  // DISAMBIGUATION header note); consumed in order, not correlated by name,
  // since name is exactly what can collide across files.
  const recapLocations = extractSpecRecapLocations(lines);
  let recapIndex = 0;

  for (const line of lines) {
    // Past this point the spec reporter re-prints each failure's result
    // line a second time (flattened, without its original nesting) inside
    // a human-readable recap section — not new information for identity
    // purposes (recapLocations above already extracted what's needed from
    // it), and without context to correctly (re-)qualify it against the
    // stack above.
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
      const file = fileFromLocation(recapLocations[recapIndex], cwd);
      recapIndex += 1;
      const qualifiedName = qualify(stack, depth, name);
      identifiers.add(file ? `${file} :: ${qualifiedName}` : qualifiedName);
    }
  }

  return identifiers;
}

const SPEC_TEST_AT_LINE = /^test at (.+)$/;

function extractSpecRecapLocations(lines) {
  const recapStart = lines.findIndex((l) => SPEC_RECAP_HEADING.test(l));
  if (recapStart === -1) return [];
  const locations = [];
  for (let i = recapStart + 1; i < lines.length; i++) {
    const match = lines[i].match(SPEC_TEST_AT_LINE);
    if (match) locations.push(match[1].trim());
  }
  return locations;
}

function parseTapFormat(lines, cwd) {
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
    let location = null;
    const fenceMatch = lines[i + 1] && lines[i + 1].match(TAP_BLOCK_OPEN);
    if (fenceMatch && depthOf(fenceMatch[1]) > depth) {
      for (let j = i + 2; j < lines.length; j++) {
        const closeMatch = lines[j].match(TAP_BLOCK_CLOSE);
        if (closeMatch && depthOf(closeMatch[1]) === depthOf(fenceMatch[1])) break;
        const typeMatch = lines[j].match(TAP_FAILURE_TYPE_FIELD);
        if (typeMatch) failureType = typeMatch[1];
        const locationMatch = lines[j].match(TAP_LOCATION_FIELD);
        if (locationMatch) location = locationMatch[1];
      }
    }

    if (failureType === 'subtestsFailed') continue; // aggregate rollup, not a leaf

    // Prefix with the leaf's own source file (see the FILE DISAMBIGUATION
    // header note) so two identically-named tests in two different files
    // can never collide into the same identifier. `location` is absent only
    // in a failure mode this parser doesn't otherwise recognize; falling
    // back to the unqualified name rather than dropping the failure keeps
    // the existing fail-open-on-the-side-of-recording-it behavior for that
    // edge case.
    const file = fileFromLocation(location, cwd);
    const qualifiedName = qualify(stack, depth, ownName);
    identifiers.add(file ? `${file} :: ${qualifiedName}` : qualifiedName);
  }

  return identifiers;
}

/**
 * @param {string} rawOutput combined stdout of a `node --test` invocation,
 *   in either the spec or tap reporter format
 * @param {object} [options]
 * @param {string} [options.cwd] the absolute directory `node --test` was
 *   run from. REQUIRED for a stable identifier when comparing failures
 *   across two runs from different working directories (e.g. a base-SHA
 *   worktree vs. the head checkout) — see the CWD-RELATIVE header note.
 *   Omitted, the extracted file path is left absolute.
 * @returns {string[]} stable, deduplicated failing-test identifiers
 */
function parseFailureIdentifiers(rawOutput, { cwd } = {}) {
  if (!rawOutput) return [];
  const lines = rawOutput.split(/\r?\n/);

  const isTap = lines.some((l) => l.startsWith('TAP version'));
  const identifiers = isTap ? parseTapFormat(lines, cwd) : parseSpecFormat(lines, cwd);

  // A spec-format file with zero ▶/✖ lines at all (e.g. genuinely all
  // passing, or an unrecognized format) never falls back to TAP parsing —
  // an empty result is a legitimate "no failures", not evidence of a wrong
  // format guess. Format detection above (the `TAP version` banner) is the
  // only branch point.
  return [...identifiers];
}

module.exports = { parseFailureIdentifiers, fileFromLocation, SPEC_RESULT_LINE, TAP_RESULT_LINE };
