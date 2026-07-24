import React from 'react';
import { Circle, Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Save & Organize — wardrobe with hanging dress, shelves, and gold check badge.
 */
export function SaveOrganizeIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Wardrobe frame */}
      <Path
        d="M3.5 4.5 H20.5 Q21.5 4.5 21.5 5.5 V20 H3.5 V5.5 Q3.5 4.5 4.5 4.5"
        stroke={color}
        {...strokeProps}
      />
      <Line x1={3.5} y1={21.2} x2={21.5} y2={21.2} stroke={color} {...strokeProps} />
      {/* Vertical divider */}
      <Line x1={14} y1={4.5} x2={14} y2={20} stroke={color} {...strokeProps} />

      {/* Left: rod + hanger + dress */}
      <Line x1={5} y1={6.5} x2={12.5} y2={6.5} stroke={color} {...strokeProps} />
      <Circle cx={5} cy={6.5} r={0.7} fill={color} stroke="none" />
      <Circle cx={12.5} cy={6.5} r={0.7} fill={color} stroke="none" />
      <Path d="M8.8 6.5 C8.8 5.9 9.3 5.6 9.7 5.9" stroke={color} {...strokeProps} strokeWidth={1.6} />
      <Path
        d={
          compact
            ? 'M6.6 8.2 L8.8 7.4 L11 8.2 V10 H6.6 Z M6.6 10 L5.8 16.5 H11.8 L11 10'
            : 'M6.4 8.4 L8.8 7.5 L11.2 8.4 V10.2 H6.4 Z M6.4 10.2 L5.5 17 H12.1 L11.2 10.2'
        }
        stroke={color}
        {...strokeProps}
      />
      {!compact && (
        <>
          <Line x1={7.2} y1={11.6} x2={6.6} y2={16.5} stroke={color} {...strokeProps} strokeWidth={1.4} />
          <Line x1={8.8} y1={11.6} x2={8.8} y2={16.5} stroke={color} {...strokeProps} strokeWidth={1.4} />
          <Line x1={10.4} y1={11.6} x2={11} y2={16.5} stroke={color} {...strokeProps} strokeWidth={1.4} />
        </>
      )}

      {/* Right shelves */}
      <Line x1={14} y1={8.2} x2={21.5} y2={8.2} stroke={color} {...strokeProps} />
      <Line x1={14} y1={11.4} x2={21.5} y2={11.4} stroke={color} {...strokeProps} />
      <Line x1={14} y1={14.6} x2={21.5} y2={14.6} stroke={color} {...strokeProps} />
      <Line x1={14} y1={17.8} x2={21.5} y2={17.8} stroke={color} {...strokeProps} />

      {/* Gold handbag (top shelf) */}
      <Path
        d="M16.2 6.2 H19.6 L20.2 7.8 H15.6 Z M17.2 5.5 Q17.9 4.8 18.6 5.5"
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />

      {/* Folded clothes */}
      <Path
        d="M15.8 9.4 H19.8 M15.8 10.4 H19.2"
        stroke={color}
        {...strokeProps}
        strokeWidth={1.6}
      />

      {/* Drawer knobs */}
      <Circle cx={17.8} cy={13} r={compact ? 0.9 : 0.75} fill={accentColor} stroke="none" />
      <Circle cx={17.8} cy={16.2} r={compact ? 0.9 : 0.75} fill={accentColor} stroke="none" />

      {/* Gold shoe */}
      <Path
        d="M15.6 19.6 H19.2 Q20.2 19.6 20.2 18.8 L19.4 18.2 H16.8 L15.8 19"
        stroke={accentColor}
        {...strokeProps}
        strokeWidth={1.6}
      />
      <Line x1={15.6} y1={19.6} x2={15.6} y2={18.4} stroke={accentColor} {...strokeProps} strokeWidth={1.6} />

      {/* Save check badge */}
      <Circle
        cx={compact ? 12.2 : 12}
        cy={compact ? 16.8 : 17}
        r={compact ? 3.4 : 3.2}
        stroke={accentColor}
        {...strokeProps}
      />
      <Path
        d={
          compact
            ? 'M10.6 16.8 L11.8 18 L14 15.6'
            : 'M10.4 17 L11.7 18.3 L13.9 15.8'
        }
        stroke={accentColor}
        {...strokeProps}
      />
    </IconSvg>
  );
}
