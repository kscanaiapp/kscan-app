import React from 'react';
import { Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Dressing Rooms — standing arch mirror with a minimal floor stand.
 * Plum only. No clothing, shelves, or interior decoration.
 */
export function DressingRoomsIcon(props: KScanIconGlyphProps) {
  const { color, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Arch mirror outline */}
      <Path
        d={
          compact
            ? 'M6.5 18.5 V10.5 A5.5 5.5 0 0 1 17.5 10.5 V18.5 Z'
            : 'M6 19 V10 A6 6 0 0 1 18 10 V19 Z'
        }
        stroke={color}
        {...strokeProps}
      />
      {/* Floor stand / base */}
      <Line
        x1={12}
        y1={compact ? 18.5 : 19}
        x2={12}
        y2={compact ? 20.5 : 21}
        stroke={color}
        {...strokeProps}
      />
      <Line
        x1={compact ? 8.5 : 8}
        y1={compact ? 20.5 : 21}
        x2={compact ? 15.5 : 16}
        y2={compact ? 20.5 : 21}
        stroke={color}
        {...strokeProps}
      />
    </IconSvg>
  );
}
