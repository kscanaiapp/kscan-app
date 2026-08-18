import { useState, useCallback, useRef, useEffect } from 'react';
import { AccessibilityInfo, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  MULTI_IMAGE_SCANNER_ENABLED,
  SCAN_IDENTIFY_BACKEND_ENABLED,
} from '../constants/featureFlags';
import { mapScanIdentifyToAnalysis } from '../services/scanIdentificationMapper';
import { prepareScannerEvidence, createEvidenceId } from '../services/scannerEvidenceGateway';
import { beginScannerV2Session } from '../services/scannerIdentificationV2';
import { runScannerIdentification } from '../services/scannerScanRequest';
import {
  buildSecondhandSearchRequest,
  searchVintedSecondhand,
} from '../services/secondhand';
import { searchSneakers, shouldEnrichSneakers } from '../services/sneakers/index';
import { compressForUpload } from '../services/imageUtils';
import {
  MAX_SCAN_IMAGES,
  buildMultiScanCandidates,
  candidateLabel,
  normalizeImageSelections,
  removeImageSelection,
} from '../services/multiImageScan';
import { preparePrivacyAdaptedImage } from '../services/privacyImageAdapter';
import { recordScanLatencyMarker } from '../services/scanLatencyMarkers';
import {
  errorPulse,
  softImpact,
  successPulse,
  warningPulse,
} from '../services/haptics';

// Fallback ceiling for the capture-to-candidate-review attempt. Detection runs
// one Edge call per source image in parallel (each client-capped at 20 s);
// compression, privacy adaptation, and network overhead require the remaining
// margin. A later result is treated as stale. Selected-item commerce calls run
// in their own queue after the user confirms and are bounded per request.
const ATTEMPT_TIMEOUT_MS = 52_000;

const PARTIAL_DETECTION_NOTICE =
  'Some images couldn’t be analyzed. Showing results from the others.';
const ITEM_FAILURE_NOTICE =
  'One item couldn’t be analyzed. Continuing with the rest.';

function logAnalyzeDiag(payload) {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  console.log(`[KSCAN_DIAG_ANALYZE] ${JSON.stringify({
    ...payload,
    timestamp: Date.now(),
  })}`);
}

const VALID_TRANSITIONS = {
  idle: ['capturing'],
  capturing: ['preview', 'error'],
  preview: ['processing', 'idle'],
  // 'non-fashion' is a distinct success state — same visual path as result
  // but with a different message and no product shelf.
  processing: ['result', 'non-fashion', 'error'],
  result: ['idle'],
  'non-fashion': ['idle'],
  error: ['idle', 'preview'],
};

function warnInvalidTransition(from, to) {
  if (typeof __DEV__ !== 'undefined' && __DEV__) {
    console.warn(`[useKScan] Invalid transition ignored: ${from} -> ${to}`);
  }
}

function userSafeError(message, userMessage) {
  const error = new Error(message);
  error.userMessage = userMessage;
  return error;
}

/**
 * K-SCAN scan state machine.
 * status: idle | capturing | preview | processing | result | non-fashion | error
 *
 * Multi-item architecture:
 *   1-5 source images → prepare each once → parallel per-image detection →
 *   normalize/aggregate/dedupe/cap candidates → deliberate multi-select review
 *   (zero commerce calls) → count-aware CTA → automatic sequential
 *   selected-item commerce queue → progressive result rendering.
 *
 * While status === 'result', `scanStage` distinguishes the modal surface:
 *   'review'  — candidates rendered for deliberate selection; no commerce yet.
 *   'results' — the selected-item queue has been confirmed; items stream in.
 * One detected candidate is the N=1 case of the same review flow: no
 * auto-selection, no auto-advance, and the same count-aware CTA.
 */
