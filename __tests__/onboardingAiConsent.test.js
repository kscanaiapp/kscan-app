const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/onboarding/index.tsx'), 'utf8');
const termsBlock = screen.match(/const renderTerms = \(\) => \([\s\S]*?\n  \);/)?.[0] ?? '';
const flat = termsBlock.replace(/\s+/g, ' ');
const approvedDisclosure =
  'Images you choose to submit may be securely transmitted and processed using artificial intelligence to provide scanning, styling, and shopping results.';

test('AI disclosure uses the exact approved wording', () => {
  assert.ok(flat.includes(approvedDisclosure));
  assert.match(termsBlock, /testID="onboarding-ai-processing-statement"/);
});

test('AI consent is an independent checkbox that starts unchecked', () => {
  assert.match(screen, /const \[aiConsentChecked, setAiConsentChecked\] = useState\(false\)/);
  assert.match(termsBlock, /testID="onboarding-ai-consent-checkbox"/);
  assert.ok(flat.includes('I consent to AI image processing'));
  assert.match(termsBlock, /accessibilityState=\{\{ checked: aiConsentChecked \}\}/);
});

test('Accept & Continue requires all four affirmative acknowledgements', () => {
  assert.match(
    termsBlock,
    /disabled=\{!termsChecked \|\| !privacyChecked \|\| !aiConsentChecked \|\| !ageChecked \|\| legalBusy\}/,
  );
});

test('checkbox order remains Terms, Privacy, AI processing, 18+', () => {
  const ids = [...termsBlock.matchAll(/testID="(onboarding-(?:terms|privacy|ai-consent|age)-checkbox)"/g)]
    .map((match) => match[1]);
  assert.deepEqual(ids, [
    'onboarding-terms-checkbox',
    'onboarding-privacy-checkbox',
    'onboarding-ai-consent-checkbox',
    'onboarding-age-checkbox',
  ]);
});

test('acceptance submits the versioned AI-processing ledger contract', () => {
  assert.match(screen, /aiProcessingVersion: AI_PROCESSING_VERSION/);
  assert.match(screen, /AI_PROCESSING_VERSION/);
});

test('Terms and Privacy links keep their approved destinations and link roles', () => {
  assert.match(termsBlock, /Linking\.openURL\('https:\/\/kscan\.app\/legal\/terms'\)/);
  assert.match(termsBlock, /Linking\.openURL\('https:\/\/kscan\.app\/legal\/privacy'\)/);
  assert.equal((termsBlock.match(/accessibilityRole="link"/g) ?? []).length, 2);
});
