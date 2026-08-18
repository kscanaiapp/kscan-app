import { useCallback, useEffect, useRef, useState } from 'react';
import {
  Alert,
  Linking,
  StyleSheet,
  View,
} from 'react-native';
import { router, useFocusEffect } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { StyleChatHeader, useStyleChatHomeBackHandler } from '../../components/style-chat/StyleChatHeader';
import { StyleChatSessionList } from '../../components/style-chat/StyleChatSessionList';
import { GenderStylingContextPrompt } from '../../components/style-chat/GenderStylingContextPrompt';
import { LuxuryScreen, PrivacyFooter } from '../../components/luxury';
import { LUXURY } from '../../constants/theme';
import { useStyleChatSessions } from '../../hooks/useStyleChatSessions';
import { useGenderStylingContext } from '../../hooks/useGenderStylingContext';
import { getStyleChatHandoffContext } from '../../services/style-chat/styleChatHandoffContext';
import {
  createStyleChatSessionLaunchGuard,
  launchStyleChatSession,
} from '../../services/style-chat/sessionLaunchGuard';
import type { StyleChatSession } from '../../services/style-chat/types';

export default function StyleChatIndexScreen() {
  const isDeleteDialogOpenRef = useRef(false);
  const handoffAutoStartAttemptedRef = useRef(false);
  const sessionLaunchGuardRef = useRef<ReturnType<typeof createStyleChatSessionLaunchGuard> | null>(null);
  if (!sessionLaunchGuardRef.current) {
    sessionLaunchGuardRef.current = createStyleChatSessionLaunchGuard();
  }
  useStyleChatHomeBackHandler(isDeleteDialogOpenRef);

  const { sessions, loading, error, createSession, deleteSession } = useStyleChatSessions();
  const [isCreating, setIsCreating] = useState(false);
  const [launchError, setLaunchError] = useState<string | null>(null);
  const genderContext = useGenderStylingContext();
  // Blocking only until hydration resolves one way or the other; a hydrate
  // failure fails OPEN (proceeds to normal Elise entry) rather than trapping
  // the user behind a preference the backend couldn't load.
  const genderGateLoading =
    genderContext.isLoading && !genderContext.hasHydrated && !genderContext.error;
  const showGenderGate = genderContext.needsFirstUseAnswer;

  useFocusEffect(
    useCallback(() => {
      sessionLaunchGuardRef.current?.resetOnFocus();
      setIsCreating(false);
      setLaunchError(null);
    }, []),
  );

  const handleNewSession = useCallback(async () => {
    const guard = sessionLaunchGuardRef.current;
    if (!guard) return;
    setIsCreating(true);
    setLaunchError(null);
    const result = await launchStyleChatSession({
      guard,
      createSession,
      navigate: (sessionId) => router.push(`/style-chat/${sessionId}`),
    });
    if (result.status === 'ignored') return;
    if (result.status === 'failed') {
      setLaunchError("We couldn't start a conversation. Please try again.");
    }
    if (result.status !== 'navigated') setIsCreating(false);
  }, [createSession]);

  useEffect(() => {
    if (
      handoffAutoStartAttemptedRef.current ||
      loading ||
      isCreating ||
      error ||
      genderGateLoading ||
      showGenderGate
    ) {
      return;
    }
    const handoff = getStyleChatHandoffContext();
    handoffAutoStartAttemptedRef.current = true;
    if (!handoff) return;
    void handleNewSession();
  }, [error, handleNewSession, isCreating, loading, genderGateLoading, showGenderGate]);

  const handleDeleteSession = (session: StyleChatSession) => {
    const clearDialog = () => { isDeleteDialogOpenRef.current = false; };
    isDeleteDialogOpenRef.current = true;
    Alert.alert(
      'Delete this conversation?',
      'This will remove the conversation and its messages. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel', onPress: clearDialog },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            clearDialog();
            try {
              await deleteSession(session.id);
            } catch {
              Alert.alert(
                'Could not delete conversation',
                "We couldn't delete the conversation right now. Please try again.",
              );
            }
          },
        },
      ],
      { cancelable: true, onDismiss: clearDialog },
    );
  };

  return (
    <LuxuryScreen
      testID="style-chat-screen"
      scrollable={false}
      safeArea={false}
      backgroundColor={LUXURY.colors.ivory}
      accessibilityLabel="Elise conversations"
    >
      <StatusBar style="dark" />
      <StyleChatHeader />
      <View style={styles.listWrap}>
        {genderGateLoading ? null : showGenderGate ? (
          <GenderStylingContextPrompt
            onSelect={(value) => { void genderContext.save(value); }}
            saving={genderContext.isLoading}
            error={genderContext.error}
          />
        ) : (
          <StyleChatSessionList
            sessions={sessions}
            loading={loading}
            error={launchError ?? error}
            onNewSession={() => { void handleNewSession(); }}
            onSelectSession={session => router.push(`/style-chat/${session.id}`)}
            onDeleteSession={handleDeleteSession}
            newSessionDisabled={isCreating}
          />
        )}
      </View>
      <PrivacyFooter
        onPrivacyPress={() => void Linking.openURL('https://kscan.app/legal/privacy')}
        onDataPress={() => void Linking.openURL('https://kscan.app/legal/delete-account')}
      />
    </LuxuryScreen>
  );
}

const styles = StyleSheet.create({
  listWrap: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
  },
});
