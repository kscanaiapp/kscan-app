import { useState, useCallback, useRef, useEffect } from 'react';
import { analyzeImage } from '../services/api';
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
  const isMounted = useRef(true);
  // Synchronous locks — read before state updates propagate, so rapid taps that
  // arrive in the same event loop tick before React re-renders cannot trigger
  // duplicate captures or duplicate API calls.
  const captureInProgressRef = useRef(false);
  const analysisInProgressRef = useRef(false);
  const secondhandRequestRef = useRef(0);

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
      if (!cameraRef?.current) return;

      captureInProgressRef.current = true;
      setStatus('capturing');
      softImpact();

      try {
        const result = await cameraRef.current.takePictureAsync({
          quality: 0.7,
        });
        setPhoto(result);
        setError(null);
        setStatus('preview');
      } catch (err) {
        if (typeof __DEV__ !== 'undefined' && __DEV__) {
          console.error('Capture failed:', err);
        }
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
      if (!photo?.uri) {
        logAnalyzeDiag({
          event: 'analyze_trigger_rejected',
          source: 'runAnalysis',
          reason: 'missing_photo_uri',
          status,
        });
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

      if (__DEV__) console.log('[DEBUG] SET_PROCESSING');

      // Yield one frame so React renders the processing UI (PerceptionLayer)
      // before the JS thread is occupied by compression work.
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_START');
      await new Promise(resolve => requestAnimationFrame(resolve));
      if (__DEV__) console.log('[DEBUG] PROCESSING_RENDER_WAIT_DONE');

      try {
        const processingStart = Date.now();

        if (__DEV__) console.log('[DEBUG] BEFORE_COMPRESS uri=' + photo.uri.slice(0, 80));
        if (__DEV__ && photo.qaFixtureName) {
          console.log('[K-SCAN QA] Fixture selected: ' + photo.qaFixtureName);
          console.log('[K-SCAN QA] Using compressImage utility: true');
          console.log('[K-SCAN QA] Sending fixture through /api/analyze');
        }
        const compressed = await compressForUpload(photo.uri);
        if (__DEV__) console.log('[DEBUG] AFTER_COMPRESS duration=' + (Date.now() - processingStart) + 'ms payloadLen=' + (compressed?.length ?? 0));

        const sanitized = await sanitizeImageBeforeUpload(compressed);
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
        const data = await analyzeImage(sanitized);
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

        const secondhandRequest = buildSecondhandSearchRequest(data);
        if (secondhandRequest) {
          searchVintedSecondhand(secondhandRequest).then((secondhand) => {
            if (!isMounted.current || secondhandRequestRef.current !== secondhandRequestId) return;
            if (!secondhand?.enabled || !Array.isArray(secondhand.items) || secondhand.items.length === 0) return;
            setAnalysis((current) => {
              if (!current || current.type === 'non-fashion') return current;
              return { ...current, secondhand };
            });
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
          searchSneakers(sneakerInput).then((sneakerReference) => {
            if (!isMounted.current || secondhandRequestRef.current !== secondhandRequestId) return;
            if (!sneakerReference || sneakerReference.length === 0) return;
            setAnalysis((current) => {
              if (!current || current.type === 'non-fashion') return current;
              return { ...current, sneakerReference };
            });
          });
        }
      } catch (err) {
        if (__DEV__) console.error('[DEBUG] ANALYZE_ERROR', err?.message);
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
      setPhoto({ uri, qaFixtureName: fixtureName });
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
      if (status !== 'idle') {
        warnInvalidTransition(status, 'capturing');
        return;
      }

      if (!uri || typeof uri !== 'string') {
        setError('Uploaded image could not be loaded.');
        setStatus('error');
        return;
      }

      setPhoto({ uri });
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
    secondhandRequestRef.current += 1;
    setStatus('idle');
  }, [status]);

  const retry = useCallback(() => {
    if (status !== 'error') {
      warnInvalidTransition(status, 'preview');
      return;
    }

    if (photo) {
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
  }, [status, photo]);

  return {
    status,
    photo,
    analysis,
    error,
    nonFashionMessage,
    capturePhoto,
    runAnalysis,
    retake,
    dismissResult,
    retry,
    selectStaticFixture,
    uploadPhoto,
  };
}
