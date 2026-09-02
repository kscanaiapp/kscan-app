import React, { useMemo } from 'react';
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
  LUXURY,
  RADIUS,
  SHADOWS,
  SPACING,
  TYPOGRAPHY,
} from '../constants/theme';
import type { DressingRoomItem, LookItem } from '../types/styleObjects';
import { canRenderSnapshotVersion } from '../services/styleObjects';
import { resolveRoomCommerceCard } from '../services/dressingRoomCommerceCard';

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
  maxLength,
  testID,
}: {
  label: string;
  value: string;
  onChangeText: (value: string) => void;
  placeholder?: string;
  multiline?: boolean;
  maxLength?: number;
  testID?: string;
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
        maxLength={maxLength}
        testID={testID}
        accessibilityLabel={label}
      />
    </View>
  );
}

function ItemTileBase({
  item,
  selected,
  onPress,
  onRemove,
  onViewDetail,
  footer,
}: {
  item: DressingRoomItem | LookItem;
  selected?: boolean;
  onPress?: () => void;
  onRemove?: () => void;
  onViewDetail?: () => void;
  footer?: React.ReactNode;
}) {
  const versionOk = canRenderSnapshotVersion(item.snapshotVersion);

  const sourceBadge = useMemo(() => {
    const sourceType = (item as DressingRoomItem).sourceType ?? null;
    let label: string;
    switch (sourceType) {
      case 'live_scan':
        label = 'Camera Scan';
        break;
      case 'upload_inspiration':
        label = 'Upload';
        break;
      case 'style_library_scan':
        label = 'Closet';
        break;
      case 'text-scan':
      case 'textScan':
        label = 'TextScan';
        break;
      case null:
      case undefined:
      case '':
        label = 'Saved Item';
        break;
      default:
        label = 'Saved Item';
    }
    return label;
  }, [(item as DressingRoomItem).sourceType]);

  // Commerce facts come from this item's own row and snapshot, so a tile can
  // only ever price the product it is actually showing.
  const commerce = useMemo(() => resolveRoomCommerceCard(item), [item]);

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
        <Text style={styles.itemSourceBadge}>{sourceBadge}</Text>
        <Text style={styles.itemTitle} numberOfLines={2}>
          {versionOk ? item.title || 'Untitled item' : 'Snapshot unavailable'}
        </Text>
        {versionOk && commerce.priceLabel ? (
          <Text style={styles.itemPrice} numberOfLines={1} testID="room-item-tile-price">
            {commerce.priceLabel}
            {commerce.retailer ? ` · ${commerce.retailer}` : ''}
          </Text>
        ) : null}
        {onViewDetail ? (
          <TouchableOpacity style={styles.viewDetailButton} onPress={onViewDetail}>
            <Text style={styles.viewDetailText}>View Detail</Text>
          </TouchableOpacity>
        ) : null}
      </View>
      {footer ? <View style={styles.itemFooter}>{footer}</View> : null}
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

/**
 * Memoized: room grids re-render on every reaction tick and every selection
 * change, and a tile now derives commerce facts from its snapshot. Without this
 * the whole grid recomputes on state that touched one card.
 */
export const ItemTile = React.memo(ItemTileBase);

const styles = StyleSheet.create({
  screen: {
    flex: 1,
    backgroundColor: LUXURY.colors.ivory,
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
    borderBottomColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
  },
  backButton: {
    width: 44,
    minHeight: 44,
    justifyContent: 'center',
  },
  backText: {
    color: LUXURY.colors.plum,
    fontSize: 28,
    fontWeight: '300',
  },
  headerCenter: {
    flex: 1,
    alignItems: 'center',
    gap: SPACING.xs,
  },
  brand: {
    ...LUXURY.typography.sectionLabel,
    fontSize: 13,
    color: LUXURY.colors.ink,
  },
  eyebrow: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    letterSpacing: 2.2,
  },
  headerTitle: {
    ...LUXURY.typography.displayTitle,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  headerRight: {
    width: 44,
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
    backgroundColor: LUXURY.colors.plum,
  },
  secondaryButton: {
    backgroundColor: LUXURY.colors.pearl,
    borderWidth: 1,
    borderColor: LUXURY.colors.gold,
  },
  dangerButton: {
    backgroundColor: 'rgba(130, 48, 56, 0.08)',
    borderWidth: 1,
    borderColor: 'rgba(130, 48, 56, 0.35)',
  },
  disabled: {
    opacity: 0.5,
  },
  buttonText: {
    ...LUXURY.typography.cta,
    textAlign: 'center',
  },
  primaryButtonText: {
    color: LUXURY.colors.inverse,
  },
  secondaryButtonText: {
    color: LUXURY.colors.plum,
  },
  dangerButtonText: {
    color: LUXURY.colors.error,
  },
  empty: {
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: SPACING.xl,
    paddingVertical: SPACING.xxxl,
    gap: SPACING.md,
  },
  emptyTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
    textAlign: 'center',
  },
  emptyBody: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.stone,
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
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  errorText: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.error,
    textAlign: 'center',
  },
  field: {
    gap: SPACING.sm,
    marginTop: SPACING.md,
  },
  fieldLabel: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  input: {
    minHeight: LUXURY.inputs.field.height,
    borderRadius: LUXURY.inputs.field.borderRadius,
    borderWidth: LUXURY.inputs.field.borderWidth,
    borderColor: LUXURY.inputs.field.borderColor,
    backgroundColor: LUXURY.inputs.field.backgroundColor,
    color: LUXURY.inputs.field.color,
    paddingHorizontal: LUXURY.inputs.field.paddingHorizontal,
    paddingVertical: SPACING.md,
    fontSize: LUXURY.inputs.field.fontSize,
    fontWeight: LUXURY.inputs.field.fontWeight,
  },
  textArea: {
    minHeight: 104,
    textAlignVertical: 'top',
  },
  itemTile: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    marginBottom: SPACING.md,
    ...SHADOWS.editorialSmall,
  },
  itemSelected: {
    borderColor: LUXURY.colors.gold,
    backgroundColor: LUXURY.colors.plumMuted,
  },
  itemSourceBadge: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 10,
    letterSpacing: 1.2,
    alignSelf: 'flex-start',
    marginTop: 2,
  },
  viewDetailButton: {
    alignSelf: 'flex-start',
    marginTop: SPACING.sm,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.ivory,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  viewDetailText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    fontSize: 10,
    letterSpacing: 1.2,
  },
  itemImage: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: LUXURY.colors.champagne,
  },
  itemFallback: {
    alignItems: 'center',
    justifyContent: 'center',
  },
  unavailableText: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
  },
  itemBody: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  itemFooter: {
    borderTopWidth: 1,
    borderTopColor: LUXURY.colors.border,
  },
  itemBrand: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.goldBrushed,
    fontSize: 10,
    letterSpacing: 1.4,
  },
  itemTitle: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.ink,
  },
  itemPrice: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.plum,
    marginTop: SPACING.xs,
  },
  selectedMark: {
    ...LUXURY.typography.caption,
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    color: LUXURY.colors.inverse,
    backgroundColor: LUXURY.colors.plum,
    borderRadius: RADIUS.pill,
    paddingHorizontal: SPACING.sm,
    paddingVertical: SPACING.xs,
    overflow: 'hidden',
  },
  removeButton: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    width: 32,
    height: 32,
    borderRadius: 16,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  removeText: {
    color: LUXURY.colors.graphite,
    fontSize: 14,
    lineHeight: 18,
  },
});

export const styleObjectStyles = styles;
