import { useState, useCallback, useRef, useEffect } from 'react';
import * as Crypto from 'expo-crypto';
import { SCAN_IDENTIFY_BACKEND_ENABLED } from '../constants/featureFlags';
import { identifyScanImage } from '../services/scanIdentification';
import { mapScanIdentifyToAnalysis } from '../services/scanIdentificationMapper';
import {
  buildSecondhandSearchRequest,
  searchVintedSecondhand,
} from '../services/secondhand';
import { searchSneakers, shouldEnrichSneakers } from '../services/sneakers/index';
import { compressForUpload } from '../services/imageUtils';
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

function createScanSessionId() {
  return `scan_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function rawImageBase64(image) {
  return typeof image === 'string' ? image.replace(/^data:[^;]+;base64,/, '').trim() : '';
}

async function digestPrefix(value) {
  const digest = await Crypto.digestStringAsync(
    Crypto.CryptoDigestAlgorithm.SHA256,
    value,
  );
  return digest.slice(0, 12).toLowerCase();
}

function createScanSession(sourceImageUri) {
  return {
    scanSessionId: createScanSessionId(),
    sourceImageUri,
    sourceUriHash: null,
    preparedImageUri: null,
    imageDigestPrefix: null,
  };
}

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
  result: ['idle', 'processing'],
  'non-fashion': ['idle'],
  error: ['idle', 'preview', 'processing'],
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
export function useKScan() {
  const [status, setStatus] = useState('idle');
  const [photo, setPhoto] = useState(null);
  const [analysis, setAnalysis] = useState(null);
  const [error, setError] = useState(null);
  const [nonFashionMessage, setNonFashionMessage] = useState(null);
  const [selectedCandidateId, setSelectedCandidateId] = useState(null);
  const isMounted = useRef(true);
  // Synchronous locks — read before state updates propagate, so rapid taps that
  // arrive in the same event loop tick before React re-renders cannot trigger
  // duplicate captures or duplicate API calls.
  const captureInProgressRef = useRef(false);
  const analysisInProgressRef = useRef(false);
  const secondhandRequestRef = useRef(0);
  const multiItemSessionRef = useRef(null);
  const initialMultiItemAnalysisRef = useRef(null);
  const retryRequestModeRef = useRef('multi_item_detection');

  useEffect(() => {
    isMounted.current = true;
    return () => { isMounted.current = false; };
  }, []);

  const capturePhoto = useCallback(
    async (cameraRef) => {
      if (captureInProgressRef.current || status !== 'idle') {
        warnInvalidTransition(status, 'capturing');
        return;
      }
      if (!cameraRef?.current || typeof cameraRef.current.takePictureAsync !== 'function') {
        setError('We could not take the photo. Please try again.');
        setStatus('error');
        return;
      }

      captureInProgressRef.current = true;
      setStatus('capturing');
      softImpact();

      try {
        const result = await cameraRef.current.takePictureAsync({
          quality: 0.7,
        });
        if (!result || typeof result.uri !== 'string' || result.uri.length === 0) {
          throw new Error('Camera returned an invalid photo.');
        }
        const session = createScanSession(result.uri);
        multiItemSessionRef.current = session;
        initialMultiItemAnalysisRef.current = null;
        retryRequestModeRef.current = 'multi_item_detection';
        setSelectedCandidateId(null);
        setPhoto({ ...result, source: 'camera', scanSessionId: session.scanSessionId });
        setError(null);
        setStatus('preview');
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error('Capture failed:', err);
        }
        setPhoto(null);
        setError('We could not take the photo. Please try again.');
        setStatus('error');
      } finally {
        captureInProgressRef.current = false;
      }
    },
    [status]
  );

  const runAnalysis = useCallback(
    async () => {
      if (__DEV__) console.log('[DEBUG] ANALYZE_TAP status=' + status);

      if (analysisInProgressRef.current) {
        logAnalyzeDiag({
          event: 'duplicate_analyze_blocked',
          source: 'runAnalysis',
          reason: 'analysis_in_flight',
          status,
        });
        warnInvalidTransition(status, 'processing');
        return;
      }

      if (status !== 'preview') {
        logAnalyzeDiag({
          event: 'analyze_trigger_rejected',
          source: 'runAnalysis',
          reason: 'invalid_status',
          status,
        });
        warnInvalidTransition(status, 'processing');
        return;
      }
      if (!photo?.uri || typeof photo.uri !== 'string') {
        logAnalyzeDiag({
          event: 'analyze_trigger_rejected',
          source: 'runAnalysis',
          reason: 'missing_photo_uri',
          status,
        });
        setError('We could not take the photo. Please try again.');
        setStatus('error');
        return;
      }

      analysisInProgressRef.current = true;
      logAnalyzeDiag({
        event: 'analyze_trigger_accepted',
        source: 'runAnalysis',
        status,
      });
      setStatus('processing');
      setError(null);
      setAnalysis(null);
      secondhandRequestRef.current += 1;
      const secondhandRequestId = secondhandRequestRef.current;

      // Shared completion path for both the primary scan-identify path and the
      // legacy /api/analyze fallback. Keeps status transitions, enrichment, and
      // minimum-HUD timing identical regardless of which backend answered.
      const finishAnalysis = async (data, processingStart) => {
        if (__DEV__) console.log('[DEBUG] AFTER_API_CALL duration=' + (Date.now() - processingStart) + 'ms type=' + data?.type);

        // Enforce minimum HUD display time so PerceptionLayer completes its entry
        // animation before we transition to result. Only effective for very fast
        // responses (< MIN_ANALYSIS_MS); longer requests are unaffected.
        const elapsed = Date.now() - processingStart;
        if (elapsed < MIN_ANALYSIS_MS) {
          await new Promise(r => setTimeout(r, MIN_ANALYSIS_MS - elapsed));
        }

        if (!isMounted.current) return;

        if (data.type === 'non-fashion') {
          // Graceful non-fashion path — not an error
          warningPulse();
          setNonFashionMessage(data.message);
          setAnalysis(null);
          if (__DEV__) console.log('[DEBUG] SET_RESULT status=non-fashion');
          setStatus('non-fashion');
          return;
        }

        successPulse();
        setAnalysis(data);
        setNonFashionMessage(null);
        if (__DEV__) console.log('[DEBUG] SET_RESULT status=result');
        setStatus('result');

        const isConfirmationResult =
          Array.isArray(data.confirmationCandidates) && data.confirmationCandidates.length > 0;
        const secondhandRequest = isConfirmationResult ? null : buildSecondhandSearchRequest(data);
        if (secondhandRequest) {
          searchVintedSecondhand(secondhandRequest)
            .then((secondhand) => {
              if (!isMounted.current || secondhandRequestRef.current !== secondhandRequestId) return;
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
        if (!isConfirmationResult && shouldEnrichSneakers(sneakerInput)) {
          searchSneakers(sneakerInput)
            .then((sneakerReference) => {
              if (!isMounted.current || secondhandRequestRef.current !== secondhandRequestId) return;
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
      let sanitized;
      let usedScanIdentify = false;

      try {
        processingStart = Date.now();

        let session = multiItemSessionRef.current;
        if (!session || session.sourceImageUri !== photo.uri) {
          session = createScanSession(photo.uri);
          multiItemSessionRef.current = session;
        }
        if (!session.sourceUriHash) {
          session.sourceUriHash = await digestPrefix(photo.uri);
        }
        if (__DEV__) {
          console.log('[KSCAN_MULTI_ITEM] correlation', {
            event: 'prepare_image_started',
            scanSessionId: session.scanSessionId,
            candidateId: 'none',
            sourceUriHash: session.sourceUriHash,
            imageDigestPrefix: session.imageDigestPrefix ?? 'pending',
            requestMode: 'multi_item_detection',
          });
        }
        if (__DEV__ && photo.qaFixtureName) {
          console.log('[K-SCAN QA] Fixture selected: ' + photo.qaFixtureName);
          console.log('[K-SCAN QA] Using compressImage utility: true');
          console.log('[K-SCAN QA] Sending fixture through scan-identify');
        }
        const compressed = session.preparedImageUri ?? await compressForUpload(photo.uri);
        if (__DEV__) console.log('[DEBUG] AFTER_COMPRESS duration=' + (Date.now() - processingStart) + 'ms payloadLen=' + (compressed?.length ?? 0));

        sanitized = session.preparedImageUri ?? await sanitizeImageBeforeUpload(compressed);
        if (!sanitized || typeof sanitized !== 'string') {
          throw userSafeError(
            'prepared image unavailable',
            'The selected outfit image could not be prepared. Please choose it again.',
          );
        }
        if (!session.preparedImageUri) {
          session.preparedImageUri = sanitized;
          session.imageDigestPrefix = await digestPrefix(rawImageBase64(sanitized));
        }
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
        const identifyResponse = await identifyScanImage(sanitized, {
          source: photo.source === 'upload' ? 'upload' : 'camera',
          localPrivacyFiltered: true,
          multiItemDetection: true,
          requestMode: 'multi_item_detection',
          scanSessionId: session.scanSessionId,
          imageDigestPrefix: session.imageDigestPrefix,
        });
        // Throws a user-safe error on 'failed' → handled by the catch below.
        const data = mapScanIdentifyToAnalysis(identifyResponse);
        if (Array.isArray(data.confirmationCandidates) && data.confirmationCandidates.length > 0) {
          initialMultiItemAnalysisRef.current = data;
          setSelectedCandidateId(data.confirmationCandidates[0].id);
        }
        retryRequestModeRef.current = 'multi_item_detection';
        await finishAnalysis(data, processingStart);
      } catch (err) {
        logAnalyzeDiag({
          event: 'scan_identify_failed',
          source: 'runAnalysis',
          usedScanIdentify,
          errorMessage: err?.message ?? null,
        });
        if (__DEV__) {
          console.warn('[useKScan] scan-identify path failed', err?.message);
        }

        if (isMounted.current) {
          errorPulse();
          setError(
            err?.userMessage ||
            'We couldn’t complete the scan. Please check your connection and try again.'
          );
          setStatus('error');
        }
      } finally {
        analysisInProgressRef.current = false;
      }
    },
    [status, photo]
  );

  const selectConfirmationCandidate = useCallback((candidateId) => {
    if (typeof candidateId !== 'string' || !candidateId.trim()) return;
    const candidates = initialMultiItemAnalysisRef.current?.confirmationCandidates;
    if (!Array.isArray(candidates) || !candidates.some((candidate) => candidate.id === candidateId)) {
      return;
    }
    setSelectedCandidateId(candidateId);

    const session = multiItemSessionRef.current;
    if (__DEV__ && session) {
      console.log('[KSCAN_MULTI_ITEM] correlation', {
        event: 'candidate_selected',
        scanSessionId: session.scanSessionId,
        candidateId,
        sourceUriHash: session.sourceUriHash ?? 'none',
        imageDigestPrefix: session.imageDigestPrefix ?? 'none',
        requestMode: 'selected_item',
      });
    }
  }, []);

  const analyzeSelectedCandidate = useCallback(async (candidateIdOverride) => {
    if (analysisInProgressRef.current) return;

    const candidateId = candidateIdOverride || selectedCandidateId;
    const initialAnalysis = initialMultiItemAnalysisRef.current;
    const candidate = initialAnalysis?.confirmationCandidates?.find(
      (item) => item.id === candidateId,
    );
    const session = multiItemSessionRef.current;

    if (!candidate || !session?.preparedImageUri || !session.imageDigestPrefix) {
      setError('The original outfit image is no longer available. Please start a new scan.');
      setStatus('error');
      return;
    }
    if (!photo?.uri || photo.uri !== session.sourceImageUri) {
      setError('The original outfit image is no longer available. Please start a new scan.');
      setStatus('error');
      return;
    }

    analysisInProgressRef.current = true;
    retryRequestModeRef.current = 'selected_item';
    setSelectedCandidateId(candidate.id);
    setError(null);
    setStatus('processing');
    secondhandRequestRef.current += 1;
    const processingStart = Date.now();

    try {
      if (__DEV__) {
        console.log('[KSCAN_MULTI_ITEM] correlation', {
          event: 'selected_item_request_started',
          scanSessionId: session.scanSessionId,
          candidateId: candidate.id,
          sourceUriHash: session.sourceUriHash ?? 'none',
          imageDigestPrefix: session.imageDigestPrefix,
          requestMode: 'selected_item',
        });
      }

      const identifyResponse = await identifyScanImage(session.preparedImageUri, {
        source: photo.source === 'upload' ? 'upload' : 'camera',
        localPrivacyFiltered: true,
        multiItemDetection: true,
        requestMode: 'selected_item',
        scanSessionId: session.scanSessionId,
        imageDigestPrefix: session.imageDigestPrefix,
        selectedCandidate: {
          candidateId: candidate.id,
          category: candidate.category,
          subtype: candidate.subtype,
          bounds: candidate.bounds,
        },
      });
      const data = mapScanIdentifyToAnalysis(identifyResponse);
      if (data.type === 'non-fashion') {
        throw userSafeError(
          'selected garment not identified',
          'The selected garment could not be identified. Please choose another item.',
        );
      }

      const elapsed = Date.now() - processingStart;
      if (elapsed < MIN_ANALYSIS_MS) {
        await new Promise((resolve) => setTimeout(resolve, MIN_ANALYSIS_MS - elapsed));
      }
      if (!isMounted.current) return;

      successPulse();
      setAnalysis(data);
      setNonFashionMessage(null);
      setStatus('result');
    } catch (err) {
      if (!isMounted.current) return;
      errorPulse();
      setAnalysis(initialAnalysis);
      setError(
        err?.userMessage ||
        'We couldn\u2019t analyze the selected garment. Please try again.',
      );
      setStatus('error');
    } finally {
      analysisInProgressRef.current = false;
    }
  }, [photo, selectedCandidateId]);

  const retake = useCallback(() => {
    const canRetakeFromPreview = status === 'preview';
    const canRetakeFromError = status === 'error' && !!photo;

    if (!canRetakeFromPreview && !canRetakeFromError) {
      warnInvalidTransition(status, 'idle');
      return;
    }

    setPhoto(null);
    setAnalysis(null);
    setError(null);
    setNonFashionMessage(null);
    setSelectedCandidateId(null);
    multiItemSessionRef.current = null;
    initialMultiItemAnalysisRef.current = null;
    retryRequestModeRef.current = 'multi_item_detection';
    secondhandRequestRef.current += 1;
    setStatus('idle');
  }, [status, photo]);

  const selectStaticFixture = useCallback(
    (uri, fixtureName) => {
      if (typeof __DEV__ === 'undefined' || !__DEV__) return;

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
      const session = createScanSession(uri);
      multiItemSessionRef.current = session;
      initialMultiItemAnalysisRef.current = null;
      retryRequestModeRef.current = 'multi_item_detection';
      setSelectedCandidateId(null);
      setPhoto({ uri, qaFixtureName: fixtureName, source: 'fixture', scanSessionId: session.scanSessionId });
      setError(null);
      setAnalysis(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      requestAnimationFrame(() => {
        if (isMounted.current) setStatus('preview');
      });
    },
    [status]
  );

  const uploadPhoto = useCallback(
    (uri) => {
      if (status !== 'idle' && status !== 'preview') {
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (!uri || typeof uri !== 'string') {
        setError('Uploaded image could not be loaded.');
        setStatus('error');
        return;
      }

      const session = createScanSession(uri);
      multiItemSessionRef.current = session;
      initialMultiItemAnalysisRef.current = null;
      retryRequestModeRef.current = 'multi_item_detection';
      setSelectedCandidateId(null);
      setPhoto({ uri, source: 'upload', scanSessionId: session.scanSessionId });
      setError(null);
      setAnalysis(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('preview');
    },
    [status]
  );

  const dismissResult = useCallback(() => {
    if (status !== 'result' && status !== 'error' && status !== 'non-fashion') {
      warnInvalidTransition(status, 'idle');
      return;
    }

    setAnalysis(null);
    setPhoto(null);
    setError(null);
    setNonFashionMessage(null);
    setSelectedCandidateId(null);
    multiItemSessionRef.current = null;
    initialMultiItemAnalysisRef.current = null;
    retryRequestModeRef.current = 'multi_item_detection';
    secondhandRequestRef.current += 1;
    setStatus('idle');
  }, [status]);

  const retry = useCallback(() => {
    if (status !== 'error') {
      warnInvalidTransition(status, 'preview');
      return;
    }

    if (
      photo &&
      retryRequestModeRef.current === 'selected_item' &&
      selectedCandidateId
    ) {
      setError(null);
      setAnalysis(initialMultiItemAnalysisRef.current);
      analyzeSelectedCandidate(selectedCandidateId);
    } else if (photo) {
      setError(null);
      setAnalysis(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('preview');
    } else {
      setError(null);
      setNonFashionMessage(null);
      secondhandRequestRef.current += 1;
      setStatus('idle');
    }
  }, [status, photo, selectedCandidateId, analyzeSelectedCandidate]);

  return {
    status,
    photo,
    analysis,
    error,
    nonFashionMessage,
    selectedCandidateId,
    capturePhoto,
    runAnalysis,
    retake,
    dismissResult,
    retry,
    selectConfirmationCandidate,
    analyzeSelectedCandidate,
    selectStaticFixture,
    uploadPhoto,
  };
}
