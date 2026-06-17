import React from 'react';
import {
  View,
  Text,
  StyleSheet,
} from 'react-native';
import { LUXURY, RADIUS, SHADOWS, SPACING } from '../../constants/theme';
import { MetadataChip } from '../MetadataChip';
import { StatusPill } from '../luxury/StatusPill';
import { formatMatchPercent } from './formatMatchPercent';

interface StyleMatchPanelProps {
  title?: string;
  category?: string;
  color?: string;
  silhouette?: string;
  material?: string;
  confidence?: number;
  styleTags?: string[];
  testID?: string;
}

/**
 * Style match summary panel.
 *
 * - Displays real style-parse metadata (category, color, silhouette, material).
 * - Title is derived from available data; never invents a designer brand.
 * - Match confidence badge only if real confidence exists.
 * - Style tags as small chips if provided.
 */
export function StyleMatchPanel({
  title,
  category,
  color,
  silhouette,
  material,
  confidence,
  styleTags,
  testID,
}: StyleMatchPanelProps) {
  const formattedConfidence = formatMatchPercent(confidence);

  // Build a display title from available metadata (no fake brands)
  const displayTitle = (() => {
    if (title && title.trim()) return title.trim();
    if (color && category) return `${color} ${category} Match`;
    if (category) return `${category} Match`;
    return 'Style Match';
  })();

  const hasMetadata = category || color || silhouette || material;

  return (
    <View style={styles.container} testID={testID ?? 'style-match-panel'}>
      <View style={styles.headerRow}>
        <Text style={styles.title} accessibilityRole="header">
          {displayTitle}
        </Text>

        {formattedConfidence !== null && formattedConfidence >= 50 && (
          <StatusPill
            label={`${formattedConfidence}% MATCH`}
            variant="gold"
            accessibilityLabel={`Match confidence: ${formattedConfidence} percent`}
          />
        )}
      </View>

      {hasMetadata ? (
        <View style={styles.metaRow}>
          {category ? <MetadataChip label="Category" value={category} /> : null}
          {color ? <MetadataChip label="Color" value={color} /> : null}
          {silhouette ? <MetadataChip label="Silhouette" value={silhouette} /> : null}
          {material ? <MetadataChip label="Material" value={material} /> : null}
        </View>
      ) : null}

      {styleTags && styleTags.length > 0 ? (
        <View style={styles.tagRow}>
          {styleTags.map((tag) => (
            <View key={tag} style={styles.tag}>
              <Text style={styles.tagText}>{tag}</Text>
            </View>
          ))}
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    borderRadius: RADIUS.xl,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    padding: SPACING.xl,
    ...SHADOWS.editorialSmall,
  },
  headerRow: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    gap: SPACING.md,
    marginBottom: SPACING.lg,
  },
  title: {
    ...LUXURY.typography.displayTitle,
    flex: 1,
  },
  metaRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  tagRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
    marginTop: SPACING.lg,
  },
  tag: {
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.cream,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.xs,
  },
  tagText: {
    ...LUXURY.typography.caption,
    textTransform: 'none',
    letterSpacing: 0.4,
    color: LUXURY.colors.graphite,
  },
});
