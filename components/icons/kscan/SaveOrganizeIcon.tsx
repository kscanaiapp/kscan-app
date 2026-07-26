import React from 'react';
import { Path, Rect } from 'react-native-svg';
import { IconSvg, resolveIconColors, strokeProps } from './iconShared';
import type { KScanIconGlyphProps } from './iconTypes';

/**
 * Save & Organize — one saved-item card with an integrated gold bookmark tab.
 */
export function SaveOrganizeIcon(props: KScanIconGlyphProps) {
  const { color, accentColor, size, variant } = resolveIconColors(props);
  const compact = variant === 'compact';

  return (
    <IconSvg size={size} accessibilityLabel={props.accessibilityLabel}>
      <Rect
        x={compact ? 4 : 3.5}
        y={compact ? 4 : 3.5}
        width={compact ? 16 : 17}
        height={compact ? 16.5 : 17.5}
        rx={2.5}
        stroke={color}
        {...strokeProps}
      />
      {/* Integrated bookmark tab on the top edge */}
      <Path
        d={
          compact
            ? 'M14.2 4 V9.2 L15.8 7.8 L17.4 9.2 V4'
            : 'M14.5 3.5 V9.5 L16.2 8 L17.9 9.5 V3.5'
        }
        stroke={accentColor}
        {...strokeProps}
      />
    </IconSvg>
  );
}
