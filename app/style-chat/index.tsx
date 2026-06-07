import {
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

export default function StyleChatIndexScreen() {
  useStyleChatHomeBackHandler();

  const { sessions, loading, error, createSession } = useStyleChatSessions();

  const handleNewSession = async () => {
    try {
      const session = await createSession();
      router.push(`/style-chat/${session.id}`);
    } catch {
      // createSession throws on auth failure; the session list will show an
      // error on reload, and the user can sign in from the main flow
    }
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
