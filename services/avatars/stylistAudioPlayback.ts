import {
  createAudioPlayer,
  setAudioModeAsync,
  type AudioPlayer,
  type AudioStatus,
} from 'expo-audio';

export interface StylistAudioPlaybackHandle {
  stop: () => void;
}

export interface StylistAudioPlaybackCallbacks {
  onPlaybackStarted: () => void;
  onPlaybackProgress: (seconds: number) => void;
  onPlaybackFinished: () => void;
  onPlaybackError: () => void;
}

export const STYLIST_AUDIO_START_TIMEOUT_MS = 10_000;

/**
 * Playback reads a fully written local file, so a bounded gap with no advancing
 * position is a stall rather than buffering. The watchdog is an independent
 * timer instead of a status-driven check because a native stall (an iOS audio
 * interruption, an Android audio-focus pause) can stop status callbacks
 * altogether, and `playbackState` does not describe the same lifecycle on both
 * platforms.
 */
export const STYLIST_AUDIO_STALL_TIMEOUT_MS = 3_000;

export async function playStylistAudio(
  uri: string,
  callbacks: StylistAudioPlaybackCallbacks,
  startTimeoutMs = STYLIST_AUDIO_START_TIMEOUT_MS,
  stallTimeoutMs = STYLIST_AUDIO_STALL_TIMEOUT_MS,
): Promise<StylistAudioPlaybackHandle> {
  await setAudioModeAsync({
    playsInSilentMode: true,
    interruptionMode: 'duckOthers',
    allowsRecording: false,
    shouldPlayInBackground: false,
    shouldRouteThroughEarpiece: false,
    allowsBackgroundRecording: false,
  });

  let player: AudioPlayer | null = null;
  let subscription: { remove: () => void } | null = null;
  let disposed = false;
  let started = false;
  let startTimeout: ReturnType<typeof setTimeout> | null = null;
  let stallTimeout: ReturnType<typeof setTimeout> | null = null;
  let lastProgressSeconds = -1;

  const clearStallTimeout = () => {
    if (stallTimeout) {
      clearTimeout(stallTimeout);
      stallTimeout = null;
    }
  };

  // Re-armed only by meaningful progress. Every timer, flag, and callback here
  // belongs to this invocation's closure, so a superseded player's watchdog can
  // never terminate a newer generation's playback.
  const armStallTimeout = () => {
    clearStallTimeout();
    stallTimeout = setTimeout(() => {
      stallTimeout = null;
      if (disposed || !started) return;
      dispose();
      callbacks.onPlaybackError();
    }, Math.max(1, stallTimeoutMs));
  };

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
    clearStallTimeout();
    subscription?.remove();
    subscription = null;
    try {
      player?.pause();
    } catch {
      // The native player may already be torn down after an interruption.
    }
    try {
      player?.remove();
    } catch {
      // Native release is best-effort and must not block StyleChat.
    }
    player = null;
  };

  try {
    player = createAudioPlayer({ uri }, {
      updateInterval: 80,
      keepAudioSessionActive: false,
    });
    subscription = player.addListener('playbackStatusUpdate', (status: AudioStatus) => {
      if (disposed) return;
      const terminalPlaybackFailure =
        status.playbackState === 'failed' ||
        (started && status.playbackState === 'idle' && !status.didJustFinish);
      if (terminalPlaybackFailure) {
        dispose();
        callbacks.onPlaybackError();
        return;
      }
      if (status.playing) {
        if (!started) {
          started = true;
          if (startTimeout) {
            clearTimeout(startTimeout);
            startTimeout = null;
          }
          lastProgressSeconds = status.currentTime;
          armStallTimeout();
          callbacks.onPlaybackStarted();
        } else if (status.currentTime > lastProgressSeconds) {
          // Only an advancing position counts as progress. A native player that
          // keeps reporting `playing` at a frozen position is stalled, so the
          // watchdog must not be re-armed by the status event alone.
          lastProgressSeconds = status.currentTime;
          armStallTimeout();
        }
        callbacks.onPlaybackProgress(status.currentTime);
      }
      if (status.didJustFinish) {
        dispose();
        callbacks.onPlaybackFinished();
      }
    });
    player.play();
    startTimeout = setTimeout(() => {
      if (disposed || started) return;
      dispose();
      callbacks.onPlaybackError();
    }, Math.max(1, startTimeoutMs));
  } catch {
    dispose();
    callbacks.onPlaybackError();
    throw new Error('Speech playback could not start.');
  }

  return { stop: dispose };
}
