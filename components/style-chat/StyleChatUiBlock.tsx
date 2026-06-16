import { View, Text, StyleSheet } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import type { StyleChatUiBlock } from '../../services/style-chat/types';

interface Props {
  block: StyleChatUiBlock;
}

export function StyleChatUiBlockView({ block }: Props) {
  const title = typeof block.title === 'string' ? block.title : '';
  const body = typeof block.body === 'string' ? block.body : '';

  return (
    <View style={styles.container}>
      {title ? (
        <Text style={styles.title}>{title}</Text>
      ) : null}
      {body ? (
        <Text style={styles.body}>{body}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 0,
    flexShrink: 1,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    padding: SPACING.sm,
    marginTop: SPACING.xs,
  },
  title: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    marginBottom: 4,
    flexShrink: 1,
    minWidth: 0,
    fontWeight: '600',
  },
  body: {
    ...LUXURY.typography.body,
    fontSize: 13,
    color: LUXURY.colors.graphite,
    flexShrink: 1,
    minWidth: 0,
  },
});
