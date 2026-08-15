// BUILD 29 — WEAR / COST-PER-WEAR DEFERRAL
//
// Product decision: WEAR_HISTORY = DEFERRED_BUILD30, CPW = DEFERRED_BUILD30.
// Wear is reachable in the audited candidate but production cannot support it
// (`wardrobe_wear_event_items` is not promoted), so a tap on "Wore this" would
// record a wear the wardrobe can never read back.
//
// WHY THIS FILE IS AN AST TEST AND NOT A GREP.
// The claim under test is REACHABILITY: "no reachable user path invokes a wear
// write". A source-string search for `WEAR_TRACKING_ACTIVE` proves only that
// the identifier appears somewhere in the file — it would pass just as happily
// if the guard sat on an unrelated element three hundred lines away. So each
// wear entry point is located as a syntax node and the guard must be proven to
// DOMINATE it: an enclosing conditional whose test references the flag. That is
// the same question the renderer asks at runtime.
//
// The wear implementation itself is deliberately preserved for Build 30;
// `wearHistoryContract.test.js` and `wearHistoryProductSurface.test.js` still
// cover it and must not be weakened by this deferral.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const FLAG = 'WEAR_TRACKING_ACTIVE';

function parse(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  return {
    source,
    sourceFile: ts.createSourceFile(filename, source, ts.ScriptTarget.ES2020, true, ts.ScriptKind.TSX),
  };
}

/** Every node in the tree, paired with its ancestor chain (root last). */
function* walk(node, ancestors = []) {
  yield { node, ancestors };
  for (const child of node.getChildren()) yield* walk(child, [node, ...ancestors]);
}

/** True when `node` mentions the deferral flag anywhere inside it. */
function referencesFlag(node) {
  let found = false;
  const visit = (n) => {
    if (found) return;
    if (ts.isIdentifier(n) && n.text === FLAG) {
      found = true;
      return;
    }
    n.forEachChild(visit);
  };
  visit(node);
  return found;
}

/**
 * Does a conditional gated on the flag dominate this node?
 *
 * Only the TEST half of a conditional counts, and the node must sit in a
 * BRANCH of it — otherwise the flag check inside an unrelated sibling
 * expression would satisfy the assertion.
 */
function guardedByFlag(target, ancestors) {
  for (const ancestor of ancestors) {
    if (ts.isConditionalExpression(ancestor)) {
      if (referencesFlag(ancestor.condition)) return true;
    }
    if (ts.isIfStatement(ancestor) && referencesFlag(ancestor.expression)) return true;
    // `{FLAG && <X />}` / `{FLAG ? ... : null}` in JSX both land here.
    if (
      ts.isBinaryExpression(ancestor) &&
      ancestor.operatorToken.kind === ts.SyntaxKind.AmpersandAmpersandToken &&
      referencesFlag(ancestor.left)
    ) {
      return true;
    }
  }
  return false;
}

function findJsxElements(sourceFile, tagName) {
  const hits = [];
  for (const { node, ancestors } of walk(sourceFile)) {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) continue;
    const tag = node.tagName.getText();
    if (tag === tagName) hits.push({ node, ancestors });
  }
  return hits;
}

/* ------------------------------------------------------------------ */
/* The gate itself                                                     */
/* ------------------------------------------------------------------ */

test('the wear deferral gate is off, and is a constant rather than an env flag', () => {
  const { source, sourceFile } = parse('constants/featureFlags.ts');

  // Evaluate the real module rather than reading the literal out of the text:
  // the value the app imports is the value under test.
  const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
  }).outputText;
  const mod = { exports: {} };
  const sandbox = { __DEV__: false, console, exports: mod.exports, module: mod, process: { env: {} } };
  vm.createContext(sandbox);
  new vm.Script(output).runInContext(sandbox);

  assert.equal(mod.exports[FLAG], false, 'Wear must be inactive for Build 29');

  // An env-driven flag is one eas.json edit away from shipping the broken loop.
  // Build 30 must turn Wear on in the same commit that promotes the migration,
  // so the value has to live in source.
  let declaration = null;
  for (const { node } of walk(sourceFile)) {
    if (ts.isVariableDeclaration(node) && node.name.getText() === FLAG) declaration = node;
  }
  assert.ok(declaration, `${FLAG} must be declared in constants/featureFlags.ts`);
  assert.equal(
    declaration.initializer.kind,
    ts.SyntaxKind.FalseKeyword,
    `${FLAG} must be a literal false, not resolved from process.env`,
  );
});

test('no eas.json build profile can activate wear or cost-per-wear', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  for (const [profile, config] of Object.entries(eas.build)) {
    const env = config.env || {};
    for (const key of Object.keys(env)) {
      assert.doesNotMatch(
        key,
        /WEAR_HISTORY|WEAR_TRACKING/i,
        `${profile} must not expose a wear activation variable (${key})`,
      );
    }
    // The separate free-tier CPW surface has its own master switch; production
    // and staging must not carry it either.
    if (profile === 'production' || profile === 'staging' || profile === 'development') {
      assert.equal(
        env.EXPO_PUBLIC_FREE_TIER_COST_PER_WEAR_ENABLED,
        undefined,
        `${profile} must not enable free-tier cost per wear`,
      );
      assert.equal(
        env.EXPO_PUBLIC_FREE_TIER_UTILITY_ENABLED,
        undefined,
        `${profile} must not enable the free-tier utility master switch`,
      );
    }
  }
});

