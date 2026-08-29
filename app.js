import React, { useCallback, useEffect, useRef, useState } from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  Pressable,
  Image,
  ActivityIndicator,
  Animated,
  BackHandler,
  Modal,
  Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions } from 'expo-camera';
import { StatusBar } from 'expo-status-bar';
import { useRouter } from 'expo-router';

import { useScanAnimation } from './hooks/useScanAnimation';
import { useKScan } from './hooks/useKScan';
import { candidateReviewDescriptor } from './services/multiImageScan';
import {
  saveScan,
  selectPurchaseOptionsSnapshot,
  attachScanPurchaseOptions,
  purchaseOptionsFingerprint,
} from './services/library';
import { createActorRequest, isActorRequestCurrent } from './services/actorContext';
import { setStyleChatHandoffContext } from './services/style-chat/styleChatHandoffContext';
import { AnalysisCard } from './components/AnalysisCard';
import { ScanResultV2 } from './components/scan-results/ScanResultV2';
import { ScanLanding } from './components/scan-room/ScanLanding';
import { LiveScanCamera } from './components/scan-room/LiveScanCamera';
import { CaptureReview } from './components/scan-room/CaptureReview';
import { AnalyzingScan } from './components/scan-room/AnalyzingScan';
import { AddScanToDressingRoomModal } from './components/AddScanToDressingRoomModal';
import { PerceptionLayer } from './components/PerceptionLayer';
import { ScanButton } from './components/ScanButton';
import { useFeatureFreeze } from './hooks/useFeatureFreeze';
import { useAuthSession } from './contexts/AuthSessionContext';
import {
  APP_BUILD_LABEL,
  DEV_FALLBACK_STATUS,
  QA_TOOLS_ENABLED,
} from './constants/build';
import {
  MULTI_IMAGE_SCANNER_ENABLED,
  TEXTSCAN_UI_ENABLED,
  SCAN_RESULTS_V2_UI_ENABLED,
  SCAN_ROOM_V2_UI_ENABLED,
} from './constants/featureFlags';
import { QA_FIXTURES } from './constants/qaFixtures';
import {
  BUTTONS,
  COLORS,
  LAYOUT,
  LOADING,
  LUXURY,
  RADIUS,
  SHADOWS,
  SPACING,
  TOAST,
  TYPOGRAPHY,
  viewfinder,
} from './constants/theme';

const EMPTY_METADATA = {
  category: '',
  color: '',
  silhouette: '',
};

const VOICE_UI_ENABLED = false;

/**
 * TextScan entry point inside the Scan surface.
 *
 * - Rendered as a subtle pill above the capture button.
 * - Uses the existing dark Scan HUD styling (ivory text, champagne/gold border).
 * - Tapping pushes /text-scan and leaves the camera view completely.
 */
function TextScanEntryPoint({ enabled }) {
  const router = useRouter();

  if (!enabled) return null;

  return (
    <TouchableOpacity
      testID="textscan-entry-button"
      style={styles.textScanEntry}
      onPress={() => router.push('/text-scan')}
      activeOpacity={0.86}
      accessibilityRole="button"
      accessibilityLabel="Open TextScan"
      accessibilityHint="Describes a fashion item with text instead of the camera"
    >
      <Text style={styles.textScanEntryText}>✧ TextScan</Text>
    </TouchableOpacity>
  );
}

/**
 * FUTURE: Voice input entry point.
 * When microphone permission, privacy disclosures, and backend voice contract
 * are ready, mount a voice input affordance near the capture controls. Keep
 * disabled until approved.
 */
function VoiceInputPlaceholder() {
  if (!VOICE_UI_ENABLED) return null;
  return null;
}

function ErrorToast({ message, onDismiss }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, {
      toValue: 1,
      duration: 250,
      useNativeDriver: true,
    }).start();

    const timer = setTimeout(() => {
      Animated.timing(opacity, {
        toValue: 0,
        duration: 250,
        useNativeDriver: true,
      }).start(() => {
        if (onDismiss) onDismiss();
      });
    }, 3000);

    return () => clearTimeout(timer);
  }, [onDismiss, opacity]);

  return (
    <Animated.View style={[styles.errorToast, { opacity }]}>
      <Text style={styles.errorToastText}>{message}</Text>
    </Animated.View>
  );
}

function SavedToast({ onDismiss }) {
  const opacity = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(opacity, { toValue: 1, duration: 200, useNativeDriver: true }).start();
    const timer = setTimeout(() => {
      Animated.timing(opacity, { toValue: 0, duration: 200, useNativeDriver: true }).start(() => {
        if (onDismiss) onDismiss();
      });
    }, 1800);
    return () => clearTimeout(timer);
  }, [onDismiss, opacity]);

  return (
    <Animated.View style={[styles.savedToast, { opacity }]}>
      <Text style={styles.savedToastText}>Saved to Style Closet</Text>
    </Animated.View>
  );
}

