/**
 * "Before we begin" AI image-processing disclosure and consent.
 *
 * Repo convention for screen-level UI is static source-text assertion
 * (see __tests__/deletionModalLayout.test.js) rather than a React render,
 * since neither Jest nor RTL is installed.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const screen = fs.readFileSync(path.join(ROOT, 'app/onboarding/index.tsx'), 'utf8');

const AI_STATEMENT =
  'Images you choose to submit may be securely transmitted and processed using artificial intelligence to provide scanning, styling, and shopping results.';
const AI_LABEL = 'I consent to AI image processing';

const termsBlock = screen.match(/const renderTerms = \(\) => \([\s\S]*?\n  \);/)?.[0] ?? '';

// Collapse JSX line wrapping so multi-line copy can be matched as one string.
const flatten = (s) => s.replace(/\s+/g, ' ');

test('terms step block is present', () => {
  assert.ok(termsBlock.length > 100, 'renderTerms block was not found');
});

test('AI statement uses the exact approved copy', () => {
  assert.ok(flatten(termsBlock).includes(AI_STATEMENT));
});

test('AI statement sits below the privacy paragraph and above the legal links', () => {
  const flat = flatten(termsBlock);
  const privacyIndex = flat.indexOf('K Scan AI is not designed for facial recognition');
  const aiIndex = flat.indexOf(AI_STATEMENT);
  const linksIndex = flat.indexOf('Terms of Service');

  assert.ok(privacyIndex >= 0, 'privacy paragraph must be found');
  assert.ok(aiIndex >= 0, 'AI statement must be found');
  assert.ok(linksIndex >= 0, 'legal links must be found');
  assert.ok(privacyIndex < aiIndex, 'AI statement must follow the privacy paragraph');
  assert.ok(aiIndex < linksIndex, 'AI statement must precede the Terms/Privacy links');
});

test('AI statement matches the privacy paragraph typography and is outside the white card', () => {
  // Same style object as the existing privacy paragraph => same typography,
  // width, alignment and spacing.
  assert.match(
    termsBlock,
    /<Text style=\{styles\.privacyNote\} testID="onboarding-ai-processing-statement">/,
  );

  const trustCard = termsBlock.match(/<View style=\{styles\.trustCard\}>[\s\S]*?<\/View>/)?.[0] ?? '';
  assert.ok(trustCard.length > 0, 'trust card must be found');
  assert.ok(!flatten(trustCard).includes(AI_STATEMENT), 'statement must not sit inside the privacy card');
});

test('AI consent checkbox uses the exact approved label', () => {
  assert.ok(flatten(termsBlock).includes(`<Text style={styles.checkboxLabel}>${AI_LABEL}</Text>`));
});

test('checkbox order is terms, privacy, AI consent, age', () => {
  const order = [...termsBlock.matchAll(/testID="(onboarding-(?:terms|privacy|ai-consent|age)-checkbox)"/g)]
    .map((m) => m[1]);
  assert.deepEqual(order, [
    'onboarding-terms-checkbox',
    'onboarding-privacy-checkbox',
    'onboarding-ai-consent-checkbox',
    'onboarding-age-checkbox',
  ]);
});

test('AI consent checkbox reuses the shared checkbox styling, at full label size', () => {
  const block = termsBlock.match(/<Pressable\s+testID="onboarding-ai-consent-checkbox"[\s\S]*?<\/Pressable>/)?.[0] ?? '';
  assert.ok(block.length > 0, 'AI consent checkbox block must be found');
  assert.match(block, /style=\{styles\.checkboxRow\}/);
  assert.match(block, /style=\{\[styles\.checkbox, aiConsentChecked && styles\.checkboxChecked\]\}/);
  assert.match(block, /<Text style=\{styles\.checkboxLabel\}>/);
  assert.match(block, /accessibilityRole="checkbox"/);
  assert.match(block, /accessibilityState=\{\{ checked: aiConsentChecked \}\}/);

  // No per-label font shrink and no forced single-line truncation.
  assert.doesNotMatch(block, /fontSize/);
  assert.doesNotMatch(block, /numberOfLines|adjustsFontSizeToFit|ellipsizeMode/);
});

test('AI consent is application state only and requests no OS permission', () => {
  const block = termsBlock.match(/<Pressable\s+testID="onboarding-ai-consent-checkbox"[\s\S]*?<\/Pressable>/)?.[0] ?? '';
  assert.match(block, /onPress=\{\(\) => setAiConsentChecked\(\(v\) => !v\)\}/);
  assert.doesNotMatch(block, /Permission|requestPermission|Camera|MediaLibrary|Linking/);
});

test('Accept & Continue stays disabled until all four boxes are checked', () => {
  const button = termsBlock.match(/<PrimaryButton[\s\S]*?testID="onboarding-accept-continue-button"[\s\S]*?\/>/)?.[0]
    ?? termsBlock.match(/<PrimaryButton[\s\S]*?\/>/)?.[0] ?? '';
  assert.ok(button.length > 0, 'Accept & Continue button must be found');
  assert.match(
    button,
    /disabled=\{!termsChecked \|\| !privacyChecked \|\| !aiConsentChecked \|\| !ageChecked \|\| legalBusy\}/,
  );
});

test('accepting persists the AI consent version alongside the other acceptances', () => {
  assert.match(screen, /aiProcessingVersion: AI_PROCESSING_VERSION/);
  assert.match(screen, /AI_PROCESSING_VERSION,?\s*\n?\s*\}? from '\.\.\/\.\.\/constants\/legal'|AI_PROCESSING_VERSION,/);
});

test('existing terms, privacy and age copy is unchanged', () => {
  const flat = flatten(termsBlock);
  assert.ok(flat.includes('I agree to the Terms of Service'));
  assert.ok(flat.includes('I acknowledge the Privacy Policy'));
  assert.ok(flat.includes('I confirm that I am 18 years of age or older.'));
  assert.ok(flat.includes(
    'K Scan AI is not designed for facial recognition or identifying people. Raw scans and uploaded images are not sold to third-party data buyers.',
  ));
});

// ─── Label fits on one line ─────────────────────────────────────────────────
//
// checkboxLabel is 14pt System (San Francisco) with flex: 1. The label box is
// the screen width minus the shell's horizontal padding (SPACING.lg = 16 each
// side), the 22pt checkbox, and the row's SPACING.md = 12 gap.

// SF Pro Text Regular advance widths as a fraction of font size.
const ADVANCE = {
  ' ': 0.260, '.': 0.260,
  a:0.534,b:0.558,c:0.494,d:0.558,e:0.525,f:0.327,g:0.557,h:0.553,i:0.240,j:0.240,
  k:0.500,l:0.240,m:0.845,n:0.553,o:0.551,p:0.558,q:0.558,r:0.353,s:0.476,t:0.340,
  u:0.553,v:0.490,w:0.746,x:0.484,y:0.490,z:0.456,
  A:0.636,B:0.625,C:0.655,D:0.690,E:0.576,F:0.559,G:0.703,H:0.710,I:0.276,J:0.548,
  K:0.625,L:0.535,M:0.859,N:0.711,O:0.733,P:0.603,Q:0.733,R:0.621,S:0.603,T:0.594,
  U:0.701,V:0.630,W:0.952,X:0.613,Y:0.590,Z:0.597,
};
const measure = (s, size) => [...s].reduce((t, ch) => t + (ADVANCE[ch] ?? 0.55) * size, 0);
const labelBox = (screenWidth) => screenWidth - 16 * 2 - 22 - 12;

test('AI consent label fits on one line at supported iPhone widths', () => {
  // 375pt is the narrowest supported iPhone (SE 2nd/3rd gen, 12/13 mini).
  for (const width of [375, 390, 393, 430]) {
    const used = measure(AI_LABEL, 14);
    assert.ok(
      used <= labelBox(width),
      `"${AI_LABEL}" needs ${used.toFixed(1)}pt but only ${labelBox(width)}pt is available at ${width}pt`,
    );
  }
});

test('AI consent label is no wider than an existing single-line label', () => {
  // "I acknowledge the Privacy Policy" ships today and renders on one line, so
  // anything no wider than it is safe without shrinking the font.
  const existing = measure('I acknowledge the Privacy Policy', 14);
  const added = measure(AI_LABEL, 14);
  assert.ok(
    added <= existing + 1,
    `AI label (${added.toFixed(1)}pt) must not exceed the known single-line label (${existing.toFixed(1)}pt)`,
  );
});
