import React from 'react';
import { Circle, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Smart Watchlist — a price tag, the plainest available signifier of "an
 * offer I'm tracking", with a small accent dot standing in for the target
 * price rather than a literal clock/eye (both read as generic "recent" /
 * "view", already used elsewhere in this set).
 *
 * Matches the existing glyph conventions: whole-unit coordinates, 1.5-unit
 * stroke, plum body / gold accent, single continuous outline with nothing
 * crossing anything else.
 */
export function WatchlistIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Tag body: a rotated rounded square with a flattened left point,
          tied off by the string hole in the upper-left corner. */}
      <Path
        d={
          compact
            ? 'M10 4 H18 A2 2 0 0 1 20 6 V14 L11 20 L4 13 A2 2 0 0 1 4 10 Z'
            : 'M10 3 H19 A2 2 0 0 1 21 5 V14 L11 21 L3 13 A2 2 0 0 1 3 10 Z'
        }
        stroke={color}
        {...strokeProps}
      />
      {/* String hole. */}
      <Circle cx={compact ? 14 : 15} cy={compact ? 8 : 7} r={1.4} stroke={color} {...strokeProps} />
      {/* Target-price accent dot, offset toward the tag's lower point. */}
      <Circle cx={compact ? 9 : 9} cy={compact ? 15 : 15} r={1.6} fill={accentColor} />
    </IconSvg>
  );
}
