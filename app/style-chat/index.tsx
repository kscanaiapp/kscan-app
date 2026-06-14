import { useRef, useState } from 'react';
import {
  Alert,
  ScrollView,
  StyleSheet,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { COLORS } from '../../constants/theme';
import {
  StyleChatHeader,
  useStyleChatHomeBackHandler,
} from '../../components/style-chat/StyleChatHeader';
import { StyleChatSessionList } from '../../components/style-chat/StyleChatSessionList';
import { useStyleChatSessions } from '../../hooks/useStyleChatSessions';
import type { StyleChatSession } from '../../services/style-chat/types';

export default function StyleChatIndexScreen() {
  const isDeleteDialogOpenRef = useRef(false);
  useStyleChatHomeBackHandler(isDeleteDialogOpenRef);

  const { sessions, loading, error, createSession, deleteSession } = useStyleChatSessions();
  const [isCreating, setIsCreating] = useState(false);

  const handleNewSession = async () => {
    if (isCreating) return;
    setIsCreating(true);
    try {
      const session = await createSession();
      router.push(`/style-chat/${session.id}`);
    } catch {
      // createSession throws on auth failure; the session list will show an
      // error on reload, and the user can sign in from the main flow
    } finally {
      setIsCreating(false);
    }
  };

  const handleDeleteSession = (session: StyleChatSession) => {
    const clearDialog = () => { isDeleteDialogOpenRef.current = false; };
    isDeleteDialogOpenRef.current = true;
    Alert.alert(
      'Delete this StyleChat conversation?',
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
    <SafeAreaView testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="dark" />
      <StyleChatHeader />
      <ScrollView
        style={styles.scroll}
        contentContainerStyle={styles.scrollContent}
        showsVerticalScrollIndicator={false}
      >
        <StyleChatSessionList
          sessions={sessions}
          loading={loading}
          error={error}
          onNewSession={() => { void handleNewSession(); }}
          onSelectSession={session => router.push(`/style-chat/${session.id}`)}
          onDeleteSession={handleDeleteSession}
          newSessionDisabled={isCreating}
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.chatScreenBg,
  },
  scroll: {
    flex: 1,
    backgroundColor: COLORS.chatPanelBg,
  },
  scrollContent: {
    flexGrow: 1,
  },
});
