import React from 'react';
import { Circle, Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Style — polished coordinated outfit (blazer + skirt) with gold accessories + AI sparkle.
 */
export function StyleIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Hanger hook */}
      <Path
        d="M12 3.2 C12 2.4 12.8 2.2 13.3 2.7"
        stroke={color}
        {...strokeProps}
      />
      <Path
        d="M7.5 6.2 L12 4.2 L16.5 6.2"
        stroke={color}
        {...strokeProps}
      />

      {/* Blazer body + sleeves */}
      <Path
        d={
          compact
            ? 'M7.5 6.2 L5.5 8.2 V14.5 H8 V11.5 H16 V14.5 H18.5 V8.2 L16.5 6.2 M10 6.8 L12 9.2 L14 6.8'
            : 'M7.2 6.4 L4.8 8.6 V15.2 H7.8 V12 H16.2 V15.2 H19.2 V8.6 L16.8 6.4 M9.6 6.8 L12 9.6 L14.4 6.8'
        }
        stroke={color}
        {...strokeProps}
      />
      {/* Neckline under blazer */}
      {!compact && (
        <Path d="M10.4 8.8 Q12 10.2 13.6 8.8" stroke={color} {...strokeProps} strokeWidth={1.5} />
      )}
      {/* Gold button */}
      <Circle cx={12} cy={compact ? 11.2 : 11.6} r={compact ? 0.85 : 0.7} fill={accentColor} stroke="none" />

      {/* Skirt */}
      <Path
        d={
          compact
            ? 'M8 14.5 H16 L15.2 19.2 H8.8 Z'
            : 'M7.8 15.2 H16.2 L15.4 20 H8.6 Z'
        }
        stroke={color}
        {...strokeProps}
      />

      {/* Gold shoe */}
      <Path
        d={
          compact
            ? 'M3.8 20.2 H7.2 Q8.2 20.2 8.2 19.4 L7.4 18.6 H5.2 L3.8 19.5'
            : 'M3.5 20.5 H7.4 Q8.5 20.5 8.5 19.5 L7.6 18.6 H5 L3.5 19.6'
        }
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.7}
      />
      <Line
        x1={compact ? 3.8 : 3.5}
        y1={compact ? 20.2 : 20.5}
        x2={compact ? 3.8 : 3.5}
        y2={compact ? 18.8 : 19}
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.7}
      />

      {/* Gold handbag */}
      <Path
        d={
          compact
            ? 'M16.2 17.8 H20 L20.5 20.2 H15.7 Z M17.2 16.8 Q18.1 15.8 19 16.8'
            : 'M16 18 H20.2 L20.8 20.6 H15.4 Z M17.1 16.8 Q18.1 15.6 19.1 16.8'
        }
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.7}
      />
      {!compact && (
        <Line x1={16.2} y1={18.8} x2={20} y2={18.8} stroke={accentColor} {...strokeProps} strokeWidth={1.4} />
      )}

      <Sparkle
        cx={compact ? 18.4 : 18.8}
        cy={compact ? 5.2 : 4.8}
        r={compact ? 2.1 : 1.8}
        color={accentColor}
      />
    </IconSvg>
  );
}
