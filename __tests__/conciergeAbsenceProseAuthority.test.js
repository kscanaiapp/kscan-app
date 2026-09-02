// CON-ABSENCE-005 — a feature flag must not decide whether the assistant may
// state a falsehood about the customer's Closet.
//
// WHAT THIS FILE EXISTS FOR
//
// The absence guard itself (enforceClosetAbsenceProseSafety) landed in #256 and
// is unit-tested in
// supabase/functions/stylechat-generate/eliseOwnershipProseSafety.test.ts.
// This file tests the WIRING, which is where the finding actually survived:
// the guard was invoked inside `if (config.flags.conciergeV1)`, and
// `ELISE_CONCIERGE_V1_ENABLED` defaults false and is unset on staging. So in the
// only configuration that ships, a flag-off Base Elise turn — the exact turn
// CON-ABSENCE-005 was observed on — still had no absence guard at all. The
// mechanism existed and was inert.
//
// A source-text `includes()` check would be brittle here (a reformat or a
// renamed variable would silently stop testing anything), so the call site is
// located in the TypeScript AST and its real ancestor chain is inspected. That
// makes "is this call inside a conciergeV1 gate?" an actual structural
// question rather than a string coincidence.
//
// `.test.js`, not `.test.ts`: scripts/run-all-tests.js discovers on that literal
// suffix, so a `.test.ts` file would never run in certification.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');

const ROOT = path.resolve(__dirname, '..');
const INDEX = 'supabase/functions/stylechat-generate/index.ts';
const CONFIG = 'supabase/functions/stylechat-generate/eliseConfig.ts';
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

function sourceFile(relative) {
  return ts.createSourceFile(
    relative,
    read(relative),
    ts.ScriptTarget.ES2020,
    /* setParentNodes */ true,
  );
}

/** Every call expression to a bare function of this name. */
function findCalls(node, name, found = []) {
  if (
    ts.isCallExpression(node)
    && ts.isIdentifier(node.expression)
    && node.expression.text === name
  ) {
    found.push(node);
  }
  // The callback must return undefined: ts.forEachChild short-circuits the walk
  // the moment a callback returns anything truthy, so `=> findCalls(...)` would
  // stop after the first child and quietly find nothing.
  node.forEachChild((child) => {
    findCalls(child, name, found);
  });
  return found;
}

/** The conditions of every `if` statement enclosing this node, innermost first. */
function enclosingIfConditions(node) {
  const conditions = [];
  for (let current = node.parent; current; current = current.parent) {
    if (ts.isIfStatement(current)) conditions.push(current.expression.getText(current.getSourceFile()));
  }
  return conditions;
}

// ── The wiring contract ─────────────────────────────────────────────────────

test('CON-ABSENCE-005: the absence guard is invoked at all', () => {
  const calls = findCalls(sourceFile(INDEX), 'enforceClosetAbsenceProseSafety');
  assert.equal(calls.length, 1, 'exactly one call site — two would be two authorities');
});

test('CON-ABSENCE-005: NO feature flag gates the absence guard', () => {
  const [call] = findCalls(sourceFile(INDEX), 'enforceClosetAbsenceProseSafety');
  const conditions = enclosingIfConditions(call);
  for (const condition of conditions) {
    assert.doesNotMatch(
      condition,
      /config\.flags\./,
      `the absence guard must not sit behind a feature flag, found: if (${condition})`,
    );
  }
});

test('CON-ABSENCE-005: specifically not behind conciergeV1, which defaults FALSE', () => {
  // The precise regression. This flag is off in every shipping configuration,
  // so gating the guard on it is the same as not having the guard.
  const [call] = findCalls(sourceFile(INDEX), 'enforceClosetAbsenceProseSafety');
  const conditions = enclosingIfConditions(call).join(' | ');
  assert.doesNotMatch(conditions, /conciergeV1/, 'the guard was inert in the only config that ships');

  // Pin the default that makes this a real-world failure rather than a theory.
  assert.match(
    read(CONFIG),
    /conciergeV1:\s*parseBooleanEnv\(env,\s*'ELISE_CONCIERGE_V1_ENABLED',\s*false\)/,
    'if this ever defaults true the finding changes shape — fail loudly rather than drift',
  );
});

