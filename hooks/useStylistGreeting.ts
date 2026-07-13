import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { getStylistSpeechConfig } from '../constants/stylistIdentity';
import { useStylistIdentity } from './useStylistIdentity';
import { resolveUserFirstName } from '../services/userFirstName';
import { buildStylistGreeting } from '../services/stylistGreeting';
import {
  speakAvatarText,
  stopAvatarSpeechPlayback,
} from '../services/avatarSpeech';
import { useAvatarSpeechState } from '../stores/avatarSpeechStore';
import { useScreenReaderEnabled } from './useScreenReaderEnabled';

const greetedActors = new Set<string>();
const dismissedActors = new Set<string>();

export interface UseStylistGreetingOptions {
  enabled?: boolean;
}

export interface UseStylistGreetingResult {
  greetingText: string;
  isSpeaking: boolean;
  canSpeak: boolean;
  dismiss: () => void;
  replay: () => void;
  stop: () => void;
}

/**
 * Hook that manages the once-per-process stylist greeting.
 *
 * - Auto-speak only once per authenticated actor per app process.
 * - Suppressed when a screen reader is active.
 * - Dismiss suppresses autoplay for the remainder of the process.
 * - Not re-triggered by rerender, remount, or navigation alone.
 * - Stops playback when the component unmounts or the actor changes.
 */
export function useStylistGreeting(
  options: UseStylistGreetingOptions = {},
): UseStylistGreetingResult {
  const { enabled = true } = options;
  const { identity } = useStylistIdentity();
  const { user } = useAuthSession();
  const screenReaderEnabled = useScreenReaderEnabled();
  const speechState = useAvatarSpeechState();
  const attemptedRef = useRef(false);

  const actorKey = user?.id ?? 'guest';
  const firstName = useMemo(
    () => resolveUserFirstName(user).firstName,
    [user],
  );
  const greeting = useMemo(
    () =>
      buildStylistGreeting({
        userFirstName: firstName,
        stylistName: identity.displayName,
      }),
    [firstName, identity.displayName],
  );

  const speechConfig = useMemo(
    () => getStylistSpeechConfig(identity.avatarId),
    [identity.avatarId],
  );

  const canSpeak =
    enabled &&
    !!speechConfig &&
    speechConfig.speechEnabled === true &&
    speechConfig.voiceProfile != null &&
    !screenReaderEnabled;

  const speakGreeting = useCallback(() => {
    if (!canSpeak || !speechConfig?.voiceProfile) return;
    if (dismissedActors.has(actorKey)) return;

    void speakAvatarText({
      text: greeting.text,
      actorKey,
      avatarId: identity.avatarId,
      utteranceKey: `greeting:${actorKey}:${Date.now()}`,
      source: 'greeting',
      voiceProfile: speechConfig.voiceProfile,
    });
  }, [actorKey, canSpeak, greeting.text, identity.avatarId, speechConfig]);

  useEffect(() => {
    if (!enabled) return;
    if (attemptedRef.current) return;
    if (greetedActors.has(actorKey)) return;
    if (dismissedActors.has(actorKey)) return;
    if (screenReaderEnabled) return;

    attemptedRef.current = true;
    greetedActors.add(actorKey);

    if (canSpeak) {
      const timer = setTimeout(() => {
        speakGreeting();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [actorKey, canSpeak, enabled, screenReaderEnabled, speakGreeting]);

  // Stop speech on unmount or actor change.
  useEffect(() => {
    return () => {
      if (speechState.actorKey === actorKey) {
        void stopAvatarSpeechPlayback();
      }
    };
  }, [actorKey, speechState.actorKey]);

  const dismiss = useCallback(() => {
    dismissedActors.add(actorKey);
    void stopAvatarSpeechPlayback();
  }, [actorKey]);

  const stop = useCallback(() => {
    void stopAvatarSpeechPlayback();
  }, []);

  const replay = useCallback(() => {
    if (!canSpeak || !speechConfig?.voiceProfile) return;
    void speakAvatarText({
      text: greeting.text,
      actorKey,
      avatarId: identity.avatarId,
      utteranceKey: `greeting:${actorKey}:replay:${Date.now()}`,
      source: 'greeting',
      voiceProfile: speechConfig.voiceProfile,
    });
  }, [actorKey, canSpeak, greeting.text, identity.avatarId, speechConfig]);

  const isSpeaking =
    speechState.actorKey === actorKey &&
    (speechState.status === 'starting' ||
      speechState.status === 'speaking' ||
      speechState.status === 'stopping');

  return {
    greetingText: greeting.text,
    isSpeaking,
    canSpeak,
    dismiss,
    replay,
    stop,
  };
}

/**
 * Clear the greeting guard for a specific actor. Intended for sign-out flows.
 */
export function clearStylistGreetingClaim(actorKey: string): void {
  greetedActors.delete(actorKey);
  dismissedActors.delete(actorKey);
}
