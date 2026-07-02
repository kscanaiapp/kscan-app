import { useState } from 'react';
import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { StyleChatMessage } from '../../services/style-chat/types';
import { StyleChatUiBlockView } from './StyleChatUiBlock';
import { useStyleDnaFeedback } from '../../hooks/useStyleDnaFeedback';
import {
  STYLE_DNA_ENABLED,
  type LocalStyleDnaFeedbackValue,
} from '../../services/style-dna/localStyleDnaFeedbackStore';

interface StyleChatBubbleProps {
  message: StyleChatMessage;
  onRetry?: () => void;
  isError?: boolean;
  /**
   * Authenticated Style DNA user key (e.g. `user:{supabaseUserId}`), passed from
   * the session screen. When absent, local feedback UI is not rendered.
   */
  userKey?: string | null;
  onStyleDnaFeedbackSaved?: () => void;
}

type AssistantContentBlock =
  | { type: 'heading'; text: string }
  | { type: 'paragraph'; text: string }
  | { type: 'list_item'; marker: string; text: string };

function parseAssistantContent(content: string): AssistantContentBlock[] {
  const normalized = content.replace(/\r\n/g, '\n').trim();
  if (!normalized) return [];

  const blocks: AssistantContentBlock[] = [];
  const paragraphLines: string[] = [];

  const flushParagraph = () => {
    if (paragraphLines.length === 0) return;
    blocks.push({ type: 'paragraph', text: paragraphLines.join(' ') });
    paragraphLines.length = 0;
  };

  normalized.split('\n').forEach(rawLine => {
    const line = rawLine.trim();
    if (!line) {
      flushParagraph();
      return;
    }

    const numberedMatch = line.match(/^(\d+)[.)]\s+(.*)$/);
    if (numberedMatch) {
      flushParagraph();
      blocks.push({ type: 'list_item', marker: `${numberedMatch[1]}.`, text: numberedMatch[2] });
      return;
    }

    const bulletMatch = line.match(/^[-*]\s+(.*)$/);
    if (bulletMatch) {
      flushParagraph();
      blocks.push({ type: 'list_item', marker: '-', text: bulletMatch[1] });
      return;
    }

    if (line.endsWith(':') && line.length <= 80) {
      flushParagraph();
      blocks.push({ type: 'heading', text: line });
      return;
    }

    paragraphLines.push(line);
  });

  flushParagraph();
  return blocks;
}

// A message is a completed assistant response only when it has a stable,
// backend-persisted id (Supabase UUID). Optimistic, still-in-flight bubbles use
// `optimistic-…` ids and must not show feedback.
function isStablePersistedId(id: string): boolean {
  return typeof id === 'string' && id.length > 0 && !id.startsWith('optimistic-');
}

function StyleDnaFeedbackRow({
  userKey,
  sessionId,
  messageId,
  onSaved,
}: {
  userKey: string;
  sessionId: string;
  messageId: string;
  onSaved?: () => void;
}) {
  const { selectedFeedback, isSavingFeedback, feedbackError, saveFeedback } = useStyleDnaFeedback({
    userKey,
    sessionId,
    messageId,
    onSaved,
  });
  const [didInteract, setDidInteract] = useState(false);

  const onPick = (value: LocalStyleDnaFeedbackValue) => {
    setDidInteract(true);
    saveFeedback(value);
  };

  const showConfirmation =
    didInteract && !isSavingFeedback && !feedbackError && selectedFeedback != null;

  const options: Array<{ value: LocalStyleDnaFeedbackValue; label: string; a11y: string }> = [
    { value: 'helpful', label: 'Helpful', a11y: 'Mark response as helpful' },
    { value: 'not_my_style', label: 'Not my style', a11y: 'Mark response as not my style' },
  ];

  return (
    <View style={styles.feedbackRow}>
      <View style={styles.feedbackOptions}>
        {options.map(opt => {
          const selected = selectedFeedback === opt.value;
          return (
            <Pressable
              key={opt.value}
              onPress={() => onPick(opt.value)}
              disabled={isSavingFeedback}
              style={[styles.feedbackChip, selected ? styles.feedbackChipSelected : null]}
              accessibilityRole="button"
              accessibilityLabel={opt.a11y}
              accessibilityState={{ selected, disabled: isSavingFeedback, busy: isSavingFeedback }}
              hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            >
              <Text style={[styles.feedbackChipText, selected ? styles.feedbackChipTextSelected : null]}>
                {opt.label}
              </Text>
            </Pressable>
          );
        })}
      </View>
      {feedbackError ? (
        <Text style={styles.feedbackError} accessibilityLiveRegion="polite">
          {feedbackError}
        </Text>
      ) : showConfirmation ? (
        <Text style={styles.feedbackConfirm} accessibilityLiveRegion="polite">
          Feedback saved
        </Text>
      ) : null}
    </View>
  );
}

