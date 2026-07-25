import React from 'react';
import { Line, Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * TextScan — scan brackets, three text lines, one secondary gold sparkle.
 */
export function TextScanIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  const inset = compact ? 3.2 : 2.8;
  const arm = compact ? 3.6 : 4;
  const right = 24 - inset;
  const bottom = 24 - inset;
  const sparkleCx = compact ? 18.8 : 19.2;
  const sparkleCy = compact ? 5 : 4.6;
  const sparkleR = compact ? 2.2 : 2;

  const lineX = compact ? 7 : 6.5;
  const y1 = compact ? 9.2 : 9;
  const y2 = compact ? 12.4 : 12.5;
  const y3 = compact ? 15.6 : 16;
  const w1 = compact ? 8.5 : 9;
  const w2 = compact ? 10 : 10.5;
  const w3 = compact ? 6.5 : 7;

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      <Path
        d={`M${inset} ${inset + arm} V${inset + 1.2} Q${inset} ${inset} ${inset + 1.2} ${inset} H${inset + arm}`}
        stroke={color}
        {...strokeProps}
      />
      {/* Top-right bracket interrupted for sparkle */}
      <Path
        d={`M${right - arm} ${inset} H${sparkleCx - sparkleR - 0.6}`}
        stroke={color}
        {...strokeProps}
      />
      <Path
        d={`M${right} ${sparkleCy + sparkleR + 0.6} V${inset + arm}`}
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

      <Line x1={lineX} y1={y1} x2={lineX + w1} y2={y1} stroke={color} {...strokeProps} />
      <Line x1={lineX} y1={y2} x2={lineX + w2} y2={y2} stroke={color} {...strokeProps} />
      <Line x1={lineX} y1={y3} x2={lineX + w3} y2={y3} stroke={color} {...strokeProps} />

      <Sparkle cx={sparkleCx} cy={sparkleCy} r={sparkleR} color={accentColor} />
    </IconSvg>
  );
}
