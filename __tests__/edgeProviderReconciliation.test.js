// Guards the Checkpoint 3 reconciliation of deployed provider-function drift.
//
// Four Edge Functions had been hot-patched in production and never committed.
// Their deployed source matched no commit in this repository, which meant a
// redeploy from a clean checkout would have silently reverted every one of the
// fixes — reopening an account-guard hole and a 500.
//
// The deltas are now committed. These tests exist so that a future refactor,
// merge or revert cannot quietly undo them again: each assertion names the
// specific production behaviour that must survive.
//
// Captured evidence and the reconciliation plan:
//   docs/evidence/deployed-drift-20260803/README.md

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FUNCTIONS = path.join(ROOT, 'supabase', 'functions');

function readFunction(slug) {
  return fs.readFileSync(path.join(FUNCTIONS, slug, 'index.ts'), 'utf8');
}

/**
 * Both of these functions were 500ing in production.
 *
 * The cause is recorded in the deployed source: the Supabase `--use-api`
 * bundler does not follow `await import()`, so a DYNAMIC import of the shared
 * account-state guard left the module unbundled at runtime. A static top-level
 * import is what makes the bundler include it — which is why this test asserts
 * the import FORM, not merely that the symbol appears somewhere.
 */
for (const slug of ['product-search-deals', 'search-vinted-secondhand']) {
  test(`${slug} statically imports the shared account-state guard`, () => {
    const source = readFunction(slug);
    assert.match(
      source,
      /^import \{ assertAccountActiveIfAuthenticated \} from '\.\.\/_shared\/deletion\/assertAccountActiveIfAuthenticated\.ts';$/m,
      'the guard must be a static top-level import — a dynamic import() is not bundled',
    );
    assert.ok(
      !/await import\(['"]\.\.\/_shared\/deletion/.test(source),
      'the dynamic import that caused the production 500 must not return',
    );
  });

  test(`${slug} invokes the account-state guard before doing any work`, () => {
    const source = readFunction(slug);
    assert.match(source, /const blocked = await assertAccountActiveIfAuthenticated\(req\);\s*\n\s*if \(blocked\) return blocked;/);

    // The guard must run before the handler does any work, or a deactivated
    // account still costs a paid upstream request.
    //
    // Positions are measured INSIDE the Deno.serve handler. Measuring across
    // the whole file would compare against helper *definitions*, which sit
    // above the handler but only execute when it calls them.
    const handlerAt = source.indexOf('Deno.serve(');
    assert.ok(handlerAt > -1, 'the request handler must exist');
    const handler = source.slice(handlerAt);

    const guardAt = handler.indexOf('assertAccountActiveIfAuthenticated(req)');
    const bodyReadAt = handler.search(/req\.(json|text)\(/);
    assert.ok(guardAt > -1, 'the guard must be called inside the handler');
    if (bodyReadAt > -1) {
      assert.ok(
        guardAt < bodyReadAt,
        'the guard must run before the request body is read and before any provider call',
      );
    }
  });
}

test('kickscrew-sneaker-description reads its own credential, not the shared one', () => {
  const source = readFunction('kickscrew-sneaker-description');
  assert.match(source, /Deno\.env\.get\('KICKSCREW_RAPIDAPI_KEY'\)/);
  assert.ok(
    !/Deno\.env\.get\('RAPIDAPI_KEY'\)/.test(source),
    'reverting to the shared RAPIDAPI_KEY would break the deployed function, which reads KICKSCREW_RAPIDAPI_KEY',
  );
});

test('product-search-deals still reads the shared credential', () => {
  // Deliberate asymmetry: only KicksCrew was separated. Asserting this keeps a
  // future "consistency" refactor from renaming a secret that production has
  // not been given.
  const source = readFunction('product-search-deals');
  assert.match(source, /Deno\.env\.get\('RAPIDAPI_KEY'\)/);
});

test('nike-shoe-details retains the experimental warning, with the decision recorded', () => {
  // Production v68 has these lines deleted. That deletion was reviewed and NOT
  // adopted: nothing recorded who determined the upstream endpoint had started
  // working, and a deleted caveat is not evidence the caveat stopped being true.
  // The warning is inert, so retaining it cannot revert production behaviour.
  const source = readFunction('nike-shoe-details');
  assert.match(source, /Do not wire into production flows until a supported URL or endpoint is confirmed/);
  assert.match(source, /DECISION 2026-08-03 — warning DELIBERATELY RETAINED/);
});

test('nike-shoe-details is still unwired from every user-facing path', () => {
  // The warning is only honoured if nothing calls it. This asserts the claim
  // the decision block makes, rather than trusting it.
  const searchRoots = ['app', 'components', 'hooks', 'contexts', 'stores', 'store'];
  const callers = [];

  const walk = (dir) => {
    if (!fs.existsSync(dir)) return;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(full);
        continue;
      }
      if (!/\.(ts|tsx|js|jsx)$/.test(entry.name)) continue;
      const source = fs.readFileSync(full, 'utf8');
      if (/fetchNikeShoeDetails|['"]nike-shoe-details['"]/.test(source)) {
        callers.push(path.relative(ROOT, full));
      }
    }
  };

  for (const root of searchRoots) walk(path.join(ROOT, root));
  assert.deepEqual(
    callers,
    [],
    `nike-shoe-details reached a user-facing path: ${callers.join(', ')}. Either wire it deliberately and retire the warning with evidence, or remove the caller.`,
  );
});

test('the reconciliation evidence and plan ship with the change', () => {
  const evidenceDir = path.join(ROOT, 'docs', 'evidence', 'deployed-drift-20260803');
  assert.ok(fs.existsSync(path.join(evidenceDir, 'README.md')));
  for (const slug of [
    'product-search-deals', 'search-vinted-secondhand',
    'kickscrew-sneaker-description', 'nike-shoe-details',
  ]) {
    assert.ok(
      fs.existsSync(path.join(evidenceDir, `${slug}.diff`)),
      `the captured diff for ${slug} must remain committed as the record of what was adopted`,
    );
  }
});
