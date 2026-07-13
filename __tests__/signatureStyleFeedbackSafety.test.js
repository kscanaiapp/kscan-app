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
const bubbleSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatBubble.tsx'),
  'utf8',
);
const statusRowSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'StyleChatStyleDnaCard.tsx'),
  'utf8',
);
const settingsSource = fs.readFileSync(
  path.join(ROOT, 'components', 'style-chat', 'SignatureStyleSettingsSection.tsx'),
  'utf8',
);
const homeStylistSource = fs.readFileSync(
  path.join(ROOT, 'components', 'home', 'HomeStylistCard.tsx'),
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
  assert.match(controlsSource, /enabled: feedbackEnabled/);
  assert.match(controlsSource, /onSaved: handleFeedbackSaved/);
  assert.match(controlsSource, /const handleFeedbackSaved = useCallback/);
  assert.match(controlsSource, /void saveFeedback\('helpful'\)/);
  assert.match(controlsSource, /void saveFeedback\('not_my_style'\)/);
  assert.match(controlsSource, /mountedRef\.current && feedbackEnabledRef\.current/);
  assert.doesNotMatch(controlsSource, /saveFeedback\('helpful'\);\s*showConfirmation/);
  assert.doesNotMatch(controlsSource, /saveFeedback\('not_my_style'\);\s*showConfirmation/);
});

test('conversation feedback UI and writes use the same explicit two-part gate', () => {
  assert.match(
    bubbleSource,
    /showFeedback && learnFromFeedback && showFeedbackControls \? \(/,
  );
  assert.match(
    bubbleSource,
    /feedbackEnabled=\{learnFromFeedback && showFeedbackControls\}/,
  );
  assert.match(controlsSource, /if \(\s*!feedbackEnabledRef\.current \|\|/);
  assert.match(controlsSource, /feedbackEnabledRef\.current = false/);
  assert.match(settingsSource, /disabled=\{loading \|\| !preferences\.learnFromFeedback\}/);
});

test('compact status row remains while feedback education is menu-only', () => {
  assert.match(sessionSource, /<StyleChatStyleDnaCard/);
  assert.match(statusRowSource, /testID="style-chat-style-dna-card"/);
  assert.match(statusRowSource, /<Text style=\{styles\.detailsText\}>Details<\/Text>/);
  assert.match(controlsSource, /const menu = menuState === 'open' \? \(/);
  assert.match(controlsSource, /!feedbackEducationDismissed \? \(/);
  assert.match(controlsSource, /<Text style=\{styles\.educationText\}>\{EDUCATION_COPY\}<\/Text>/);
});

test('runtime polish keeps the status row quiet and the Home Elise CTA readable', () => {
  assert.match(statusRowSource, /minHeight: 36/);
  assert.match(statusRowSource, /borderColor: LUXURY\.colors\.hairline/);
  assert.match(statusRowSource, /backgroundColor: 'transparent'/);
  assert.match(homeStylistSource, /hasSessions \? 'Continue chat' : 'Start chat'/);
  assert.match(homeStylistSource, /fontSize: 14/);
  assert.match(homeStylistSource, /letterSpacing: 0\.2/);
  assert.match(homeStylistSource, /textTransform: 'none'/);
  assert.match(homeStylistSource, /textAlign: 'center'/);
});

test('feedback visibility is opt-in without removing ordinary recommendation reasoning', () => {
  assert.match(bubbleSource, /showFeedbackControls = false/);
  assert.match(bubbleSource, /b\.type === 'why_this_works'/);
  assert.match(controlsSource, /testID="style-chat-inline-feedback-row"/);
  assert.match(controlsSource, /testID="style-chat-feedback-menu"/);
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
