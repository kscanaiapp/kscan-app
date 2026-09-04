/**
 * The Live VTO surface.
 *
 * WHAT IT RENDERS TODAY. High-level session state and the four controls the
 * current contract actually supports: close, switch product, Photoreal, and
 * capture preview. There is no styling shelf, no closet, no outfit builder and
 * no video control -- those belong to a later phase and speculative chrome for
 * them would be a promise this lane has no runtime to keep.
 *
 * NO CAMERA VIEW IS MOUNTED HERE. The native runtime owns camera acquisition,
 * inference and rendering behind its own view; this component speaks only the
 * high-level command/event contract. That is why nothing in this file imports
 * a camera, and why there is no frame, mask, landmark or pose value anywhere
 * in it to render. Until the native view exists, the panel shows the session's
 * state honestly rather than faking a viewfinder.
 *
 * ERRORS ARE BOUNDED. Every message shown comes from the K Scan copy table in
 * types/vtoLive.ts. A provider-native or ML-native string cannot reach this
 * screen: `toLiveVtoRuntimeError` discards native detail before a
 * LiveVtoRuntimeError is ever constructed.
 *
 * A PHOTOREAL FAILURE DOES NOT END THE SESSION. The notice below is bounded
 * and dismissible, and the Live controls stay exactly where they were.
 */

import React from 'react';
import { ActivityIndicator, Image, StyleSheet, Text, View } from 'react-native';

import { InlineNotice, PrimaryButton, SecondaryButton, TertiaryButton } from '../luxury';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import {
  LIVE_VTO_PROCESSING_NOTE,
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
  testID?: string;
}

/** One line per session state. Kept in a table rather than a chain of ternaries
 *  so a new state cannot be added without someone writing its copy. */
const STATE_COPY: Readonly<Record<LiveVtoSessionState, string>> = {
  INITIALIZING: 'Starting Live…',
  READY: 'Ready. Step into frame.',
  TRACKING: 'Live',
  TRACKING_WEAK: 'Hold still — finding you.',
  TRACKING_LOST: 'Step back into frame.',
  GARMENT_LOADING: 'Loading this piece…',
  CAPTURE_READY: 'Photo captured.',
  ERROR: 'Live isn’t running.',
};

const BUSY_STATES: ReadonlySet<LiveVtoSessionState> = new Set<LiveVtoSessionState>([
  'INITIALIZING',
  'GARMENT_LOADING',
]);

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
  testID,
}: VtoLivePanelProps) {
  const busy = BUSY_STATES.has(session.state);
  const errored = session.state === 'ERROR';
  // Photoreal and preview are only honest offers while a session is actually
  // tracking someone -- a capture with nothing tracked is not a person frame.
  const canCapture = session.state === 'TRACKING' || session.state === 'CAPTURE_READY';

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
      <View
        style={styles.stage}
        accessible
        accessibilityLiveRegion="polite"
        accessibilityLabel={STATE_COPY[session.state]}
        testID="vto-live-stage"
      >
        {busy ? <ActivityIndicator size="large" color={LUXURY.colors.plum} /> : null}
        <Text style={styles.stageText}>{STATE_COPY[session.state]}</Text>
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

const styles = StyleSheet.create({
  root: {
    marginTop: SPACING.xs,
  },
  stage: {
    minHeight: 180,
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
