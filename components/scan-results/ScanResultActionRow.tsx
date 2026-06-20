import React from 'react';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  SafeAreaView,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

interface ScanResultActionRowProps {
  onSave?: () => void;
  onFindSimilar?: () => void;
  onAskStyleChat?: () => void;
  onAddToDressingRoom?: () => void;
  saveLabel?: string;
  findSimilarLabel?: string;
  askStyleChatLabel?: string;
  addToDressingRoomLabel?: string;
  testID?: string;
}

/**
 * Sticky bottom action row for scan results.
 *
 * - Pinned at the bottom of the viewport, above safe area.
 * - Maps actions to existing app behavior (save, find similar, StyleChat, dressing room).
 * - Hides buttons if the corresponding behavior does not exist.
 * - Minimum 44×44 touch targets.
 */
export function ScanResultActionRow({
  onSave,
  onFindSimilar,
  onAskStyleChat,
  onAddToDressingRoom,
  saveLabel = 'Save to Closet',
  findSimilarLabel = 'Find Similar',
  askStyleChatLabel = 'Ask StyleChat',
  addToDressingRoomLabel = 'Add to Dressing Room',
  testID,
}: ScanResultActionRowProps) {
  const insets = useSafeAreaInsets();

  const actions = [
    { label: saveLabel, onPress: onSave },
    { label: findSimilarLabel, onPress: onFindSimilar },
    { label: askStyleChatLabel, onPress: onAskStyleChat },
    { label: addToDressingRoomLabel, onPress: onAddToDressingRoom },
  ].filter((a) => typeof a.onPress === 'function') as {
    label: string;
    onPress: () => void;
  }[];

  if (actions.length === 0) return null;

  return (
    <View
      style={[
        styles.container,
        { paddingBottom: Math.max(SPACING.md, insets.bottom) },
      ]}
      testID={testID ?? 'scan-result-action-row'}
    >
      <View style={styles.row}>
        {actions.map((action, index) => {
          const isPrimary = index === 0;
          return (
            <TouchableOpacity
              key={action.label}
              onPress={action.onPress}
              activeOpacity={0.86}
              accessibilityRole="button"
              accessibilityLabel={action.label}
              style={[
                styles.button,
                isPrimary ? styles.primaryButton : styles.secondaryButton,
              ]}
            >
              <Text
                style={[
                  styles.buttonText,
                  isPrimary ? styles.primaryButtonText : styles.secondaryButtonText,
                ]}
              >
                {action.label}
              </Text>
            </TouchableOpacity>
          );
        })}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    backgroundColor: 'rgba(255, 253, 249, 0.96)',
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.xl,
    paddingTop: SPACING.md,
    ...SHADOWS.editorialRaised,
    zIndex: 50,
    elevation: 50,
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    gap: SPACING.sm,
    flexWrap: 'wrap',
  },
  button: {
    minHeight: 48,
    minWidth: 120,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.sm,
    flex: 1,
  },
  primaryButton: {
    backgroundColor: LUXURY.colors.plum,
    ...SHADOWS.editorialSmall,
  },
  secondaryButton: {
    backgroundColor: 'transparent',
    borderWidth: 1.5,
    borderColor: LUXURY.colors.gold,
  },
  buttonText: {
    ...LUXURY.typography.cta,
    fontSize: 12,
    letterSpacing: 2.0,
    textAlign: 'center',
  },
  primaryButtonText: {
    color: LUXURY.colors.inverse,
  },
  secondaryButtonText: {
    color: LUXURY.colors.plum,
  },
});
