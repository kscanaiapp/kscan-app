import React from 'react';
import { Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * TextScan — scan brackets framing three text lines + gold AI sparkle.
 * Compact variant widens gaps and enlarges the sparkle for 20–22 px use.
 */
export function TextScanIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  const bracket = compact ? 3.2 : 3.6;
  const inset = compact ? 3.5 : 3;
  const right = 24 - inset;
  const bottom = 24 - inset;

  // Top-right bracket is interrupted for the sparkle.
  const sparkleCx = compact ? 19.2 : 19.5;
  const sparkleCy = compact ? 4.8 : 4.5;
  const sparkleR = compact ? 2.4 : 2.1;

  const lineY1 = compact ? 9.5 : 9;
  const lineY2 = compact ? 12.5 : 12.5;
  const lineY3 = compact ? 15.5 : 16;
  const lineX = compact ? 7 : 6.5;
  const lineW1 = compact ? 8.5 : 9.5;
  const lineW2 = compact ? 10.5 : 11.5;
  const lineW3 = compact ? 6.5 : 7;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* TL */}
      <Path
        d={`M${inset} ${inset + bracket} V${inset + 1.2} Q${inset} ${inset} ${inset + 1.2} ${inset} H${inset + bracket}`}
        stroke={color}
        {...strokeProps}
      />
      {/* TR — split around sparkle */}
      <Path
        d={`M${right - bracket} ${inset} H${sparkleCx - sparkleR - 0.8}`}
        stroke={color}
        {...strokeProps}
      />
      <Path
        d={`M${right} ${sparkleCy + sparkleR + 0.8} V${inset + bracket}`}
        stroke={color}
        {...strokeProps}
      />
      {/* BL */}
      <Path
        d={`M${inset} ${bottom - bracket} V${bottom - 1.2} Q${inset} ${bottom} ${inset + 1.2} ${bottom} H${inset + bracket}`}
        stroke={color}
        {...strokeProps}
      />
      {/* BR */}
      <Path
        d={`M${right - bracket} ${bottom} H${right - 1.2} Q${right} ${bottom} ${right} ${bottom - 1.2} V${bottom - bracket}`}
        stroke={color}
        {...strokeProps}
      />

      <Line x1={lineX} y1={lineY1} x2={lineX + lineW1} y2={lineY1} stroke={color} {...strokeProps} />
      <Line x1={lineX} y1={lineY2} x2={lineX + lineW2} y2={lineY2} stroke={color} {...strokeProps} />
      <Line x1={lineX} y1={lineY3} x2={lineX + lineW3} y2={lineY3} stroke={color} {...strokeProps} />

      <Sparkle cx={sparkleCx} cy={sparkleCy} r={sparkleR} color={accentColor} />
    </IconSvg>
  );
}
