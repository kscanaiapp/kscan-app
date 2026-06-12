import { View, Text, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
import type { StyleChatUiBlock } from '../../services/style-chat/types';

interface Props {
  block: StyleChatUiBlock;
}

export function StyleChatUiBlockView({ block }: Props) {
  return (
    <View style={styles.container}>
      {block.title ? (
        <Text style={styles.title}>{block.title}</Text>
      ) : null}
      {block.body ? (
        <Text style={styles.body}>{block.body}</Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    minWidth: 0,
    flexShrink: 1,
    borderRadius: RADIUS.sm,
    borderWidth: 1,
    borderColor: COLORS.borderStrong,
    backgroundColor: 'rgba(45, 31, 94, 0.18)',
    padding: SPACING.md,
    marginTop: SPACING.xs,
  },
  title: {
    ...TYPOGRAPHY.sectionLabel,
    color: COLORS.accent,
    marginBottom: 4,
    flexShrink: 1,
    minWidth: 0,
  },
  body: {
    ...TYPOGRAPHY.body,
    fontSize: 13,
    color: COLORS.textSecondary,
    flexShrink: 1,
    minWidth: 0,
  },
});
