const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (relative) => fs.readFileSync(path.join(ROOT, relative), 'utf8');

test('picker exposes a real 1-5 image selection and review/removal flow', () => {
  const hook = read('hooks/useKScan.js');
  const review = read('components/scan-room/CaptureReview.tsx');
  assert.match(hook, /allowsMultipleSelection:\s*MULTI_IMAGE_SCANNER_ENABLED/);
  assert.match(hook, /selectionLimit:\s*MULTI_IMAGE_SCANNER_ENABLED \? MAX_SCAN_IMAGES : 1/);
  assert.match(hook, /normalizeImageSelections\([\s\S]*result\.assets/);
  assert.match(hook, /removeImageSelection\(selectedImages, imageId\)/);
  assert.match(review, /reviewImages\.map\(\(image, index\)/);
  assert.match(review, /scan-room-remove-image-/);
  assert.match(review, /scan-room-add-image/);
});

test('all selected images enter the bounded v119 request pipeline in stable order', () => {
  const hook = read('hooks/useKScan.js');
  // Parallel per-image detection tolerates partial source failure.
  assert.match(hook, /Promise\.allSettled\(imagesForAttempt\.map/);
  assert.match(hook, /requestMode:\s*'multi_item_detection'/);
  assert.match(hook, /requestMode:\s*'selected_item'/);
  assert.match(hook, /scanSessionId:\s*candidate\.detectionResponse\.scanSessionId/);
  assert.match(hook, /imageDigestPrefix:\s*candidate\.detectionResponse\.imageDigestPrefix/);
  assert.match(hook, /buildMultiScanCandidates\(detectionResponses\)/);
  // No automatic pre-selection commerce fan-out: the singular selected_item
  // request may exist only inside the sequential queue processor.
  const detectionSection = hook.slice(hook.indexOf('const runAnalysis'), hook.indexOf('const toggleScanCandidate'));
  assert.doesNotMatch(detectionSection, /selected_item/);
  assert.match(hook, /processSelectedItemQueue/);
});

test('request cancellation, timeout, unmount, and stale-response guards cover the multi-image attempt', () => {
  const hook = read('hooks/useKScan.js');
  assert.match(hook, /ATTEMPT_TIMEOUT_MS = 52_000/);
  assert.match(hook, /activeAbortControllerRef\.current\?\.abort\(\)/);
  assert.match(hook, /const attemptController = activeAbortControllerRef\.current/);
  assert.match(hook, /signal:\s*attemptController\?\.signal/);
  assert.match(hook, /attemptTimeoutId = setTimeout\(\(\) => \{[\s\S]*attemptController\?\.abort\(\)/);
  assert.match(hook, /!isOperationValid\(operationId\)/);
  assert.match(hook, /isGenerationValid\(generation/);
  assert.match(hook, /isMountedRef\.current/);
});

test('multi-item UI supports item selection, save-one, save-all, and deliberate add-all', () => {
  const app = read('app.js');
  const navigator = read('components/scan-results/MultiItemResultNavigator.tsx');
  assert.match(app, /onSelectItem:\s*selectScanItem/);
  assert.match(app, /persistScanItem\(activeScanItem\)/);
  assert.match(app, /saveAllScanItems/);
  assert.match(app, /setAddAllToRoom\(true\)/);
  assert.match(navigator, /multi-item-save-all/);
  assert.match(navigator, /multi-item-add-all-room/);
  assert.match(navigator, /IMAGE \{item\.sourceImageIndex \+ 1\}/);
});

test('save metadata is backward-compatible and associates item to scan group/image', () => {
  const app = read('app.js');
  assert.match(app, /multiScan:\s*\{/);
  assert.match(app, /schemaVersion:\s*1/);
  assert.match(app, /sourceImageId:\s*item\.sourceImageId/);
  assert.match(app, /sourceImageIndex:\s*item\.sourceImageIndex/);
  assert.match(app, /source:\s*item\.source === 'camera' \|\| item\.source === 'upload'/);
  assert.doesNotMatch(app, /source:\s*photo\.source \|\| 'scan'/);
});

test('multi-item Dressing Room add isolates item failures and suppresses duplicate taps', () => {
  const modal = read('components/AddScanToDressingRoomModal.tsx');
  assert.match(modal, /additionalScans/);
  assert.match(modal, /Promise\.allSettled/);
  assert.match(modal, /if \(savingRef\.current\) return/);
  assert.match(modal, /result\.saved === 0/);
  assert.match(modal, /Added \$\{result\.saved\} of \$\{result\.total\} items/);
});

test('multi-image is enabled across every Android v26 build profile', () => {
  // Android v26 owner ruling: multi-image Scanner ships as a release feature.
  // The earlier posture kept production opt-in; that is no longer the accepted
  // release configuration, and the flag must not be disabled to satisfy it.
  const flags = read('constants/featureFlags.ts');
  const eas = JSON.parse(read('eas.json'));
  assert.match(flags, /EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED === 'true'/);
  for (const profile of ['development', 'preview', 'production']) {
    assert.equal(
      eas.build[profile].env.EXPO_PUBLIC_MULTI_IMAGE_SCANNER_ENABLED,
      'true',
      profile + ' must enable multi-image',
    );
  }
});

test('Android permission posture remains picker-based without broad media access', () => {
  const app = JSON.parse(read('app.json'));
  const permissions = app.expo.android.permissions;
  const blocked = app.expo.android.blockedPermissions;
  assert.ok(!permissions.includes('android.permission.READ_MEDIA_IMAGES'));
  assert.ok(blocked.includes('android.permission.READ_MEDIA_IMAGES'));
  assert.ok(blocked.includes('android.permission.READ_EXTERNAL_STORAGE'));
  assert.ok(permissions.includes('android.permission.CAMERA'));
});

test('candidate Edge Function source matches v119 two-stage contract and five-item bound', () => {
  const edge = read('supabase/functions/scan-identify/index.ts');
  const sanitizer = read('supabase/functions/scan-identify/multiItemGarments.ts');
  assert.match(edge, /requestMode === 'selected_item'/);
  assert.match(edge, /requestMode === 'multi_item_detection'/);
  assert.match(edge, /selected_item_image_mismatch/);
  assert.match(edge, /detectedGarments/);
  assert.match(sanitizer, /const MAX_GARMENTS = 5/);
  assert.match(sanitizer, /sanitizeDetectedGarments/);
});