export function useKScan(actorId = null) {
  const normalizedActorId =
    typeof actorId === 'string' && actorId.trim() ? actorId.trim() : null;
  const [status, setStatus] = useState('idle');
  const [photo, setPhoto] = useState(null);
  const [selectedImages, setSelectedImages] = useState([]);
  const [analysis, setAnalysis] = useState(null);
  const [scanItems, setScanItems] = useState([]);
  const [selectedScanItemId, setSelectedScanItemId] = useState(null);
  const [analysisActorId, setAnalysisActorId] = useState(null);
  const [error, setError] = useState(null);
  const [nonFashionMessage, setNonFashionMessage] = useState(null);
  // Render-only flag that mirrors the imperative scanInFlightRef. It stays true
  // from the first synchronous guard activation until the attempt fully settles
  // (success, failure, timeout, abort, or picker cancellation).
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // ── Multi-item review + queue state (appended after legacy slots so the
  //    positional test harness mapping for the slots above stays stable). ──
  const [scanCandidates, setScanCandidates] = useState([]);
  const [selectedCandidateIds, setSelectedCandidateIds] = useState([]);
  // 'idle' | 'review' | 'results' — meaningful while status === 'result'.
  const [scanStage, setScanStage] = useState('idle');
  // candidateId → 'queued' | 'analyzing' | 'ready' | 'failed'
  const [itemStates, setItemStates] = useState({});
  const [queueActive, setQueueActive] = useState(false);
  // null | 'quota' — quota/rate-limit halts preserve remaining selections.
  const [queueHalted, setQueueHalted] = useState(null);
  // Single nonblocking session-level notices. Never provider details.
  const [detectionNotice, setDetectionNotice] = useState(null);
  const [queueNotice, setQueueNotice] = useState(null);

  const isMountedRef = useRef(true);
  // Synchronous lock — read before state updates propagate, so rapid taps that
  // arrive in the same event loop tick before React re-renders cannot trigger
  // duplicate captures, picker opens, compressions, or API calls.
  const scanInFlightRef = useRef(false);
  // Monotonic operation ID. A completed/timed-out/superseded attempt must not
  // update state, navigate, or replace a newer image.
  const operationIdRef = useRef(0);
  const activeAbortControllerRef = useRef(null);
  const currentActorRef = useRef(normalizedActorId);
  const activeOperationActorRef = useRef(null);
  const previousActorRef = useRef(normalizedActorId);
  const secondhandRequestRef = useRef(0);
  const prevIsAnalyzingRef = useRef(false);
  // ── Multi-item refs ──
  // Monotonic source/scan generation. Incremented on every source-image
  // mutation, reset, actor change, or new attempt; every asynchronous
  // continuation (detection completion, queue step, enrichment) must verify
  // the captured generation before mutating state. Abort alone is not
  // sufficient — stale callbacks must also fail this check.
  const scanGenerationRef = useRef(0);
  // Ordered stable-ID selection mirror for synchronous rapid-tap handling.
  const selectedCandidateIdsRef = useRef([]);
  const scanCandidatesRef = useRef([]);
  const itemStatesRef = useRef({});
  // Synchronous CTA duplicate lock for the selected-item queue.
  const queueInFlightRef = useRef(false);
  const queueAbortControllerRef = useRef(null);
  // Session-latched Scanner V2 rollout decision (Phase 2B.2). Resolved once at
  // the start of each Scanner session and read by every stage of it. Defaults
  // to disabled so a session that somehow starts without resolving stays on the
  // legacy path rather than opting itself in.
  const scannerV2SessionRef = useRef({ enabled: false });
  currentActorRef.current = normalizedActorId;

  // Clears all candidate/selection/queue state and invalidates every pending
  // asynchronous continuation (detection, queue, enrichment). Runs on source
  // mutation, reset, actor change, session replacement, and unmount.
  const invalidateScanPipeline = useCallback(() => {
    scanGenerationRef.current += 1;
    queueAbortControllerRef.current?.abort();
    queueAbortControllerRef.current = null;
    queueInFlightRef.current = false;
    selectedCandidateIdsRef.current = [];
    scanCandidatesRef.current = [];
    itemStatesRef.current = {};
    if (!isMountedRef.current) return;
    setScanCandidates([]);
    setSelectedCandidateIds([]);
    setScanStage('idle');
    setItemStates({});
    setQueueActive(false);
    setQueueHalted(null);
    setDetectionNotice(null);
    setQueueNotice(null);
  }, []);

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Invalidate any in-flight attempt so late results are discarded.
      operationIdRef.current += 1;
      activeAbortControllerRef.current?.abort();
      scanInFlightRef.current = false;
      scanGenerationRef.current += 1;
      queueAbortControllerRef.current?.abort();
      queueInFlightRef.current = false;
    };
  }, []);

  useEffect(() => {
    if (previousActorRef.current === normalizedActorId) return;
    previousActorRef.current = normalizedActorId;
    operationIdRef.current += 1;
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = null;
    activeOperationActorRef.current = null;
    scanInFlightRef.current = false;
    secondhandRequestRef.current += 1;
    invalidateScanPipeline();
    setIsAnalyzing(false);
    setPhoto(null);
    setSelectedImages([]);
    setAnalysis(null);
    setScanItems([]);
    setSelectedScanItemId(null);
    setAnalysisActorId(null);
    setError(null);
    setNonFashionMessage(null);
    setStatus('idle');
  }, [normalizedActorId, invalidateScanPipeline]);

  // Announce the start of analysis exactly once per true in-flight window.
  useEffect(() => {
    if (isAnalyzing && !prevIsAnalyzingRef.current) {
      AccessibilityInfo.announceForAccessibility('Scan analysis in progress');
    }
    prevIsAnalyzingRef.current = isAnalyzing;
  }, [isAnalyzing]);

  const clearInFlight = useCallback((operationId) => {
    // Only the current attempt may clear the guard it created. Incrementing the
    // operation ID here also prevents a late background completion from this
    // attempt from overwriting newer state.
    if (operationId !== operationIdRef.current) return;
    operationIdRef.current += 1;
    scanInFlightRef.current = false;
    activeAbortControllerRef.current = null;
    activeOperationActorRef.current = null;
    if (isMountedRef.current) {
      setIsAnalyzing(false);
    }
  }, []);

  const startInFlight = useCallback(() => {
    if (scanInFlightRef.current) return null;
    scanInFlightRef.current = true;
    const operationId = ++operationIdRef.current;
    activeOperationActorRef.current = currentActorRef.current;
    // Replace any previous controller for this hook instance; this is the
    // single active attempt boundary.
    activeAbortControllerRef.current?.abort();
    activeAbortControllerRef.current = new AbortController();
    if (isMountedRef.current) {
      setIsAnalyzing(true);
    }
    return operationId;
  }, []);

  const isOperationValid = useCallback((operationId) => (
    isMountedRef.current &&
    operationId === operationIdRef.current &&
    activeOperationActorRef.current === currentActorRef.current
  ), []);

  // Generation + actor + mount check for queue steps and other continuations
  // that outlive the initial detection operation.
  const isGenerationValid = useCallback((generation, actor) => (
    isMountedRef.current &&
    generation === scanGenerationRef.current &&
    actor === currentActorRef.current
  ), []);

  const capturePhoto = useCallback(
    async (cameraRef) => {
      if (scanInFlightRef.current || status !== 'idle') {
        logAnalyzeDiag({
          event: 'scan_duplicate_blocked',
          source: 'capturePhoto',
          reason: 'scan_in_flight_or_invalid_status',
          status,
        });
        warnInvalidTransition(status, 'capturing');
        return;
      }
      if (!cameraRef?.current || typeof cameraRef.current.takePictureAsync !== 'function') {
        setError('We could not take the photo. Please try again.');
        setStatus('error');
        return;
      }

      const operationId = startInFlight();
      if (operationId === null) return;

      setStatus('capturing');
      softImpact();

      try {
        const result = await cameraRef.current.takePictureAsync({
          quality: 0.7,
        });
        if (!result || typeof result.uri !== 'string' || result.uri.length === 0) {
          throw new Error('Camera returned an invalid photo.');
        }
        if (isOperationValid(operationId)) {
          // New capture replaces the source set → downstream state is stale.
          invalidateScanPipeline();
          const images = normalizeImageSelections([{ uri: result.uri }], 'camera');
          setSelectedImages(images);
          setPhoto({ ...result, ...images[0], source: 'camera' });
          setError(null);
          setStatus('preview');
        }
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error('Capture failed:', err);
        }
        if (isOperationValid(operationId)) {
          setPhoto(null);
          setError('We could not take the photo. Please try again.');
          setStatus('error');
        }
      } finally {
        clearInFlight(operationId);
      }
    },
    [status, startInFlight, clearInFlight, isOperationValid, invalidateScanPipeline]
  );

  const pickGalleryPhotos = useCallback(
    async (append) => {
      if (scanInFlightRef.current) {
        logAnalyzeDiag({
          event: 'scan_duplicate_blocked',
          source: append ? 'addGalleryPhotos' : 'selectGalleryPhoto',
          reason: 'scan_in_flight',
          status,
        });
        warnInvalidTransition(status, 'capturing');
        return;
      }

      const operationId = startInFlight();
      if (operationId === null) return;

      try {
        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ['images'],
          quality: 1,
          allowsEditing: false,
          allowsMultipleSelection: MULTI_IMAGE_SCANNER_ENABLED,
          selectionLimit: MULTI_IMAGE_SCANNER_ENABLED ? MAX_SCAN_IMAGES : 1,
          orderedSelection: MULTI_IMAGE_SCANNER_ENABLED,
        });

        if (isOperationValid(operationId)) {
          if (result?.canceled) return;
          if (!Array.isArray(result?.assets) || result.assets.length === 0) {
            throw new Error('EMPTY_IMAGE_SELECTION');
          }
          if (result.assets.some((asset) => asset?.type && asset.type !== 'image')) {
            throw new Error('UNSUPPORTED_MEDIA');
          }
          const images = normalizeImageSelections(
            MULTI_IMAGE_SCANNER_ENABLED ? result.assets : result.assets.slice(0, 1),
            'upload',
            append ? selectedImages : [],
          );
          // Source-image collection mutated → invalidate all downstream state.
          invalidateScanPipeline();
          setSelectedImages(images);
          setPhoto({ ...images[0], source: images[0].source });
          setError(null);
          setAnalysis(null);
          setScanItems([]);
          setSelectedScanItemId(null);
          setAnalysisActorId(null);
          setNonFashionMessage(null);
          secondhandRequestRef.current += 1;
          setStatus('preview');
        }
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error('Gallery selection failed:', err);
        }
        if (isOperationValid(operationId)) {
          if (err?.message === 'TOO_MANY_IMAGES') {
            Alert.alert('Maximum 5 Images', 'Remove an image before adding another.');
            setStatus(selectedImages.length > 0 ? 'preview' : 'idle');
          } else {
            setError('Uploaded image could not be loaded.');
            setStatus('error');
          }
        }
      } finally {
        clearInFlight(operationId);
      }
    },
    [status, selectedImages, startInFlight, clearInFlight, isOperationValid, invalidateScanPipeline]
  );

  const selectGalleryPhoto = useCallback(
    () => pickGalleryPhotos(false),
    [pickGalleryPhotos],
  );

  const addGalleryPhotos = useCallback(
    () => pickGalleryPhotos(true),
    [pickGalleryPhotos],
  );

  const removeSelectedImage = useCallback((imageId) => {
    if (scanInFlightRef.current) return;
    const images = removeImageSelection(selectedImages, imageId);
    // Source-image collection mutated → invalidate all downstream state.
    invalidateScanPipeline();
    setSelectedImages(images);
    setAnalysis(null);
    setScanItems([]);
    setSelectedScanItemId(null);
    if (images.length === 0) {
      setPhoto(null);
      setStatus('idle');
    } else {
      setPhoto({ ...images[0], source: images[0].source });
      setStatus('preview');
    }
  }, [selectedImages, invalidateScanPipeline]);

  const uploadPhoto = useCallback(
    (uri) => {
      if (scanInFlightRef.current) {
        logAnalyzeDiag({
          event: 'scan_duplicate_blocked',
          source: 'uploadPhoto',
          reason: 'scan_in_flight',
          status,
        });
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (status !== 'idle' && status !== 'preview') {
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (!uri || typeof uri !== 'string') {
        setError('Uploaded image could not be loaded.');
        setStatus('error');
        return;
      }

      const images = normalizeImageSelections([{ uri }], 'upload');
      invalidateScanPipeline();
      setSelectedImages(images);
      setPhoto({ ...images[0], source: 'upload' });
      setError(null);
      setAnalysis(null);
      setScanItems([]);
      setSelectedScanItemId(null);
      setAnalysisActorId(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('preview');
    },
    [status, invalidateScanPipeline]
  );

  // Async enrichment for the currently displayed analysis. Never blocks or
  // replaces the result card; guarded by mount + secondhand request id.
  const enrichDisplayedAnalysis = useCallback((data, secondhandRequestId) => {
    // Phase 3 provider cleanup: the Vinted/Apify backend has no configured
    // credentials (APIFY_VINTED_ACTOR_ID / APIFY_API_TOKEN are unset in both
    // App Staging and Production), so this call was firing on every scan and
    // always resolving to SECONDHAND_RESULTS_UNAVAILABLE — a dead network
    // round trip on every single scan for zero result. Disabled until Apify
    // is actually configured; restore the call below when it is.
    const secondhandRequest = null; // was: buildSecondhandSearchRequest(data);
    if (secondhandRequest) {
      searchVintedSecondhand(secondhandRequest)
        .then((secondhand) => {
          if (!isMountedRef.current || secondhandRequestRef.current !== secondhandRequestId) return;
          if (!secondhand?.enabled || !Array.isArray(secondhand.items) || secondhand.items.length === 0) return;
          setAnalysis((current) => {
            if (!current || current.type === 'non-fashion') return current;
            return { ...current, secondhand };
          });
        })
        .catch(() => {
          // Async enrichment failure must not replace the result card.
        });
    }

    // Sneaker enrichment — async, never blocks the result card.
    const sneakerInput = {
      rawText:            data.result,
      category:           data.metadata?.category,
      categoryConfidence: data.metadata?.categoryConfidence,
      brand:              data.metadata?.brand,
      model:              data.metadata?.silhouette,
    };
    if (shouldEnrichSneakers(sneakerInput)) {
      searchSneakers(sneakerInput)
        .then((sneakerReference) => {
          if (!isMountedRef.current || secondhandRequestRef.current !== secondhandRequestId) return;
          if (!sneakerReference || sneakerReference.length === 0) return;
          setAnalysis((current) => {
            if (!current || current.type === 'non-fashion') return current;
            return { ...current, sneakerReference };
          });
        })
        .catch(() => {
          // Async enrichment failure must not replace the result card.
        });
    }
  }, []);

  const runAnalysis = useCallback(
    async () => {
      if (__DEV__) console.log('[DEBUG] ANALYZE_TAP status=' + status);

      if (scanInFlightRef.current) {
        logAnalyzeDiag({
          event: 'scan_duplicate_blocked',
          source: 'runAnalysis',
          reason: 'scan_in_flight',
          status,
        });
        warnInvalidTransition(status, 'processing');
        return;
      }

      if (status !== 'preview') {
        logAnalyzeDiag({
          event: 'scan_analyze_rejected',
          source: 'runAnalysis',
          reason: 'invalid_status',
          status,
        });
        warnInvalidTransition(status, 'processing');
        return;
      }
      if (!photo?.uri || typeof photo.uri !== 'string') {
        logAnalyzeDiag({
          event: 'scan_analyze_rejected',
          source: 'runAnalysis',
          reason: 'missing_photo_uri',
          status,
        });
        setError('We could not take the photo. Please try again.');
        setStatus('error');
        return;
      }
      const imagesForAttempt = selectedImages.length > 0
        ? selectedImages
        : normalizeImageSelections([{ uri: photo.uri }], photo.source || 'camera');

      const operationId = startInFlight();
      if (operationId === null) return;
      // Bind every continuation and timeout to the controller created for this
      // exact attempt. A stale timer must never abort a newer actor/generation.
      const attemptController = activeAbortControllerRef.current;

      // A new attempt supersedes any previous candidates, selection, or queue.
      invalidateScanPipeline();
      // Resolve the Scanner V2 rollout flag ONCE for this session and latch it.
      // Detection, selection, identification and persistence all read this same
      // value, so a flag change between capture and selection can never make
      // the two halves of one scan speak different contracts.
      scannerV2SessionRef.current = beginScannerV2Session();
      const generation = scanGenerationRef.current;
      const attemptActor = currentActorRef.current;
      recordScanLatencyMarker('scan_submit', generation, imagesForAttempt.length);

      logAnalyzeDiag({
        event: 'scan_analyze_accepted',
        source: 'runAnalysis',
        status,
        operationId,
      });
      setStatus('processing');
      setError(null);
      setAnalysis(null);
      setScanItems([]);
      setSelectedScanItemId(null);
      setAnalysisActorId(null);
      secondhandRequestRef.current += 1;

      // Completion path for detection: candidate review or non-fashion.
      const finishDetection = async (data) => {
        if (!isOperationValid(operationId) || !isGenerationValid(generation, attemptActor)) {
          logAnalyzeDiag({
            event: 'scan_stale_result_discarded',
            source: 'finishDetection',
            operationId,
          });
          return;
        }

        if (data.type === 'non-fashion') {
          // Graceful non-fashion path — not an error
          warningPulse();
          setNonFashionMessage(data.message);
          setAnalysis(null);
          setAnalysisActorId(null);
          if (__DEV__) console.log('[DEBUG] SET_RESULT status=non-fashion');
          setStatus('non-fashion');
          return;
        }

        // Candidate review: render immediately after detection. No commerce
        // request, no auto-selection, no artificial presentation delay.
        successPulse();
        setScanCandidates(data.candidates);
        scanCandidatesRef.current = data.candidates;
        setSelectedCandidateIds([]);
        selectedCandidateIdsRef.current = [];
        setItemStates({});
        itemStatesRef.current = {};
        setScanStage('review');
        setAnalysisActorId(attemptActor);
        if (data.partialFailure) {
          setDetectionNotice(PARTIAL_DETECTION_NOTICE);
        }
        recordScanLatencyMarker('candidate_normalization_complete', generation, data.candidates.length);
        if (__DEV__) console.log('[DEBUG] SET_RESULT status=result stage=review');
        setStatus('result');
      };

      if (__DEV__) console.log('[DEBUG] SET_PROCESSING');

      // Yield one frame so React renders the processing UI before the JS
      // thread is occupied by compression work.
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_START');
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_DONE');

      let processingStart;
      let usedScanIdentify = false;
      let attemptTimeoutId = null;

      const executeScanAttempt = async () => {
        if (
          !isOperationValid(operationId) ||
          !isGenerationValid(generation, attemptActor) ||
          attemptController?.signal.aborted
        ) {
          throw userSafeError(
            'scan attempt superseded',
            'We couldnâ€™t complete the scan. Please try again.',
          );
        }
        processingStart = Date.now();

        if (__DEV__) console.log('[DEBUG] BEFORE_COMPRESS imageCount=' + imagesForAttempt.length);
        if (__DEV__ && photo.qaFixtureName) {
          console.log('[K-SCAN QA] Fixture selected: ' + photo.qaFixtureName);
          console.log('[K-SCAN QA] Using compressImage utility: true');
          console.log('[K-SCAN QA] Sending fixture through scan-identify');
        }

        if (!SCAN_IDENTIFY_BACKEND_ENABLED) {
          throw userSafeError(
            'scan backend disabled',
            'We couldn’t complete the scan. Please check your connection and try again.',
          );
        }
        usedScanIdentify = true;

        // Prepare (compress once + privacy-adapt once) and detect per image, in
        // parallel. A single failed image must not cancel the whole session:
        // allSettled keeps every successful sibling.
        let firstRequestMarked = false;
        let firstResponseMarked = false;
        let dispatchedRequestCount = 0;
        const settledDetections = await Promise.allSettled(imagesForAttempt.map(async (image) => {
          const compressed = await compressForUpload(image.uri);
          const adapted = await preparePrivacyAdaptedImage(compressed);
          // Compression/privacy preparation may outlive an actor change or
          // reset. Reject before invoking the provider so a superseded image
          // cannot be sent under a replacement session.
          if (
            !isOperationValid(operationId) ||
            !isGenerationValid(generation, attemptActor) ||
            attemptController?.signal.aborted
          ) {
            throw userSafeError(
              'scan attempt superseded during preparation',
              'We couldnâ€™t complete the scan. Please try again.',
            );
          }
          if (!firstRequestMarked) {
            firstRequestMarked = true;
            recordScanLatencyMarker('image_preparation_complete', generation);
            recordScanLatencyMarker('first_detection_request_sent', generation);
          }
          dispatchedRequestCount += 1;
          if (dispatchedRequestCount === imagesForAttempt.length) {
            recordScanLatencyMarker('all_detection_requests_sent', generation);
          }
          // ONE evidence object, ONE HTTP request, per source image. Each image
          // gets its own evidence id, so a five-image batch is five correlated
          // detections — never one combined payload and never a batch collapsed
          // to its first image.
          const evidence = prepareScannerEvidence({
            preparedImage: adapted.uri,
            source: image.source === 'upload' ? 'gallery' : 'camera',
            evidenceId: createEvidenceId(),
          });
          if (!evidence) {
            throw userSafeError(
              'prepared evidence unavailable',
              'The selected outfit image could not be prepared. Please choose it again.',
            );
          }
          const outcome = await runScannerIdentification({
            mode: 'detect_items',
            evidence,
            platform: 'android',
            requestId: createEvidenceId(),
            sessionFlag: scannerV2SessionRef.current,
            localPrivacyFiltered: adapted.localPrivacyFiltered,
            signal: attemptController?.signal,
          });
          const response = outcome.response;
          if (!firstResponseMarked) {
            firstResponseMarked = true;
            recordScanLatencyMarker('first_detection_response', generation);
          }
          // A V2 response that failed validation is a real failure, not a
          // reason to retry on the legacy contract. Surfacing it as this
          // image's failure keeps sibling images unaffected.
          if (outcome.v2ValidationFailure || outcome.rejection) {
            throw userSafeError(
              'scanner v2 contract failure',
              'We couldn’t complete the scan. Please try again.',
            );
          }
          return {
            image,
            preparedImage: adapted.uri,
            preparedPrivacyFiltered: adapted.localPrivacyFiltered,
            response,
            // Correlation for the follow-up selected-item request. Bound to the
            // evidence these candidates were actually detected in.
            evidence,
            evidenceId: evidence.evidenceId,
            identificationV2: outcome.identificationV2,
            v2Candidates: outcome.candidates,
            contractPath: outcome.contractPath,
          };
        }));
        recordScanLatencyMarker('all_detection_responses_settled', generation);
        if (__DEV__) console.log('[DEBUG] AFTER_DETECTION duration=' + (Date.now() - processingStart) + 'ms imageCount=' + settledDetections.length);

        const detectionResponses = [];
        let failedImageCount = 0;
        for (const settled of settledDetections) {
          if (settled.status === 'fulfilled') {
            detectionResponses.push(settled.value);
          } else {
            failedImageCount += 1;
          }
        }

        if (detectionResponses.length === 0) {
          // Every image failed → existing controlled error path.
          const firstReason = settledDetections.find((settled) => settled.status === 'rejected')?.reason;
          if (firstReason?.userMessage) throw firstReason;
          throw userSafeError(
            firstReason?.message || 'all detection images failed',
            'We couldn’t complete the scan. Please check your connection and try again.',
          );
        }

        // Backend daily quota during detection is a controlled outcome.
        const rateLimited = detectionResponses.find(({ response }) => response.status === 'rate_limited');

        const candidates = buildMultiScanCandidates(detectionResponses);
        if (candidates.length === 0) {
          if (rateLimited) {
            throw userSafeError(
              'scan quota reached during detection',
              rateLimited.response.userMessage || 'Daily scan limit reached. Try again tomorrow.',
            );
          }
          const allNonFashion = detectionResponses.every(({ response }) => response.status === 'non_fashion');
          if (allNonFashion) {
            await finishDetection({
              type: 'non-fashion',
              message: detectionResponses[0]?.response.userMessage ||
                'No fashion items were detected in the selected images.',
            });
            return;
          }
          throw userSafeError(
            'no valid garments detected',
            'We could not find a clear fashion item in those images. Remove unclear images or try again.',
          );
        }

        await finishDetection({
          type: 'candidates',
          candidates,
          partialFailure: failedImageCount > 0,
        });
      };

      const attemptTimeoutPromise = new Promise((_, reject) => {
        attemptTimeoutId = setTimeout(() => {
          logAnalyzeDiag({
            event: 'scan_timeout',
            source: 'runAnalysis',
            operationId,
          });
          attemptController?.abort();
          reject(userSafeError(
            'scan attempt timed out',
            'Analysis is taking longer than expected. Please try again.',
          ));
        }, ATTEMPT_TIMEOUT_MS);
      });

      try {
        await Promise.race([executeScanAttempt(), attemptTimeoutPromise]);
      } catch (err) {
        logAnalyzeDiag({
          event: 'scan_identify_failed',
          source: 'runAnalysis',
          usedScanIdentify,
          operationId,
          errorMessage: err?.message ?? null,
        });
        if (__DEV__) {
          console.warn('[useKScan] scan-identify path failed', err?.message);
        }

        if (isOperationValid(operationId)) {
          errorPulse();
          setError(
            err?.userMessage ||
            'We couldn’t complete the scan. Please check your connection and try again.'
          );
          setStatus('error');
        }
      } finally {
        if (attemptTimeoutId !== null) {
          clearTimeout(attemptTimeoutId);
        }
        clearInFlight(operationId);
      }
    },
    [status, photo, selectedImages, startInFlight, clearInFlight, isOperationValid, isGenerationValid, invalidateScanPipeline]
  );

  // ── Deliberate multi-select (ordered, stable IDs, zero provider calls) ──
  const toggleScanCandidate = useCallback((candidateId) => {
    if (typeof candidateId !== 'string' || !candidateId.trim()) return;
    if (!scanCandidatesRef.current.some((candidate) => candidate.id === candidateId)) return;
    // Selection is frozen once the queue is confirmed for this generation;
    // resume recalculates from the preserved list instead.
    if (queueInFlightRef.current) return;
    // Ready/failed items from a halted queue keep their state; re-toggling a
    // consumed candidate is a no-op to prevent duplicate analysis.
    if (itemStatesRef.current[candidateId] === 'ready') return;

    // Functional update + synchronous ref reconciliation inside the same
    // authoritative operation, so rapid toggles in one tick stay consistent.
    const current = selectedCandidateIdsRef.current;
    const exists = current.includes(candidateId);
    const next = exists
      ? current.filter((id) => id !== candidateId)
      : [...current, candidateId];
    selectedCandidateIdsRef.current = next;
    setSelectedCandidateIds(() => next);
  }, []);

  // Count-aware CTA action. Confirms the current ordered selection and starts
  // the automatic sequential selected-item commerce queue. Also serves as the
  // explicit resume action after a quota halt (it recalculates the remaining
  // unanalyzed selected candidates).
  const confirmSelectedCandidates = useCallback(() => {
    // Synchronous duplicate lock: a second CTA tap in the same tick is a no-op.
    if (queueInFlightRef.current) return;

    const orderedIds = [];
    const seen = new Set();
    for (const id of selectedCandidateIdsRef.current) {
      if (seen.has(id)) continue;
      seen.add(id);
      const state = itemStatesRef.current[id];
      // Completed candidates are never repeated; failed ones require the
      // compatible retry path (resume) and are requeued only if still selected.
      if (state === 'ready') continue;
      orderedIds.push(id);
    }
    if (orderedIds.length === 0) return;

    queueInFlightRef.current = true;
    const generation = scanGenerationRef.current;
    const queueActor = currentActorRef.current;
    recordScanLatencyMarker('selection_cta_pressed', generation, orderedIds.length);

    const queuedStates = { ...itemStatesRef.current };
    for (const id of orderedIds) queuedStates[id] = 'queued';
    itemStatesRef.current = queuedStates;
    setItemStates(queuedStates);
    setQueueActive(true);
    setQueueHalted(null);
    setQueueNotice(null);
    setScanStage('results');

    void processSelectedItemQueue(orderedIds, generation, queueActor);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const setItemState = useCallback((candidateId, state) => {
    itemStatesRef.current = { ...itemStatesRef.current, [candidateId]: state };
    if (isMountedRef.current) {
      setItemStates(itemStatesRef.current);
    }
  }, []);

  // Sequential selected-item commerce queue. One singular request per selected
  // candidate, one active request at a time, FIFO order, progressive results.
  const processSelectedItemQueue = useCallback(async (queueIds, generation, queueActor) => {
    let firstResultRendered = scanItemsHasEntriesRef.current;
    try {
      for (let index = 0; index < queueIds.length; index += 1) {
        if (!isGenerationValid(generation, queueActor)) return;

        const candidateId = queueIds[index];
        const candidate = scanCandidatesRef.current.find((entry) => entry.id === candidateId);
        if (!candidate) {
          setItemState(candidateId, 'failed');
          continue;
        }

        setItemState(candidateId, 'analyzing');

        let detailResponse = candidate.detectionResponse;
        let detailStatus = 'complete';
        let requestFailed = false;
        // Validated V2 identity for this selected item, when the session ran on
        // the V2 contract. Stays null on the legacy path, which is what keeps a
        // legacy operation from ever writing a V2 snapshot.
        let detailIdentificationV2 = null;
        let detailEvidenceSource = candidate.source === 'upload' ? 'gallery' : 'camera';

        if (candidate.selectedCandidate) {
          const requestController = new AbortController();
          queueAbortControllerRef.current = requestController;
          if (index === 0) {
            recordScanLatencyMarker('first_selected_request_sent', generation);
          }
          try {
            // Source continuity: the candidate's own prepared image, evidence,
            // session and digest — never the first image, never re-prepared,
            // never recompressed. The evidence object is reused verbatim, so
            // the bytes identified here are the exact bytes detection saw.
            const selectedEvidence = candidate.evidence ?? prepareScannerEvidence({
              preparedImage: candidate.preparedImage,
              source: candidate.source === 'upload' ? 'gallery' : 'camera',
              evidenceId: candidate.v2Correlation?.evidenceId,
            });
            if (!selectedEvidence) throw userSafeError('prepared evidence unavailable', ITEM_FAILURE_NOTICE);
            const outcome = await runScannerIdentification({
              mode: 'identify_selected_item',
              evidence: selectedEvidence,
              platform: 'android',
              requestId: createEvidenceId(),
              sessionFlag: scannerV2SessionRef.current,
              selectedCandidate: candidate.v2Correlation ?? undefined,
              legacyCorrelation: {
                scanSessionId: candidate.detectionResponse.scanSessionId,
                imageDigestPrefix: candidate.detectionResponse.imageDigestPrefix,
              },
              localPrivacyFiltered: candidate.preparedPrivacyFiltered === true,
              signal: requestController.signal,
            });
            detailResponse = outcome.response;
            detailIdentificationV2 = outcome.identificationV2;
            detailEvidenceSource = selectedEvidence.source;
            if (outcome.v2ValidationFailure || outcome.rejection) requestFailed = true;
          } catch (err) {
            if (__DEV__) console.warn('[useKScan] selected_item request failed', err?.message);
            requestFailed = true;
          } finally {
            // An older queue request may settle after a replacement queue has
            // installed its own controller. Only clear the controller owned by
            // this request.
            if (queueAbortControllerRef.current === requestController) {
              queueAbortControllerRef.current = null;
            }
          }
        }

        if (!isGenerationValid(generation, queueActor)) return;

        // Quota / rate limit: stop the queue, preserve completed results and
        // the remaining selected IDs, surface the existing limit message, and
        // wait for an explicit user resume. No automatic retries.
        if (!requestFailed && detailResponse?.status === 'rate_limited') {
          setItemState(candidateId, 'queued');
          setQueueHalted('quota');
          setQueueNotice(detailResponse.userMessage || 'Daily scan limit reached. Try again tomorrow.');
          return;
        }

        if (requestFailed || !detailResponse || detailResponse.status !== 'completed') {
          if (!requestFailed && candidate.garment) {
            // Existing partial fallback: detection already produced a genuine
            // garment; present it without commerce rather than discarding it.
            detailStatus = 'partial';
            detailResponse = {
              status: 'completed',
              attributes: candidate.garment.attributes,
              identification: candidate.garment.identification,
              recommendedProducts: [],
              userMessage: candidate.garment.label,
            };
          } else {
            setItemState(candidateId, 'failed');
            setQueueNotice(ITEM_FAILURE_NOTICE);
            continue;
          }
          // The partial fallback presents detection's own garment, which never
          // carried a completed V2 identity. Keeping a V2 result here would
          // attach an identity to a response that did not produce it.
          detailIdentificationV2 = null;
        }

        const item = {
          id: candidate.id,
          sourceImageId: candidate.sourceImageId,
          sourceImageIndex: candidate.sourceImageIndex,
          sourceImageUri: candidate.sourceImageUri,
          source: candidate.source,
          garment: candidate.garment,
          selectedCandidate: candidate.selectedCandidate,
          detectionResponse: candidate.detectionResponse,
          label: candidateLabel(candidate),
          analysis: mapScanIdentifyToAnalysis(detailResponse, {
            identificationV2: detailIdentificationV2,
            source: detailEvidenceSource,
          }),
          detailStatus,
        };

        if (!isGenerationValid(generation, queueActor)) return;

        scanItemsHasEntriesRef.current = true;
        setScanItems((current) => (
          current.some((existing) => existing.id === item.id) ? current : [...current, item]
        ));
        setItemState(candidateId, 'ready');

        if (!firstResultRendered) {
          firstResultRendered = true;
          successPulse();
          secondhandRequestRef.current += 1;
          const secondhandRequestId = secondhandRequestRef.current;
          setSelectedScanItemId(item.id);
          setAnalysis(item.analysis);
          setAnalysisActorId(queueActor);
          recordScanLatencyMarker('first_selected_result_rendered', generation);
          enrichDisplayedAnalysis(item.analysis, secondhandRequestId);
        } else {
          recordScanLatencyMarker('subsequent_result_rendered', generation, index);
        }
      }
    } finally {
      if (isGenerationValid(generation, queueActor)) {
        queueInFlightRef.current = false;
        setQueueActive(false);
        if (itemStatesRef.current && !Object.values(itemStatesRef.current).some((state) => state === 'queued' || state === 'analyzing')) {
          recordScanLatencyMarker('queue_complete', generation);
        }
      }
      // On an invalid generation the pipeline was already invalidated (and the
      // lock released) by invalidateScanPipeline; do not touch newer state.
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const scanItemsHasEntriesRef = useRef(false);

  const retake = useCallback(() => {
    if (scanInFlightRef.current) {
      logAnalyzeDiag({
        event: 'scan_retake_blocked',
        source: 'retake',
        status,
      });
      warnInvalidTransition(status, 'idle');
      return;
    }

    const canRetakeFromPreview = status === 'preview';
    const canRetakeFromError = status === 'error' && !!photo;

    if (!canRetakeFromPreview && !canRetakeFromError) {
      warnInvalidTransition(status, 'idle');
      return;
    }

    invalidateScanPipeline();
    scanItemsHasEntriesRef.current = false;
    setPhoto(null);
    setSelectedImages([]);
    setAnalysis(null);
    setScanItems([]);
    setSelectedScanItemId(null);
    setAnalysisActorId(null);
    setError(null);
    setNonFashionMessage(null);
    secondhandRequestRef.current += 1;
    setStatus('idle');
  }, [status, photo, invalidateScanPipeline]);

  const selectStaticFixture = useCallback(
    (uri, fixtureName) => {
      if (typeof __DEV__ === 'undefined' || !__DEV__) return;

      if (scanInFlightRef.current) {
        logAnalyzeDiag({
          event: 'scan_fixture_blocked',
          source: 'selectStaticFixture',
          status,
        });
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (status !== 'idle') {
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (!uri || typeof uri !== 'string') {
        setError('Static QA fixture could not be loaded.');
        setStatus('error');
        return;
      }

      if (__DEV__) console.log('[K-SCAN QA] Fixture selected: ' + fixtureName);
      setStatus('capturing');
      invalidateScanPipeline();
      scanItemsHasEntriesRef.current = false;
      const images = normalizeImageSelections([{ uri, qaFixtureName: fixtureName }], 'fixture');
      setSelectedImages(images);
      setPhoto({ ...images[0], source: 'fixture' });
      setError(null);
      setAnalysis(null);
      setScanItems([]);
      setSelectedScanItemId(null);
      setAnalysisActorId(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      requestAnimationFrame(() => {
        if (isMountedRef.current) setStatus('preview');
      });
    },
    [status, invalidateScanPipeline]
  );

  const dismissResult = useCallback(() => {
    if (scanInFlightRef.current) {
      logAnalyzeDiag({
        event: 'scan_dismiss_blocked',
        source: 'dismissResult',
        status,
      });
      warnInvalidTransition(status, 'idle');
      return;
    }

    if (status !== 'result' && status !== 'error' && status !== 'non-fashion') {
      warnInvalidTransition(status, 'idle');
      return;
    }

    invalidateScanPipeline();
    scanItemsHasEntriesRef.current = false;
    setAnalysis(null);
    setScanItems([]);
    setSelectedScanItemId(null);
    setAnalysisActorId(null);
    setPhoto(null);
    setSelectedImages([]);
    setError(null);
    setNonFashionMessage(null);
    secondhandRequestRef.current += 1;
    setStatus('idle');
  }, [status, invalidateScanPipeline]);

  const retry = useCallback(() => {
    if (scanInFlightRef.current) {
      logAnalyzeDiag({
        event: 'scan_retry_duplicate_blocked',
        source: 'retry',
        status,
      });
      warnInvalidTransition(status, 'preview');
      return;
    }

    if (status !== 'error') {
      warnInvalidTransition(status, 'preview');
      return;
    }

    invalidateScanPipeline();
    scanItemsHasEntriesRef.current = false;
    if (photo) {
      setError(null);
      setAnalysis(null);
      setScanItems([]);
      setSelectedScanItemId(null);
      setAnalysisActorId(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('preview');
    } else {
      setError(null);
      setAnalysisActorId(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('idle');
    }
  }, [status, photo, invalidateScanPipeline]);

  const selectScanItem = useCallback((itemId) => {
    if (scanInFlightRef.current || status !== 'result') return;
    const item = scanItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    // Invalidate enrichment for the previously displayed item before swapping
    // the analysis. Otherwise a late secondhand/sneaker response can decorate
    // the newly selected candidate with the prior candidate's data.
    secondhandRequestRef.current += 1;
    const secondhandRequestId = secondhandRequestRef.current;
    setSelectedScanItemId(item.id);
    setAnalysis(item.analysis);
    setAnalysisActorId(currentActorRef.current);
    enrichDisplayedAnalysis(item.analysis, secondhandRequestId);
  }, [status, scanItems, enrichDisplayedAnalysis]);

  return {
    status,
    photo,
    selectedImages,
    analysis,
    scanItems,
    selectedScanItemId,
    analysisActorId,
    error,
    nonFashionMessage,
    isAnalyzing,
    // Multi-item review + queue surface
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
    uploadPhoto,
    selectGalleryPhoto,
    addGalleryPhotos,
    removeSelectedImage,
    selectScanItem,
    toggleScanCandidate,
    confirmSelectedCandidates,
  };
}
