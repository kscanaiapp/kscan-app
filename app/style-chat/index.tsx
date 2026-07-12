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
import { LuxuryScreen, PrivacyFooter } from '../../components/luxury';
import { LUXURY } from '../../constants/theme';
import { useStyleChatSessions } from '../../hooks/useStyleChatSessions';
import { getStyleChatHandoffContext } from '../../services/style-chat/styleChatHandoffContext';
import { createStyleChatSessionLaunchGuard } from '../../services/style-chat/sessionLaunchGuard';
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

  useFocusEffect(
    useCallback(() => {
      sessionLaunchGuardRef.current?.resetOnFocus();
      setIsCreating(false);
    }, []),
  );

  const handleNewSession = useCallback(async () => {
    const guard = sessionLaunchGuardRef.current;
    if (!guard?.tryBegin()) return;
    setIsCreating(true);
    try {
      let sessionId = guard.getPendingSessionId();
      if (!sessionId) {
        const session = await createSession();
        if (!session?.id) {
          guard.releaseForRetry();
          setIsCreating(false);
          return;
        }
        sessionId = session.id;
        guard.rememberSession(sessionId);
      }
      router.push(`/style-chat/${sessionId}`);
    } catch {
      // createSession throws on auth failure; the session list will show an
      // error on reload, and the user can sign in from the main flow
      // If navigation failed after creation, retain the session ID so retrying
      // opens the same session instead of inserting another one.
      guard.releaseForRetry();
      setIsCreating(false);
    }
  }, [createSession]);

  useEffect(() => {
    if (handoffAutoStartAttemptedRef.current || loading || isCreating || error) return;
    const handoff = getStyleChatHandoffContext();
    handoffAutoStartAttemptedRef.current = true;
    if (!handoff) return;
    void handleNewSession();
  }, [error, handleNewSession, isCreating, loading]);

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
        <StyleChatSessionList
          sessions={sessions}
          loading={loading}
          error={error}
          onNewSession={() => { void handleNewSession(); }}
          onSelectSession={session => router.push(`/style-chat/${session.id}`)}
          onDeleteSession={handleDeleteSession}
          newSessionDisabled={isCreating}
        />
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
