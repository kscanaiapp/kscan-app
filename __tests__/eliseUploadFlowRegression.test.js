// Phase 2 image-intake flow regression tests for the Elise UX polish build.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

const photoIntake = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatPhotoIntake.tsx'), 'utf8');
const useAttachments = fs.readFileSync(path.join(ROOT, 'hooks', 'useStyleChatAttachments.ts'), 'utf8');
const attachmentBar = fs.readFileSync(path.join(ROOT, 'components', 'style-chat', 'StyleChatAttachmentBar.tsx'), 'utf8');
const provider = fs.readFileSync(path.join(ROOT, 'services', 'style-chat', 'providers', 'edgeStyleChatProvider.ts'), 'utf8');
const attachmentStore = fs.readFileSync(path.join(ROOT, 'services', 'style-chat', 'styleChatAttachmentStore.ts'), 'utf8');

// ── Intake sequence ──────────────────────────────────────────────────────────

test('photo intake still opens image picker first', () => {
  assert.match(photoIntake, /launchImageLibraryAsync|launchCameraAsync/);
});

test('privacy sanitizer remains first guard', () => {
  assert.match(photoIntake, /sanitizeImageBeforeUpload/);
});

test('scan-identify remains guarded before review', () => {
  assert.match(photoIntake, /identifyScanImage/);
  assert.match(photoIntake, /step === 'review'/);
});

test('completed identification uses the shared mapper and persists candidate metadata', () => {
  assert.match(photoIntake, /mapScanIdentifyToAnalysis/);
  assert.doesNotMatch(photoIntake, /identification as any\)\?\.metadata/);
  assert.match(photoIntake, /persistCandidateReview/);
  assert.match(photoIntake, /color:\s*mapped\.metadata\.color/);
  assert.match(photoIntake, /updateClosetCandidate/);
});

test('attachment is explicit and Closet persistence remains optional', () => {
  assert.match(photoIntake, /title="Attach to Elise"/);
  assert.match(photoIntake, /['"]Save to Closet['"]/);
  assert.match(photoIntake, /promoteSelectedClosetCandidates/);
  assert.doesNotMatch(photoIntake, /Save to Closet & Attach/);
  assert.match(photoIntake, /onAttached/);
});

test('manual metadata fallback remains available', () => {
  assert.match(photoIntake, /manual_details/);
  assert.match(photoIntake, /title.*category/);
});

test('remote backing remains required for resolved attachments', () => {
  assert.match(useAttachments, /uploading_media/);
  assert.match(useAttachments, /ensureSavedScanMediaBacking/);
  assert.match(useAttachments, /state === 'ready'/);
});

test('local URI never enters server payload', () => {
  // The provider builds a body with only sessionId, message, and stable
  // attachment references. No local URI or image path fields are sent.
  assert.match(provider, /sessionId: input\.sessionId/);
  assert.match(provider, /message: input\.message/);
  assert.match(provider, /attachments: input\.attachments/);
  assert.doesNotMatch(provider, /localUri|local_uri/);
});

test('send is blocked while attachments are unresolved', () => {
  assert.match(useAttachments, /canSendWithAttachments/);
  assert.match(useAttachments, /isPendingAttachmentState/);
});

test('failed upload remains retryable', () => {
  assert.match(attachmentBar, /onRetry/);
  assert.match(useAttachments, /retryAttachment/);
  assert.match(attachmentBar, /failed_retryable/);
});

test('draft preservation and handoff consumption remain wired', () => {
  assert.match(useAttachments, /draftId/);
  assert.match(useAttachments, /consumeAttachmentHandoff/);
  assert.match(attachmentStore, /DraftAttachment/);
});

// ── Component references ─────────────────────────────────────────────────────

test('Phase 2 component names and handoff keys are not renamed for branding', () => {
  assert.match(photoIntake, /export function StyleChatPhotoIntake/);
  assert.match(photoIntake, /onAttached/);
  assert.match(useAttachments, /addResolvedOwnedItem/);
  assert.match(useAttachments, /StyleChatAttachment/);
});
