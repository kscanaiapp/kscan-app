/**
 * GP-002 — every surface that renders model-authored prose must expose the
 * in-app "report offensive AI output" control.
 *
 * services/reportAiOutput.ts declares three feature labels — 'StyleChat',
 * 'TextScan' and 'Scan Results' — but before this repair only StyleChat wired
 * one up. components/AnalysisCard.tsx renders the scan-identify (Gemini) style
 * analysis paragraph and is the surface a Library saved scan opens into, so it
 * carried AI prose with no reporting route at all.
 *
 * Surfaces deliberately NOT covered here, with the reason each is out of scope:
 *
 *   app/text-scan/index.tsx        renders validated attributes and product
 *                                  cards only — no model prose block.
 *   Today with Elise (Home)        services/todayWithElise/generatedGreeting.ts
 *                                  is deterministic app-authored copy; the only
 *                                  variable is the user's own first name.
 *   Private Dressing Room Elise    services/privateDressingRoomEliseUx.ts owns
 *                                  every visible word; the response contract's
 *                                  `displayCopy` / `clarification` are never
 *                                  read.
 *
 * If any of those starts rendering provider prose, it needs a control too and
 * this file is where that expectation belongs.
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..');

function readSource(relativePath) {
  return fs.readFileSync(path.join(ROOT, relativePath), 'utf8');
}

/**
 * Source with comments removed. privateDressingRoomEliseUx.ts documents the
 * `displayCopy` rule in prose, so a raw substring search would match the very
 * comment that states the field is never read.
 */
function readCode(relativePath) {
  return readSource(relativePath)
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

test('GP-006: the Scan Results analysis surface opens the shared in-app report flow', () => {
  const source = readSource('components/AnalysisCard.tsx');

  assert.match(
    source,
    /import \{ useAiOutputReporting \} from '\.\.\/contexts\/AiOutputReportingContext'/,
    'AnalysisCard must use the shared in-app AI-output reporting context',
  );
  assert.match(
    source,
    /openAiOutputReport\(\{ feature: 'Scan Results', itemId: scanSourceId \?\? null \}\)/,
    "the report must be filed under the 'Scan Results' feature label",
  );
  assert.match(
    source,
    /testID="analysis-card-report-ai"/,
    'the control needs a stable testID for runtime QA',
  );
  assert.match(
    source,
    /accessibilityLabel="Report this style analysis as offensive or unsafe"/,
    'the control must state what reporting it means',
  );
});

test('GP-002: the report control is bound to the analysis body, not the footer', () => {
  const source = readSource('components/AnalysisCard.tsx');
  const bodyIndex = source.indexOf('{/* AI result body */}');
  const reportIndex = source.indexOf('testID="analysis-card-report-ai"');
  const matchSummaryIndex = source.indexOf('{/* Match summary */}');

  assert.ok(bodyIndex > -1 && reportIndex > -1 && matchSummaryIndex > -1);
  assert.ok(
    bodyIndex < reportIndex && reportIndex < matchSummaryIndex,
    'the control must sit directly under the AI paragraph it reports',
  );
});

test('GP-006: StyleChat keeps its existing per-message report control and opens the in-app flow', () => {
  const source = readSource('components/style-chat/StyleChatBubble.tsx');
  assert.match(source, /openAiOutputReport\(\{[\s\S]*feature: 'StyleChat'/);
  assert.match(
    source,
    /accessibilityLabel="Report this Elise response as offensive or unsafe"/,
  );
});

test('GP-006: the report service carries only review identifiers, never email or scan media', () => {
  const source = readSource('services/reportAiOutput.ts');
  const code = readCode('services/reportAiOutput.ts');
  for (const field of ['feature', 'session_id', 'message_id', 'item_id']) {
    assert.ok(source.includes(field), `report context must include "${field}"`);
  }
  assert.doesNotMatch(source, /mailto:|Linking\.openURL|openURL\(/i);
  assert.doesNotMatch(code, /scanImageUri|outputText|raw_response|rawOutput/i);
});

test('GP-006: the root mounts the in-app sheet with reason, success, failure, retry, and duplicate-tap guards', () => {
  const layout = readSource('app/_layout.tsx');
  const context = readSource('contexts/AiOutputReportingContext.tsx');

  assert.match(layout, /<AiOutputReportProvider>/);
  for (const token of [
    'testID="ai-output-report-sheet"',
    'ai-output-report-reason-${reason.id}',
    'testID="ai-output-report-submit"',
    'testID="ai-output-report-success"',
    'testID="ai-output-report-error"',
    'testID="ai-output-report-retry"',
    'createAiOutputReportSubmissionGate',
    "state === 'submitting'",
  ]) {
    assert.ok(context.includes(token), `in-app report sheet must contain ${token}`);
  }
  assert.doesNotMatch(
    context,
    /mailto:|Linking\.openURL|openURL\(/i,
    'the sheet must never hand reporting to an external email application',
  );
});

test('GP-002: the AI surfaces excluded above still render no provider prose', () => {
  // Private Dressing Room: the UX module owns the copy table and the
  // orchestration layer must not read provider-authored display strings.
  const ux = readCode('services/privateDressingRoomEliseUx.ts');
  assert.match(ux, /PRIVATE_ELISE_COPY = Object\.freeze\(/);
  for (const providerField of ['displayCopy', 'clarificationText', 'rationale']) {
    assert.ok(
      !new RegExp(`\\b${providerField}\\b`).test(ux),
      `private Dressing Room copy must stay app-owned (found ${providerField})`,
    );
  }

  // Today with Elise: greeting personalization is a first-name substitution.
  const greeting = readCode('services/todayWithElise/generatedGreeting.ts');
  assert.match(greeting, /GENERIC_DAYPART_OPENERS/);
  assert.ok(
    !/fetch\(|supabase|invoke\(/.test(greeting),
    'the greeting must not call a model provider',
  );
});