export function StyleChatBubble({
  message,
  onRetry,
  isError,
  userKey,
  onStyleDnaFeedbackSaved,
}: StyleChatBubbleProps) {
  const isUser = message.sender === 'user';
  const content = typeof message.content === 'string' ? message.content : '';
  const uiBlocks = Array.isArray(message.uiBlocks) ? message.uiBlocks : [];
  const assistantBlocks = !isUser ? parseAssistantContent(content) : [];
  const insets = useSafeAreaInsets();
  const safeRowPadding = insets.left || insets.right
    ? {
        paddingLeft: Math.max(SPACING.xl, insets.left),
        paddingRight: Math.max(SPACING.xl, insets.right),
      }
    : null;

  // Style DNA Phase 0: local feedback only on completed assistant messages with a
  // stable persisted id, and only when we have an authenticated user key.
  const showFeedback =
    STYLE_DNA_ENABLED &&
    !isUser &&
    !isError &&
    Boolean(userKey) &&
    content.trim().length > 0 &&
    isStablePersistedId(message.id);

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
        {isUser || assistantBlocks.length === 0 ? (
          <Text style={isUser ? styles.textUser : styles.textAssistant}>
            {content}
          </Text>
        ) : (
          <View style={styles.assistantContent}>
            {assistantBlocks.map((block, index) => {
              if (block.type === 'heading') {
                return (
                  <Text key={`${block.type}-${index}`} style={styles.assistantHeading}>
                    {block.text}
                  </Text>
                );
              }

              if (block.type === 'list_item') {
                return (
                  <View key={`${block.type}-${index}`} style={styles.listRow}>
                    <Text style={styles.listMarker}>{block.marker}</Text>
                    <Text style={styles.listText}>{block.text}</Text>
                  </View>
                );
              }

              return (
                <Text key={`${block.type}-${index}`} style={styles.textAssistant}>
                  {block.text}
                </Text>
              );
            })}
          </View>
        )}
        {!isUser && uiBlocks.length > 0 ? (
          <View style={styles.uiBlocks}>
            {uiBlocks.map((block, i) => (
              <StyleChatUiBlockView key={i} block={block} />
            ))}
          </View>
        ) : null}
        {showFeedback ? (
          <StyleDnaFeedbackRow
            userKey={userKey as string}
            sessionId={message.sessionId}
            messageId={message.id}
            onSaved={onStyleDnaFeedbackSaved}
          />
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
  assistantContent: {
    gap: SPACING.sm,
  },
  assistantHeading: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 11,
    fontWeight: '600',
    letterSpacing: 1.2,
    textTransform: 'uppercase',
  },
  listRow: {
    flexDirection: 'row',
    alignItems: 'flex-start',
    gap: SPACING.sm,
  },
  listMarker: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    lineHeight: 22,
  },
  listText: {
    ...LUXURY.typography.body,
    fontSize: 15,
    color: LUXURY.colors.ink,
    lineHeight: 22,
    flex: 1,
    minWidth: 0,
  },
  uiBlocks: {
    marginTop: SPACING.sm,
    minWidth: 0,
  },
  feedbackRow: {
    marginTop: SPACING.sm,
    paddingTop: SPACING.sm,
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.hairline,
    // Reserve consistent height so hydrating the persisted selection does not
    // shift the bubble layout.
    minHeight: 44,
    justifyContent: 'center',
  },
  feedbackOptions: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  feedbackChip: {
    minHeight: 32,
    justifyContent: 'center',
    paddingVertical: SPACING.xs,
    paddingHorizontal: SPACING.md,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.ivory,
  },
  feedbackChipSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: 'rgba(198, 161, 91, 0.14)',
  },
  feedbackChipText: {
    ...LUXURY.typography.caption,
    fontSize: 12,
    color: LUXURY.colors.graphite,
    letterSpacing: 0.4,
  },
  feedbackChipTextSelected: {
    color: LUXURY.colors.plum,
    fontWeight: '600',
  },
  feedbackConfirm: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xs,
    letterSpacing: 0.6,
  },
  feedbackError: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.error,
    marginTop: SPACING.xs,
    letterSpacing: 0.6,
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
