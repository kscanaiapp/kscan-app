import React from 'react';
import { Path, Rect } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Voice Scan — a microphone.
 *
 * The Voice Scan pill previously carried no glyph at all, which made it the
 * only entry on Home identified by text alone and left the secondary row
 * visually lopsided against TextScan.
 *
 * The feature is inactive, so this is drawn to be tinted by its caller rather
 * than to assert itself: the pill passes its own muted colour, and the glyph
 * inherits it through the standard `color` prop like every other icon. Nothing
 * here encodes the disabled state — that stays the pill's decision.
 *
 * Three forms only — capsule, cradle, stem — with a clear gap between the
 * capsule and the cradle. A microphone is one of the few shapes that survives
 * this size intact, provided that gap is never closed up.
 */
export function VoiceScanIcon(props: KScanIconGlyphProps) {
  const { color, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      {/* Capsule. */}
      <Rect
        x={compact ? 10 : 9.5}
        y={4}
        width={compact ? 4 : 5}
        height={compact ? 9 : 10}
        rx={compact ? 2 : 2.5}
        stroke={color}
        {...strokeProps}
      />
      {/* Cradle. */}
      <Path
        d={compact ? 'M7 12 A5 5 0 0 0 17 12' : 'M6.5 12 A5.5 5.5 0 0 0 17.5 12'}
        stroke={color}
        {...strokeProps}
      />
      {/* Stem. */}
      <Path d="M12 17.5 V20" stroke={color} {...strokeProps} />
    </IconSvg>
  );
}
