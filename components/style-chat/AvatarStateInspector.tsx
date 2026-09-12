import { StyleSheet, Text, View } from 'react-native';
import type { AvatarPresentation } from '../../services/avatars/avatarPresentation';

/**
 * Development-only avatar state inspector.
 *
 * It exists so a wrong avatar state is diagnosable without a debugger: it shows
 * the authoritative inputs next to the state they projected to, and the reason
 * the projection gave.
 *
 * Hard constraints, all asserted by `__tests__/avatarStateInspector.test.js`:
 *
 *   - absent from production: the component returns null unless `__DEV__`,
 *   - read-only: it holds no state, starts no timer, subscribes to nothing,
 *   - no network: it makes no request of any kind,
 *   - no accessibility focus: the whole panel is hidden from assistive
 *     technology, so it cannot steal focus from Elise.
 */

export interface AvatarStateInspectorProps {
  presentation: AvatarPresentation;
  /** Authoritative playback phase, as the store reports it. */
  playbackPhase: string;
  /** Authoritative Elise processing state. */
  eliseProcessing: boolean;
  /** Whether the store's utterance belongs to this surface. */
  playbackScopeMatches: boolean;
  /** The host's current animation epoch. */
  motionEpoch: number;
  reduceMotion: boolean;
}

function isDevelopment(): boolean {
  return typeof __DEV__ !== 'undefined' && __DEV__ === true;
}

export function AvatarStateInspector({
  presentation,
  playbackPhase,
  eliseProcessing,
  playbackScopeMatches,
  motionEpoch,
  reduceMotion,
}: AvatarStateInspectorProps) {
  if (!isDevelopment()) return null;

  const rows: readonly [string, string][] = [
    ['elise', eliseProcessing ? 'processing' : 'idle'],
    ['playback', `${playbackPhase}${playbackScopeMatches ? '' : ' (out of scope)'}`],
    ['utterance', presentation.utteranceGeneration === null
      ? 'none'
      : `gen ${presentation.utteranceGeneration}`],
    ['epoch', String(motionEpoch)],
    ['avatar', presentation.state + (presentation.speakingDegraded ? ' (degraded)' : '')],
    ['renderer', presentation.rendererState],
    ['reason', presentation.reason],
    ['reduce motion', reduceMotion ? 'on' : 'off'],
  ];

  return (
    <View
      testID="avatar-state-inspector"
      accessibilityElementsHidden
      importantForAccessibility="no-hide-descendants"
      pointerEvents="none"
      style={styles.panel}
    >
      {rows.map(([label, value]) => (
        <Text key={label} style={styles.row} numberOfLines={1}>
          {label}: {value}
        </Text>
      ))}
    </View>
  );
}

const styles = StyleSheet.create({
  panel: {
    position: 'absolute',
    left: 4,
    bottom: 4,
    paddingHorizontal: 6,
    paddingVertical: 4,
    borderRadius: 4,
    backgroundColor: 'rgba(9, 7, 13, 0.72)',
    maxWidth: 220,
  },
  row: {
    color: '#FFFDF9',
    fontSize: 9,
    lineHeight: 12,
  },
});
