import React from 'react';
import { Path } from 'react-native-svg';
import { IconSvg, ScanBrackets, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Visual Search — scan-corner brackets framing one centered garment.
 *
 * CONCEPT PRESERVED: brackets + a fashion item inside, never a generic
 * magnifier.
 *
 * WHAT CHANGED AND WHY: the previous garment drew a V-neckline and a full
 * shoulder box across the same band (y 5.8-9.2), so two strokes crossed inside
 * a four-unit space and read as a smudge rather than a neckline. The silhouette
 * is now a single closed tee outline — one continuous path, no self-crossing,
 * every vertex on a whole unit — so the shoulders, sleeves and neck stay
 * legible at the size Home actually renders.
 */
export function VisualSearchIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/*
        Gold frame, plum subject. Structure is the accent and the garment is the
        primary colour across this set, so the thing being acted on is always
        the thing that reads first.
      */}
      <ScanBrackets color={accentColor} />
      {/*
        Sleeveless tee: left shoulder, neck V, right shoulder, sleeve tip,
        sleeve underarm, body, hem. Closed with Z so the shoulder line is a
        join rather than two overlapping caps. Compact pulls the sleeve tips in
        by one unit so they cannot crowd the brackets at small render sizes.
      */}
      <Path
        d={
          compact
            ? 'M9 6 L12 8 L15 6 L16 9 L15 11 V18 H9 V11 L8 9 Z'
            : 'M9 6 L12 8 L15 6 L17 9 L15 11 V18 H9 V11 L7 9 Z'
        }
        stroke={color}
        {...strokeProps}
      />
    </IconSvg>
  );
}
