import React, { useState } from 'react';
import {
  Image,
  Pressable,
  StyleSheet,
  Text,
  View,
  ViewStyle,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';

export interface SavedLookCardProps {
  /** Image URI for the saved look/scan. */
  imageUrl?: string | null;
  /** Primary title (look name, scan result, etc.). */
  title: string;
  /** Secondary line such as source room or category. */
  subtitle?: string;
  /** Optional small attribute tags (category, color, silhouette, etc.). */
  tags?: string[];
  /** Optional saved/created date label. */
  date?: string;
  /** Optional status pill label, e.g. "Scan", "Upload", "Look". */
  status?: string;
  /** Called when the card is pressed. */
  onPress?: () => void;
  /** Called when the delete button is pressed. */
  onDelete?: () => void;
  /** Optional view action label shown when onPress is provided. */
  viewLabel?: string;
  /**
   * Optional edit action. Rendered as its own control beside the view label so
   * the card keeps a single primary tap target: on the Closet grid the card
   * itself opens the outfit builder, which left editing with no affordance at
   * all before this existed (BUG-16).
   */
  onEdit?: () => void;
  /** Label for the edit action. */
  editLabel?: string;
  /** Test ID for E2E. */
  testID?: string;
  /** Accessibility label describing the card. */
  accessibilityLabel?: string;
  /** Override root style (e.g. width for grids). */
  style?: ViewStyle;
}

/**
 * A premium archive card for saved scans, looks, and inspiration uploads.
 *
 * - Image-first layout with pearl surface and champagne border.
 * - Optional status pill, tags, date, and delete action.
 * - Optional onPress for viewing the saved item.
 */
export function SavedLookCard({
  imageUrl,
  title,
  subtitle,
  tags,
  date,
  status,
  onPress,
  onDelete,
  viewLabel = 'View',
  onEdit,
  editLabel = 'Edit',
  testID,
  accessibilityLabel,
  style,
}: SavedLookCardProps) {
  const [imageError, setImageError] = useState(false);
  const hasImage = Boolean(imageUrl) && !imageError;

  const cardContent = (
    <>
      <View style={styles.imageWrap}>
        {hasImage ? (
          <Image
            source={{ uri: imageUrl! }}
            style={styles.image}
            resizeMode="cover"
            onError={() => setImageError(true)}
            accessibilityLabel={`${title} image`}
          />
        ) : (
          <View style={styles.placeholder}>
            <Text style={styles.placeholderText}>K</Text>
          </View>
        )}
        {status ? (
          <View style={styles.statusPill}>
            <Text style={styles.statusText}>{status}</Text>
          </View>
        ) : null}
        {onDelete ? (
          <Pressable
            onPress={onDelete}
            style={styles.deleteButton}
            accessibilityRole="button"
            accessibilityLabel={`Delete ${title}`}
            hitSlop={{ top: 12, right: 12, bottom: 12, left: 12 }}
          >
            <Text style={styles.deleteText}>×</Text>
          </Pressable>
        ) : null}
      </View>

      <View style={styles.meta}>
        {subtitle ? (
          <Text style={styles.subtitle} numberOfLines={1}>
            {subtitle}
          </Text>
        ) : null}
        <Text style={styles.cardTitle} numberOfLines={2}>
          {title}
        </Text>
        {tags && tags.length > 0 ? (
          <View style={styles.tagRow}>
            {tags.map((tag) => (
              <View key={tag} style={styles.tag}>
                <Text style={styles.tagText}>{tag}</Text>
              </View>
            ))}
          </View>
        ) : null}
        {date ? <Text style={styles.date}>{date}</Text> : null}
        {onPress || onEdit ? (
          <View style={styles.actionRow}>
            {onPress ? <Text style={styles.viewLabel}>{viewLabel}</Text> : null}
            {onEdit ? (
              <Pressable
                onPress={onEdit}
                style={styles.editButton}
                accessibilityRole="button"
                accessibilityLabel={`Edit ${title}`}
                hitSlop={{ top: 10, right: 10, bottom: 10, left: 10 }}
                testID="saved-look-card-edit"
              >
                <Text style={styles.editLabel}>{editLabel}</Text>
              </Pressable>
            ) : null}
          </View>
        ) : null}
      </View>
    </>
  );

  if (onPress) {
    return (
      <Pressable
        testID={testID}
        onPress={onPress}
        style={[styles.card, style]}
        accessibilityRole="button"
        accessibilityLabel={accessibilityLabel ?? `${title} saved look`}
      >
        {cardContent}
      </Pressable>
    );
  }

  return (
    <View
      testID={testID}
      style={[styles.card, style]}
      accessibilityRole="text"
      accessibilityLabel={accessibilityLabel ?? `${title} saved look`}
    >
      {cardContent}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    overflow: 'hidden',
    ...SHADOWS.editorialSmall,
  },
  imageWrap: {
    width: '100%',
    aspectRatio: 1,
    backgroundColor: LUXURY.colors.champagne,
    position: 'relative',
  },
  image: {
    width: '100%',
    height: '100%',
  },
  placeholder: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
  },
  placeholderText: {
    fontFamily: LUXURY.typography.brandMark.fontFamily,
    fontSize: 28,
    color: LUXURY.colors.goldBrushed,
  },
  statusPill: {
    position: 'absolute',
    top: SPACING.sm,
    left: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: `${LUXURY.colors.goldBrushed}55`,
    backgroundColor: `${LUXURY.colors.pearl}F2`,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  statusText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    fontWeight: '600',
    letterSpacing: 1.2,
    color: LUXURY.colors.goldBrushed,
  },
  deleteButton: {
    position: 'absolute',
    top: SPACING.sm,
    right: SPACING.sm,
    width: 26,
    height: 26,
    borderRadius: 13,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: 'rgba(255, 255, 255, 0.92)',
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
  },
  deleteText: {
    color: LUXURY.colors.graphite,
    fontSize: 16,
    lineHeight: 18,
  },
  meta: {
    padding: SPACING.md,
    gap: SPACING.xs,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 1.2,
    color: LUXURY.colors.stone,
  },
  cardTitle: {
    ...LUXURY.typography.bodyStrong,
    fontSize: 14,
    lineHeight: 20,
    color: LUXURY.colors.ink,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.xs,
    marginTop: SPACING.xs,
  },
  tag: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.sm,
    paddingVertical: 3,
  },
  tagText: {
    ...LUXURY.typography.caption,
    fontSize: 9,
    letterSpacing: 0.8,
    color: LUXURY.colors.graphite,
  },
  date: {
    ...LUXURY.typography.caption,
    fontSize: 10,
    letterSpacing: 0.8,
    color: LUXURY.colors.stone,
    marginTop: SPACING.xs,
  },
  viewLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    marginTop: SPACING.sm,
  },
  actionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  // 44pt minimum target: this sits inside a card that is itself pressable, so a
  // near-miss must not silently open the outfit builder instead.
  editButton: {
    minHeight: 44,
    minWidth: 44,
    justifyContent: 'center',
    alignItems: 'flex-end',
    marginTop: SPACING.sm,
  },
  editLabel: {
    ...LUXURY.typography.ctaSecondary,
    fontSize: 11,
    letterSpacing: 1.4,
    color: LUXURY.colors.plum,
  },
});
