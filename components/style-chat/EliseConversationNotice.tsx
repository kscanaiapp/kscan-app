import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, SPACING } from '../../constants/theme';
import {
  parseEliseConversationNotice,
  type EliseConversationNoticeBlock,
} from '../../services/style-chat/eliseConversationFrame';

/**
 * Elise Conversation Quality V2 — the one line a deterministic check adds
 * under a reply.
 *
 * Copy lives here; the persisted block carries only a closed code and
 * closed-vocabulary tokens, never model prose. Every line states a fact the
 * client proved from the conversation, in Elise's voice, without apologising
 * or lecturing.
 */
function list(tokens: readonly string[]): string {
  if (tokens.length <= 1) return tokens[0] ?? '';
  if (tokens.length === 2) return `${tokens[0]} or ${tokens[1]}`;
  return `${tokens.slice(0, -1).join(', ')}, or ${tokens[tokens.length - 1]}`;
}

export function eliseConversationNoticeCopy(block: EliseConversationNoticeBlock): string {
  const tokens = block.tokens ?? [];
  switch (block.code) {
    case 'constraint_conflict':
      return `That mentions ${list(tokens)}, which you asked me to leave out. Ask me for a swap and I'll keep ${tokens.length > 1 ? 'them' : 'it'} out.`;
    case 'rejected_repeat':
      return `That brings back the ${list(tokens)} you passed on. Ask me for a swap and I'll suggest something else.`;
    case 'shopping_held_owned_only':
      return "You asked to stick to what you own, so I haven't pulled up anything to buy. Say “show me options to buy” if you'd like to shop.";
    case 'shopping_held_not_requested':
      return "I haven't pulled up anything to buy. Say “show me options” if you'd like to shop.";
    default:
      return '';
  }
}

export function EliseConversationNotice({ block }: { block: unknown }) {
  const notice = parseEliseConversationNotice(block);
  if (!notice) return null;
  const copy = eliseConversationNoticeCopy(notice);
  if (!copy) return null;
  return (
    <View style={styles.container} testID={`elise-conversation-notice-${notice.code}`}>
      <Text style={styles.text}>{copy}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    paddingTop: SPACING.xs,
    minWidth: 0,
    flexShrink: 1,
  },
  text: {
    color: LUXURY.colors.graphite,
    fontSize: 13,
    lineHeight: 18,
    flexShrink: 1,
    minWidth: 0,
  },
});
