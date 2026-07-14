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

export async function playStylistAudio(
  uri: string,
  callbacks: StylistAudioPlaybackCallbacks,
  startTimeoutMs = STYLIST_AUDIO_START_TIMEOUT_MS,
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

  const dispose = () => {
    if (disposed) return;
    disposed = true;
    if (startTimeout) {
      clearTimeout(startTimeout);
      startTimeout = null;
    }
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
      if (status.playing) {
        if (!started) {
          started = true;
          if (startTimeout) {
            clearTimeout(startTimeout);
            startTimeout = null;
          }
          callbacks.onPlaybackStarted();
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
