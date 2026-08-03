const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('direct Elise media has independent attachment and Closet lifecycles', () => {
  const types = read('types/styleChatAttachments.ts');

  for (const state of ['identifying', 'ready', 'sending', 'sent', 'send_failed']) {
    assert.match(types, new RegExp(`['"]${state}['"]`));
  }
  for (const state of ['not_saved', 'saving', 'saved', 'save_failed']) {
    assert.match(types, new RegExp(`['"]${state}['"]`));
  }
  assert.match(types, /closetState\??:/);
  assert.match(types, /closetItemId\??:/);
  assert.match(types, /closetCandidateId\??:/);
});

test('Android review attaches identified context before optional Closet promotion', () => {
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');

  assert.match(intake, /title="Attach to Elise"/i);
  assert.match(intake, /['"]Save to Closet['"]/i);
  assert.doesNotMatch(intake, /Save to Closet & Attach/i);
  assert.doesNotMatch(intake, /saveScanToCloud/);
  assert.doesNotMatch(intake, /ensureSavedScanMediaBacking/);
  assert.match(intake, /createClosetCandidate/);
  assert.match(intake, /promoteSelectedClosetCandidates/);
});

test('ready unsaved media is snapshotted and acknowledged without a saved_scan reference', () => {
  const store = read('services/style-chat/styleChatAttachmentStore.ts');
  const hook = read('hooks/useStyleChat.ts');
  const provider = read('services/style-chat/providers/edgeStyleChatProvider.ts');

  assert.match(store, /entry\.fashionContext/);
  assert.match(store, /references:\s*unique[\s\S]*filter\(Boolean\)/);
  assert.match(hook, /references\.length\s*>\s*0\s*\|\|[\s\S]*fashionContext/);
  assert.match(provider, /fashionContextAccepted/);
  assert.match(provider, /fashionContextVersion/);
});

test('Closet retry is candidate-idempotent and never owns attachment state', () => {
  const attachments = read('hooks/useStyleChatAttachments.ts');
  const closet = read('services/closetLibrary.js');

  assert.match(attachments, /saveDirectImageToCloset/);
  assert.match(attachments, /promoteSelectedClosetCandidates/);
  assert.match(attachments, /applyClosetOutcome\(candidateId,\s*'save_failed'\)/);
  assert.match(closet, /sourceCandidateId/);
  assert.match(closet, /deduped:\s*true/);
});

test('cancelled staging and abandoned sends cannot remain pending forever', () => {
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');
  const send = read('hooks/useStyleChat.ts');

  assert.match(intake, /operationId !== operationIdRef\.current[\s\S]*deleteClosetCandidate/);
  assert.match(send, /activeAttachmentSendFailureRef/);
  assert.match(send, /failActiveAttachmentSend\?\.\(\)/);
});

test('retry has exactly one native photo-picker launch owner', () => {
  const intake = read('components/style-chat/StyleChatPhotoIntake.tsx');
  const retryHandler = intake.match(
    /const handleTryAnother = useCallback\(async \(\) => \{([\s\S]*?)\n  \}, \[[^\]]*\]\);/,
  )?.[1] ?? '';

  assert.match(retryHandler, /resetState\(\)/);
  assert.doesNotMatch(
    retryHandler,
    /startPicker\(/,
    'retry must reset to idle and let the existing visible+idle effect launch once',
  );
  assert.match(
    intake,
    /if \(visible && step === 'idle' && !inFlightRef\.current\) \{\s*void startPicker\(\);/,
  );
});
