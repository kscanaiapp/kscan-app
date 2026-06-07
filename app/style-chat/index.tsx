import { useState } from 'react';
import {
  SafeAreaView,
  ScrollView,
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { router } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { COLORS } from '../../constants/theme';
import { StyleChatHeader } from '../../components/style-chat/StyleChatHeader';
import { StyleChatSessionList } from '../../components/style-chat/StyleChatSessionList';
import type { StyleChatSession } from '../../services/style-chat/types';

export default function StyleChatIndexScreen() {
  const [sessions, setSessions] = useState<StyleChatSession[]>([]);

  const handleNewSession = () => {
    const newSession: StyleChatSession = {
      id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      title: 'New Styling Session',
      mode: 'general',
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
    setSessions(prev => [newSession, ...prev]);
    router.push(`/style-chat/${newSession.id}`);
  };

  const handleSelectSession = (session: StyleChatSession) => {
    router.push(`/style-chat/${session.id}`);
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
          onNewSession={handleNewSession}
          onSelectSession={handleSelectSession}
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
