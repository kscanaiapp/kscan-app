import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Visual Search — scan-corner brackets framing one centered garment.
 * Plum only. No magnifier, sparkle, or secondary badge.
 */
export function VisualSearchIcon(props: KScanIconGlyphProps) {
  const { color, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';
  const inset = compact ? 3 : 2.5;
  const arm = compact ? 4 : 4.5;
  const right = 24 - inset;
  const bottom = 24 - inset;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      <Path
        d={`M${inset} ${inset + arm} V${inset + 1.2} Q${inset} ${inset} ${inset + 1.2} ${inset} H${inset + arm}`}
        stroke={color}
        {...strokeProps}
      />
      <Path
        d={`M${right - arm} ${inset} H${right - 1.2} Q${right} ${inset} ${right} ${inset + 1.2} V${inset + arm}`}
        stroke={color}
        {...strokeProps}
      />
      <Path
        d={`M${inset} ${bottom - arm} V${bottom - 1.2} Q${inset} ${bottom} ${inset + 1.2} ${bottom} H${inset + arm}`}
        stroke={color}
        {...strokeProps}
      />
      <Path
        d={`M${right - arm} ${bottom} H${right - 1.2} Q${right} ${bottom} ${right} ${bottom - 1.2} V${bottom - arm}`}
        stroke={color}
        {...strokeProps}
      />
      {/* Simple sleeveless dress silhouette */}
      <Path
        d={
          compact
            ? 'M9.2 6.2 L12 8.6 L14.8 6.2 M9.2 6.2 V9.4 H14.8 V6.2 M9.2 9.4 L7.8 17.8 H16.2 L14.8 9.4'
            : 'M9 5.8 L12 8.4 L15 5.8 M9 5.8 V9.2 H15 V5.8 M9 9.2 L7.5 18.2 H16.5 L15 9.2'
        }
        stroke={color}
        {...strokeProps}
      />
    </IconSvg>
  );
}