test('the OWNERSHIP half is EVIDENCE-gated and no longer FLAG-gated (WC-003)', () => {
  // SUPERSEDES the original form of this test, which required
  // `config.flags.conciergeV1` in this condition.
  //
  // #256 gave two reasons for the asymmetry. The substantive one -- "ownership
  // stands down without evidence, or it would suppress ordinary Base Elise
  // answers" -- is about the EVIDENCE gate, and that gate is unchanged and
  // still asserted below. The other was explicitly procedural: widening the
  // flag gate "would be a different, unreviewed change".
  //
  // The Build 34 Concierge deep audit (2026-09-02) is that review, and it found
  // the flag gate actively harmful. `ELISE_CONCIERGE_V1_ENABLED` defaults false
  // and is the configuration that ships, while `listClosetItems` is gated on
  // K+ and `closetWardrobeContextV1` -- NOT on Concierge. So the shipping flag
  // set had owned Closet evidence and no ownership guard, and a K+ customer
  // could be told "you already have a black blazer" about a blazer they do not
  // own. That is the same shape as CON-ABSENCE-005, which this very file was
  // created to close for the absence half.
  const [call] = findCalls(sourceFile(INDEX), 'enforceOwnershipProseSafety');
  const conditions = enclosingIfConditions(call).join(' | ');
  assert.ok(
    !/conciergeV1/.test(conditions),
    'a capability flag must not decide whether a false ownership claim may reach the customer',
  );
  assert.match(
    conditions,
    /adviceShortlistForProseSafety\.length > 0|proseSafetyOwnedFocus/,
    'the ownership guard must stay evidence-gated',
  );
});

test('the absence guard runs BEFORE the ownership guard, on the same text', () => {
  const file = sourceFile(INDEX);
  const [absence] = findCalls(file, 'enforceClosetAbsenceProseSafety');
  const [ownership] = findCalls(file, 'enforceOwnershipProseSafety');
  assert.ok(
    absence.getStart() < ownership.getStart(),
    'chaining order is what stops the ownership half resurrecting a removed sentence',
  );
  assert.match(
    ownership.getText(file),
    /text:\s*assistantTextSafe/,
    'the ownership half must read the absence-filtered text, not the raw model output',
  );
});

// ── The fallback contract ───────────────────────────────────────────────────

test('CON-ABSENCE-005: a no-census turn does not fall back to Concierge wording', () => {
  const file = sourceFile(INDEX);
  const [call] = findCalls(file, 'enforceClosetAbsenceProseSafety');
  const text = call.getText(file);
  // The Concierge copy promises "wardrobe evidence" — exactly what a no-census
  // turn lacks. Falling back to it would swap one unsupported implication for
  // another.
  assert.match(
    text,
    /neutralFallback:\s*censusAvailable\s*\?\s*CONCIERGE_NEUTRAL_OWNERSHIP_FALLBACK\s*:\s*BASE_NEUTRAL_ADVICE_FALLBACK/,
    'the fallback must be chosen by census availability',
  );
});

test('the base fallback claims nothing about the Closet in either direction', () => {
  const source = read(INDEX);
  const match = source.match(/const BASE_NEUTRAL_ADVICE_FALLBACK\s*=\s*\n?\s*'([^']+)'/);
  assert.ok(match, 'BASE_NEUTRAL_ADVICE_FALLBACK must exist');
  const copy = match[1];
  for (const forbidden of ['closet', 'wardrobe', 'own', 'you have', "don't have", 'evidence']) {
    assert.doesNotMatch(
      copy,
      new RegExp(forbidden, 'i'),
      `fallback copy must not mention "${forbidden}": ${copy}`,
    );
  }
});

// ── Provenance still comes from the census, not the flag ────────────────────

test('census availability still folds in the census honesty conditions', () => {
  const file = sourceFile(INDEX);
  const [call] = findCalls(file, 'enforceClosetAbsenceProseSafety');
  // Walk up to the enclosing block and read the whole statement group, so this
  // survives the variable being declared a few lines above the call.
  let block = call.parent;
  while (block && !ts.isBlock(block)) block = block.parent;
  const text = block.getText(file);
  // SUPERSEDES the inline expression this used to pin. WC-002 moved those
  // conditions into ONE exported predicate, `censusLicensesAbsenceClaims`,
  // which the structured gap layer reads too -- so the two can no longer drift
  // apart -- and added a third condition the inline form was missing: a
  // category map truncated to its top-N slice cannot be read negatively
  // either, because a dropped category looks exactly like one the customer
  // owns none of. Pinning the old literal here would now require the WEAKER
  // rule, so the assertion moves to the predicate and the predicate's own
  // conditions are asserted where they live.
  assert.match(
    text,
    /censusAvailable\s*=\s*censusLicensesAbsenceClaims\(census\)/,
    'permission must come from the single shared absence-licence predicate',
  );
  const census = read('supabase/functions/stylechat-generate/eliseClosetCensus.ts');
  const predicate = census.slice(
    census.indexOf('export function censusLicensesAbsenceClaims'),
    census.indexOf('export function censusConfirmsRoleAbsent'),
  );
  assert.match(predicate, /if \(!census\.exhaustive\) return false;/);
  assert.match(predicate, /if \(census\.unclassifiedItems > 0\) return false;/);
  assert.match(predicate, /if \(census\.categoriesTruncated\) return false;/);
  assert.match(text, /count > 0/, 'only counted-non-zero subjects may be treated as present');
});
