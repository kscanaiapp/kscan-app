import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { StyleChatMessage } from '../../services/style-chat/types';
import { StyleChatUiBlockView } from './StyleChatUiBlock';

interface StyleChatBubbleProps {
  message: StyleChatMessage;
  onRetry?: () => void;
  isError?: boolean;
}

export function StyleChatBubble({ message, onRetry, isError }: StyleChatBubbleProps) {
  const isUser = message.sender === 'user';
  const content = typeof message.content === 'string' ? message.content : '';
  const uiBlocks = Array.isArray(message.uiBlocks) ? message.uiBlocks : [];
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
        <View style={styles.avatarDot} accessibilityLabel="AI stylist" />
      ) : null}
      <View
        style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
        accessibilityRole="text"
        accessibilityLabel={isUser ? 'Your message' : 'AI stylist message'}
      >
        <Text style={isUser ? styles.textUser : styles.textAssistant}>
          {content}
        </Text>
        {!isUser && uiBlocks.length > 0 ? (
          <View style={styles.uiBlocks}>
            {uiBlocks.map((block, i) => (
              <StyleChatUiBlockView key={i} block={block} />
            ))}
          </View>
        ) : null}
        {isError && onRetry ? (
          <Pressable
            onPress={onRetry}
            style={styles.retryBtn}
            accessibilityRole="button"
            accessibilityLabel="Retry last message"
            accessibilityHint="Resend the message that failed"
          >
            <Text style={styles.retryText}>Retry</Text>
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
    marginVertical: SPACING.sm,
    paddingHorizontal: SPACING.xl,
  },
  rowUser: {
    justifyContent: 'flex-end',
  },
  rowAssistant: {
    justifyContent: 'flex-start',
  },
  avatarDot: {
    width: 7,
    height: 7,
    borderRadius: 4,
    backgroundColor: LUXURY.colors.gold,
    marginRight: SPACING.sm,
    marginBottom: 10,
    flexShrink: 0,
  },
  bubble: {
    maxWidth: '84%',
    flexShrink: 1,
    minWidth: 0,
    borderRadius: RADIUS.lg,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
  },
  bubbleUser: {
    backgroundColor: LUXURY.colors.plum,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumSoft,
    ...LUXURY.cards.product.shadow,
  },
  bubbleAssistant: {
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    ...LUXURY.cards.product.shadow,
  },
  textUser: {
    ...LUXURY.typography.body,
    fontSize: 15,
    color: LUXURY.colors.inverse,
    lineHeight: 22,
    flexShrink: 1,
    minWidth: 0,
  },
  textAssistant: {
    ...LUXURY.typography.body,
    fontSize: 15,
    color: LUXURY.colors.ink,
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
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.pearl,
    minHeight: 32,
    justifyContent: 'center',
  },
  retryText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontWeight: '600',
    letterSpacing: 1.2,
  },
});
