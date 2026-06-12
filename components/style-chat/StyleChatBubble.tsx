import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
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
  const insets = useSafeAreaInsets();
  const safeRowPadding = insets.left || insets.right ? {
    paddingLeft: Math.max(SPACING.xl, insets.left),
    paddingRight: Math.max(SPACING.xl, insets.right),
  } : null;

  return (
    <View
      testID={isUser ? 'style-chat-message-user' : 'style-chat-message-assistant'}
      style={[styles.row, safeRowPadding, isUser ? styles.rowUser : styles.rowAssistant]}
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
    width: '100%',
    minWidth: 0,
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
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '84%',
    flexShrink: 1,
    minWidth: 0,
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
    flexShrink: 1,
    minWidth: 0,
  },
  textAssistant: {
    ...TYPOGRAPHY.body,
    fontSize: 14,
    color: COLORS.textPrimary,
    lineHeight: 22,
    flexShrink: 1,
    minWidth: 0,
  },
  uiBlocks: {
    marginTop: SPACING.sm,
    minWidth: 0,
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
