import React from 'react';
import Svg, { Path } from 'react-native-svg';
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
