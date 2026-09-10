/**
 * The Live VTO surface -- the CUSTOMER's Live experience, not a diagnostic.
 *
 * WHAT CHANGED AND WHY. This panel used to mount no camera at all; its own
 * header said "NO CAMERA VIEW IS MOUNTED HERE ... Until the native view
 * exists, the panel shows the session's state honestly rather than faking a
 * viewfinder", and the only surface that mounted the runtime was
 * `app/dev-n1-diagnostic.tsx`. That was the right posture while the runtime
 * was being built; it is not a shippable product surface, and mission
 * section 35 forbids completion resting on the diagnostic screen for start,
 * tracking feedback, garment switching, capture, Photoreal, retry, fallback
 * or exit. `VtoLiveNativeView` is what moves the camera onto this screen.
 *
 * THE CAPTURE CONTROLS BIND TO ONE AUTHORITY. `session.captureReady`, and
 * nothing else. It is derived in `services/vto/vtoLiveSession.ts` (see
 * `deriveCaptureReady`) from the runtime's own facts, so a control is offered
 * only when a capture would genuinely produce a person frame. The previous
 * rule -- `state === 'TRACKING' || state === 'CAPTURE_READY'` -- could never
 * have worked: no runtime emitted a tracking event, so TRACKING was
 * unreachable and both controls were permanently disabled.
 *
 * TRACKING COPY IS CUSTOMER COPY. Nothing here names MediaPipe, a BodyFrame,
 * a confidence value, a frame rate, a native state id, or a geometry refusal.
 * The guidance enum and the session state are the only inputs, and both are
 * bounded vocabularies from `types/vtoLive.ts`.
 *
 * ANNOUNCEMENTS ARE COALESCED, NEVER PER-FRAME, AND NEVER TAKE FOCUS. See
 * `useAnnouncedStatus` below for why coalescing by VALUE beats a debounce
 * here.
 *
 * ERRORS ARE BOUNDED. Every message comes from the K Scan copy table in
 * types/vtoLive.ts; `toLiveVtoRuntimeError` discards native detail before a
 * LiveVtoRuntimeError is ever constructed. A recoverable failure now offers a
 * real retry rather than only a way out.
 *
 * A PHOTOREAL FAILURE DOES NOT END THE SESSION. The notice is bounded and
 * dismissible, and the Live controls stay exactly where they were.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { AccessibilityInfo, ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { VtoLiveNativeView } from './VtoLiveNativeView';
import { InlineNotice, PrimaryButton, SecondaryButton, TertiaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  LIVE_VTO_PROCESSING_NOTE,
  type LiveVtoGarmentStatus,
  type LiveVtoGuidance,
  type LiveVtoSessionState,
  type PhotorealFailureOutcome,
} from '../../types/vtoLive';
import type { LiveVtoSessionSnapshot } from '../../services/vto/vtoLiveSession';

export interface VtoLivePanelProps {
  session: LiveVtoSessionSnapshot;
  entered: boolean;
  photorealFailure: PhotorealFailureOutcome | null;
  /** The last composited preview the customer captured. LOCAL DISPLAY ONLY --
   *  it can never become a generative input, because the handoff refuses any
   *  frame that is not a PERSON_FRAME. */
  previewUri: string | null;
  /** True while a Photoreal capture is already running. The control is disabled
   *  rather than swallowing the tap: the hook refuses a concurrent request
   *  (VTO-HA-003) and a button that ignores you without saying so is worse than
   *  one that tells you it is busy. */
  photorealPending: boolean;
  onEnter: () => void;
  onClose: () => void;
  onSwitchToAiPhoto: () => void;
  onRequestPhotoreal: () => void;
  onCapturePreview: () => void;
  onDismissPhotorealFailure: () => void;
  /** Restarts a session that failed RECOVERABLY. Offered only then -- see the
   *  `canRetry` note below. */
  onRetry?: () => void;
  testID?: string;
}

/** One line per session state. Kept in a table rather than a chain of ternaries
 *  so a new state cannot be added without someone writing its copy. */
const STATE_COPY: Readonly<Record<LiveVtoSessionState, string>> = {
  INITIALIZING: 'Starting Live…',
  READY: 'Getting ready…',
  TRACKING: 'Ready',
  TRACKING_WEAK: 'Hold still — finding you.',
  TRACKING_LOST: 'Step back into frame.',
  GARMENT_LOADING: 'Loading this piece…',
  CAPTURE_READY: 'Photo captured.',
  ERROR: 'Live isn’t running.',
};

/**
 * The framing hint, when the runtime has one.
 *
 * Shown INSTEAD of the state line while tracking is degraded, not alongside
 * it: two competing instructions on one screen is how a customer ends up
 * following neither. 'none' means the runtime has nothing useful to say and
 * the state line stands on its own.
 */
