const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('Build 35 restores real 1-5 image selection and review controls', () => {
  const hook = read('hooks/useKScan.js');
  const review = read('components/scan-room/CaptureReview.tsx');
  const flags = read('constants/featureFlags.ts');

  assert.match(flags, /EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED === 'true'/);
  assert.match(hook, /allowsMultipleSelection:\s*MULTI_IMAGE_SCANNER_ENABLED/);
  assert.match(hook, /selectionLimit:\s*MULTI_IMAGE_SCANNER_ENABLED \? remaining : 1/);
  assert.match(hook, /orderedSelection:\s*MULTI_IMAGE_SCANNER_ENABLED/);
  assert.match(hook, /normalizeImageSelections\(/);
  assert.match(hook, /removeImageSelection\(selectedImages, imageId\)/);
  assert.match(review, /reviewImages\.map\(\(image, index\)/);
  assert.match(review, /scan-room-add-image/);
  assert.match(review, /scan-room-remove-image-/);
});

test('multi-image batches use current Scanner V2 orchestration one evidence image at a time', () => {
  const hook = read('hooks/useKScan.js');
  const request = read('services/scannerScanRequest.ts');

  assert.match(hook, /Promise\.allSettled\([\s\S]*preparedEntries\.map/);
  assert.match(hook, /runScannerIdentification\(\{/);
  assert.match(hook, /mode:\s*'detect_items'/);
  assert.match(hook, /mode:\s*'identify_selected_item'/);
  assert.match(hook, /multiImageSessionsRef/);
  assert.match(hook, /multiImageCandidateLookupRef/);
  assert.match(hook, /serverCandidateId/);
  assert.match(request, /ONE evidence object per HTTP request/);
  assert.match(request, /every image of an Android batch/);
});

test('restored batch candidate identity remains source-image bound', () => {
  const hook = read('hooks/useKScan.js');
  const result = read('components/scan-results/ScanResultV2.tsx');

  assert.match(hook, /sourceImageId:\s*entry\.image\.id/);
  assert.match(hook, /sourceImageIndex:\s*entry\.image\.originalIndex/);
  assert.match(hook, /sourceImageUri:\s*entry\.image\.uri/);
  assert.match(hook, /const displayId = \`\$\{entry\.image\.id\}:\$\{candidate\.id\}\`/);
  assert.match(result, /sourceImageIndex/);
  assert.match(result, /from image/);
});

test('ordinary production remains opt-in while Staging and certification can exercise restoration', () => {
  const eas = JSON.parse(read('eas.json'));
  assert.equal(eas.build.production.env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED, undefined);
  assert.equal(eas.build.staging.env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED, 'true');
  assert.equal(eas.build['production-certification'].env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED, 'true');
});
