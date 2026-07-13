const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.resolve(__dirname, '..');
const hookSource = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleDnaFeedback.ts'), 'utf8');
const controlsSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatFeedbackControls.tsx'),
  'utf8',
);
const sessionSource = fs.readFileSync(
  path.join(ROOT, 'app', 'style-chat', '[sessionId].tsx'),
  'utf8',
);

test('feedback hook gates direct writes and rapid repeated submissions', () => {
  assert.match(hookSource, /activeRef\.current/);
  assert.match(hookSource, /savingFeedbackRef\.current/);
  assert.match(hookSource, /if \(!activeRef\.current \|\| savingFeedbackRef\.current\) return false/);
  assert.match(hookSource, /saveFeedback: \(value: LocalStyleDnaFeedbackValue\) => Promise<boolean>/);
});

test('feedback hydration and completions are scoped to the exact actor and message', () => {
  assert.match(hookSource, /scopeKey = `\$\{userKey \?\? ''\}\\u0000\$\{sessionId\}\\u0000\$\{messageId\}`/);
  assert.match(hookSource, /scopeVersionRef\.current !== scopeVersion/);
  assert.match(hookSource, /hydrationVersionRef\.current !== hydrationVersion/);
  assert.match(hookSource, /scopeVersionRef\.current === operationScopeVersion/);
});

test('controls announce success only from the durable-save callback', () => {
  assert.match(controlsSource, /enabled: learnFromFeedback/);
  assert.match(controlsSource, /onSaved: handleFeedbackSaved/);
  assert.match(controlsSource, /const handleFeedbackSaved = useCallback/);
  assert.match(controlsSource, /void saveFeedback\('helpful'\)/);
  assert.match(controlsSource, /void saveFeedback\('not_my_style'\)/);
  assert.match(controlsSource, /mountedRef\.current && learningEnabledRef\.current/);
  assert.doesNotMatch(controlsSource, /saveFeedback\('helpful'\);\s*showConfirmation/);
  assert.doesNotMatch(controlsSource, /saveFeedback\('not_my_style'\);\s*showConfirmation/);
});

test('explanation is local metadata display and does not write or call a provider', () => {
  const whyHandler = controlsSource.match(
    /const handleWhy = useCallback\(\(\) => \{[\s\S]*?\}, \[\]\);/,
  )?.[0];
  assert.ok(whyHandler);
  assert.match(whyHandler, /setExplanationOpen\(true\)/);
  assert.doesNotMatch(whyHandler, /saveFeedback|setFeedbackForMessage|provider|supabase/);
  assert.match(controlsSource, /details in your request and any styling context available/);
  assert.doesNotMatch(controlsSource, /considers your Signature Style, recent scans/);
});

test('overflow menu is toggle-dismissible and exposes expanded accessibility state', () => {
  assert.match(controlsSource, /current === 'open' \? 'closed' : 'open'/);
  assert.match(controlsSource, /accessibilityRole="menu"/);
  assert.match(controlsSource, /accessibilityState=\{\{ expanded: menuState === 'open' \}\}/);
});

test('opening a menu scrolls the exact recommendation clear of the composer', () => {
  assert.match(controlsSource, /testID="style-chat-feedback-menu"[\s\S]*?onLayout=\{onMenuOpened\}/);
  assert.match(sessionSource, /renderMessage = \(\{ item, index \}/);
  assert.match(sessionSource, /scrollToIndex\(\{ index, animated: true, viewPosition: 0 \}\)/);
});
