import React from 'react';
import { Circle, Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Visual Search — garment in scan brackets with gold magnifier + AI sparkle.
 */
export function VisualSearchIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  const inset = 2.5;
  const right = 24 - inset;
  const bottom = 24 - inset;
  const arm = compact ? 3.2 : 3.8;

  const lensCx = compact ? 15.5 : 15.8;
  const lensCy = compact ? 15.2 : 15.5;
  const lensR = compact ? 4.2 : 4.6;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Scan brackets */}
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
      {/* BR bracket shortened for magnifier handle */}
      <Path
        d={`M${right - arm} ${bottom} H${right - 2.2}`}
        stroke={color}
        {...strokeProps}
      />

      {/* Dress */}
      <Path
        d={
          compact
            ? 'M9.2 5.8 L12 8.2 L14.8 5.8 M9.2 5.8 V9.2 H14.8 V5.8 M9.2 9.2 H14.8 V11 H9.2 Z M9.2 11 L7.8 18.2 H16.2 L14.8 11'
            : 'M9 5.5 L12 8 L15 5.5 M9 5.5 V9.4 H15 V5.5 M9 9.4 H15 V11.2 H9 Z M9 11.2 L7.5 18.5 H16.5 L15 11.2'
        }
        stroke={color}
        {...strokeProps}
      />
      {!compact && (
        <>
          <Line x1={10.2} y1={13.2} x2={9.6} y2={18.2} stroke={color} {...strokeProps} strokeWidth={1.5} />
          <Line x1={11.4} y1={13.2} x2={11} y2={18.2} stroke={color} {...strokeProps} strokeWidth={1.5} />
          <Line x1={12.6} y1={13.2} x2={13} y2={18.2} stroke={color} {...strokeProps} strokeWidth={1.5} />
          <Line x1={13.8} y1={13.2} x2={14.4} y2={18.2} stroke={color} {...strokeProps} strokeWidth={1.5} />
        </>
      )}

      {/* Magnifier */}
      <Circle cx={lensCx} cy={lensCy} r={lensR} stroke={accentColor} {...strokeProps} />
      <Path
        d={`M${lensCx + lensR * 0.72} ${lensCy + lensR * 0.72} L${lensCx + lensR + 2.4} ${lensCy + lensR + 2.2}`}
        stroke={color}
        {...strokeProps}
      />

      <Sparkle
        cx={compact ? 17.2 : 17.5}
        cy={compact ? 8.2 : 8}
        r={compact ? 1.9 : 1.7}
        color={accentColor}
      />
    </IconSvg>
  );
}
