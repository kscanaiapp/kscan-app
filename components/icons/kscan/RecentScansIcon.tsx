import React from 'react';
import { Line, Path, Rect } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Recent Scans — two stacked scan cards with an integrated corner clock.
 * Wire glyph: plum cards/clock outline; optional gold clock hand.
 */
export function RecentScansIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Back card */}
      <Rect
        x={compact ? 5.5 : 5}
        y={compact ? 3.5 : 3}
        width={compact ? 13 : 14}
        height={compact ? 15 : 16}
        rx={2.5}
        stroke={color}
        {...strokeProps}
      />
      {/* Front card */}
      <Rect
        x={compact ? 2.5 : 2}
        y={compact ? 6.5 : 6}
        width={compact ? 13 : 14}
        height={compact ? 15 : 16}
        rx={2.5}
        stroke={color}
        {...strokeProps}
      />
      {/* Integrated clock arc in front-card lower-right corner */}
      <Path
        d={
          compact
            ? 'M12.2 16.8 A3.2 3.2 0 1 1 15.4 19.8'
            : 'M12.5 16.2 A3.4 3.4 0 1 1 15.8 19.5'
        }
        stroke={color}
        {...strokeProps}
      />
      <Line
        x1={compact ? 13.8 : 14.2}
        y1={compact ? 18.2 : 17.8}
        x2={compact ? 13.8 : 14.2}
        y2={compact ? 16.6 : 16}
        stroke={accentColor}
        {...strokeProps}
      />
      <Line
        x1={compact ? 13.8 : 14.2}
        y1={compact ? 18.2 : 17.8}
        x2={compact ? 15.2 : 15.8}
        y2={compact ? 18.8 : 18.6}
        stroke={accentColor}
        {...strokeProps}
      />
    </IconSvg>
  );
}