/* ------------------------------------------------------------------ */
/* Reachability: every wear entry point is dominated by the gate        */
/* ------------------------------------------------------------------ */

test('the Closet "Wore this" control is unreachable', () => {
  const { sourceFile } = parse('app/library.tsx');
  const buttons = findJsxElements(sourceFile, 'WoreThisButton');
  assert.equal(buttons.length, 1, 'Closet renders WoreThisButton from one place');
  for (const { node, ancestors } of buttons) {
    assert.ok(
      guardedByFlag(node, ancestors),
      `Closet WoreThisButton is not dominated by ${FLAG}`,
    );
  }
});

test('the Saved Look "Wore this look" control is unreachable', () => {
  const { sourceFile } = parse('app/looks/[id].tsx');
  const buttons = findJsxElements(sourceFile, 'WoreThisButton');
  assert.equal(buttons.length, 1, 'the Look detail renders WoreThisButton from one place');
  for (const { node, ancestors } of buttons) {
    assert.ok(
      guardedByFlag(node, ancestors),
      `Saved Look WoreThisButton is not dominated by ${FLAG}`,
    );
  }
});

test('no navigation pushes the Wear History route', () => {
  for (const relativePath of ['app/library.tsx', 'app/looks/[id].tsx']) {
    const { sourceFile } = parse(relativePath);
    for (const { node, ancestors } of walk(sourceFile)) {
      if (!ts.isStringLiteral(node) || node.text !== '/wear-history') continue;
      assert.ok(
        guardedByFlag(node, ancestors),
        `${relativePath} navigates to /wear-history without the ${FLAG} guard`,
      );
    }
  }
});

test('the Wear History route redirects and issues no wear query when deferred', () => {
  const { sourceFile } = parse('app/wear-history.tsx');

  // Reached by deep link or by restored navigation state even with the Closet
  // entry hidden, so the route file itself must refuse to render.
  let redirects = false;
  for (const { node, ancestors } of walk(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (node.expression.getText() !== 'router.replace') continue;
    if (guardedByFlag(node, ancestors)) redirects = true;
  }
  assert.ok(redirects, 'wear-history must redirect away while Wear is deferred');

  // And nothing below the redirect may render or query. The mount effect is
  // guarded, and the component returns null before the retry control — which is
  // itself a `loadFirstPage` call site that hiding the nav entry did not cover.
  let mountQueryGuarded = false;
  for (const { node, ancestors } of walk(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (node.expression.getText() !== 'loadFirstPage') continue;
    if (guardedByFlag(node, ancestors)) mountQueryGuarded = true;
  }
  assert.ok(mountQueryGuarded, 'the wear-history mount query is not guarded');

  let bailsOut = false;
  for (const { node } of walk(sourceFile)) {
    if (!ts.isReturnStatement(node) || !node.expression) continue;
    if (node.expression.kind !== ts.SyntaxKind.NullKeyword) continue;
    const parentIf = node.parent && ts.isIfStatement(node.parent) ? node.parent : null;
    if (parentIf && referencesFlag(parentIf.expression)) bailsOut = true;
  }
  assert.ok(
    bailsOut,
    'wear-history must return null on the deferral gate so its retry control is unreachable',
  );
});

/* ------------------------------------------------------------------ */
/* Closet still works without wear                                     */
/* ------------------------------------------------------------------ */

test('Closet cards fall back to the added date instead of claiming "No wears recorded"', () => {
  const { sourceFile } = parse('app/library.tsx');

  let fallback = null;
  for (const { node } of walk(sourceFile)) {
    if (!ts.isVariableDeclaration(node) || node.name.getText() !== 'wearContextLabel') continue;
    fallback = node;
  }
  assert.ok(fallback, 'Closet must still compute a card subtitle');

  // The FIRST statement of the label must be the deferral early-return, so no
  // wear vocabulary can reach the card while the feature is deferred.
  const body = fallback.initializer.body;
  const first = body.statements[0];
  assert.ok(
    ts.isIfStatement(first) && referencesFlag(first.expression),
    'the wear label must short-circuit on the deferral gate before any wear text',
  );
  assert.match(
    first.thenStatement.getText(),
    /formatDate/,
    'the deferred label must fall back to the item date, which is what it showed before wear existed',
  );

  // The wear query must not run at all.
  let guardedQuery = false;
  for (const { node, ancestors } of walk(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (node.expression.getText() !== 'loadWearStats') continue;
    if (guardedByFlag(node, ancestors)) guardedQuery = true;
  }
  assert.ok(guardedQuery, 'Closet must not query wear statistics while Wear is deferred');
});
