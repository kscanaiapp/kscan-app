import { useEffect, useRef, useState } from 'react';
import { AppState } from 'react-native';
import { useIsFocused } from '@react-navigation/native';
import type { StylistIdentity } from '../constants/stylistIdentity';
import { getStylistVoiceProfile } from '../constants/stylistIdentity';
import { STYLIST_SPEECH_ENABLED } from '../constants/featureFlags';
import type { KPlusResolvedState } from '../types/entitlements';
import { useAuthSession } from '../contexts/AuthSessionContext';
import { usePrivacyPreferences } from '../contexts/PrivacyPreferencesContext';
import { captureActorScope, isActorScopeCurrent } from '../services/actorScope';
import { getGreetingTextForUser } from '../services/style-chat/styleChatGreeting';
import { startHomeEliseWelcome } from '../services/homeEliseWelcomeRuntime';
import type { HomeWelcomeBinding } from '../services/homeEliseWelcome';
import { useVoiceResponsesPreference } from './useVoiceResponsesPreference';
import { useScreenReaderEnabled, useScreenReaderReady } from './useScreenReaderEnabled';

export function useHomeEliseWelcome({ identity, ready, entitlement }: {
  identity: StylistIdentity;
  ready: boolean;
  entitlement: KPlusResolvedState;
}) {
  const { user, loading, isAuthenticated, isRecoveringSession, isRefreshing } = useAuthSession();
  const { bootStatus, remoteFetchFailed, profile } = usePrivacyPreferences();
  const preference = useVoiceResponsesPreference();
  const screenReader = useScreenReaderEnabled();
  const readerReady = useScreenReaderReady();
  const focused = useIsFocused();
  const [foreground, setForeground] = useState(AppState.currentState === 'active');
  const [binding, setBinding] = useState<HomeWelcomeBinding | null>(null);
  const actorId = user?.id ?? null;
  const text = getGreetingTextForUser(user, identity);
  const settled = ready && !loading && !isRecoveringSession && !isRefreshing &&
    bootStatus === 'ready' && !preference.loading && readerReady && entitlement !== 'loading';
  const eligible = STYLIST_SPEECH_ENABLED && isAuthenticated && !remoteFetchFailed &&
    profile.account_status === 'active' && !profile.account_locked_at &&
    entitlement === 'active' && preference.enabled && !screenReader &&
    getStylistVoiceProfile(identity.avatarId) !== 'silent';
  // Current gates close synchronously on render, before effect teardown runs.
  const live = useRef({ actorId, text, avatarId: identity.avatarId, settled, eligible, focused });
  live.current = { actorId, text, avatarId: identity.avatarId, settled, eligible, focused };
  const active = useRef<ReturnType<typeof startHomeEliseWelcome> | null>(null);

  useEffect(() => {
    const subscription = AppState.addEventListener('change', (status) => {
      if (status !== 'active') active.current?.cancel();
      setForeground(status === 'active');
    });
    return () => subscription.remove();
  }, []);

  useEffect(() => {
    if (!actorId || !settled || !focused || !foreground) return;
    const scope = captureActorScope();
    if (scope.actorId !== actorId) return;
    const attempt = startHomeEliseWelcome({
      actorId, avatarId: identity.avatarId, text, eligible,
      isCurrent: () => isActorScopeCurrent(scope) && live.current.actorId === actorId &&
        live.current.text === text && live.current.avatarId === identity.avatarId &&
        live.current.settled && (!eligible || live.current.eligible) && live.current.focused &&
        AppState.currentState === 'active',
      onBinding: setBinding,
    });
    active.current = attempt;
    return () => {
      attempt.cancel();
      if (active.current === attempt) active.current = null;
    };
  }, [actorId, settled, focused, foreground, identity.avatarId, text, eligible]);

  return {
    text,
    binding: binding?.actorId === actorId && binding.avatarId === identity.avatarId ? binding : null,
  };
}
