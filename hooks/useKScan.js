import { useState, useCallback, useRef, useEffect } from 'react';
import { AccessibilityInfo, Alert } from 'react-native';
import * as ImagePicker from 'expo-image-picker';
import {
  MULTI_IMAGE_SCANNER_ENABLED,
  SCAN_IDENTIFY_BACKEND_ENABLED,
} from '../constants/featureFlags';
import { identifyScanImage } from '../services/scanIdentification';
import { mapScanIdentifyToAnalysis } from '../services/scanIdentificationMapper';
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
import {
  getPrivacySanitizerStatus,
  sanitizeImageBeforeUpload,
} from '../services/privacyImageSanitizer';
import {
  errorPulse,
  softImpact,
  successPulse,
  warningPulse,
} from '../services/haptics';

// Minimum time to stay in 'processing' so the PerceptionLayer HUD has time to
// complete its entry animation (~730ms) before the result card appears.
const MIN_ANALYSIS_MS = 600;

// Fallback ceiling for the entire capture-to-result attempt. The backend edge
// function uses ~20 s; compression + sanitizer + network overhead needs a bit
// more room. A late result after this window is treated as a timeout.
const ATTEMPT_TIMEOUT_MS = 52_000;

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
 * non-fashion: the AI confirmed the image is not a fashion item.
 *   analysis will be null; nonFashionMessage holds the AI's explanation.
 *   Resets to idle via dismissResult().
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
  currentActorRef.current = normalizedActorId;

  useEffect(() => {
    isMountedRef.current = true;
    return () => {
      isMountedRef.current = false;
      // Invalidate any in-flight attempt so late results are discarded.
      operationIdRef.current += 1;
      activeAbortControllerRef.current?.abort();
      scanInFlightRef.current = false;
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
  }, [normalizedActorId]);

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
    [status, startInFlight, clearInFlight, isOperationValid]
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
        const { status: permStatus } = await ImagePicker.requestMediaLibraryPermissionsAsync();
        if (permStatus !== 'granted') {
          // Permission denial is a controlled outcome, not an error. Release the
          // guard first, then restore the guidance alert that the prior app.js
          // upload flow showed — without it, tapping Upload silently does nothing.
          clearInFlight(operationId);
          Alert.alert(
            'Photo Access Required',
            'Allow K Scan to access your photo library to upload a scan image.',
            [{ text: 'OK' }],
          );
          return;
        }

        const result = await ImagePicker.launchImageLibraryAsync({
          mediaTypes: ImagePicker.MediaTypeOptions.Images,
          quality: 1,
          allowsEditing: false,
          allowsMultipleSelection: MULTI_IMAGE_SCANNER_ENABLED,
          selectionLimit: MULTI_IMAGE_SCANNER_ENABLED ? MAX_SCAN_IMAGES : 1,
          orderedSelection: MULTI_IMAGE_SCANNER_ENABLED,
        });

        if (isOperationValid(operationId)) {
          if (!result.canceled && Array.isArray(result.assets) && result.assets.length > 0) {
            const images = normalizeImageSelections(
              MULTI_IMAGE_SCANNER_ENABLED ? result.assets : result.assets.slice(0, 1),
              'upload',
              append ? selectedImages : [],
            );
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
    [status, selectedImages, startInFlight, clearInFlight, isOperationValid]
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
  }, [selectedImages]);

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
    [status]
  );

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
      const secondhandRequestId = secondhandRequestRef.current;

      // Shared completion path for the scan-identify backend.
      const finishAnalysis = async (data, processingStart) => {
        if (__DEV__) console.log('[DEBUG] AFTER_API_CALL duration=' + (Date.now() - processingStart) + 'ms type=' + data?.type);

        if (!isOperationValid(operationId)) {
          logAnalyzeDiag({
            event: 'scan_stale_result_discarded',
            source: 'finishAnalysis',
            operationId,
          });
          return;
        }

        // Enforce minimum HUD display time so PerceptionLayer completes its entry
        // animation before we transition to result. Only effective for very fast
        // responses (< MIN_ANALYSIS_MS); longer requests are unaffected.
        const elapsed = Date.now() - processingStart;
        if (elapsed < MIN_ANALYSIS_MS) {
          await new Promise(r => setTimeout(r, MIN_ANALYSIS_MS - elapsed));
        }

        if (!isOperationValid(operationId)) {
          logAnalyzeDiag({
            event: 'scan_stale_result_discarded',
            source: 'finishAnalysis_after_min_delay',
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

        successPulse();
        setAnalysis(data);
        setAnalysisActorId(activeOperationActorRef.current);
        setNonFashionMessage(null);
        if (__DEV__) console.log('[DEBUG] SET_RESULT status=result');
        setStatus('result');

        const secondhandRequest = buildSecondhandSearchRequest(data);
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
      };

      if (__DEV__) console.log('[DEBUG] SET_PROCESSING');

      // Yield one frame so React renders the processing UI (PerceptionLayer)
      // before the JS thread is occupied by compression work.
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_START');
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_DONE');

      let processingStart;
      let usedScanIdentify = false;
      let attemptTimeoutId = null;

      const executeScanAttempt = async () => {
        processingStart = Date.now();

        if (__DEV__) console.log('[DEBUG] BEFORE_COMPRESS imageCount=' + imagesForAttempt.length);
        if (__DEV__ && photo.qaFixtureName) {
          console.log('[K-SCAN QA] Fixture selected: ' + photo.qaFixtureName);
          console.log('[K-SCAN QA] Using compressImage utility: true');
          console.log('[K-SCAN QA] Sending fixture through scan-identify');
        }
        const preparedImages = await Promise.all(imagesForAttempt.map(async (image) => {
          const compressed = await compressForUpload(image.uri);
          const prepared = await sanitizeImageBeforeUpload(compressed);
          return { image, prepared };
        }));
        if (__DEV__) console.log('[DEBUG] AFTER_COMPRESS duration=' + (Date.now() - processingStart) + 'ms imageCount=' + preparedImages.length);
        if (__DEV__) {
          const sanitizerStatus = getPrivacySanitizerStatus();
          console.warn(
            '[K-SCAN PRIVACY] Pre-upload sanitizer status mode=' +
            sanitizerStatus.mode +
            ' faceDetectionAvailable=' +
            sanitizerStatus.faceDetectionAvailable +
            ' faceBlurApplied=' +
            sanitizerStatus.faceBlurApplied
          );
        }

        if (__DEV__) console.log('[DEBUG] BEFORE_API_CALL');
        // Production camera scan path (KS-REL-008C): always route through the
        // app-side scan-identify Supabase Edge Function. The legacy Render
        // /api/analyze fallback has been removed for production submission.
        if (!SCAN_IDENTIFY_BACKEND_ENABLED) {
          throw userSafeError(
            'scan backend disabled',
            'We couldn’t complete the scan. Please check your connection and try again.',
          );
        }
        usedScanIdentify = true;

        const detectionResponses = await Promise.all(preparedImages.map(async ({ image, prepared }) => ({
          image,
          preparedImage: prepared,
          response: await identifyScanImage(prepared, {
            source: image.source === 'upload' ? 'upload' : 'camera',
            localPrivacyFiltered: true,
            multiItemDetection: true,
            requestMode: 'multi_item_detection',
            signal: activeAbortControllerRef.current?.signal,
          }),
        })));

        const candidates = buildMultiScanCandidates(detectionResponses);
        if (candidates.length === 0) {
          const allNonFashion = detectionResponses.every(({ response }) => response.status === 'non_fashion');
          if (allNonFashion) {
            await finishAnalysis({
              type: 'non-fashion',
              message: detectionResponses[0]?.response.userMessage ||
                'No fashion items were detected in the selected images.',
            }, processingStart);
            return;
          }
          throw userSafeError(
            'no valid garments detected',
            'We could not find a clear fashion item in those images. Remove unclear images or try again.',
          );
        }

        const items = await Promise.all(candidates.map(async (candidate) => {
          let detailResponse = candidate.detectionResponse;
          let detailStatus = 'complete';
          if (candidate.selectedCandidate) {
            detailResponse = await identifyScanImage(candidate.preparedImage, {
              source: candidate.source === 'upload' ? 'upload' : 'camera',
              localPrivacyFiltered: true,
              multiItemDetection: true,
              requestMode: 'selected_item',
              scanSessionId: candidate.detectionResponse.scanSessionId,
              imageDigestPrefix: candidate.detectionResponse.imageDigestPrefix,
              selectedCandidate: candidate.selectedCandidate,
              signal: activeAbortControllerRef.current?.signal,
            });
          }

          if (detailResponse.status !== 'completed') {
            detailStatus = 'partial';
            detailResponse = candidate.garment ? {
              status: 'completed',
              attributes: candidate.garment.attributes,
              identification: candidate.garment.identification,
              recommendedProducts: [],
              userMessage: candidate.garment.label,
            } : candidate.detectionResponse;
          }

          return {
            id: candidate.id,
            sourceImageId: candidate.sourceImageId,
            sourceImageIndex: candidate.sourceImageIndex,
            sourceImageUri: candidate.sourceImageUri,
            source: candidate.source,
            garment: candidate.garment,
            selectedCandidate: candidate.selectedCandidate,
            detectionResponse: candidate.detectionResponse,
            label: candidateLabel(candidate),
            analysis: mapScanIdentifyToAnalysis(detailResponse),
            detailStatus,
          };
        }));

        if (!isOperationValid(operationId)) return;
        setScanItems(items);
        setSelectedScanItemId(items[0].id);

        // Throws a user-safe error on 'failed' → handled by the catch below.
        const data = items[0].analysis;
        await finishAnalysis(data, processingStart);
      };

      const attemptTimeoutPromise = new Promise((_, reject) => {
        attemptTimeoutId = setTimeout(() => {
          logAnalyzeDiag({
            event: 'scan_timeout',
            source: 'runAnalysis',
            operationId,
          });
          activeAbortControllerRef.current?.abort();
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
    [status, photo, selectedImages, startInFlight, clearInFlight, isOperationValid]
  );

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
  }, [status, photo]);

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
    [status]
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
  }, [status]);

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
  }, [status, photo]);

  const selectScanItem = useCallback((itemId) => {
    if (scanInFlightRef.current || status !== 'result') return;
    const item = scanItems.find((candidate) => candidate.id === itemId);
    if (!item) return;
    setSelectedScanItemId(item.id);
    setAnalysis(item.analysis);
    setAnalysisActorId(currentActorRef.current);
  }, [status, scanItems]);

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
  };
}
