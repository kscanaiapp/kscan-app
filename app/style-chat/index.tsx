import {
  Alert,
  SafeAreaView,
  ScrollView,
  StyleSheet,
} from 'react-native';
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
  useStyleChatHomeBackHandler();

  const { sessions, loading, error, createSession, deleteSession } = useStyleChatSessions();

  const handleNewSession = async () => {
    try {
      const session = await createSession();
      router.push(`/style-chat/${session.id}`);
    } catch {
      // createSession throws on auth failure; the session list will show an
      // error on reload, and the user can sign in from the main flow
    }
  };

  const handleDeleteSession = (session: StyleChatSession) => {
    Alert.alert(
      'Delete this StyleChat conversation?',
      'This will remove the conversation and its messages. This cannot be undone.',
      [
        { text: 'Cancel', style: 'cancel' },
        {
          text: 'Delete',
          style: 'destructive',
          onPress: async () => {
            try {
              await deleteSession(session.id);
            } catch (err: unknown) {
              Alert.alert(
                'Could not delete conversation',
                (err as Error)?.message || 'Please try again.',
              );
            }
          },
        },
      ],
    );
  };

  return (
    <SafeAreaView testID="style-chat-screen" style={styles.safe}>
      <StatusBar style="light" />
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
        />
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: {
    flex: 1,
    backgroundColor: COLORS.bg,
  },
  scroll: {
    flex: 1,
  },
  scrollContent: {
    flexGrow: 1,
  },
});
