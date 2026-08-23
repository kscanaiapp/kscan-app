import { useState, useCallback, useRef, useEffect } from 'react';
import { AccessibilityInfo } from 'react-native';
import * as Crypto from 'expo-crypto';
import * as ImagePicker from 'expo-image-picker';
import { SCAN_IDENTIFY_BACKEND_ENABLED } from '../constants/featureFlags';
import { prepareScannerEvidence, createEvidenceId } from '../services/scannerEvidenceGateway';
import { beginScannerV2Session } from '../services/scannerIdentificationV2';
import { runScannerIdentification } from '../services/scannerScanRequest';
import { mapScanIdentifyToAnalysis } from '../services/scanIdentificationMapper';
import { fetchDeferredCommerce, mergeEnrichedOffers } from '../services/commerceHydration';
import { fetchMultiItemCommerce } from '../services/multiItemCommerce';
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

// Fallback ceiling for the entire capture-to-result attempt. The backend edge
// function uses ~20 s; compression + sanitizer + network overhead needs a bit
// more room. A late result after this window is treated as a timeout.
const ATTEMPT_TIMEOUT_MS = 32_000;

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
    localPrivacyFiltered: false,
    // One session is one prepared image, so it is exactly one piece of
    // evidence (Phase 2B.2). Minting the id here gives the lifecycle for free:
    // the id survives detection → selection for an unchanged image, and a new
    // capture, retake or replacement gallery item builds a new session and
    // therefore new evidence. Candidates tied to the previous id are dropped
    // with the session that held them.
    evidenceId: createEvidenceId(),
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
  // Render-only flag that mirrors the imperative scanInFlightRef. It stays true
  // from the first synchronous guard activation until the attempt fully settles
  // (success, failure, timeout, abort, or picker cancellation).
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  // v127: commerce lifecycle is tracked separately from scan status so a
  // pending shelf never drags the scan back into a loading state.
  //
  // Declared LAST on purpose: useKScanDuplicateGuard.test.js drives the hook
  // through a positional useState slot table, so inserting a new state above an
  // existing one silently reassigns every slot after it.
  const [commerceStatus, setCommerceStatus] = useState('idle');
  // Build 32: one commerce card per detected multi-item candidate, independent
  // of the single-selection commerceStatus/analysis.purchaseOptions above.
  // Declared last, same reason as commerceStatus — see the note there.
  const [multiItemCommerce, setMultiItemCommerce] = useState([]);
  const [multiItemCommerceStatus, setMultiItemCommerceStatus] = useState('idle');

  const isMountedRef = useRef(true);
  // Synchronous lock — read before state updates propagate, so rapid taps that
  // arrive in the same event loop tick before React re-renders cannot trigger
  // duplicate captures, picker opens, compressions, or API calls.
  const scanInFlightRef = useRef(false);
  // Monotonic operation ID. A completed/timed-out/superseded attempt must not
  // update state, navigate, or replace a newer image.
  const operationIdRef = useRef(0);
  const activeAbortControllerRef = useRef(null);
  const secondhandRequestRef = useRef(0);
  const multiItemSessionRef = useRef(null);
  const initialMultiItemAnalysisRef = useRef(null);
  const retryRequestModeRef = useRef('multi_item_detection');
  const prevIsAnalyzingRef = useRef(false);
  // Session-latched Scanner V2 rollout decision (Phase 2B.2). Resolved once at
  // the start of each Scanner session and read by every stage of it — detection,
  // selection, identification and persistence — so a flag change between
  // capture and selection can never make the two halves of one scan speak
  // different contracts. Defaults to disabled so a session that somehow starts
  // without resolving stays on the legacy path rather than opting itself in.
  const scannerV2SessionRef = useRef({ enabled: false });

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

  // Announce the start of analysis exactly once per true in-flight window.
  useEffect(() => {
    if (isAnalyzing && !prevIsAnalyzingRef.current) {
      AccessibilityInfo.announceForAccessibility('Scan analysis in progress');
    }
    prevIsAnalyzingRef.current = isAnalyzing;
  }, [isAnalyzing]);

  // v127 commerce hydration guards. Declared here so startInFlight can reset
  // them; the hydration logic that consumes them lives further down.
  const commerceGenerationRef = useRef(0);
  const commerceRequestedRef = useRef(null);
  const commerceAbortRef = useRef(null);
  // Build 32 multi-item commerce guards — independent generation/abort so a
  // superseded detection's late offers can never overwrite a newer scan.
  const multiItemCommerceGenerationRef = useRef(0);
  const multiItemCommerceRequestedRef = useRef(null);
  const multiItemCommerceAbortRef = useRef(null);

  const clearInFlight = useCallback((operationId) => {
    // Only the current attempt may clear the guard it created. Incrementing the
    // operation ID here also prevents a late background completion from this
    // attempt from overwriting newer state.
    if (operationId !== operationIdRef.current) return;
    operationIdRef.current += 1;
    scanInFlightRef.current = false;
    activeAbortControllerRef.current = null;
    if (isMountedRef.current) {
      setIsAnalyzing(false);
    }
  }, []);

  const startInFlight = useCallback(() => {
    if (scanInFlightRef.current) return null;
    // v127: a new scan attempt supersedes commerce still in flight for the
    // previous result. Bumping here (rather than at setStatus('result')) means
    // a late answer for the old scan is already inert before the new one
    // finishes, which is what makes the A-then-B overwrite case impossible.
    commerceGenerationRef.current += 1;
    commerceRequestedRef.current = null;
    commerceAbortRef.current?.abort();
    commerceAbortRef.current = null;
    if (isMountedRef.current) setCommerceStatus('idle');
    multiItemCommerceGenerationRef.current += 1;
    multiItemCommerceRequestedRef.current = null;
    multiItemCommerceAbortRef.current?.abort();
    multiItemCommerceAbortRef.current = null;
    if (isMountedRef.current) {
      setMultiItemCommerce([]);
      setMultiItemCommerceStatus('idle');
    }
    scanInFlightRef.current = true;
    const operationId = ++operationIdRef.current;
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
    isMountedRef.current && operationId === operationIdRef.current
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
          const session = createScanSession(result.uri);
          multiItemSessionRef.current = session;
          initialMultiItemAnalysisRef.current = null;
          retryRequestModeRef.current = 'multi_item_detection';
          setSelectedCandidateId(null);
          setPhoto({ ...result, source: 'camera', scanSessionId: session.scanSessionId });
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

  const selectGalleryPhoto = useCallback(
    async () => {
      if (scanInFlightRef.current) {
        logAnalyzeDiag({
          event: 'scan_duplicate_blocked',
          source: 'selectGalleryPhoto',
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
          allowsMultipleSelection: false,
        });

        if (isOperationValid(operationId)) {
          if (result?.canceled) return;
          const asset = result?.assets?.[0];
          if (!asset?.uri || (asset.type && asset.type !== 'image')) {
            throw new Error('INVALID_IMAGE_SELECTION');
          }
          const uri = asset.uri;
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
        }
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error('Gallery selection failed:', err);
        }
        if (isOperationValid(operationId)) {
          setError('Uploaded image could not be loaded.');
          setStatus('error');
        }
      } finally {
        clearInFlight(operationId);
      }
    },
    [status, startInFlight, clearInFlight, isOperationValid]
  );

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

      const operationId = startInFlight();
      if (operationId === null) return;

      // Resolve the Scanner V2 rollout flag ONCE for this session and latch it.
      // Detection, selection, identification and persistence all read this same
      // value, so a flag change between capture and selection can never make
      // the two halves of one scan speak different contracts.
      scannerV2SessionRef.current = beginScannerV2Session();

      logAnalyzeDiag({
        event: 'scan_analyze_accepted',
        source: 'runAnalysis',
        status,
        operationId,
      });
      setStatus('processing');
      setError(null);
      setAnalysis(null);
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
        // Phase 3 provider cleanup: the Vinted/Apify backend has no configured
        // credentials (APIFY_VINTED_ACTOR_ID / APIFY_API_TOKEN are unset in both
        // App Staging and Production), so this call was firing on every scan and
        // always resolving to SECONDHAND_RESULTS_UNAVAILABLE — a dead network
        // round trip on every single scan for zero result. Disabled until Apify
        // is actually configured; restore the call below when it is.
        const secondhandRequest = null; // was: isConfirmationResult ? null : buildSecondhandSearchRequest(data);
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
        if (!isConfirmationResult && shouldEnrichSneakers(sneakerInput)) {
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
      let sanitized;
      let usedScanIdentify = false;
      let attemptTimeoutId = null;

      const executeScanAttempt = async () => {
        processingStart = Date.now();

        // Session management: reuse the prepared image across retries for the
        // same source URI (avoids re-compressing and re-sanitizing).
        let session = multiItemSessionRef.current;
        if (!session || session.sourceImageUri !== photo.uri) {
          session = createScanSession(photo.uri);
          multiItemSessionRef.current = session;
        }
        if (!session.sourceUriHash) {
          session.sourceUriHash = await digestPrefix(photo.uri);
        }

        if (__DEV__) console.log('[DEBUG] BEFORE_COMPRESS');
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
        const sanitizerStatus = getPrivacySanitizerStatus();
        session.localPrivacyFiltered =
          sanitizerStatus.faceBlurApplied === true &&
          sanitizerStatus.plateMaskApplied === true;
        if (__DEV__) {
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

        const evidenceSource = photo.source === 'upload' ? 'gallery' : 'camera';
        // ONE evidence object per HTTP request. iOS Scanner is single-image, so
        // this is the session's one piece of evidence, reused verbatim through
        // selection without any re-preparation.
        const evidence = prepareScannerEvidence({
          preparedImage: sanitized,
          source: evidenceSource,
          evidenceId: session.evidenceId,
        });
        if (!evidence) {
          throw userSafeError(
            'prepared evidence unavailable',
            'The selected outfit image could not be prepared. Please choose it again.',
          );
        }
        session.evidenceId = evidence.evidenceId;

        const outcome = await runScannerIdentification({
          mode: 'detect_items',
          evidence,
          platform: 'ios',
          requestId: createEvidenceId(),
          sessionFlag: scannerV2SessionRef.current,
          legacyCorrelation: {
            scanSessionId: session.scanSessionId,
            imageDigestPrefix: session.imageDigestPrefix,
          },
          localPrivacyFiltered: session.localPrivacyFiltered,
          signal: activeAbortControllerRef.current?.signal,
        });
        // A malformed V2 payload is a real backend failure, never a reason to
        // silently retry on the legacy contract.
        if (outcome.v2ValidationFailure || outcome.rejection) {
          throw userSafeError(
            'scanner v2 contract failure',
            'We couldn’t complete the scan. Please try again.',
          );
        }
        const identifyResponse = outcome.response;
        session.v2Candidates = outcome.candidates;
        session.evidenceSource = evidenceSource;

        // Throws a user-safe error on 'failed' → handled by the catch below.
        const data = mapScanIdentifyToAnalysis(identifyResponse, {
          identificationV2: outcome.identificationV2,
          source: evidenceSource,
        });
        if (Array.isArray(data.confirmationCandidates) && data.confirmationCandidates.length > 0) {
          initialMultiItemAnalysisRef.current = data;
          setSelectedCandidateId(data.confirmationCandidates[0].id);
        }
        retryRequestModeRef.current = 'multi_item_detection';
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
    [status, photo, startInFlight, clearInFlight, isOperationValid]
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
    if (scanInFlightRef.current) return;

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

    const operationId = startInFlight();
    if (operationId === null) return;

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

      const evidenceSource = session.evidenceSource
        ?? (photo.source === 'upload' ? 'gallery' : 'camera');
      // The SAME prepared derivative and the SAME evidence id detection used.
      // Nothing is recompressed, re-oriented or re-prepared, and no new
      // evidence id is minted for an unchanged image.
      const evidence = prepareScannerEvidence({
        preparedImage: session.preparedImageUri,
        source: evidenceSource,
        evidenceId: session.evidenceId,
      });
      if (!evidence) {
        throw userSafeError(
          'prepared evidence unavailable',
          'The original outfit image is no longer available. Please start a new scan.',
        );
      }

      // Prefer the server's own V2 candidate record for this candidateId. The
      // detection digest comes ONLY from it — never computed here, never copied
      // from another evidence id, never substituted with the session id.
      const v2Candidate = Array.isArray(session.v2Candidates)
        ? session.v2Candidates.find(
          (entry) => entry.candidateId === candidate.id
            && entry.evidenceId === evidence.evidenceId,
        )
        : undefined;

      const outcome = await runScannerIdentification({
        mode: 'identify_selected_item',
        evidence,
        platform: 'ios',
        requestId: createEvidenceId(),
        sessionFlag: scannerV2SessionRef.current,
        selectedCandidate: {
          evidenceId: evidence.evidenceId,
          candidateId: candidate.id,
          // Category comes FROM detection and is carried through unchanged.
          category: v2Candidate?.category ?? candidate.category,
          ...(v2Candidate?.subtype ?? candidate.subtype
            ? { subtype: v2Candidate?.subtype ?? candidate.subtype }
            : {}),
          ...(v2Candidate?.bounds ?? candidate.bounds
            ? { bounds: v2Candidate?.bounds ?? candidate.bounds }
            : {}),
          ...(v2Candidate?.detectionDigest
            ? { detectionDigest: v2Candidate.detectionDigest }
            : {}),
        },
        legacyCorrelation: {
          scanSessionId: session.scanSessionId,
          imageDigestPrefix: session.imageDigestPrefix,
        },
        localPrivacyFiltered: session.localPrivacyFiltered,
        signal: activeAbortControllerRef.current?.signal,
      });
      if (outcome.v2ValidationFailure || outcome.rejection) {
        throw userSafeError(
          'scanner v2 contract failure',
          'We couldn’t analyze the selected garment. Please try again.',
        );
      }
      const identifyResponse = outcome.response;
      const data = mapScanIdentifyToAnalysis(identifyResponse, {
        identificationV2: outcome.identificationV2,
        source: evidenceSource,
      });
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
      if (!isOperationValid(operationId)) return;

      successPulse();
      setAnalysis(data);
      setNonFashionMessage(null);
      setStatus('result');
    } catch (err) {
      if (!isOperationValid(operationId)) return;
      errorPulse();
      setAnalysis(initialAnalysis);
      setError(
        err?.userMessage ||
        'We couldn\u2019t analyze the selected garment. Please try again.',
      );
      setStatus('error');
    } finally {
      clearInFlight(operationId);
    }
  }, [photo, selectedCandidateId, startInFlight, clearInFlight, isOperationValid]);

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

  // ── v127 deferred commerce hydration ──────────────────────────────────────
  //
  // When the backend defers commerce, the scan result is already on screen and
  // the shelf hydrates afterwards. Three separate guards are needed and none
  // substitutes for the others:
  //
  //   commerceGenerationRef  — which scan result the response belongs to, so a
  //                            slow scan A cannot overwrite a newer scan B.
  //   commerceRequestedRef   — single-flight, so a rerender cannot dispatch a
  //                            second request for the same result.
  //   isMountedRef           — no state write after unmount.
  //
  // The scan's own operationId cannot be reused: clearInFlight() increments it
  // when the scan completes, so it is already stale by the time commerce runs.
  const hydrateDeferredCommerce = useCallback(async (analysisWithEvidence, { isRetry = false } = {}) => {
    const evidence = analysisWithEvidence?.commerceEvidence;
    if (!evidence?.identification) return;

    const generation = commerceGenerationRef.current;
    const flightKey = `${generation}`;
    // Single-flight per scan result. A retry is an explicit user action and is
    // allowed to supersede a settled attempt, never to race a live one.
    if (!isRetry && commerceRequestedRef.current === flightKey) return;
    if (isRetry && commerceRequestedRef.current === `${flightKey}:active`) return;
    commerceRequestedRef.current = `${flightKey}:active`;

    commerceAbortRef.current?.abort();
    const controller = new AbortController();
    commerceAbortRef.current = controller;

    // The scan result is already visible; only the shelf enters a pending state.
    if (isMountedRef.current && commerceGenerationRef.current === generation) {
      setCommerceStatus('pending');
    }

    const applyIfCurrent = (updater) => {
      // Stale-response protection: a late answer for a superseded scan is
      // dropped rather than rendered over the current one.
      if (!isMountedRef.current) return false;
      if (commerceGenerationRef.current !== generation) return false;
      updater();
      return true;
    };

    let result;
    try {
      result = await fetchDeferredCommerce(evidence, { signal: controller.signal });
    } catch {
      // fetchDeferredCommerce never throws, but a caller must not depend on it.
      result = { status: 'error', purchaseOptions: [], enrichmentCandidates: [], retryable: true };
    }

    commerceRequestedRef.current = flightKey;

    if (result.status === 'error') {
      // Commerce failure is never scan failure: status stays 'result'.
      applyIfCurrent(() => setCommerceStatus(result.retryable === false ? 'idle' : 'error'));
      return;
    }

    const hydrated = applyIfCurrent(() => {
      setCommerceStatus(result.status);
      if (result.purchaseOptions.length > 0) {
        setAnalysis((prev) => (prev ? { ...prev, purchaseOptions: result.purchaseOptions } : prev));
      }
    });
    if (!hydrated) return;

    // Bounded enrichment, after first paint. The backend serves the repeat
    // discovery from its own cache, so this hop costs the enrichment call only.
    if (result.purchaseOptions.length > 0 && result.enrichmentCandidates.length > 0) {
      let enrichedResult;
      try {
        enrichedResult = await fetchDeferredCommerce(evidence, {
          enrich: true,
          signal: controller.signal,
        });
      } catch {
        return;
      }
      if (enrichedResult.status === 'error' || !enrichedResult.purchaseOptions.length) return;
      applyIfCurrent(() => {
        setAnalysis((prev) => {
          if (!prev) return prev;
          const merged = mergeEnrichedOffers(
            Array.isArray(prev.purchaseOptions) ? prev.purchaseOptions : [],
            enrichedResult.purchaseOptions,
          );
          return { ...prev, purchaseOptions: merged };
        });
      });
    }
  }, []);

  // Dispatch hydration once per deferred scan result.
  useEffect(() => {
    if (status !== 'result') return;
    if (!analysis?.commerceDeferred) return;
    hydrateDeferredCommerce(analysis);
  }, [status, analysis?.commerceDeferred, analysis?.commerceEvidence, hydrateDeferredCommerce]);

  // Abort any in-flight hydration when the hook unmounts.
  useEffect(() => () => {
    commerceAbortRef.current?.abort();
    commerceAbortRef.current = null;
  }, []);

  /** Explicit user retry. Issues MODE B only — never re-runs Gemini. */
  const retryCommerce = useCallback(() => {
    if (!analysis?.commerceDeferred) return;
    hydrateDeferredCommerce(analysis, { isRetry: true });
  }, [analysis, hydrateDeferredCommerce]);

  // ── Build 32 multi-item commerce hydration ────────────────────────────────
  //
  // One MODE B request per eligible detected candidate, dispatched in
  // parallel. No new Gemini call: every candidate already carries its own
  // identification/attributes from the multi-item detection response.
  // Independent of the single-selection hydrateDeferredCommerce above — a
  // scan can show multi-item cards without the user ever picking one.
  const hydrateMultiItemCommerce = useCallback(async (candidates, { isRetry = false } = {}) => {
    if (!Array.isArray(candidates) || candidates.length === 0) return;

    const generation = multiItemCommerceGenerationRef.current;
    const flightKey = `${generation}`;
    if (!isRetry && multiItemCommerceRequestedRef.current === flightKey) return;
    if (isRetry && multiItemCommerceRequestedRef.current === `${flightKey}:active`) return;
    multiItemCommerceRequestedRef.current = `${flightKey}:active`;

    multiItemCommerceAbortRef.current?.abort();
    const controller = new AbortController();
    multiItemCommerceAbortRef.current = controller;

    if (isMountedRef.current && multiItemCommerceGenerationRef.current === generation) {
      setMultiItemCommerceStatus('pending');
    }

    let cardsByCandidate;
    try {
      cardsByCandidate = await fetchMultiItemCommerce(candidates, { signal: controller.signal });
    } catch {
      cardsByCandidate = new Map();
    }

    multiItemCommerceRequestedRef.current = flightKey;

    // Stale-response protection: a late answer for a superseded scan is
    // dropped rather than rendered over the current one.
    if (!isMountedRef.current || multiItemCommerceGenerationRef.current !== generation) return;
    setMultiItemCommerce(Array.from(cardsByCandidate.values()));
    setMultiItemCommerceStatus('ready');
  }, []);

  // Dispatch once per detection result that has candidates to shop.
  //
  // Gated on commerceDeferred for the same reason the single-item dispatch
  // above is: that marker is set only when the backend reports
  // `commerce.deferred === true`, which only the v127 funnel branch does. With
  // the funnel disabled the MODE B route does not exist server-side, so every
  // per-item request would fall through to the image path, return
  // 'no image provided', and render a "no strong match" state for a search
  // that never ran — N wasted invocations and a false statement to the user.
  useEffect(() => {
    if (status !== 'result') return;
    if (!analysis?.commerceDeferred) return;
    const candidates = analysis?.confirmationCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    hydrateMultiItemCommerce(candidates);
  }, [status, analysis?.commerceDeferred, analysis?.confirmationCandidates, hydrateMultiItemCommerce]);

  // Abort any in-flight multi-item hydration when the hook unmounts.
  useEffect(() => () => {
    multiItemCommerceAbortRef.current?.abort();
    multiItemCommerceAbortRef.current = null;
  }, []);

  /** Explicit user retry for the whole multi-item shelf. MODE B only. */
  const retryMultiItemCommerce = useCallback(() => {
    // Same v127 authority gate as the dispatch effect and as retryCommerce.
    if (!analysis?.commerceDeferred) return;
    const candidates = analysis?.confirmationCandidates;
    if (!Array.isArray(candidates) || candidates.length === 0) return;
    hydrateMultiItemCommerce(candidates, { isRetry: true });
  }, [analysis, hydrateMultiItemCommerce]);

  return {
    status,
    photo,
    analysis,
    commerceStatus,
    multiItemCommerce,
    multiItemCommerceStatus,
    error,
    nonFashionMessage,
    selectedCandidateId,
    isAnalyzing,
    capturePhoto,
    runAnalysis,
    retake,
    dismissResult,
    retry,
    selectConfirmationCandidate,
    analyzeSelectedCandidate,
    retryCommerce,
    retryMultiItemCommerce,
    selectStaticFixture,
    uploadPhoto,
    selectGalleryPhoto,
  };
}
