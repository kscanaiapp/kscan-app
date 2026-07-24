import React from 'react';
import { Circle, Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Recent Scans — stacked scan cards with garment + gold history clock.
 */
export function RecentScansIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Back cards */}
      {!compact && (
        <Path
          d="M8 3.5 H17.5 Q19 3.5 19 5 V14.5"
          stroke={color}
          {...strokeProps}
        />
      )}
      <Path
        d={compact ? 'M6.5 4 H16.5 Q18 4 18 5.5 V15' : 'M6.5 4.5 H16.8 Q18.2 4.5 18.2 5.9 V15.2'}
        stroke={color}
        {...strokeProps}
      />

      {/* Front card */}
      <Path
        d={
          compact
            ? 'M4.5 6.2 H14.2 Q15.8 6.2 15.8 7.8 V18.2 Q15.8 19.8 14.2 19.8 H4.5 Q2.9 19.8 2.9 18.2 V7.8 Q2.9 6.2 4.5 6.2 Z'
            : 'M4 6.5 H14.5 Q16.2 6.5 16.2 8.2 V18.5 Q16.2 20.2 14.5 20.2 H4 Q2.3 20.2 2.3 18.5 V8.2 Q2.3 6.5 4 6.5 Z'
        }
        stroke={color}
        {...strokeProps}
      />

      {/* Inner corner brackets on front card */}
      <Path d="M5.2 8.2 H7.2 M5.2 8.2 V10" stroke={compact ? accentColor : color} {...strokeProps} strokeWidth={1.6} />
      <Path d="M13.2 8.2 H11.2 M13.2 8.2 V10" stroke={compact ? accentColor : color} {...strokeProps} strokeWidth={1.6} />
      <Path d="M5.2 17.8 H7.2 M5.2 17.8 V16" stroke={accentColor} {...strokeProps} strokeWidth={1.6} />
      <Path d="M13.2 17.8 H11.2 M13.2 17.8 V16" stroke={accentColor} {...strokeProps} strokeWidth={1.6} />

      {/* Dress on hanger */}
      <Path
        d="M9.2 8.8 C9.2 8.2 9.8 7.8 10.4 8.1"
        stroke={color}
        {...strokeProps}
        strokeWidth={1.6}
      />
      <Path
        d={
          compact
            ? 'M7.4 10.2 L9.2 9.4 L11 10.2 V12 H7.4 Z M7.4 12 L6.6 16.8 H11.8 L11 12'
            : 'M7.2 10.4 L9.2 9.5 L11.2 10.4 V12.2 H7.2 Z M7.2 12.2 L6.3 17.2 H12.1 L11.2 12.2'
        }
        stroke={color}
        {...strokeProps}
      />
      {!compact && (
        <>
          <Line x1={7.8} y1={13.4} x2={7.4} y2={16.8} stroke={color} {...strokeProps} strokeWidth={1.4} />
          <Line x1={9.2} y1={13.4} x2={9.2} y2={16.8} stroke={color} {...strokeProps} strokeWidth={1.4} />
          <Line x1={10.6} y1={13.4} x2={11} y2={16.8} stroke={color} {...strokeProps} strokeWidth={1.4} />
        </>
      )}

      {/* History clock */}
      <Circle
        cx={compact ? 17.6 : 18}
        cy={compact ? 17.6 : 18}
        r={compact ? 3.8 : 4}
        stroke={accentColor}
        {...strokeProps}
      />
      {/* Clock hands */}
      <Line
        x1={compact ? 17.6 : 18}
        y1={compact ? 17.6 : 18}
        x2={compact ? 17.6 : 18}
        y2={compact ? 15.4 : 15.6}
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />
      <Line
        x1={compact ? 17.6 : 18}
        y1={compact ? 17.6 : 18}
        x2={compact ? 19.4 : 19.8}
        y2={compact ? 18.8 : 19.2}
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />
      {/* Clockwise arrow tip */}
      <Path
        d={
          compact
            ? 'M20.4 16.2 L21.2 17.6 L19.6 18'
            : 'M20.8 16.4 L21.6 18 L19.8 18.4'
        }
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />
    </IconSvg>
  );
}
