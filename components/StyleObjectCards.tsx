import React from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import {
  BUTTONS,
  COLORS,
  LAYOUT,
  RADIUS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
} from '../constants/theme';
import type { DressingRoomItem, LookItem } from '../types/styleObjects';
import { canRenderSnapshotVersion } from '../services/styleObjects';

export function Header({
  title,
  eyebrow,
  onBack,
  right,
}: {
  title: string;
  eyebrow: string;
  onBack?: () => void;
  right?: React.ReactNode;
}) {
  return (
    <View style={styles.header}>
      <TouchableOpacity style={styles.backButton} onPress={onBack} disabled={!onBack}>
        <Text style={styles.backText}>{onBack ? '<' : ''}</Text>
      </TouchableOpacity>
      <View style={styles.headerCenter}>
        <Text style={styles.brand}>K-SCAN</Text>
        <Text style={styles.eyebrow}>{eyebrow}</Text>
        <Text style={styles.headerTitle} numberOfLines={2}>{title}</Text>
      </View>
      <View style={styles.headerRight}>{right}</View>
    </View>
  );
}

export function PrimaryButton({
  label,
  onPress,
  disabled,
  variant = 'primary',
  testID,
}: {
  label: string;
  onPress: () => void;
  disabled?: boolean;
  variant?: 'primary' | 'secondary' | 'danger';
  testID?: string;
}) {
  return (
    <TouchableOpacity
      testID={testID}
      style={[
        styles.button,
        variant === 'primary' ? styles.primaryButton : styles.secondaryButton,
        variant === 'danger' ? styles.dangerButton : null,
        disabled ? styles.disabled : null,
      ]}
      onPress={onPress}
      disabled={disabled}
      activeOpacity={0.84}
    >
      <Text
        style={[
          styles.buttonText,
          variant === 'primary' ? styles.primaryButtonText : styles.secondaryButtonText,
          variant === 'danger' ? styles.dangerButtonText : null,
        ]}
      >
        {label}
      </Text>
    </TouchableOpacity>
  );
}

export function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.emptyBody}>{body}</Text>
    </View>
  );
}

