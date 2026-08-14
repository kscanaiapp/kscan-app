import { useCallback } from 'react';

import { useAuthSession } from '../contexts/AuthSessionContext';
import { getStylistVoiceProfile } from '../constants/stylistIdentity';
import { speakAvatarCue } from '../services/avatarSpeech';
import type { EliseSpeechMoment } from '../services/style-chat/eliseSpeechMoments';
import { useScreenReaderEnabled, useScreenReaderReady } from './useScreenReaderEnabled';
import { useStylistIdentity } from './useStylistIdentity';
import { useVoiceResponsesPreference } from './useVoiceResponsesPreference';

/**
 * One gate for every deterministic speech moment.
 *
 * The eligibility rules are the same ones `useStyleChat` applies to spoken
 * responses, and they are centralized here rather than repeated at five call
 * sites for the obvious reason: a voice-off user who still hears a cue because
 * one screen forgot a condition is a privacy-shaped bug, not a cosmetic one.
 *
 * Deliberately fire-and-forget. Callers invoke this AFTER the product action has
 * already succeeded and never await it, so a provider failure cannot roll back a
 * Closet save or a Dressing Room handoff. Speech is enhancement; §15.
 */
export type SpeakEliseCue = (
  moment: EliseSpeechMoment,
  occurrenceId: string | null | undefined,
  sessionId?: string | null,
) => void;

export function useEliseSpeechCue(): SpeakEliseCue {
  const { user } = useAuthSession();
  const { identity } = useStylistIdentity();
  const voicePreference = useVoiceResponsesPreference();
  const screenReaderEnabled = useScreenReaderEnabled();
  const screenReaderReady = useScreenReaderReady();

  const actorId = user?.id ?? null;
  const avatarId = identity.avatarId;

  return useCallback<SpeakEliseCue>((moment, occurrenceId, sessionId) => {
    if (!actorId || !avatarId || !occurrenceId) return;
    // A silent stylist has no configured voice. The server refuses this too, so
    // checking here only avoids a request that is guaranteed to be rejected.
    if (getStylistVoiceProfile(avatarId) === 'silent') return;
    if (!voicePreference.enabled || voicePreference.loading) return;
    // Screen-reader users get the visible equivalent and their own announcements;
    // Elise talking over VoiceOver/TalkBack is worse than Elise staying quiet.
    if (!screenReaderReady || screenReaderEnabled) return;

    void speakAvatarCue({
      actorId,
      cue: moment,
      occurrenceId,
      stylistId: avatarId,
      avatarId,
      sessionId: sessionId ?? null,
    });
  }, [
    actorId,
    avatarId,
    voicePreference.enabled,
    voicePreference.loading,
    screenReaderEnabled,
    screenReaderReady,
  ]);
}
