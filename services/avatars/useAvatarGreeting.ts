import { useCallback, useEffect, useRef } from 'react';
import { AccessibilityInfo } from 'react-native';
import { useAuthSession } from '../../contexts/AuthSessionContext';
import { resolveGreeting } from './greeting';
import { getAvatarEntry } from './registry';
import { speakUtterance, stopSpeech } from './avatarSpeech';
import { useAvatarSpeechState } from './avatarSpeechStore';
import { useScreenReaderEnabled } from '../../hooks/useScreenReaderEnabled';
import { useReducedMotion } from '../../hooks/useReducedMotion';

const greetedActors = new Set<string>();
const dismissedActors = new Set<string>();

export interface UseAvatarGreetingOptions {
  actorKey: string;
  avatarId?: string;
  enabled?: boolean;
}

export interface UseAvatarGreetingResult {
  greetingText: string;
  isSpeaking: boolean;
  canSpeak: boolean;
  dismiss: () => void;
  replay: () => void;
  stop: () => void;
  userFirstName: string | null;
  nameSource: 'user_metadata' | 'none';
  genericFallback: boolean;
}

function extractFirstName(user: ReturnType<typeof useAuthSession>['user']): string | null {
  const meta = user?.user_metadata as Record<string, string | undefined> | undefined;
  const profileName = (meta?.full_name ?? meta?.name ?? meta?.display_name ?? '').trim() || null;
  return profileName?.split(' ')[0]?.trim() || null;
}

/**
 * Hook that manages the once-per-process greeting for a stylist avatar.
 *
 * - Auto-speak only once per actor per app process.
 * - Suppressed when a screen reader is active.
 * - Suppressed after Dismiss for the remainder of the process.
 * - Not re-triggered by rerender, remount, or navigation alone.
 */
export function useAvatarGreeting(options: UseAvatarGreetingOptions): UseAvatarGreetingResult {
  const { actorKey, avatarId, enabled = true } = options;
  const { user } = useAuthSession();
  const screenReaderEnabled = useScreenReaderEnabled();
  const reducedMotion = useReducedMotion();
  const speechState = useAvatarSpeechState();
  const attemptedRef = useRef(false);

  const entry = getAvatarEntry(avatarId);
  const stylistName = entry?.name ?? 'Elise';
  const firstName = extractFirstName(user);
  const resolved = resolveGreeting({ actorKey, stylistName, userFirstName: firstName });

  const speechEnabled =
    enabled &&
    !!entry &&
    entry.enabled &&
    entry.greetingSpeechEnabled &&
    entry.speech.speechEnabled === true &&
    !!entry.speech.voiceProfile;

  const canSpeak = speechEnabled && !screenReaderEnabled;

  const speakGreeting = useCallback(() => {
    if (!canSpeak || !entry?.speech.voiceProfile) return;
    if (dismissedActors.has(actorKey)) return;

    const utteranceKey = `greeting:${actorKey}:${Date.now()}`;
    void speakUtterance({
      text: resolved.text,
      actorKey,
      avatarId: entry.id,
      utteranceKey,
      source: 'greeting',
      voiceProfile: entry.speech.voiceProfile,
    });
  }, [actorKey, canSpeak, entry, resolved.text]);

  useEffect(() => {
    if (!enabled) return;
    if (attemptedRef.current) return;
    if (greetedActors.has(actorKey)) return;
    if (dismissedActors.has(actorKey)) return;
    if (screenReaderEnabled) return;

    attemptedRef.current = true;
    greetedActors.add(actorKey);

    if (canSpeak) {
      // Small delay so the UI settles before speaking.
      const timer = setTimeout(() => {
        speakGreeting();
      }, 400);
      return () => clearTimeout(timer);
    }
  }, [actorKey, canSpeak, enabled, screenReaderEnabled, speakGreeting]);

  const dismiss = useCallback(() => {
    dismissedActors.add(actorKey);
    void stopSpeech();
  }, [actorKey]);

  const stop = useCallback(() => {
    void stopSpeech();
  }, []);

  const replay = useCallback(() => {
    if (!canSpeak) return;
    void speakUtterance({
      text: resolved.text,
      actorKey,
      avatarId: entry?.id ?? '',
      utteranceKey: `greeting:${actorKey}:replay:${Date.now()}`,
      source: 'greeting',
      voiceProfile: entry?.speech.voiceProfile!,
    });
  }, [actorKey, canSpeak, entry, resolved.text]);

  const isSpeaking =
    speechState.actorKey === actorKey &&
    (speechState.status === 'starting' || speechState.status === 'speaking' || speechState.status === 'stopping');

  return {
    greetingText: resolved.text,
    isSpeaking,
    canSpeak,
    dismiss,
    replay,
    stop,
    userFirstName: resolved.userFirstName,
    nameSource: resolved.nameSource,
    genericFallback: resolved.genericFallback,
  };
}

/**
 * Reset the greeting guard for a specific actor. Intended for sign-out flows.
 */
export function clearGreetingClaim(actorKey: string): void {
  greetedActors.delete(actorKey);
  dismissedActors.delete(actorKey);
}
