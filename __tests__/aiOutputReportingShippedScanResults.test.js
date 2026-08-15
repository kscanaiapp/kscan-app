/**
 * KSB29-021 / KSB29-034 / KSB29-035 — AI-output reporting on the Scan Results
 * surface PRODUCTION ACTUALLY RENDERS.
 *
 * WHAT THE OLD COVERAGE PROVED, AND WHY IT WAS FALSE GREEN.
 * `aiOutputReportingReachability.test.js` asserts that
 * `components/AnalysisCard.tsx` contains an `openAiOutputReport({ feature:
 * 'Scan Results', ... })` call. That is true, and it is irrelevant: the
 * production build profile sets EXPO_PUBLIC_SCAN_RESULTS_V2_UI=true, and app.js
 * branches on that flag to `ScanResultV2` — AnalysisCard is the branch
 * production does NOT take. A green suite therefore certified a report control
 * that no shipping user could reach, on a surface Google requires it on.
 *
 * WHAT THIS FILE PROVES INSTEAD — the whole chain, link by link:
 *
 *   production eas.json flag value
 *     -> the real featureFlags resolver
 *       -> the branch app.js actually renders
 *         -> the identity that branch passes as the report target
 *           -> ScanResultV2 forwarding it to the analysis surface
 *             -> the real openAiOutputReport call on that surface
 *               -> the REAL reporting service, executed
 *                 -> server acceptance, not `ok`
 *
 * The structural links are checked against the TypeScript AST rather than by
 * substring, because the question is which branch renders what — a question
 * text search cannot answer. The final two links are executed for real, with a
 * stub Supabase client, so the request shape and the acceptance rule are
 * observed rather than described.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const ts = require('typescript');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');

function parse(relativePath) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const kind = relativePath.endsWith('.tsx') || relativePath.endsWith('.js')
    ? ts.ScriptKind.TSX
    : ts.ScriptKind.TS;
  return ts.createSourceFile(filename, source, ts.ScriptTarget.ES2020, true, kind);
}

function* walk(node) {
  yield node;
  for (const child of node.getChildren()) yield* walk(child);
}

function loadTsModule(relativePath, requireMap = {}, extraSandbox = {}) {
  const filename = path.join(ROOT, relativePath);
  const source = fs.readFileSync(filename, 'utf8');
  const output = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.CommonJS,
      target: ts.ScriptTarget.ES2020,
      esModuleInterop: true,
    },
  }).outputText;
  const module = { exports: {} };
  const sandbox = {
    __DEV__: false,
    console,
    exports: module.exports,
    module,
    require: (id) => {
      if (id in requireMap) return requireMap[id];
      if (id.startsWith('node:')) return require(id);
      throw new Error(`Unexpected require in ${relativePath}: ${id}`);
    },
    ...extraSandbox,
  };
  vm.createContext(sandbox);
  new vm.Script(output, { filename }).runInContext(sandbox);
  return module.exports;
}

/** Find the JSX attribute `name` on the opening tag of element `tagName`. */
function jsxAttribute(sourceFile, tagName, name) {
  for (const node of walk(sourceFile)) {
    if (!ts.isJsxSelfClosingElement(node) && !ts.isJsxOpeningElement(node)) continue;
    if (node.tagName.getText() !== tagName) continue;
    for (const attr of node.attributes.properties) {
      if (ts.isJsxAttribute(attr) && attr.name.getText() === name) return attr;
    }
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Link 1 — the production flag value, through the real resolver       */
/* ------------------------------------------------------------------ */

test('production enables Scan Results V2, so V2 is the shipping surface', () => {
  const eas = JSON.parse(fs.readFileSync(path.join(ROOT, 'eas.json'), 'utf8'));
  const raw = eas.build.production.env.EXPO_PUBLIC_SCAN_RESULTS_V2_UI;
  assert.equal(raw, 'true', 'production must enable Scan Results V2');

  // Resolve through the real module with the real production value, rather
  // than restating the comparison the module performs.
  const flags = loadTsModule(
    'constants/featureFlags.ts',
    {},
    { process: { env: { EXPO_PUBLIC_SCAN_RESULTS_V2_UI: raw } } },
  );
  assert.equal(
    flags.SCAN_RESULTS_V2_UI_ENABLED,
    true,
    'the production env must resolve the V2 flag on',
  );
});

/* ------------------------------------------------------------------ */
/* Link 2 — which branch app.js renders under that flag                */
/* ------------------------------------------------------------------ */

test('app.js renders ScanResultV2 (not AnalysisCard) on the production flag', () => {
  const sourceFile = parse('app.js');

  let branch = null;
  for (const node of walk(sourceFile)) {
    if (!ts.isConditionalExpression(node)) continue;
    if (node.condition.getText().trim() !== 'SCAN_RESULTS_V2_UI_ENABLED') continue;
    branch = node;
  }
  assert.ok(branch, 'app.js must branch the result surface on SCAN_RESULTS_V2_UI_ENABLED');

  // The flag-ON branch is the shipping surface. This is the exact fact the old
  // AnalysisCard-only assertion missed.
  assert.match(
    branch.whenTrue.getText(),
    /<ScanResultV2/,
    'the enabled branch must render ScanResultV2',
  );
  assert.match(
    branch.whenFalse.getText(),
    /<AnalysisCard/,
    'AnalysisCard is the disabled branch, which production does not take',
  );
});

/* ------------------------------------------------------------------ */
/* Link 3 — KSB29-034, the report target is a persisted identity       */
/* ------------------------------------------------------------------ */

test('the shipped surface receives a persisted scan identity as the report target', () => {
  const sourceFile = parse('app.js');
  const attr = jsxAttribute(sourceFile, 'ScanResultV2', 'scanSourceId');
  assert.ok(attr, 'ScanResultV2 must receive scanSourceId');

  const expression = attr.initializer.expression.getText();

  // A QA fixture name is populated only by development fixtures, so on a real
  // device the target resolved to null and the report had no reportable
  // subject. The persisted saved-scan id must be preferred.
  assert.match(
    expression,
    /savedScanId/,
    'the report target must prefer the persisted saved scan id (KSB29-034)',
  );
  assert.ok(
    expression.indexOf('savedScanId') < expression.indexOf('qaFixtureName'),
    'the persisted identity must take precedence over the development fixture name',
  );
});

/* ------------------------------------------------------------------ */
/* Link 4 — ScanResultV2 forwards it to the analysis surface           */
/* ------------------------------------------------------------------ */

test('ScanResultV2 forwards the scan identity to the style-analysis surface', () => {
  const sourceFile = parse('components/scan-results/ScanResultV2.tsx');
  const attr = jsxAttribute(sourceFile, 'StyleAnalysisSection', 'scanSourceId');
  assert.ok(
    attr,
    'StyleAnalysisSection must receive scanSourceId, or the control has no target',
  );
  assert.match(attr.initializer.expression.getText(), /scanSourceId/);
});

/* ------------------------------------------------------------------ */
/* Link 5 — the report action exists on that surface and is reachable  */
/* ------------------------------------------------------------------ */

test('the shipped style-analysis surface opens the shared report flow', () => {
  const relativePath = 'components/scan-results/StyleAnalysisSection.tsx';
  const sourceFile = parse(relativePath);

  // It must use the shared flow, not a private reimplementation.
  let importsContext = false;
  for (const node of walk(sourceFile)) {
    if (!ts.isImportDeclaration(node)) continue;
    if (!/AiOutputReportingContext/.test(node.moduleSpecifier.getText())) continue;
    importsContext = true;
  }
  assert.ok(importsContext, 'the surface must use the shared AI-output reporting context');

  // The call must be a real invocation with the governed feature label and the
  // forwarded identity — not a hardcoded or fixture value.
  let call = null;
  for (const node of walk(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (node.expression.getText() !== 'openAiOutputReport') continue;
    call = node;
  }
  assert.ok(call, 'the surface must call openAiOutputReport');

  const argument = call.arguments[0];
  assert.ok(ts.isObjectLiteralExpression(argument), 'the report request must be an object literal');

  const properties = new Map(
    argument.properties
      .filter((property) => ts.isPropertyAssignment(property))
      .map((property) => [property.name.getText(), property.initializer.getText()]),
  );
  assert.equal(
    properties.get('feature'),
    "'Scan Results'",
    "the report must be filed under the 'Scan Results' feature label",
  );
  assert.equal(
    properties.get('itemId'),
    'scanSourceId',
    'the report must target the forwarded scan identity',
  );

  // Rendered only when there is a resolvable target: a report the server cannot
  // resolve is worse than no control.
  let guarded = false;
  for (const node of walk(sourceFile)) {
    if (!ts.isConditionalExpression(node)) continue;
    if (node.condition.getText() !== 'scanSourceId') continue;
    if (/openAiOutputReport/.test(node.whenTrue.getText())) guarded = true;
  }
  assert.ok(guarded, 'the control must be gated on having a resolvable report target');
});

/* ------------------------------------------------------------------ */
/* Link 6 — the REAL service, executed                                 */
/* ------------------------------------------------------------------ */

function stubSupabase({ session = { user: { id: 'user-1' } }, insertError = null, captured }) {
  return {
    supabase: {
      auth: { getSession: async () => ({ data: { session } }) },
      from(table) {
        return {
          insert: async (row) => {
            captured.table = table;
            captured.row = row;
            return { error: insertError };
          },
        };
      },
    },
  };
}

function loadReportingService(supabaseStub) {
  return loadTsModule('services/contentReports.ts', {
    './supabaseClient': supabaseStub,
    '../constants/reportReasons': loadTsModule('constants/reportReasons.ts'),
    './ugcSafetyStore': loadTsModule('services/ugcSafetyStore.ts', {
      // The store only needs its UUID validator here; AsyncStorage is a native
      // module and is never exercised by the report path under test.
      '@react-native-async-storage/async-storage': {
        default: { getItem: async () => null, setItem: async () => {} },
      },
    }),
  });
}

test('the real reporting service files an ai_output report the server can act on', () => {
  const captured = {};
  const contentReports = loadReportingService(stubSupabase({ captured }));

  const reportAiOutput = loadTsModule('services/reportAiOutput.ts', {
    './contentReports': contentReports,
  });

  return reportAiOutput
    .submitAiOutputReport({
      request: { feature: 'Scan Results', itemId: 'saved-scan-123' },
      reasonId: reportAiOutput.AI_OUTPUT_REPORT_REASONS[0].id,
      notes: '',
    })
    .then((result) => {
      assert.equal(captured.table, 'content_reports');
      assert.equal(captured.row.target_type, 'ai_output', 'must file against the ai_output target type');
      assert.equal(captured.row.target_id, 'saved-scan-123', 'must carry the persisted scan identity');
      assert.equal(
        captured.row.ai_output_context.feature,
        'Scan Results',
        'must carry the AI-output context production already supports',
      );
      assert.equal(captured.row.ai_output_context.item_id, 'saved-scan-123');
      // reporter identity is bound server-side by auth.uid(), never by the client.
      assert.equal('reporter_user_id' in captured.row, false);

      assert.equal(contentReports.isReportServerAccepted(result), true);
    });
});

/* ------------------------------------------------------------------ */
/* Link 7 — KSB29-035, success means acceptance, not `ok`              */
/* ------------------------------------------------------------------ */

test('an unauthenticated report is NOT reported to the user as sent', () => {
  const captured = {};
  const contentReports = loadReportingService(stubSupabase({ session: null, captured }));
  const reportAiOutput = loadTsModule('services/reportAiOutput.ts', {
    './contentReports': contentReports,
  });

  return reportAiOutput
    .submitAiOutputReport({
      request: { feature: 'Scan Results', itemId: 'saved-scan-123' },
      reasonId: reportAiOutput.AI_OUTPUT_REPORT_REASONS[0].id,
      notes: '',
    })
    .then((result) => {
      // This is the exact outcome the defect surfaced as "REPORT SENT".
      assert.equal(result.ok, true, 'the local-only outcome really does return ok: true');
      assert.equal(result.serverAccepted, false, 'but nothing reached the server');
      assert.equal(
        contentReports.isReportServerAccepted(result),
        false,
        'so it must not be treated as a receipt',
      );
      assert.equal(captured.row, undefined, 'and no row was inserted');
    });
});

test('the report sheet gates its success copy on server acceptance, not on ok', () => {
  const sourceFile = parse('contexts/AiOutputReportingContext.tsx');

  let gated = false;
  for (const node of walk(sourceFile)) {
    if (!ts.isCallExpression(node)) continue;
    if (node.expression.getText() !== 'setState') continue;
    const argument = node.arguments[0];
    if (!argument || !ts.isConditionalExpression(argument)) continue;
    if (!/'success'/.test(argument.whenTrue.getText())) continue;

    assert.match(
      argument.condition.getText(),
      /isReportServerAccepted/,
      'the success state must be decided by the authoritative acceptance contract',
    );
    assert.doesNotMatch(
      argument.condition.getText(),
      /\.ok\b/,
      "`.ok` alone must not be able to produce a 'REPORT SENT' confirmation",
    );
    gated = true;
  }
  assert.ok(gated, 'the report sheet must set a success state from the submit result');
});
