import { View, Text, StyleSheet, Pressable } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { StyleChatMessage } from '../../services/style-chat/types';
import { StyleChatUiBlockView } from './StyleChatUiBlock';
import { StyleChatActionCards } from './StyleChatActionCards';
import { StyleChatFeedbackControls } from './StyleChatFeedbackControls';
import { useStylistIdentity } from '../../hooks/useStylistIdentity';
import { STYLE_DNA_ENABLED } from '../../services/style-dna/localStyleDnaFeedbackStore';
import { useAiOutputReporting } from '../../contexts/AiOutputReportingContext';
import { isSyntheticStyleChatFailure } from '../../services/style-chat/styleChatOutcome';
import { isEligibleForStyleFeedback } from '../../services/style-dna/styleDnaEligibility';

interface StyleChatBubbleProps {
  message: StyleChatMessage;
  onRetry?: () => void;
  isError?: boolean;
  /**
   * Authenticated Style DNA user key (e.g. `user:{supabaseUserId}`), passed from
   * the session screen. When absent, local feedback UI is not rendered.
   */
  userKey?: string | null;
  /**
   * When false, no new Signature Style signals are recorded and no success
   * confirmation is shown. Existing learned data remains intact.
   */
  learnFromFeedback?: boolean;
  /**
   * When true, compact inline feedback actions and their overflow menu are
   * available on eligible recommendations. Learning must also be enabled.
   */
  showFeedbackControls?: boolean;
  /**
   * When false, the one-time menu education banner is shown on first menu open.
   */
  feedbackEducationDismissed?: boolean;
  /**
   * Called when the user dismisses the one-time education banner.
   */
  onDismissFeedbackEducation?: () => void;
  onFeedbackMenuOpened?: () => void;
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

function findWhyThisWorks(message: StyleChatMessage): string | undefined {
  if (!Array.isArray(message.uiBlocks)) return undefined;
  const block = message.uiBlocks.find((b) => b.type === 'why_this_works');
  return typeof block?.body === 'string' ? block.body : undefined;
}

export function StyleChatBubble({
  message,
  onRetry,
  isError,
  userKey,
  learnFromFeedback = true,
  showFeedbackControls = false,
  feedbackEducationDismissed = false,
  onDismissFeedbackEducation,
  onFeedbackMenuOpened,
  onStyleDnaFeedbackSaved,
}: StyleChatBubbleProps) {
  const isUser = message.sender === 'user';
  const { identity } = useStylistIdentity();
  const stylistDisplayName = identity.displayName;
  const content = typeof message.content === 'string' ? message.content : '';
  const uiBlocks = Array.isArray(message.uiBlocks) ? message.uiBlocks : [];
  const isSyntheticFailure = isSyntheticStyleChatFailure(message);
  const { openAiOutputReport } = useAiOutputReporting();
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
  const isGreeting = !isUser && uiBlocks.some((block) => block?.type === 'greeting');

  const showFeedback =
    STYLE_DNA_ENABLED &&
    !isSyntheticFailure &&
    !isGreeting &&
    isStablePersistedId(message.id) &&
    isEligibleForStyleFeedback({ message, userKey, isError });

  return (
    <View
      testID={isUser ? 'style-chat-message-user' : 'style-chat-message-assistant'}
      style={[styles.row, safeRowPadding, isUser ? styles.rowUser : styles.rowAssistant]}
    >
      {!isUser ? (
        <View
          style={styles.avatarDot}
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
        />
      ) : null}
      <View
        style={[styles.bubble, isUser ? styles.bubbleUser : styles.bubbleAssistant]}
        accessibilityRole="text"
        accessibilityLabel={
          isUser
            ? `Your message: ${content}`
            : isGreeting
              ? `${stylistDisplayName}: ${content}`
              : `${stylistDisplayName} message: ${content}`
        }
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
        {/* Phase 2: bounded attachment summaries on user messages. */}
        {isUser
          ? uiBlocks
              .filter((block) => block?.type === 'stylechat_attachments')
              .map((block, i) => (
                <View key={`att-${i}`} style={styles.attachmentSummaryWrap}>
                  {(Array.isArray((block as { items?: unknown }).items)
                    ? ((block as unknown as { items: Array<Record<string, unknown>> }).items)
                    : []
                  ).map((item, j) => (
                    <View key={j} style={styles.attachmentSummaryChip}>
                      <Text style={styles.attachmentSummaryText} numberOfLines={1}>
                        {String(item.title ?? 'Attachment')}
                        {typeof item.itemCount === 'number' && item.itemCount > 1
                          ? ` · ${item.itemCount} items`
                          : ''}
                      </Text>
                    </View>
                  ))}
                </View>
              ))
          : null}
        {!isUser && uiBlocks.length > 0 ? (
          <View style={styles.uiBlocks}>
            {uiBlocks.map((block, i) => {
              // Phase 2: validated structured actions render as app-controlled
              // action cards, never as raw JSON or generic blocks.
              if (block?.type === 'greeting') {
                return null;
              }

              if (block?.type === 'stylechat_actions') {
                const actions = Array.isArray((block as { actions?: unknown }).actions)
                  ? ((block as unknown as { actions: never[] }).actions)
                  : [];
                return <StyleChatActionCards key={`actions-${i}`} actions={actions} />;
              }
              return <StyleChatUiBlockView key={i} block={block} />;
            })}
          </View>
        ) : null}
        {showFeedback && learnFromFeedback && showFeedbackControls ? (
          <StyleChatFeedbackControls
            userKey={userKey as string}
            sessionId={message.sessionId}
            messageId={message.id}
            whyThisWorks={findWhyThisWorks(message)}
            feedbackEnabled={learnFromFeedback && showFeedbackControls}
            feedbackEducationDismissed={feedbackEducationDismissed}
            onDismissEducation={onDismissFeedbackEducation ?? (() => {})}
            onMenuOpened={onFeedbackMenuOpened}
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
        {message.sender === 'assistant' && !isSyntheticFailure && !isGreeting ? (
          <Pressable
            onPress={() =>
              openAiOutputReport({
                feature: 'StyleChat',
                sessionId: message.sessionId,
                messageId: message.id,
              })
            }
            style={styles.reportBtn}
            accessibilityRole="button"
            accessibilityLabel="Report this Elise response as offensive or unsafe"
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
          >
            <Text style={styles.reportText}>Report Response</Text>
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
  attachmentSummaryWrap: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  attachmentSummaryChip: {
    borderRadius: 12,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 2,
    maxWidth: 200,
  },
  attachmentSummaryText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.inverse,
    fontSize: 11,
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
  reportBtn: {
    marginTop: SPACING.sm,
    alignSelf: 'flex-start',
    paddingVertical: SPACING.xs,
    minHeight: 32,
    justifyContent: 'center',
  },
  reportText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.6,
    textDecorationLine: 'underline',
  },
});
