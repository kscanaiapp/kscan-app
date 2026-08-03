// Direct Elise attachment gate: attach-first media, optional Closet persistence.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

const direct = read('services/style-chat/eliseDirectImageAttachment.ts');
const hook = read('hooks/useStyleChatAttachments.ts');
const screen = read('app/style-chat/[sessionId].tsx');
const closet = read('services/closetLibrary.js');

test('privacy preparation still precedes the durable candidate write', () => {
  const body = direct.slice(
    direct.indexOf('export async function prepareEliseDirectImage'),
    direct.indexOf('export async function resolvePreparedDirectImageAttachment'),
  );
  assert.ok(body.indexOf('prepareImageForPrivacyUpload') >= 0);
  assert.ok(body.indexOf('prepareImageForPrivacyUpload') < body.indexOf('stageSanitizedEliseDirectImage'));
});

test('direct attachment uses candidate media and creates no Recent Scan or cloud row', () => {
  assert.match(direct, /createClosetCandidate/);
  assert.match(direct, /candidateImageUri/);
  assert.doesNotMatch(direct, /saveScan\(|saveScanToCloud|upsertSavedScanRowForAttachment/);
  assert.doesNotMatch(direct, /ensureSavedScanMediaBacking|from\('saved_scans'\)/);
});

test('identification resolution makes the candidate ready without promoting it', () => {
  assert.match(direct, /to:\s*'ready_for_review'/);
  assert.match(direct, /closetState:\s*closetItemId \? 'saved' : 'not_saved'/);
  assert.doesNotMatch(direct, /resolved:\s*\{[\s\S]*sourceType:\s*'saved_scan'/);
});

test('the composer requires identified fashion context before a direct draft is ready', () => {
  assert.match(hook, /if \(!identified \|\| identified\.kind !== 'identified'\)/);
  assert.match(hook, /fashionContext:\s*identified\.context/);
  assert.match(hook, /resolved:\s*null/);
  assert.match(hook, /state:\s*'ready'/);
});

test('send snapshots accept unsaved context and require the backend acknowledgement', () => {
  const store = read('services/style-chat/styleChatAttachmentStore.ts');
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');
  assert.match(store, /Boolean\(entry\.resolved \|\| entry\.fashionContext\)/);
  assert.match(provider, /fashionContextAccepted/);
  assert.match(provider, /fashionContextVersion/);
});

test('Closet promotion is an independent retry action keyed by candidate id', () => {
  assert.match(hook, /saveDirectImageToCloset/);
  assert.match(hook, /candidateIds:\s*\[candidateId\]/);
  assert.match(hook, /applyClosetOutcome\(candidateId, 'save_failed'\)/);
  assert.match(closet, /sourceCandidateId/);
  assert.match(closet, /deduped:\s*true/);
});

test('the screen keeps send and Closet callbacks on separate state tracks', () => {
  assert.match(screen, /onSaveToCloset/);
  assert.match(screen, /onSending: \(\) => chatAttachments\.markSending/);
  assert.match(screen, /onSendFailed: \(\) => chatAttachments\.markSendFailed/);
  assert.match(screen, /onSent: \(\) => \{[\s\S]*markSent/);
});
