/**
 * Full-body framing guide shown before the user picks a try-on photo.
 *
 * WHY A GUIDE AND NOT A DETECTOR. The generation provider does markedly
 * better with a clean, full-body, front-facing photo than with a cropped
 * selfie, and the cheapest place to fix that is BEFORE the picker opens --
 * a bad input costs a full generation round trip to discover. This is a
 * purely decorative overlay: it runs no pose estimation, reads no pixels,
 * and never blocks or grades a photo. It only shows the shape we would like
 * the photo to fill.
 *
 * VTO's architecture is photo-library based (services/vto/vtoPersonInput.ts
 * opens ImagePicker; there is no in-app VTO camera), so "the capture screen"
 * is the pre-selection state of the sheet. That is where this renders.
 *
 * Faint by construction: at these opacities it reads as a watermark behind
 * the copy, not as a frame the user must obey.
 */

import React from 'react';
import { StyleSheet, Text, View } from 'react-native';
import Svg, { Ellipse, Path } from 'react-native-svg';

import { LUXURY, SPACING } from '../../constants/theme';

/** The one behavioural nudge that measurably improves provider output. */
export const VTO_SILHOUETTE_HELPER_TEXT =
  'Stand back and face the camera for the best result.';

const VIEWBOX = '0 0 120 200';
const STROKE_OPACITY = 0.45;
const FILL_OPACITY = 0.1;

export interface VtoSilhouetteGuideProps {
  /** Overall height of the guide; width follows the 0.6 aspect of the viewBox. */
  height?: number;
  testID?: string;
}

export function VtoSilhouetteGuide({ height = 168, testID }: VtoSilhouetteGuideProps) {
  const width = height * 0.6;
  return (
    <View style={styles.wrap} testID={testID ?? 'vto-silhouette-guide'}>
      {/*
          Decorative only: the helper text below carries the meaning, so the
          drawing itself is hidden from assistive tech rather than announced
          as a second, redundant description.
      */}
      <View
        accessible={false}
        importantForAccessibility="no"
        style={{ width, height }}
      >
        <Svg width={width} height={height} viewBox={VIEWBOX}>
          {/* Head */}
          <Ellipse
            cx={60}
            cy={26}
            rx={15}
            ry={18}
            stroke={LUXURY.colors.plum}
            strokeOpacity={STROKE_OPACITY}
            strokeWidth={2}
            fill={LUXURY.colors.plum}
            fillOpacity={FILL_OPACITY}
          />
          {/* Torso, arms and legs as one continuous standing figure. */}
          <Path
            d="M60 46
               C50 46 44 52 42 60
               L34 96
               C33 101 30 104 26 105
               L26 112
               C33 111 38 107 40 101
               L44 88
               L44 128
               C44 133 45 137 46 142
               L49 186
               L58 186
               L58 140
               L62 140
               L62 186
               L71 186
               L74 142
               C75 137 76 133 76 128
               L76 88
               L80 101
               C82 107 87 111 94 112
               L94 105
               C90 104 87 101 86 96
               L78 60
               C76 52 70 46 60 46 Z"
            stroke={LUXURY.colors.plum}
            strokeOpacity={STROKE_OPACITY}
            strokeWidth={2}
            strokeLinejoin="round"
            fill={LUXURY.colors.plum}
            fillOpacity={FILL_OPACITY}
          />
        </Svg>
      </View>
      <Text style={styles.helper}>{VTO_SILHOUETTE_HELPER_TEXT}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  wrap: {
    alignItems: 'center',
    marginTop: SPACING.sm,
    marginBottom: SPACING.sm,
  },
  helper: {
    ...LUXURY.typography.caption,
    marginTop: SPACING.sm,
    textAlign: 'center',
    textTransform: 'none',
    letterSpacing: 0.2,
    color: LUXURY.colors.stone,
  },
});