function ActionButton({ label, onPress, variant = 'primary', disabled = false }) {
  const isPrimary = variant === 'primary';
  const isSecondary = variant === 'secondary';
  const isTertiary = variant === 'tertiary';

  return (
    <TouchableOpacity
      style={[
        styles.actionButtonBase,
        isPrimary ? styles.primaryButton : null,
        isSecondary ? styles.secondaryButton : null,
        isTertiary ? styles.tertiaryButton : null,
        disabled ? styles.buttonDisabled : null,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.86}
      accessibilityLabel={label}
    >
      <Text
        style={[
          styles.actionButtonText,
          isPrimary ? styles.primaryButtonText : null,
          isSecondary ? styles.secondaryButtonText : null,
          isTertiary ? styles.tertiaryButtonText : null,
        ]}
        numberOfLines={2}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

function ProcessingPanel() {
  const [showSpinner, setShowSpinner] = useState(false);
  const [showLongWait, setShowLongWait] = useState(false);

  useEffect(() => {
    const spinnerTimer = setTimeout(() => setShowSpinner(true), 200);
    const longWaitTimer = setTimeout(() => setShowLongWait(true), 10000);
    return () => {
      clearTimeout(spinnerTimer);
      clearTimeout(longWaitTimer);
    };
  }, []);

  return (
    <View style={styles.processingPanel}>
      <View style={styles.processingIndicatorSlot}>
        {showSpinner ? (
          <ActivityIndicator size={LOADING.indicatorSize} color={COLORS.activeVision} />
        ) : (
          <View style={styles.processingIndicatorHalo} />
        )}
      </View>
      <Text style={styles.processingText}>Analyzing your look…</Text>
      <Text style={styles.processingCaption}>
        {showLongWait
          ? 'Analysis is taking longer than expected. Please try again if it continues.'
          : 'This may take a moment'}
      </Text>
    </View>
  );
}

function QAPanel({ status, onSelectFixture }) {
  if (!QA_TOOLS_ENABLED) return null;

  return (
    <View style={styles.qaPanel} testID="qa-panel">
      <Text style={styles.qaTitle}>QA</Text>
      <Text style={styles.qaText}>Build: {APP_BUILD_LABEL}</Text>
      <Text style={styles.qaText}>DEV_FALLBACK: {DEV_FALLBACK_STATUS}</Text>
      <Text style={styles.qaText}>Static QA: enabled</Text>
      <Text style={styles.qaText}>State: {status}</Text>
      <View style={styles.qaFixtureGrid}>
        {QA_FIXTURES.map((fixture) => (
          <TouchableOpacity
            key={fixture.id}
            style={[
              styles.qaFixtureButton,
              status !== 'idle' ? styles.qaFixtureButtonDisabled : null,
            ]}
            onPress={() => onSelectFixture(fixture)}
            disabled={status !== 'idle'}
            activeOpacity={0.78}
          >
            <Text style={styles.qaFixtureText}>{fixture.label}</Text>
          </TouchableOpacity>
        ))}
      </View>
    </View>
  );
}

export default function App() {
  const [permission, requestPermission] = useCameraPermissions();
  const cameraRef = useRef(null);
  const [isCameraReady, setIsCameraReady] = useState(false);
  const { isFeatureEnabled, isLoading: featureFreezeLoading } = useFeatureFreeze();
  const { user } = useAuthSession();
  const dressingRoomsEnabled = !featureFreezeLoading && isFeatureEnabled('dressingRooms');
  const styleChatEnabled = !featureFreezeLoading && isFeatureEnabled('styleChat');
  const textScanEnabled =
    TEXTSCAN_UI_ENABLED && !featureFreezeLoading && isFeatureEnabled('textScan');

  const {
    status,
    photo,
    selectedImages,
    analysis,
    commerceStatus,
    retryCommerce,
    scanItems,
    selectedScanItemId,
    analysisActorId,
    error,
    nonFashionMessage,
    isAnalyzing,
    scanCandidates,
    selectedCandidateIds,
    scanStage,
    itemStates,
    queueActive,
    queueHalted,
    detectionNotice,
    queueNotice,
    capturePhoto,
    runAnalysis,
    retake,
    dismissResult,
    retry,
    selectStaticFixture,
    selectGalleryPhoto,
    addGalleryPhotos,
    removeSelectedImage,
    selectScanItem,
    toggleScanCandidate,
    confirmSelectedCandidates,
  } = useKScan(user?.id ?? null);

  const router = useRouter();
  const [qaPanelVisible, setQaPanelVisible] = useState(false);
  const qaTapRef = useRef({ count: 0, lastTap: 0 });

  // Scan Room V2 state
  const [v2CameraVisible, setV2CameraVisible] = useState(false);
  const [v2AnalyzingMinComplete, setV2AnalyzingMinComplete] = useState(false);

  const handleHome = useCallback(() => {
    router.replace('/');
  }, [router]);

  useEffect(() => {
    if (!permission?.granted || isCameraReady) return undefined;
    const timer = setTimeout(() => {
      setIsCameraReady(true);
    }, 2500);
    return () => clearTimeout(timer);
  }, [permission?.granted, isCameraReady]);

  useEffect(() => {
    if (typeof __DEV__ === 'undefined' || !__DEV__) return;
    console.log(`[K-SCAN] Build: ${APP_BUILD_LABEL}`);
    console.log('[K-SCAN] __DEV__:', true);
    console.log(`[K-SCAN] DEV_FALLBACK: ${DEV_FALLBACK_STATUS}`);
    console.log(`[K-SCAN] Static QA path enabled: ${QA_TOOLS_ENABLED}`);
    if (QA_TOOLS_ENABLED) console.log('[K-SCAN] QA tools active');
  }, []);

  useEffect(() => {
    if (status === 'processing') {
      setV2AnalyzingMinComplete(false);
    }
  }, [status]);

  useEffect(() => {
    if (!v2CameraVisible) {
      setIsCameraReady(false);
    }
  }, [v2CameraVisible]);

  const handleBrandPress = useCallback(() => {
    if (!QA_TOOLS_ENABLED) return;

    const now = Date.now();
    const previous = qaTapRef.current;
    const count = now - previous.lastTap < 800 ? previous.count + 1 : 1;
    qaTapRef.current = { count, lastTap: now };

    if (count >= 3) {
      qaTapRef.current = { count: 0, lastTap: 0 };
      setQaPanelVisible((visible) => !visible);
    }
  }, []);

  const renderBrandTitle = () => (
    <TouchableOpacity
      onPress={handleBrandPress}
      activeOpacity={QA_TOOLS_ENABLED ? 0.82 : 1}
      accessibilityLabel="K Scan AI"
    >
      <Text style={styles.brandTitle}>K Scan AI</Text>
    </TouchableOpacity>
  );

  const handleSelectFixture = useCallback(
    (fixture) => {
      if (!QA_TOOLS_ENABLED) return;
      const resolved = Image.resolveAssetSource(fixture.source);
      selectStaticFixture(resolved?.uri, fixture.id);
      setQaPanelVisible(false);
    },
    [selectStaticFixture]
  );

  // Track saves per detected item so retries and effect re-runs remain idempotent.
  const [savedToast, setSavedToast] = useState(false);
  const [savedScanIdsByItem, setSavedScanIdsByItem] = useState({});
  const savingItemIdsRef = useRef(new Set());
  const scanGroupIdRef = useRef(null);
  const currentActorIdRef = useRef(user?.id ?? null);
  currentActorIdRef.current = user?.id ?? null;
  const [scanRoomModalVisible, setScanRoomModalVisible] = useState(false);
  const [addAllToRoom, setAddAllToRoom] = useState(false);

  const activeScanItem = scanItems.find((item) => item.id === selectedScanItemId) ?? null;
  const activePhoto = activeScanItem
    ? { uri: activeScanItem.sourceImageUri, source: activeScanItem.source }
    : photo;
  const activeSavedScanId = activeScanItem
    ? savedScanIdsByItem[activeScanItem.id] ?? null
    : null;

  // ── Deliberate multi-item review / queue derived state (render-only). All
  //    selection and queue authority lives in useKScan.js. ──
  const reviewCandidates = scanCandidates.map(candidateReviewDescriptor);
  const reviewCandidateById = new Map(reviewCandidates.map((entry) => [entry.id, entry]));
  // FIFO summaries for every selected candidate: completed items navigate,
  // queued/analyzing/failed items render as visibly pending, non-savable chips.
  const multiItemSummaries = selectedCandidateIds
    .map((candidateId) => {
      const ready = scanItems.find((item) => item.id === candidateId);
      if (ready) {
        return {
          id: ready.id,
          label: ready.label,
          sourceImageIndex: ready.sourceImageIndex,
          detailStatus: ready.detailStatus,
        };
      }
      const descriptor = reviewCandidateById.get(candidateId);
      if (!descriptor) return null;
      return {
        id: descriptor.id,
        label: descriptor.label,
        sourceImageIndex: descriptor.sourceImageIndex,
        detailStatus: 'complete',
      };
    })
    .filter(Boolean);
  const remainingSelectedCount = selectedCandidateIds
    .filter((candidateId) => itemStates[candidateId] !== 'ready')
    .length;
  const showCandidateReview =
    scanStage === 'review' || (scanStage === 'results' && !analysis);

  // perceiving: true while the post-result PerceptionLayer (real metadata) is
  // running. The AnalysisCard is held back until perceiving becomes false.
  const [perceiving, setPerceiving] = useState(false);
  // procHudKey: bumped each time a new analysis starts so the processing
  // PerceptionLayer always mounts fresh even on retry.
  const [procHudKey, setProcHudKey] = useState(0);

  const prevStatus = useRef(status);
  useEffect(() => {
    const prev = prevStatus.current;
    prevStatus.current = status;

    if (status === 'processing') {
      // New analysis: reset post-result HUD and mount a fresh processing HUD
      setPerceiving(false);
      setProcHudKey(k => k + 1);
      setV2AnalyzingMinComplete(false);
      setSavedScanIdsByItem({});
      savingItemIdsRef.current.clear();
      scanGroupIdRef.current = `multi-scan-${Date.now()}`;
      setAddAllToRoom(false);
      return;
    }
    // When processing succeeds, briefly show the HUD with real metadata
    // before revealing the AnalysisCard (the cinematic reveal moment).
    // The post-result PerceptionLayer HUD only mounts when the legacy
    // (non-V2) scan room UI is active, so only gate on it there --
    // otherwise `perceiving` would stay true forever and the V2 result
    // Modal (ScanResultV2 / AnalysisCard) would never be allowed to render.
    if (prev === 'processing' && status === 'result') {
      setPerceiving(!SCAN_ROOM_V2_UI_ENABLED);
      return;
    }
    // Clear on any reset path
    if (status === 'idle' || status === 'error' || status === 'non-fashion') {
      setPerceiving(false);
    }
  }, [status]);

  // Save one detected item at a time; the in-flight set closes manual/automatic races.
  const persistScanItem = useCallback(async (item) => {
    if (!item || !analysisActorId || analysisActorId !== user?.id) return null;
    if (savedScanIdsByItem[item.id]) return savedScanIdsByItem[item.id];
    if (savingItemIdsRef.current.has(item.id)) return null;
    savingItemIdsRef.current.add(item.id);
    // Capture (actorId, actorEpoch, requestId) BEFORE the async save. The
    // persistence layer derives ownership from this and rejects the write if the
    // actor changed while the scan was being persisted, so in-flight
    // authenticated work can never be downgraded into an ownerless record.
    const actorRequest = createActorRequest();
    try {
      const saved = await saveScan({
        photoUri: item.sourceImageUri,
        analysis: {
          ...item.analysis,
          multiScan: {
            schemaVersion: 1,
            groupId: scanGroupIdRef.current,
            itemId: item.id,
            sourceImageId: item.sourceImageId,
            sourceImageIndex: item.sourceImageIndex,
            imageCount: selectedImages.length || 1,
            // Selected count is the stable session total even when the user
            // saves the first progressive result while later items are queued.
            itemCount: selectedCandidateIds.length || scanItems.length || 1,
          },
        },
        source: item.source === 'camera' || item.source === 'upload' ? item.source : 'unknown',
        actorRequest,
      });
      if (saved) {
        if (currentActorIdRef.current !== analysisActorId) return null;
        if (!isActorRequestCurrent(actorRequest)) return null;
        setSavedScanIdsByItem((current) => ({ ...current, [item.id]: saved.id }));
        setSavedToast(true);
        return saved.id;
      }
      return null;
    } finally {
      savingItemIdsRef.current.delete(item.id);
    }
  }, [analysisActorId, user?.id, savedScanIdsByItem, selectedImages.length, selectedCandidateIds.length, scanItems.length]);

  useEffect(() => {
    setSavedScanIdsByItem({});
    savingItemIdsRef.current.clear();
    setScanRoomModalVisible(false);
    setAddAllToRoom(false);
  }, [user?.id]);

  const saveAllScanItems = useCallback(async () => {
    await Promise.all(scanItems.map((item) => persistScanItem(item)));
  }, [scanItems, persistScanItem]);

  useEffect(() => {
    if (
      status !== 'result' ||
      scanStage !== 'results' ||
      queueActive ||
      queueHalted !== null ||
      selectedCandidateIds.length !== 1 ||
      scanItems.length !== 1 ||
      selectedImages.length > 1 ||
      !analysisActorId ||
      analysisActorId !== user?.id
    ) return;
    void persistScanItem(scanItems[0]);
  }, [status, scanStage, queueActive, queueHalted, selectedCandidateIds.length, scanItems, selectedImages.length, analysisActorId, user?.id, persistScanItem]);

  // v127: attach commerce that arrived after a scan item's row was already
  // written.
  //
  // Android saves per item (persistScanItem / savedScanIdsByItem) rather than
  // a single scan record, so this iterates every scanItems entry instead of
  // reading a single saved id. It is correct whether commerce lands before or
  // after that item's save completes — the saved id simply appears later in
  // savedScanIdsByItem in that case — and there is no timer anywhere in this
  // path. It also updates every item, not only the one currently displayed, so
  // a background item's commerce still persists once it is saved.
  const attachedCommerceRef = useRef({});
  useEffect(() => {
    if (status !== 'result') return;
    for (const item of scanItems) {
      const savedId = savedScanIdsByItem[item.id];
      if (!savedId) continue;
      const options = selectPurchaseOptionsSnapshot(item.analysis);
      if (!options.length) continue;
      // One attach per (record, shelf). Re-running for the same shelf would be
      // harmless — the write replaces rather than appends — but it would still
      // be a pointless write on every rerender. Keyed on shelf CONTENT, because
      // enrichment upgrades offers in place and so leaves the count unchanged.
      const key = savedId + ':' + purchaseOptionsFingerprint(options);
      if (attachedCommerceRef.current[item.id] === key) continue;
      attachedCommerceRef.current[item.id] = key;
      const actorRequest = createActorRequest();
      attachScanPurchaseOptions(savedId, options, { actorRequest }).catch(() => null);
    }
  }, [status, scanItems, savedScanIdsByItem]);

  // Android hardware back button — handle non-modal screens where React
  // Native's default behavior would exit the app instead of resetting state.
  // The result Modal already handles back via onRequestClose, so we only need
  // to intercept the states that render plain screens (no Modal).
  useEffect(() => {
    const onBack = () => {
      // Block back during active analysis: aborting here would leave the
      // network request orphaned and the state machine in an undefined position.
      if (status === 'processing') return true;
      // Block back during the brief cinematic HUD reveal (< 1s window).
      if (status === 'result' && perceiving) return true;
      // result + !perceiving: AnalysisCard Modal handles back via onRequestClose.
      if (status === 'result') return false;
      // preview: discard the captured photo and return to camera.
      if (status === 'preview') { retake(); return true; }
      // non-fashion: return to camera without treating it as an error.
      if (status === 'non-fashion') { dismissResult(); return true; }
      // error: return to camera (retake clears state; dismissResult if no photo).
      if (status === 'error') {
        if (photo) { retake(); } else { dismissResult(); }
        return true;
      }
      // idle / capturing: allow default (exit app or navigate back).
      return false;
    };
    const sub = BackHandler.addEventListener('hardwareBackPress', onBack);
    return () => sub.remove();
  }, [status, perceiving, photo, retake, dismissResult]);

  const scanAnim = useScanAnimation(status === 'processing');

  if (!permission) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.centerContent}>
          {renderBrandTitle()}
          <Text style={styles.infoText}>
            We need access to your camera to capture your look.
          </Text>
          <ActionButton label="Allow Camera" onPress={requestPermission} />
        </View>
      </SafeAreaView>
    );
  }

  if (!permission.granted) {
    return (
      <SafeAreaView style={styles.container}>
        <StatusBar style="light" />
        <View style={styles.centerContent}>
          {renderBrandTitle()}
          <Text style={styles.infoText}>
            Camera access is currently disabled. Enable it in settings to continue.
          </Text>
          <ActionButton label="Grant Access" onPress={requestPermission} />
        </View>
      </SafeAreaView>
    );
  }

  const renderViewfinder = (isProcessing = false) => (
    <View style={[styles.viewfinderOverlay, { pointerEvents: 'none' }]}>
      <View style={styles.viewfinderFrame}>
        <View style={[styles.corner, styles.topLeft]} />
        <View style={[styles.corner, styles.topRight]} />
        <View style={[styles.corner, styles.bottomLeft]} />
        <View style={[styles.corner, styles.bottomRight]} />
        {isProcessing && (
          <Animated.View
            style={[
              styles.scanningLine,
              {
                transform: [
                  {
                    translateY: scanAnim.interpolate({
                      inputRange: [0, 1],
                      outputRange: [
                        -viewfinder.scanningLineOffset,
                        viewfinder.scanningLineOffset,
                      ],
                    }),
                  },
                ],
              },
            ]}
          />
        )}
      </View>
    </View>
  );

  const renderCameraScreen = () => (
    <View style={styles.cameraScreen}>
      <View style={styles.cameraStage}>
        <CameraView
          style={styles.camera}
          ref={cameraRef}
          facing="back"
          onCameraReady={() => setIsCameraReady(true)}
        />

        <View style={[styles.cameraOverlay, { pointerEvents: 'box-none' }]}>
          <SafeAreaView style={styles.topBar}>
            {renderBrandTitle()}
            <Text style={styles.caption}>Capture your silhouette</Text>
            <Text style={styles.scanSafetyText}>
              Clothing-focused images only. Avoid faces, bystanders, or sensitive info.
            </Text>
            <View testID="scan-home-signal" style={styles.scanSignalBadge}>
              <Text style={styles.scanSignalText}>Scan Ready</Text>
            </View>
          </SafeAreaView>

          <Pressable
            onPress={handleHome}
            style={styles.homeButtonV1}
            accessibilityRole="button"
            accessibilityLabel="Go Home"
            accessibilityHint="Returns to the K Scan AI home screen"
          >
            <Text style={styles.homeButtonV1Text}>Home</Text>
          </Pressable>

          {status === 'idle' && (
            <TouchableOpacity
              testID="library-button"
              style={styles.libraryButton}
              onPress={() => router.push('/library')}
              disabled={isAnalyzing}
              activeOpacity={isAnalyzing ? 1 : 0.8}
            >
              <Text style={styles.libraryButtonText}>CLOSET</Text>
            </TouchableOpacity>
          )}

          {status === 'idle' && dressingRoomsEnabled && (
            <TouchableOpacity
              testID="dressing-rooms-camera-button"
              style={styles.roomsButton}
              onPress={() => router.push('/dressing-rooms')}
              disabled={isAnalyzing}
              activeOpacity={isAnalyzing ? 1 : 0.8}
            >
              <Text style={styles.libraryButtonText}>ROOMS</Text>
            </TouchableOpacity>
          )}

          {QA_TOOLS_ENABLED && status === 'idle' && (
            <TouchableOpacity
              testID="qa-toggle-button"
              style={styles.qaToggleButton}
              onPress={() => setQaPanelVisible((visible) => !visible)}
              activeOpacity={0.8}
            >
              <Text style={styles.qaToggleButtonText}>QA</Text>
            </TouchableOpacity>
          )}

          {renderViewfinder(false)}

          <View style={styles.bottomBar}>
            {/* Future TextScan / voice affordances — invisible while gated. */}
            <TextScanEntryPoint enabled={textScanEnabled} />
            <VoiceInputPlaceholder />
            {status === 'capturing' ? (
              <ActivityIndicator
                testID="capturing-indicator"
                size="small"
                color={COLORS.scanCyan}
              />
            ) : (
              <ScanButton
                testID="scan-button"
                onPress={() => capturePhoto(cameraRef)}
                disabled={status !== 'idle' || !isCameraReady || isAnalyzing}
                pulse={status === 'idle'}
              />
            )}
          </View>

          {status === 'idle' ? (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel="Privacy and data choices"
              onPress={() => router.push('/privacy')}
              style={styles.privacyFooter}
              hitSlop={12}
            >
              <Text style={styles.privacyFooterText}>Privacy & Data</Text>
            </Pressable>
          ) : null}
        </View>
      </View>

      {status === 'error' && error && !photo && (
        <ErrorToast message={error} onDismiss={dismissResult} />
      )}
    </View>
  );

  const renderPreviewImage = () => {
    if (photo?.uri) {
      return <Image source={{ uri: photo.uri }} style={styles.preview} />;
    }

    return (
      <View style={styles.previewFallback}>
        {__DEV__ && (
          <Text style={styles.devWarning}>
            DEV: preview rendered without photo - check useKScan transitions
          </Text>
        )}
        <Text style={styles.infoText}>No captured image available.</Text>
      </View>
    );
  };

  const renderActionArea = () => {
    if (status === 'preview') {
      return (
        <View style={styles.actionsContainer}>
          {photo?.uri && dressingRoomsEnabled ? (
            <ActionButton
              label="Add Scan to Dressing Room"
              onPress={() => setScanRoomModalVisible(true)}
              variant="secondary"
            />
          ) : null}
          <ActionButton label="Analyze Style" onPress={runAnalysis} disabled={isAnalyzing} />
          <ActionButton label="Retake" onPress={retake} variant="secondary" disabled={isAnalyzing} />
        </View>
      );
    }

    if (status === 'processing') {
      return (
        <View style={styles.actionsContainer}>
          <ProcessingPanel />
        </View>
      );
    }

    if (status === 'non-fashion') {
      return (
        <View style={styles.actionsContainer}>
          <View style={styles.nonFashionPanel}>
            <Text style={styles.nonFashionTitle}>NO FASHION SIGNAL DETECTED</Text>
            <Text style={styles.nonFashionBody}>
              {nonFashionMessage ||
                "Point K Scan AI at apparel, footwear, or accessories and scan again."}
            </Text>
          </View>
          {photo?.uri && dressingRoomsEnabled ? (
            <ActionButton
              label="Add Scan to Dressing Room"
              onPress={() => setScanRoomModalVisible(true)}
              variant="secondary"
            />
          ) : null}
          <ActionButton label="Scan Again" onPress={dismissResult} disabled={isAnalyzing} />
        </View>
      );
    }

    if (status === 'error') {
      // A failed scan has no usable analysis to save. Guard on concrete fields --
      // an empty object ({}) is truthy -- so we never offer to save a scan the
      // app just told the user failed.
      const hasUsableAnalysis = Boolean(
        analysis &&
          (analysis.result ||
            analysis.metadata?.category ||
            (Array.isArray(analysis.products) && analysis.products.length) ||
            analysis.type === 'non-fashion'),
      );
      return (
        <View style={styles.actionsContainer}>
          {error ? <Text style={styles.errorText}>{error}</Text> : null}
          {photo?.uri && dressingRoomsEnabled && hasUsableAnalysis ? (
            <ActionButton
              label="Add Scan to Dressing Room"
              onPress={() => setScanRoomModalVisible(true)}
              variant="secondary"
            />
          ) : null}
          <ActionButton label="Try Again" onPress={retry} variant="secondary" disabled={isAnalyzing} />
          <ActionButton label="Retake Photo" onPress={retake} variant="tertiary" disabled={isAnalyzing} />
        </View>
      );
    }

    return <View style={styles.actionsContainer} />;
  };

  const renderPreviewScreen = () => (
    <SafeAreaView style={styles.previewScreen}>
      <View style={styles.previewHeader}>
        <View style={styles.previewHeaderRow}>
          <View style={styles.previewHeaderLeft}>
            {renderBrandTitle()}
          </View>
          <Pressable
            onPress={handleHome}
            style={styles.homeButton}
            accessibilityRole="button"
            accessibilityLabel="Go Home"
            accessibilityHint="Returns to the K Scan AI home screen"
          >
            <Text style={styles.homeButtonText}>Home</Text>
          </Pressable>
        </View>
        <Text style={styles.subtitle}>Look Analyzer</Text>
      </View>

      <View style={styles.previewContainer}>
        {renderPreviewImage()}
        {status === 'processing' ? renderViewfinder(true) : null}
      </View>

      {renderActionArea()}
    </SafeAreaView>
  );

  const renderContent = () => {
    if (SCAN_ROOM_V2_UI_ENABLED) {
      switch (status) {
        case 'idle':
          if (!v2CameraVisible) {
            return (
              <ScanLanding
                onOpenCamera={() => setV2CameraVisible(true)}
                onUploadImage={selectGalleryPhoto}
                onTextScan={() => router.push('/text-scan')}
                onHome={handleHome}
                disabled={isAnalyzing}
                textScanEnabled={textScanEnabled}
              />
            );
          }
          return (
            <LiveScanCamera
              cameraRef={cameraRef}
              isCameraReady={isCameraReady}
              onCapture={() => capturePhoto(cameraRef)}
              onCameraReady={() => setIsCameraReady(true)}
              onUpload={selectGalleryPhoto}
              onTextScan={() => router.push('/text-scan')}
              onBack={() => setV2CameraVisible(false)}
              onHome={handleHome}
              isAnalyzing={isAnalyzing}
              textScanEnabled={textScanEnabled}
            />
          );

        case 'capturing':
          return (
            <LiveScanCamera
              cameraRef={cameraRef}
              isCameraReady={isCameraReady}
              isCapturing
              onCapture={() => capturePhoto(cameraRef)}
              onCameraReady={() => setIsCameraReady(true)}
              onUpload={selectGalleryPhoto}
              onTextScan={() => router.push('/text-scan')}
              onBack={() => setV2CameraVisible(false)}
              onHome={handleHome}
              isAnalyzing={isAnalyzing}
              textScanEnabled={textScanEnabled}
            />
          );

        case 'preview':
          if (!photo?.uri) {
            // Stay inside V2 UI if preview state exists without a valid image URI.
            return v2CameraVisible ? (
              <LiveScanCamera
                cameraRef={cameraRef}
                isCameraReady={isCameraReady}
                onCapture={() => capturePhoto(cameraRef)}
                onCameraReady={() => setIsCameraReady(true)}
                onUpload={selectGalleryPhoto}
                onTextScan={() => router.push('/text-scan')}
                onBack={() => setV2CameraVisible(false)}
                onHome={handleHome}
                isAnalyzing={isAnalyzing}
                textScanEnabled={textScanEnabled}
              />
            ) : (
              <ScanLanding
                onOpenCamera={() => setV2CameraVisible(true)}
                onUploadImage={selectGalleryPhoto}
                onTextScan={() => router.push('/text-scan')}
                onHome={handleHome}
                disabled={isAnalyzing}
                textScanEnabled={textScanEnabled}
              />
            );
          }
          return (
            <CaptureReview
              imageUri={photo.uri}
              images={selectedImages}
              source={photo.source || 'camera'}
              onRetake={photo.source === 'upload' ? selectGalleryPhoto : retake}
              onAddImage={MULTI_IMAGE_SCANNER_ENABLED ? addGalleryPhotos : undefined}
              onRemoveImage={removeSelectedImage}
              onAnalyze={runAnalysis}
              onHome={handleHome}
              isAnalyzing={isAnalyzing}
            />
          );

        case 'processing':
          return (
            <AnalyzingScan
              imageUri={photo?.uri}
              isComplete={false}
              hasError={false}
              onMinimumDisplayComplete={() => setV2AnalyzingMinComplete(true)}
              onHome={handleHome}
            />
          );

        case 'result':
          // Detection complete: dismiss AnalyzingScan immediately and let the
          // candidate review / result modal render. Real candidates are never
          // held back for presentation timing.
          return renderPreviewScreen();

        case 'non-fashion':
        case 'error':
          if (!photo?.uri) {
            return v2CameraVisible ? (
              <LiveScanCamera
                cameraRef={cameraRef}
                isCameraReady={isCameraReady}
                onCapture={() => capturePhoto(cameraRef)}
                onCameraReady={() => setIsCameraReady(true)}
                onUpload={selectGalleryPhoto}
                onTextScan={() => router.push('/text-scan')}
                onBack={() => setV2CameraVisible(false)}
                onHome={handleHome}
                isAnalyzing={isAnalyzing}
                textScanEnabled={textScanEnabled}
              />
            ) : (
              <ScanLanding
                onOpenCamera={() => setV2CameraVisible(true)}
                onUploadImage={selectGalleryPhoto}
                onTextScan={() => router.push('/text-scan')}
                onHome={handleHome}
                disabled={isAnalyzing}
                textScanEnabled={textScanEnabled}
              />
            );
          }
          return renderPreviewScreen();

        default:
          return renderCameraScreen();
      }
    }

    // Existing flow (flag disabled)
    switch (status) {
      case 'idle':
      case 'capturing':
        return renderCameraScreen();

      case 'preview':
      case 'processing':
      case 'result':
      case 'non-fashion':
        return renderPreviewScreen();

      case 'error':
        return photo ? renderPreviewScreen() : renderCameraScreen();

      default:
        return renderCameraScreen();
    }
  };

  return (
    <View style={styles.container}>
      <StatusBar style={SCAN_ROOM_V2_UI_ENABLED && status !== 'result' && status !== 'error' ? 'dark' : 'light'} />
      {renderContent()}

      {QA_TOOLS_ENABLED && (
        <Modal
          visible={qaPanelVisible}
          animationType="fade"
          transparent
          onRequestClose={() => setQaPanelVisible(false)}
        >
          <QAPanel status={status} onSelectFixture={handleSelectFixture} />
        </Modal>
      )}

      {/* Processing HUD — only show old HUD when V2 is disabled */}
      {status === 'processing' && !SCAN_ROOM_V2_UI_ENABLED && (
        <PerceptionLayer
          key={procHudKey}
          metadata={null}
          onComplete={() => {}}
        />
      )}

      {savedToast && <SavedToast onDismiss={() => setSavedToast(false)} />}

      {SCAN_ROOM_V2_UI_ENABLED && status === 'error' && error && !photo?.uri && (
        <ErrorToast message={error} onDismiss={dismissResult} />
      )}

      {/* Post-result HUD: briefly shows real metadata before AnalysisCard slides up */}
      {status === 'result' && perceiving && !SCAN_ROOM_V2_UI_ENABLED && (
        <PerceptionLayer
          metadata={analysis?.metadata ?? EMPTY_METADATA}
          onComplete={() => setPerceiving(false)}
        />
      )}

      {/* Deliberate candidate review (and queue processing before the first
          result) renders in ScanResultV2 for both result-UI configurations;
          zero commerce work happens on this surface and no Dressing Room
          actions are exposed in review mode. */}
      {status === 'result' && !perceiving && showCandidateReview && (
        <ScanResultV2
          onDismiss={dismissResult}
          scanImageUri={activePhoto?.uri ?? null}
          candidateReview={{
            stage: scanStage === 'results' ? 'processing' : 'review',
            imageCount: selectedImages.length || 1,
            candidates: reviewCandidates,
            selectedCandidateIds,
            itemStates,
            onToggleCandidate: toggleScanCandidate,
            onConfirmSelection: confirmSelectedCandidates,
            detectionNotice,
            queueNotice,
          }}
        />
      )}

      {status === 'result' && !perceiving && !showCandidateReview && (
        // The deliberate queue requires the navigator-capable renderer even
        // when the legacy result flag is off. Otherwise later selected items,
        // Save All, and the active-item Elise handoff become unreachable.
        (SCAN_RESULTS_V2_UI_ENABLED || selectedCandidateIds.length > 0) ? (
          <ScanResultV2
            analysis={analysis}
            scanImageUri={activePhoto?.uri ?? null}
            scanSourceId={photo?.qaFixtureName ?? null}
            // v127 (P1-B): commerceStatus reflects the CURRENTLY SELECTED
            // item (see hooks/useKScan.js selectScanItem / the per-item
            // scheduler in services/commerceJobScheduler.ts) — switching
            // items shows that item's own status, never another item's.
            commerceStatus={analysis?.commerceDeferred ? commerceStatus : 'idle'}
            onRetryCommerce={retryCommerce}
            onDismiss={dismissResult}
            onSaveToLibrary={activeScanItem
              ? activeSavedScanId
                ? () => router.push('/library')
                : () => { void persistScanItem(activeScanItem); }
              : undefined}
            saveActionLabel={activeSavedScanId ? 'View Closet' : 'Save Item'}
            onAddToDressingRoom={dressingRoomsEnabled ? () => {
              setAddAllToRoom(false);
              setScanRoomModalVisible(true);
            } : undefined}
            multiItem={activeScanItem ? {
              imageCount: selectedImages.length || 1,
              items: multiItemSummaries,
              selectedItemId: activeScanItem.id,
              savedItemIds: new Set(Object.keys(savedScanIdsByItem)),
              onSelectItem: selectScanItem,
              itemStates,
              queueNotice,
              // Save All saves successfully completed items only; disabled
              // until at least one item is ready.
              onSaveAll: selectedCandidateIds.length > 1 ? () => { void saveAllScanItems(); } : undefined,
              saveAllDisabled: scanItems.length === 0,
              onAddAllToDressingRoom: dressingRoomsEnabled && scanItems.length > 1 ? () => {
                setAddAllToRoom(true);
                setScanRoomModalVisible(true);
              } : undefined,
              // Quota halt: explicit user resume for remaining selections.
              onResumeQueue: queueHalted === 'quota' && remainingSelectedCount > 0
                ? confirmSelectedCandidates
                : undefined,
              resumeCount: remainingSelectedCount,
            } : undefined}
            onAskStyleChat={styleChatEnabled ? () => {
              const source = activePhoto?.source === 'upload' ? 'upload' : 'camera';
              const meta = analysis?.metadata ?? {};
              // Phase 2B.3: when Scanner produced a canonical V2 identity, hand
              // THAT to Elise alongside the legacy display fields. The identity is
              // reused verbatim — Elise never re-identifies a garment Scanner
              // already identified, so the handoff costs no second scan and the
              // two surfaces cannot disagree about what the item is.
              //
              // Absent when Scanner ran on the legacy contract, which leaves the
              // descriptive fields as the only context exactly as today.
              const scannerIdentificationV2 =
                analysis?.identificationSnapshotV2?.identification ?? null;
              setStyleChatHandoffContext({
                source,
                imageUri: activePhoto?.uri ?? null,
                category: meta.category || null,
                color: meta.color || null,
                silhouette: meta.silhouette || null,
                material: meta.material || null,
                descriptors: Array.isArray(meta.styleTags) ? meta.styleTags : undefined,
                analysisText: analysis?.result || null,
                createdAt: new Date().toISOString(),
                ...(scannerIdentificationV2
                  ? { identificationV2: scannerIdentificationV2 }
                  : {}),
              });
              router.push('/style-chat');
            } : undefined}
          />
        ) : (
          <AnalysisCard
            result={analysis?.result ?? ''}
            metadata={analysis?.metadata ?? EMPTY_METADATA}
            products={analysis?.products ?? []}
            purchaseOptions={analysis?.purchaseOptions ?? []}
            // v127 (P1-B): commerceStatus reflects the CURRENTLY SELECTED
            // item (see hooks/useKScan.js selectScanItem / the per-item
            // scheduler in services/commerceJobScheduler.ts) — switching
            // items shows that item's own status, never another item's.
            commerceStatus={analysis?.commerceDeferred ? commerceStatus : 'idle'}
            onRetryCommerce={retryCommerce}
            scanResultObject={analysis?.scanResultObject ?? null}
            secondhand={analysis?.secondhand ?? null}
            sneakerReference={analysis?.sneakerReference ?? null}
            scanImageUri={activePhoto?.uri ?? null}
            scanSourceId={photo?.qaFixtureName ?? null}
            scanSourceType="live_scan"
            onDismiss={dismissResult}
            onAddToDressingRoom={dressingRoomsEnabled ? () => {
              setAddAllToRoom(false);
              setScanRoomModalVisible(true);
            } : undefined}
          />
        )
      )}

      {dressingRoomsEnabled ? (
        <AddScanToDressingRoomModal
          visible={scanRoomModalVisible}
          localImageUri={activePhoto?.uri ?? null}
          scan={{
            sourceType: activePhoto?.source === 'upload' ? 'upload_inspiration' : 'live_scan',
            sourceId: activeScanItem?.id ?? photo?.qaFixtureName ?? null,
            result: analysis?.result ?? null,
            metadata: analysis?.metadata ?? null,
          }}
          additionalScans={addAllToRoom ? scanItems
            .filter((item) => item.id !== activeScanItem?.id)
            .map((item) => ({
              localImageUri: item.sourceImageUri,
              scan: {
                sourceType: item.source === 'upload' ? 'upload_inspiration' : 'live_scan',
                sourceId: item.id,
                result: item.analysis?.result ?? null,
                metadata: item.analysis?.metadata ?? null,
              },
            })) : []}
          onClose={() => {
            setScanRoomModalVisible(false);
            setAddAllToRoom(false);
          }}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.obsidian,
  },
  brandTitle: {
    ...TYPOGRAPHY.brand,
    color: COLORS.textInverse,
    textShadowColor: COLORS.darkOverlay,
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  subtitle: {
    ...TYPOGRAPHY.subtitle,
    marginTop: SPACING.xs,
    color: COLORS.chromeMist,
  },
  caption: {
    ...TYPOGRAPHY.caption,
    marginTop: SPACING.sm,
    color: COLORS.chromeMist,
    textShadowColor: 'rgba(0, 0, 0, 0.42)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  scanSafetyText: {
    ...TYPOGRAPHY.caption,
    marginTop: SPACING.xs,
    maxWidth: 260,
    color: COLORS.chromeMist,
    fontSize: 10,
    lineHeight: 15,
    letterSpacing: 0.8,
    textShadowColor: 'rgba(0, 0, 0, 0.48)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
  },
  scanSignalBadge: {
    alignSelf: 'flex-start',
    marginTop: SPACING.md,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.darkOverlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
  },
  scanSignalText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.activeVision,
    fontSize: 10,
    letterSpacing: 1.5,
  },
  infoText: {
    ...TYPOGRAPHY.body,
    color: COLORS.chromeMist,
    textAlign: 'center',
    marginTop: SPACING.lg,
  },
  processingText: {
    ...TYPOGRAPHY.title,
    color: COLORS.textInverse,
    textAlign: 'center',
    marginTop: SPACING.md,
  },
  processingCaption: {
    ...TYPOGRAPHY.body,
    color: COLORS.chromeMist,
    textAlign: 'center',
    marginTop: SPACING.sm,
  },
  errorText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    textAlign: 'center',
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.md,
  },
  devWarning: {
    ...TYPOGRAPHY.caption,
    color: COLORS.warning,
    textAlign: 'center',
    marginBottom: SPACING.sm,
  },
  actionButtonBase: {
    minWidth: BUTTONS.minWidth,
    minHeight: BUTTONS.height,
    maxWidth: '100%',
    paddingHorizontal: BUTTONS.horizontalPadding,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    alignSelf: 'center',
  },
  actionButtonText: {
    ...TYPOGRAPHY.cta,
    textAlign: 'center',
  },
  primaryButton: {
    backgroundColor: COLORS.accent,
  },
  primaryButtonText: {
    color: BUTTONS.primaryText,
  },
  secondaryButton: {
    backgroundColor: COLORS.surfaceCard,
    borderWidth: 1,
    borderColor: BUTTONS.secondaryBorder,
  },
  secondaryButtonText: {
    color: BUTTONS.secondaryText,
  },
  tertiaryButton: {
    backgroundColor: 'transparent',
  },
  tertiaryButtonText: {
    color: COLORS.chromeMist,
  },
  buttonDisabled: {
    opacity: 0.5,
  },
  centerContent: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
  },
  cameraScreen: {
    flex: 1,
    backgroundColor: COLORS.obsidian,
  },
  camera: {
    flex: 1,
  },
  cameraStage: {
    flex: 1,
  },
  cameraOverlay: {
    ...StyleSheet.absoluteFillObject,
    zIndex: 10,
    elevation: 10,
  },
  topBar: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    paddingHorizontal: LAYOUT.screenPadding,
    paddingTop: LAYOUT.safeTop,
  },
  viewfinderOverlay: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    justifyContent: 'center',
    alignItems: 'center',
  },
  viewfinderFrame: {
    width: viewfinder.width,
    aspectRatio: viewfinder.aspectRatio,
    position: 'relative',
    overflow: 'hidden',
  },
  scanningLine: {
    position: 'absolute',
    left: 0,
    right: 0,
    height: viewfinder.scanningLineHeight,
    backgroundColor: COLORS.scanCyan,
    borderRadius: viewfinder.scanningLineHeight / 2,
    shadowColor: COLORS.activeVision,
    shadowOpacity: 0.42,
    shadowRadius: 18,
    shadowOffset: { width: 0, height: 0 },
  },
  corner: {
    position: 'absolute',
    width: viewfinder.cornerArmLength,
    height: viewfinder.cornerArmLength,
    borderColor: COLORS.hudLine,
  },
  topLeft: {
    top: 0,
    left: 0,
    borderTopWidth: viewfinder.cornerStroke,
    borderLeftWidth: viewfinder.cornerStroke,
  },
  topRight: {
    top: 0,
    right: 0,
    borderTopWidth: viewfinder.cornerStroke,
    borderRightWidth: viewfinder.cornerStroke,
  },
  bottomLeft: {
    bottom: 0,
    left: 0,
    borderBottomWidth: viewfinder.cornerStroke,
    borderLeftWidth: viewfinder.cornerStroke,
  },
  bottomRight: {
    bottom: 0,
    right: 0,
    borderBottomWidth: viewfinder.cornerStroke,
    borderRightWidth: viewfinder.cornerStroke,
  },
  bottomBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    zIndex: 20,
    elevation: 20,
    paddingBottom: LAYOUT.cameraFooterPaddingBottom,
    paddingTop: LAYOUT.cameraFooterPaddingTop,
    alignItems: 'center',
    backgroundColor: COLORS.darkOverlay,
    borderTopWidth: StyleSheet.hairlineWidth,
    borderTopColor: COLORS.darkOverlayBorder,
  },
  textScanEntry: {
    alignSelf: 'center',
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: COLORS.champagneGold,
    backgroundColor: 'rgba(9, 7, 13, 0.42)',
    minHeight: 36,
    justifyContent: 'center',
  },
  textScanEntryText: {
    ...TYPOGRAPHY.caption,
    fontSize: 12,
    letterSpacing: 1.6,
    color: COLORS.textInverse,
  },
  privacyFooter: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: LAYOUT.cameraFooterPaddingBottom + 112,
    zIndex: 21,
    elevation: 21,
    alignItems: 'center',
    paddingVertical: SPACING.sm,
  },
  privacyFooterText: {
    ...TYPOGRAPHY.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: COLORS.chromeMist,
    opacity: 0.86,
    textShadowColor: 'rgba(0, 0, 0, 0.48)',
    textShadowOffset: { width: 0, height: 1 },
    textShadowRadius: 4,
    textTransform: 'uppercase',
  },
  previewScreen: {
    flex: 1,
    backgroundColor: COLORS.obsidian,
  },
  previewHeader: {
    paddingHorizontal: LAYOUT.screenPadding,
    paddingTop: SPACING.lg,
    paddingBottom: SPACING.md,
    borderBottomWidth: 1,
    borderBottomColor: COLORS.darkOverlayBorder,
    backgroundColor: COLORS.obsidian,
    marginBottom: SPACING.sm,
  },
  previewHeaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    minHeight: 44,
  },
  previewHeaderLeft: {
    flex: 1,
  },
  homeButton: {
    borderRadius: RADIUS.pill,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.goldBrushed,
    backgroundColor: LUXURY.colors.pearl,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    minHeight: 36,
    justifyContent: 'center',
    alignItems: 'center',
    ...SHADOWS.editorialSmall,
  },
  homeButtonText: {
    ...TYPOGRAPHY.caption,
    fontSize: 11,
    letterSpacing: 1.2,
    color: LUXURY.colors.plumDeep,
    textTransform: 'uppercase',
  },
  homeButtonV1: {
    position: 'absolute',
    top: LAYOUT.safeTop + SPACING.lg,
    left: LAYOUT.screenPadding,
    zIndex: 30,
    elevation: 30,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.darkOverlay,
    borderWidth: 1.5,
    borderColor: LUXURY.colors.goldBrushed,
    ...SHADOWS.darkFloat,
  },
  homeButtonV1Text: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textInverse,
  },
  previewContainer: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    position: 'relative',
  },
  preview: {
    width: '100%',
    height: LAYOUT.previewHeight,
    resizeMode: 'cover',
    borderRadius: LAYOUT.previewRadius,
  },
  previewFallback: {
    width: '100%',
    height: LAYOUT.previewHeight,
    borderRadius: LAYOUT.previewRadius,
    backgroundColor: COLORS.graphiteRaised,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
  },
  actionsContainer: {
    minHeight: LAYOUT.actionsMinHeight,
    paddingHorizontal: LAYOUT.screenPadding,
    paddingBottom: LAYOUT.screenPadding,
    justifyContent: 'flex-start',
    gap: SPACING.sm,
  },
  processingPanel: {
    minHeight: LAYOUT.actionsMinHeight - SPACING.lg,
    borderRadius: LOADING.panelRadius,
    backgroundColor: COLORS.graphiteRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.graphiteLine,
    padding: LOADING.panelPadding,
    justifyContent: 'center',
    alignItems: 'center',
  },
  processingIndicatorSlot: {
    width: 36,
    height: 36,
    alignItems: 'center',
    justifyContent: 'center',
  },
  processingIndicatorHalo: {
    width: 22,
    height: 22,
    borderRadius: 11,
    borderWidth: 1,
    borderColor: COLORS.scanCyan,
    backgroundColor: COLORS.darkOverlay,
  },
  nonFashionPanel: {
    borderRadius: LOADING.panelRadius,
    backgroundColor: COLORS.graphiteRaised,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.graphiteLine,
    padding: LOADING.panelPadding,
    gap: SPACING.sm,
  },
  nonFashionTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.scanCyan,
    textAlign: 'center',
    letterSpacing: 1.6,
  },
  nonFashionBody: {
    ...TYPOGRAPHY.body,
    color: COLORS.chromeMist,
    textAlign: 'center',
  },
  qaPanel: {
    position: 'absolute',
    left: SPACING.md,
    right: SPACING.md,
    bottom: SPACING.md,
    zIndex: 80,
    elevation: 80,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: COLORS.graphiteLine,
    backgroundColor: COLORS.obsidianSoft,
    padding: SPACING.md,
  },
  qaTitle: {
    ...TYPOGRAPHY.caption,
    color: COLORS.scanCyan,
    marginBottom: SPACING.xs,
  },
  qaText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.chromeMist,
    marginBottom: 2,
  },
  qaFixtureGrid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.sm,
  },
  qaFixtureButton: {
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.graphiteLine,
    backgroundColor: COLORS.graphiteRaised,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
  },
  qaFixtureButtonDisabled: {
    opacity: 0.45,
  },
  qaFixtureText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textInverse,
  },
  errorToast: {
    position: 'absolute',
    top: TOAST.top,
    left: LAYOUT.screenPadding,
    right: LAYOUT.screenPadding,
    backgroundColor: TOAST.backgroundColor,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
    borderRadius: TOAST.borderRadius,
    paddingVertical: TOAST.paddingVertical,
    paddingHorizontal: TOAST.paddingHorizontal,
    alignItems: 'center',
  },
  errorToastText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.errorSoft,
    textAlign: 'center',
  },
  // "Saved to Style Library" toast — bottom of screen, above PerceptionLayer
  savedToast: {
    position: 'absolute',
    bottom: 96,
    left: LAYOUT.screenPadding,
    right: LAYOUT.screenPadding,
    backgroundColor: TOAST.backgroundColor,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
    borderRadius: TOAST.borderRadius,
    paddingVertical: TOAST.paddingVertical,
    paddingHorizontal: TOAST.paddingHorizontal,
    alignItems: 'center',
    zIndex: 55,
    elevation: 55,
  },
  savedToastText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.success,
  },
  // Library entry button — top-right of camera screen
  // top uses LAYOUT.safeTop which is now Platform-aware (56dp Android / 44dp iOS)
  // to clear the Pixel 8 Pro status-bar + punch-hole cutout (≈50dp).
  libraryButton: {
    position: 'absolute',
    top: LAYOUT.safeTop + SPACING.lg,
    right: LAYOUT.screenPadding,
    zIndex: 30,
    elevation: 30,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.darkOverlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
    ...SHADOWS.darkFloat,
  },
  libraryButtonText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textInverse,
  },
  qaToggleButton: {
    position: 'absolute',
    top: LAYOUT.safeTop + SPACING.xl + 92,
    right: LAYOUT.screenPadding,
    zIndex: 30,
    elevation: 30,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.sm,
    backgroundColor: COLORS.darkOverlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
  },
  qaToggleButtonText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.textInverse,
  },
  roomsButton: {
    position: 'absolute',
    top: LAYOUT.safeTop + SPACING.lg + 44,
    right: LAYOUT.screenPadding,
    zIndex: 30,
    elevation: 30,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    backgroundColor: COLORS.darkOverlay,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
    ...SHADOWS.darkFloat,
  },
  v2CapturingOverlay: {
    ...StyleSheet.absoluteFillObject,
    backgroundColor: LUXURY.colors.ivory,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.md,
  },
  v2CapturingText: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.plum,
  },
});
