import { View, Text, StyleSheet } from 'react-native';
import { COLORS, RADIUS, SPACING, TYPOGRAPHY } from '../../constants/theme';
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
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.darkOverlayBorder,
    backgroundColor: COLORS.surfaceSoft,
    padding: SPACING.sm,
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