export function LoadingOrError({
  loading,
  error,
  onRetry,
}: {
  loading: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  if (loading) {
    return (
      <View style={styles.centerPanel}>
        <Text style={styles.centerText}>LOADING</Text>
      </View>
    );
  }
  if (error) {
    return (
      <View style={styles.centerPanel}>
        <Text style={styles.errorText}>{error}</Text>
        {onRetry ? <PrimaryButton label="Retry" onPress={onRetry} variant="secondary" /> : null}
      </View>
    );
  }
  return null;
}

export function TextField({
  label,
  value,
  onChangeText,
  placeholder,
  multiline,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
}) {
  return (
    <View style={styles.field}>
      <Text style={styles.fieldLabel}>{label}</Text>
      <TextInput
        value={value}
        onChangeText={onChangeText}
        placeholder={placeholder}
        placeholderTextColor={COLORS.editorialTextMuted}
        style={[styles.input, multiline ? styles.textArea : null]}
        multiline={multiline}
      />
    </View>
  );
}

export function ItemTile({
  item,
  selected,
  onPress,
  onRemove,
}: {
  item: DressingRoomItem | LookItem;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
}) {
  const versionOk = canRenderSnapshotVersion(item.snapshotVersion);
  const content = (
    <View style={[styles.itemTile, selected ? styles.itemSelected : null]}>
      {versionOk && item.imageUrl ? (
        <Image source={{ uri: item.imageUrl }} style={styles.itemImage} resizeMode="cover" />
      ) : (
        <View style={[styles.itemImage, styles.itemFallback]}>
          <Text style={styles.unavailableText}>UNAVAILABLE</Text>
        </View>
      )}
      <View style={styles.itemBody}>
        <Text style={styles.itemBrand} numberOfLines={1}>{item.brand || item.category || 'K-SCAN'}</Text>
        <Text style={styles.itemTitle} numberOfLines={2}>
          {versionOk ? item.title || 'Untitled item' : 'Snapshot unavailable'}
        </Text>
      </View>
      {selected ? <Text style={styles.selectedMark}>SELECTED</Text> : null}
      {onRemove ? (
        <TouchableOpacity style={styles.removeButton} onPress={onRemove}>
          <Text style={styles.removeText}>x</Text>
        </TouchableOpacity>
      ) : null}
    </View>
  );

  if (!onPress) return content;
  return <Pressable onPress={onPress}>{content}</Pressable>;
}

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: COLORS.canvasWarm,
  },
  content: {
    padding: LAYOUT.screenPadding,
    paddingBottom: 96,
  },
  header: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: LAYOUT.screenPadding,
    paddingTop: LAYOUT.safeTop,
    paddingBottom: SPACING.lg,
    borderBottomWidth: StyleSheet.hairlineWidth,
    borderBottomColor: COLORS.borderHairline,
    backgroundColor: COLORS.canvasWarm,
  },
  backButton: {
    width: 42,
    minHeight: 42,
    justifyContent: 'center',
  },
  backText: {
    color: COLORS.goldPressed,
    fontSize: 24,
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    gap: SPACING.xs,
  },
  brand: {
    ...TYPOGRAPHY.brand,
    fontSize: 15,
    color: COLORS.editorialTextPrimary,
  },
  eyebrow: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
  },
  headerTitle: {
    ...TYPOGRAPHY.title,
    color: COLORS.editorialTextPrimary,
    textAlign: 'center',
  },
  headerRight: {
    width: 42,
    alignItems: 'flex-end',
  },
  button: {
    minHeight: BUTTONS.height,
    borderRadius: RADIUS.pill,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    marginTop: SPACING.md,
  },
  primaryButton: {
    backgroundColor: COLORS.gold,
  },
  secondaryButton: {
    backgroundColor: COLORS.surfaceCard,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
  },
  dangerButton: {
    backgroundColor: 'rgba(255, 107, 107, 0.1)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: 'rgba(255, 107, 107, 0.35)',
  },
  disabled: {
    opacity: 0.48,
  },
  buttonText: {
    ...TYPOGRAPHY.cta,
    textAlign: 'center',
  },
  primaryButtonText: {
    color: COLORS.textInverse,
  },
  secondaryButtonText: {
    color: COLORS.editorialTextSecondary,
  },
  dangerButtonText: {
    color: COLORS.error,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xxxl,
    gap: SPACING.md,
  },
  emptyTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextPrimary,
    textAlign: 'center',
  },
  emptyBody: {
    ...TYPOGRAPHY.body,
    color: COLORS.editorialTextMuted,
    textAlign: 'center',
  },
  centerPanel: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    padding: LAYOUT.screenPadding,
    gap: SPACING.md,
  },
  centerText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  errorText: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.error,
    textAlign: 'center',
  },
  field: {
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  fieldLabel: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  input: {
    minHeight: 52,
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceRaised,
    color: COLORS.editorialTextPrimary,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    fontSize: 15,
  },
  textArea: {
    minHeight: 104,
    textAlignVertical: 'top',
  },
  itemTile: {
    borderRadius: RADIUS.md,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
    backgroundColor: COLORS.surfaceCard,
    overflow: 'hidden',
    marginBottom: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  itemSelected: {
    borderColor: COLORS.gold,
    backgroundColor: COLORS.accentSoft,
  },
  itemImage: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: COLORS.surfaceMuted,
  },
  itemFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailableText: {
    ...TYPOGRAPHY.caption,
    color: COLORS.editorialTextMuted,
  },
  itemBody: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  itemBrand: {
    ...TYPOGRAPHY.caption,
    color: COLORS.goldPressed,
    fontSize: 10,
  },
  itemTitle: {
    ...TYPOGRAPHY.bodyStrong,
    color: COLORS.editorialTextPrimary,
  },
  selectedMark: {
    ...TYPOGRAPHY.caption,
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    color: COLORS.textInverse,
    backgroundColor: COLORS.gold,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    overflow: 'hidden',
  },
  removeButton: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    width: 28,
    height: 28,
    borderRadius: 14,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: COLORS.borderHairline,
  },
  removeText: {
    color: COLORS.editorialTextSecondary,
    fontSize: 14,
  },
});

export const styleObjectStyles = styles;
