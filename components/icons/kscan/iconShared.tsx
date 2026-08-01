import React from 'react';
import Svg, { Path, G } from 'react-native-svg';
import { LUXURY } from '../../../constants/theme';
import {
  KSCAN_ICON_STROKE,
  KSCAN_ICON_VIEWBOX,
  type KScanIconGlyphProps,
} from './iconTypes';

export function resolveIconColors(props: KScanIconGlyphProps) {
  return {
    color: props.color ?? LUXURY.colors.plum,
    accentColor: props.accentColor ?? LUXURY.colors.goldBrushed,
    size: props.size ?? 24,
    variant: props.variant ?? 'standard',
  };
}

export function iconA11yProps(accessibilityLabel?: string) {
  if (accessibilityLabel) {
    return {
      accessible: true as const,
      accessibilityRole: 'image' as const,
      accessibilityLabel,
    };
  }
  return {
    accessible: false as const,
    importantForAccessibility: 'no' as const,
  };
}

export const strokeProps = {
  strokeWidth: KSCAN_ICON_STROKE,
  strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const,
  fill: 'none' as const,
};

/** Four-point AI sparkle centered at (cx, cy) with half-extent `r`. */
export function Sparkle({
  cx,
  cy,
  r,
  color,
  filled = false,
}: {
  cx: number;
  cy: number;
  r: number;
  color: string;
  filled?: boolean;
}) {
  const d = [
    `M${cx} ${cy - r}`,
    `C${cx} ${cy - r * 0.28} ${cx + r * 0.28} ${cy} ${cx + r} ${cy}`,
    `C${cx + r * 0.28} ${cy} ${cx} ${cy + r * 0.28} ${cx} ${cy + r}`,
    `C${cx} ${cy + r * 0.28} ${cx - r * 0.28} ${cy} ${cx - r} ${cy}`,
    `C${cx - r * 0.28} ${cy} ${cx} ${cy - r * 0.28} ${cx} ${cy - r}`,
    'Z',
  ].join(' ');

  return (
    <Path
      d={d}
      stroke={color}
      fill={filled ? color : 'none'}
      {...strokeProps}
      strokeWidth={filled ? 1.5 : KSCAN_ICON_STROKE}
    />
  );
}

/**
 * The four scan-corner brackets shared by Visual Search and TextScan.
 *
 * WHY THIS IS SHARED: both icons frame their subject with the same scan
 * language, and drawing them twice is how the two drifted apart — TextScan's
 * top-right bracket had been broken into two segments to make room for a
 * sparkle, so the two icons no longer read as the same system. One primitive
 * makes that class of drift impossible.
 *
 * GEOMETRY: corners sit on integer coordinates (3 / 21) with integer arms and a
 * radius-2 round. Every coordinate is a whole unit so that at a 1:1 render the
 * stroke edges land on whole device pixels instead of being antialiased across
 * two rows — which is what made the previous brackets look soft.
 */
export function ScanBrackets({ color }: { color: string }) {
  return (
    <G stroke={color} {...strokeProps}>
      <Path d="M3 7 V5 A2 2 0 0 1 5 3 H7" />
      <Path d="M17 3 H19 A2 2 0 0 1 21 5 V7" />
      <Path d="M3 17 V19 A2 2 0 0 0 5 21 H7" />
      <Path d="M17 21 H19 A2 2 0 0 0 21 19 V17" />
    </G>
  );
}

export function IconSvg({
  size,
  accessibilityLabel,
  children,
}: {
  size: number;
  accessibilityLabel?: string;
  children: React.ReactNode;
}) {
  const a11y = iconA11yProps(accessibilityLabel);
  return (
    <Svg
      width={size}
      height={size}
      viewBox={KSCAN_ICON_VIEWBOX}
      preserveAspectRatio="xMidYMid meet"
      {...a11y}
    >
      {children}
    </Svg>
  );
}
