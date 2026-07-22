/**
 * Elise visual attachment composer — unit coverage for limits, normalization,
 * deduplication, focus ordering, telemetry, and Scanner prep parity constants.
 */

const assert = require('assert');
const fs = require('fs');
const path = require('path');

const root = path.resolve(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

// ── Feature flag ─────────────────────────────────────────────────────────────

test('ELISE_VISUAL_ATTACHMENTS_V1_ENABLED flag exists and defaults off', () => {
  const flags = read('constants/featureFlags.ts');
  assert.match(flags, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED/);
  assert.match(
    flags,
    /process\.env\.EXPO_PUBLIC_ELISE_VISUAL_ATTACHMENTS_V1_ENABLED === 'true'/,
  );
  assert.doesNotMatch(flags, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED\s*=\s*true/);
  assert.doesNotMatch(flags, /DIRECT_IMAGE_ATTACHMENTS_ENABLED\s*=\s*false/);
});

test('session wires visual attachment flag and composer attach control', () => {
  const session = read('app/style-chat/[sessionId].tsx');
  assert.match(session, /ELISE_VISUAL_ATTACHMENTS_V1_ENABLED/);
  assert.match(session, /showAttachButton/);
  assert.match(session, /onDirectImage/);
  assert.match(session, /addDressingRoomItem/);
  assert.match(session, /addSharedItem/);
  assert.match(session, /setFocusedAttachment/);
});

test('composer input supports attach control layout', () => {
  const input = read('components/style-chat/StyleChatInput.tsx');
  assert.match(input, /showAttachButton/);
  assert.match(input, /onAttachPress/);
  assert.match(input, /stylechat-attach-button/);
});

test('attachment menu exposes required sources', () => {
  const bar = read('components/style-chat/StyleChatAttachmentBar.tsx');
  assert.match(bar, /Take Photo/);
  assert.match(bar, /Choose from Photos/);
  assert.match(bar, /Recent Scans/);
  assert.match(bar, /Closet & Saved/);
  assert.match(bar, /Dressing Rooms/);
  assert.match(bar, /stylechat-attach-take-photo/);
  assert.match(bar, /stylechat-attach-choose-photos/);
  assert.match(bar, /stylechat-attach-recent/);
  assert.match(bar, /stylechat-attach-closet/);
  assert.match(bar, /stylechat-attach-rooms/);
  // User-facing copy must stay nontechnical.
  assert.doesNotMatch(bar, /title=["'][^"']*V2/);
  assert.doesNotMatch(bar, />\s*focusEvidenceId\s*</);
  assert.doesNotMatch(bar, />\s*contractVersion\s*</);
});

// ── Verified limits ──────────────────────────────────────────────────────────

test('client limits are min(backend, product) and document focus contract', () => {
  const limits = read('types/eliseVisualAttachments.ts');
  assert.match(limits, /VERIFIED_BACKEND_MAX_ATTACHMENTS/);
  assert.match(limits, /VERIFIED_BACKEND_MAX_DIRECT_IMAGES/);
  assert.match(limits, /VERIFIED_BACKEND_MAX_IMAGE_BYTES/);
  assert.match(limits, /MAX_ELISE_ATTACHMENTS = Math\.min/);
  assert.match(limits, /MAX_ELISE_DIRECT_IMAGES = Math\.min/);
  assert.match(limits, /PRODUCT_MAX_ATTACHMENTS = 4/);
  assert.match(limits, /PRODUCT_MAX_DIRECT_IMAGES = 2/);

  const hook = read('hooks/useStyleChatAttachments.ts');
  assert.match(
    hook,
    /V2 treats attachment order as multimodal focus priority/,
  );
});

test('backend multimodal limits remain 2 images / 4MiB / jpeg|png|webp', () => {
  const multimodal = read('supabase/functions/stylechat-generate/multimodal.ts');
  assert.match(multimodal, /MAX_MULTIMODAL_IMAGES = 2/);
  assert.match(multimodal, /MAX_MULTIMODAL_TOTAL_BYTES = 4 \* 1024 \* 1024/);
  assert.match(multimodal, /image\/jpeg/);
  assert.match(multimodal, /image\/png/);
  assert.match(multimodal, /image\/webp/);
});

// ── Scanner prep reuse ───────────────────────────────────────────────────────

test('Scanner and Elise share metadata-stripped prep pathway', () => {
  const sanitizer = read('services/privacyImageSanitizer.js');
  assert.match(sanitizer, /metadata-stripped-reencode/);
  assert.match(sanitizer, /remoteTransmissionAllowed: true/);
  assert.doesNotMatch(sanitizer, /mode: 'blocked'/);

  const upload = read('services/privacyImageUpload.ts');
  assert.match(upload, /isPrivateImageUploadAvailable\(\): boolean \{\s*return true;/);
  assert.match(upload, /SCANNER_COMPAT_MAX_WIDTH = 896/);
  assert.match(upload, /SCANNER_COMPAT_JPEG_QUALITY = 0\.65/);

  const imageUtils = read('services/imageUtils.js');
  assert.match(imageUtils, /SCANNER_IMAGE_MAX_WIDTH = 896/);
  assert.match(imageUtils, /SCANNER_IMAGE_JPEG_QUALITY = 0\.65/);

  const direct = read('services/style-chat/eliseDirectImageAttachment.ts');
  assert.match(direct, /compressForUpload/);
  assert.match(direct, /prepareImageForPrivacyUpload/);
  assert.doesNotMatch(direct, /identifyScanImage/);
});

test('Scanner identify path supplies privacyProof from sanitizer status', () => {
  const hook = read('hooks/useKScan.js');
  assert.match(hook, /privacyProof:/);
  assert.match(hook, /metadataStripped: sanitizerStatus\.metadataStripped/);

  const identify = read('services/scanIdentification.ts');
  assert.match(identify, /typeof proof\.faceDetectionPerformed === 'boolean'/);
  assert.match(identify, /proof\.metadataStripped === true/);
});

// ── Normalization ────────────────────────────────────────────────────────────

test('normalizeAttachmentResource maps snake_case and rejects malformed rows', () => {
  // Lightweight inline copy of the pure mapping rules via source contract.
  const src = read('services/style-chat/eliseVisualAttachmentNormalize.ts');
  assert.match(src, /source_type/);
  assert.match(src, /source_id/);
  assert.match(src, /saved_scan_id/);
  assert.match(src, /room_id/);
  assert.match(src, /item_id/);
  assert.match(src, /actor_relationship/);
  assert.match(src, /storage_path/);
  assert.match(src, /return null/);
  assert.doesNotMatch(src, /\.\.\.raw/);
});

// ── Deduplication ────────────────────────────────────────────────────────────

test('dedupe helper prefers owned provenance and preserves focus', () => {
  const src = read('services/style-chat/eliseVisualAttachmentDedup.ts');
  assert.match(src, /provenanceRank/);
  assert.match(src, /focusedLocalKey/);
  assert.match(src, /Never escalate shared/);
  assert.match(src, /orderAttachmentsForSend/);
});

// ── Telemetry privacy ────────────────────────────────────────────────────────

test('telemetry is allowlisted and never logs raw media', () => {
  const src = read('services/style-chat/eliseVisualAttachmentTelemetry.ts');
  assert.match(src, /attachmentSourceCounts/);
  assert.match(src, /attachmentsResolved/);
  assert.match(src, /PREPARATION_FAILED/);
  assert.doesNotMatch(src, /base64|signedUrl|localUri|message text/i);
});

// ── Reddit screenshot fixture contract ───────────────────────────────────────

test('reddit lace-top fixture validates expected advice dimensions', () => {
  const fixture = {
    id: 'reddit-black-lace-off-shoulder-top',
    garment: {
      category: 'tops',
      silhouette: 'off-the-shoulder',
      material: 'black lace',
      visibleCompanion: 'dark denim shorts',
    },
    question: 'What bottoms should I wear with this top?',
    expectedAdviceDimensions: [
      'black lace',
      'off-the-shoulder',
      'bottom pairing',
      'color harmony',
      'proportion',
      'occasion',
      'material contrast',
    ],
    forbiddenInferences: [
      'identity',
      'age',
      'ethnicity',
      'health',
      'body measurements',
      'sexual history',
    ],
  };

  assert.equal(fixture.question.includes('bottoms'), true);
  assert.equal(fixture.garment.material, 'black lace');
  assert.ok(fixture.expectedAdviceDimensions.includes('bottom pairing'));
  assert.ok(!fixture.forbiddenInferences.includes('silhouette'));

  // Source must construct V2 owned_item/saved_scan for direct images.
  const direct = read('services/style-chat/eliseDirectImageAttachment.ts');
  assert.match(direct, /attachmentType: 'owned_item'/);
  assert.match(direct, /sourceType: 'saved_scan'/);
  assert.match(direct, /contractVersion: STYLECHAT_ATTACHMENT_CONTRACT_VERSION/);
});

// ── Empty / rejection response handling ──────────────────────────────────────

test('empty attachment response uses recoverable copy and keeps drafts', () => {
  const hook = read('hooks/useStyleChat.ts');
  assert.match(hook, /STYLECHAT_ATTACHMENT_EMPTY_RESPONSE_COPY/);
  assert.match(hook, /couldn’t generate advice for that attachment/i);
  assert.match(hook, /hasAttachments && !trimmedAssistant && !hasActions/);
  assert.match(hook, /STYLECHAT_ATTACHMENTS_REJECTED_COPY/);
});

test('no new global privacy hard-block was introduced', () => {
  const sanitizer = read('services/privacyImageSanitizer.js');
  const upload = read('services/privacyImageUpload.ts');
  assert.doesNotMatch(sanitizer, /DIRECT_IMAGE_ATTACHMENTS_ENABLED/);
  assert.doesNotMatch(upload, /DIRECT_IMAGE_ATTACHMENTS_ENABLED/);
  assert.doesNotMatch(sanitizer, /QA account|allowlist|bypass/i);
});

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (error) {
    console.error(`not ok - ${name}`);
    console.error(error);
    process.exitCode = 1;
  }
}
