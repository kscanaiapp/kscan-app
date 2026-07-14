import { useCallback, useEffect } from 'react';

import { useAuthSession } from '../contexts/AuthSessionContext';
import {
  hydrateStylistVoicePreference,
  setStylistVoicePreference,
  useStylistVoicePreferenceState,
} from '../stores/stylistVoicePreferenceStore';
import { stopAvatarSpeechPlayback } from '../services/avatarSpeech';

export interface VoiceResponsesPreference {
  enabled: boolean;
  loading: boolean;
  setEnabled: (enabled: boolean) => Promise<void>;
}

export function useVoiceResponsesPreference(): VoiceResponsesPreference {
  const { user } = useAuthSession();
  const actorId = user?.id ?? null;
  const state = useStylistVoicePreferenceState();

  useEffect(() => {
    void hydrateStylistVoicePreference(actorId);
  }, [actorId]);

  const setEnabled = useCallback(async (enabled: boolean) => {
    if (!actorId) return;
    if (!enabled) {
      // setStylistVoicePreference updates the shared state synchronously before
      // its storage write, so new messages fail closed while teardown runs.
      const persistence = setStylistVoicePreference(actorId, false);
      await stopAvatarSpeechPlayback({ actorId });
      await persistence;
      return;
    }
    await setStylistVoicePreference(actorId, true);
  }, [actorId]);

  const belongsToActor = Boolean(actorId && state.actorId === actorId);
  return {
    enabled: belongsToActor && !state.loading ? state.enabled : false,
    loading: Boolean(actorId) && (!belongsToActor || state.loading),
    setEnabled,
  };
}
