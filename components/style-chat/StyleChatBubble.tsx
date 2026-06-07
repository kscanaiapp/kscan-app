import { View, Text, StyleSheet, Pressable } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import type { StyleChatMessage } from '../../services/style-chat/types';
import { StyleChatUiBlockView } from './StyleChatUiBlock';

interface StyleChatBubbleProps {
  message: StyleChatMessage;
  onRetry?: () => void;
  isError?: boolean;
}

export function StyleChatBubble({ message, onRetry, isError }: StyleChatBubbleProps) {
  const isUser = message.sender === 'user';

  return (
    <View
      testID={isUser ? 'style-chat-message-user' : 'style-chat-message-assistant'}
      style={[styles.row, isUser ? styles.rowUser : styles.rowAssistant]}
    >
      {!isUser ? (
        <View style={styles.avatarDot} />
      ) : null}
      <View style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}>
        <Text style={isUser ? styles.textUser : styles.textAssistant}>
          {message.content}
        </Text>
        {!isUser && message.uiBlocks.length > 0 ? (
          <View style={styles.uiBlocks}>
            {message.uiBlocks.map((block, i) => (
              <StyleChatUiBlockView key={i} block={block} />
            ))}
          </View>
        ) : null}
        {isError && onRetry ? (
          <Pressable onPress={onRetry} style={styles.retryBtn}>
            <Text style={styles.retryText}>RETRY</Text>
          </Pressable>
        ) : null}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  row: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    marginVertical: SPACING.xs,
    paddingHorizontal: SPACING.xl,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  avatarDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: COLORS.accent,
    marginRight: SPACING.sm,
    marginBottom: 8,
  },
  bubble: {
    maxWidth: '80%',
    borderRadius: RADIUS.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  bubbleUser: {
    backgroundColor: 'rgba(45, 31, 94, 0.55)',
    borderWidth: 1,
    borderColor: 'rgba(139, 92, 246, 0.25)',
  },
  bubbleAssistant: {
    backgroundColor: COLORS.surface,
    borderWidth: 1,
    borderColor: COLORS.border,
  },
  textUser: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    color: COLORS.chrome,
    lineHeight: 22,
  },
  textAssistant: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    color: COLORS.textPrimary,
    lineHeight: 22,
  },
  uiBlocks: {
    marginTop: SPACING.sm,
  },
  retryBtn: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
  },
  retryText: {
    ...TYPOGRAPHY.chipLabel,
    color: COLORS.accent,
    fontSize: 10,
  },
});