const GUIDANCE_COPY: Readonly<Record<LiveVtoGuidance, string | null>> = {
  none: null,
  step_back: 'Step back so we can see you.',
  step_closer: 'Come a little closer.',
  center_yourself: 'Turn to face the camera.',
  improve_lighting: 'Try somewhere brighter.',
  hold_still: 'Hold still — finding you.',
};

/** What the garment lifecycle looks like to a customer. Only the states that
 *  say something they can act on get copy; the rest are silent by design. */
const GARMENT_COPY: Readonly<Record<LiveVtoGarmentStatus, string | null>> = {
  IDLE: null,
  SELECTED: 'Switching…',
  LOADING: 'Loading this piece…',
  RENDERED: null,
  FAILED: 'We couldn’t load this piece in Live.',
};

const BUSY_STATES: ReadonlySet<LiveVtoSessionState> = new Set<LiveVtoSessionState>([
  'INITIALIZING',
  'GARMENT_LOADING',
]);

const GARMENT_SPEAKING_STATUSES: ReadonlySet<LiveVtoGarmentStatus> =
  new Set<LiveVtoGarmentStatus>(['SELECTED', 'LOADING', 'FAILED']);

/**
 * THE ONE LINE THE CUSTOMER READS, and the one thing announced.
 *
 * Derived rather than stored so it cannot drift from the session: an error
 * speaks first, the garment lifecycle speaks while a piece is switching,
 * loading or failed (it explains what the screen is doing), guidance speaks
 * while tracking is degraded (it is the actionable half), and the state line
 * is the fallback. Exported because the announcement test asserts on the
 * SAME function the panel renders, not on a re-derived copy of the rule.
 */
export function liveStatusLine(session: LiveVtoSessionSnapshot): string {
  if (session.state === 'ERROR') return session.error?.message ?? STATE_COPY.ERROR;
  if (GARMENT_SPEAKING_STATUSES.has(session.garmentStatus)) {
    const garment = GARMENT_COPY[session.garmentStatus];
    if (garment) return garment;
  }
  if (session.state === 'TRACKING_WEAK' || session.state === 'TRACKING_LOST') {
    const guidance = GUIDANCE_COPY[session.guidance];
    if (guidance) return guidance;
  }
  return STATE_COPY[session.state] ?? STATE_COPY.INITIALIZING;
}

