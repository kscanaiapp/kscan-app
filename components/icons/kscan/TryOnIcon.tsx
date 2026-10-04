import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg, resolveIconColors, Sparkle, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Try It On — a garment with the AI sparkle.
 *
 * The one glyph for Virtual Try-On, wherever it is introduced. It is a garment
 * and deliberately not a figure: the feature visualizes a piece of clothing,
 * and a drawn body would imply a body is being assessed, which it is not.
 *
 * The sparkle is the same four-point mark the Style and TextScan glyphs use for
 * "AI did this", in the caller's accent colour, so Try It On reads as part of
 * that family rather than as a new symbol to learn.
 */
export function TryOnIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Garment: shoulders, sleeves, body, with an open neckline. */}
      <Path
        d="M7.5 7 L3 9.5 L4.5 13 L7 12 V21 H14 V12 L16.5 13 L18 9.5 L13.5 7 Q10.5 10 7.5 7 Z"
        stroke={color}
        {...strokeProps}
      />
      <Sparkle cx={19} cy={5} r={compact ? 2 : 2.5} color={accentColor} filled={compact} />
    </IconSvg>
  );
}
