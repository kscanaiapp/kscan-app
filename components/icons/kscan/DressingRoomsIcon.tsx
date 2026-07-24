import React from 'react';
import { Circle, Ellipse, Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Dressing Rooms — two outfit panels with central gold mirror (comparison).
 */
export function DressingRoomsIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Base */}
      <Path
        d="M2.5 21 H21.5"
        stroke={color}
        {...strokeProps}
      />

      {/* Left panel */}
      <Path
        d="M3 21 V6.5 Q3 4.5 5 4.5 H9.2 Q10.5 4.5 10.5 6 V21"
        stroke={color}
        {...strokeProps}
      />
      {/* Right panel */}
      <Path
        d="M21 21 V6.5 Q21 4.5 19 4.5 H14.8 Q13.5 4.5 13.5 6 V21"
        stroke={color}
        {...strokeProps}
      />

      {/* Left dress + hanger */}
      <Path d="M6.6 6.2 C6.6 5.6 7.1 5.3 7.5 5.6" stroke={color} {...strokeProps} strokeWidth={1.6} />
      <Path
        d={
          compact
            ? 'M5.2 7.6 L6.8 6.9 L8.4 7.6 V9.2 H5.2 Z M5.2 9.2 L4.6 14.5 H9 L8.4 9.2'
            : 'M5 7.8 L6.8 7 L8.6 7.8 V9.5 H5 Z M5 9.5 L4.3 15 H9.3 L8.6 9.5'
        }
        stroke={color}
        {...strokeProps}
      />
      {/* Gold shoe left */}
      <Path
        d="M4.8 18.2 H7.6 Q8.4 18.2 8.4 17.5 L7.8 16.9 H5.8 L4.8 17.6"
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />
      <Line x1={4.8} y1={18.2} x2={4.8} y2={17.2} stroke={accentColor} {...strokeProps} strokeWidth={1.6} />

      {/* Right suit + hanger */}
      <Path d="M16.4 6.2 C16.4 5.6 16.9 5.3 17.3 5.6" stroke={color} {...strokeProps} strokeWidth={1.6} />
      <Path
        d={
          compact
            ? 'M14.6 7.5 H19.2 V10.8 H14.6 Z M15.4 10.8 V14.8 H18.4 V10.8 M16 7.5 L16.9 8.6 L17.8 7.5'
            : 'M14.4 7.6 H19.4 V11.2 H14.4 Z M15.2 11.2 V15.2 H18.6 V11.2 M15.8 7.6 L16.9 8.9 L18 7.6'
        }
        stroke={color}
        {...strokeProps}
      />
      {!compact && <Circle cx={16.9} cy={10} r={0.55} fill={accentColor} stroke="none" />}
      {/* Gold bag right */}
      <Path
        d="M15.2 17.2 H18.6 L19 18.8 H14.8 Z M16.2 16.4 Q16.9 15.6 17.6 16.4"
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />

      {/* Central gold mirror */}
      <Ellipse
        cx={12}
        cy={compact ? 12.2 : 12.5}
        rx={compact ? 1.7 : 1.9}
        ry={compact ? 6.2 : 6.8}
        stroke={accentColor}
        {...strokeProps}
      />
      <Line
        x1={11.3}
        y1={compact ? 11.2 : 11.5}
        x2={12.7}
        y2={compact ? 12.4 : 12.8}
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.5}
      />
      <Line
        x1={11.3}
        y1={compact ? 12.6 : 13}
        x2={12.7}
        y2={compact ? 13.8 : 14.3}
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.5}
      />
      {/* Mirror hinges */}
      <Circle cx={10.5} cy={compact ? 12.2 : 12.5} r={0.7} fill={accentColor} stroke="none" />
      <Circle cx={13.5} cy={compact ? 12.2 : 12.5} r={0.7} fill={accentColor} stroke="none" />
      {/* Mirror legs */}
      <Line x1={11.2} y1={compact ? 18.4 : 19.2} x2={11.2} y2={21} stroke={accentColor} {...strokeProps} strokeWidth={1.5} />
      <Line x1={12.8} y1={compact ? 18.4 : 19.2} x2={12.8} y2={21} stroke={accentColor} {...strokeProps} strokeWidth={1.5} />

      <Sparkle cx={12} cy={compact ? 3.6 : 3.2} r={compact ? 1.7 : 1.5} color={accentColor} />
    </IconSvg>
  );
}