export function VtoLivePanel({
  session,
  entered,
  photorealFailure,
  previewUri,
  photorealPending,
  onEnter,
  onClose,
  onSwitchToAiPhoto,
  onRequestPhotoreal,
  onCapturePreview,
  onDismissPhotorealFailure,
  onRetry,
  testID,
}: VtoLivePanelProps) {
  const busy = BUSY_STATES.has(session.state);
  const errored = session.state === 'ERROR';
  // THE CAPTURE AUTHORITY. Not a state comparison, and not "the camera module
  // exists" -- the single derived answer from services/vto/vtoLiveSession.ts.
  const canCapture = session.captureReady === true;
  const statusLine = useMemo(() => liveStatusLine(session), [session]);

  // A recoverable failure is the only one worth a retry. An unrecoverable one
  // (no module in this build, camera permission switched off at the OS level)
  // would hand the customer a button that cannot work, which is worse than
  // saying so plainly and pointing at AI Photo.
  const canRetry = errored && session.error?.recoverable === true && typeof onRetry === 'function';

  useAnnouncedStatus(entered ? statusLine : null);

  if (!entered) {
    return (
      <View style={styles.root} testID={testID ?? 'vto-live-panel'}>
        <View style={styles.stage}>
          <Text style={styles.stageText}>Live uses your camera to show the piece on you.</Text>
        </View>
        {/* The camera prompt happens on THIS tap and nowhere earlier. */}
        <Text style={styles.privacy}>{LIVE_VTO_PROCESSING_NOTE}</Text>
        <View style={styles.actions}>
          <PrimaryButton title="Start Live" onPress={onEnter} testID="vto-live-enter" />
          <SecondaryButton
            title="Use AI Photo instead"
            onPress={onSwitchToAiPhoto}
            testID="vto-live-use-ai-photo"
          />
        </View>
      </View>
    );
  }

  return (
    <View style={styles.root} testID={testID ?? 'vto-live-panel'}>
      {/* THE VIEWFINDER. Mounted only while the session is entered and has
          not failed -- a dead session must not keep the camera open, and a
          black rectangle under an error message is not an experience. */}
      {errored ? null : (
        <VtoLiveNativeView live style={styles.nativeView} testID="vto-live-native" />
      )}

      <View
        style={styles.stage}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={statusLine}
        testID="vto-live-stage"
      >
        {busy ? <ActivityIndicator size="large" color={LUXURY.colors.plum} /> : null}
        <Text style={styles.stageText}>{statusLine}</Text>
      </View>

      {errored && session.error ? (
        <InlineNotice
          variant="error"
          title="Live isn’t available"
          body={session.error.message}
          accessibilityRole="alert"
          testID="vto-live-error"
          style={styles.notice}
        />
      ) : null}

      {photorealFailure ? (
        // Bounded, and pointedly NOT a teardown: the Live session behind this
        // notice is still running and its controls are still live.
        <InlineNotice
          variant="error"
          title="AI photo didn’t finish"
          body="Live is still running. You can try again."
          accessibilityRole="alert"
          testID="vto-live-photoreal-error"
          style={styles.notice}
        />
      ) : null}

      {previewUri ? (
        // The capture control's visible result. Without this the button would
        // grab a frame and silently discard it, which is not a working control.
        <Image
          source={{ uri: previewUri }}
          style={styles.preview}
          resizeMode="contain"
          accessible
          accessibilityRole="image"
          accessibilityLabel="The preview you captured"
          testID="vto-live-preview"
        />
      ) : null}

      <Text style={styles.privacy}>{LIVE_VTO_PROCESSING_NOTE}</Text>

      <View style={styles.actions}>
        {canRetry ? (
          <PrimaryButton title="Try Live again" onPress={onRetry} testID="vto-live-retry" />
        ) : null}
        <PrimaryButton
          title={photorealPending ? 'Creating AI photo…' : 'Create AI photo'}
          onPress={onRequestPhotoreal}
          disabled={!canCapture || photorealPending}
          testID="vto-live-photoreal"
        />
        <SecondaryButton
          title="Capture preview"
          onPress={onCapturePreview}
          disabled={!canCapture || photorealPending}
          testID="vto-live-capture-preview"
        />
        <SecondaryButton
          title="Use AI Photo instead"
          onPress={onSwitchToAiPhoto}
          testID="vto-live-switch-ai-photo"
        />
        {photorealFailure ? (
          <TertiaryButton
            title="Dismiss"
            onPress={onDismissPhotorealFailure}
            testID="vto-live-dismiss-error"
          />
        ) : null}
        <TertiaryButton title="Close Live" onPress={onClose} testID="vto-live-close" />
      </View>
    </View>
  );
}

/**
 * Announces the status line, once per genuine change.
 *
 * WHY A HOOK AND NOT JUST THE LIVE REGION. `accessibilityLiveRegion` is
 * Android-only; iOS needs an explicit `announceForAccessibility`. Both are
 * driven from the SAME derived line here, so the two platforms say the same
 * words at the same moments.
 *
 * COALESCED BY VALUE, NOT BY TIMER. Tracking events arrive per inference, but
 * `statusLine` changes only when the customer-visible state or guidance does,
 * and the ref comparison drops everything else. Deliberately not a debounce:
 * a debounce would DELAY a real change as well as suppress a repeat, and the
 * change a customer most needs to hear ("Ready") is the one it would delay.
 *
 * FOCUS IS NEVER MOVED. `announceForAccessibility` speaks without taking
 * focus; `setAccessibilityFocus` would yank a screen reader out of whatever
 * control the customer was on, several times per session.
 */
function useAnnouncedStatus(statusLine: string | null): void {
  const [announced, setAnnounced] = useState<string | null>(null);
  const lastRef = useRef<string | null>(null);

  useEffect(() => {
    if (statusLine === null || statusLine === lastRef.current) return;
    lastRef.current = statusLine;
    setAnnounced(statusLine);
  }, [statusLine]);

  useEffect(() => {
    if (announced === null) return;
    try {
      AccessibilityInfo.announceForAccessibility?.(announced);
    } catch {
      // An announcement failing is never worth a crash on a camera surface.
    }
  }, [announced]);
}

const styles = StyleSheet.create({
  root: {
    marginTop: SPACING.xs,
  },
  nativeView: {
    marginBottom: SPACING.sm,
  },
  stage: {
    minHeight: 72,
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.champagne,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.lg,
  },
  stageText: {
    ...LUXURY.typography.body,
    textAlign: 'center',
  },
  privacy: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.2,
    marginTop: SPACING.sm,
  },
  notice: {
    marginTop: SPACING.sm,
  },
  preview: {
    marginTop: SPACING.md,
    width: '100%',
    height: 220,
    borderRadius: RADIUS.md,
    backgroundColor: LUXURY.colors.champagne,
  },
  actions: {
    marginTop: SPACING.md,
    gap: SPACING.sm,
  },
});
