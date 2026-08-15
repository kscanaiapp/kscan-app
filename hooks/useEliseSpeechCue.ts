import { useCallback, useEffect, useRef } from 'react';

import { useAuthSession } from '../contexts/AuthSessionContext';
import { getStylistVoiceProfile } from '../constants/stylistIdentity';
import { speakAvatarCue, stopAvatarSpeechPlayback } from '../services/avatarSpeech';
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

/**
 * DEF-062 — stop this screen's cue when the user leaves it.
 *
 * Cues are fire-and-forget by design, which is right for the request but left
 * playback running: walking out of the Dressing Room mid-sentence meant Elise
 * kept talking over whatever screen came next, with no way to stop her.
 *
 * Scoped to the same actor + avatar the cue was spoken under, so this silences
 * THIS user's stylist and cannot cancel speech that belongs to another scope.
 * The scope is captured in a ref and read at cleanup, so an identity change
 * during teardown cannot make the cleanup target the wrong avatar. Nothing
 * about how speech is produced or stored changes.
 */
export function useStopEliseCueOnLeave(): void {
  const { user } = useAuthSession();
  const { identity } = useStylistIdentity();

  const scopeRef = useRef({ actorId: user?.id ?? null, avatarId: identity.avatarId });
  scopeRef.current = { actorId: user?.id ?? null, avatarId: identity.avatarId };

  useEffect(() => {
    return () => {
      const { actorId, avatarId } = scopeRef.current;
      if (!actorId || !avatarId) return;
      void stopAvatarSpeechPlayback({ actorId, avatarId });
    };
  }, []);
}
