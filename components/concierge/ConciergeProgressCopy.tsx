/**
 * Build 34 / K+ Wardrobe Concierge -- the staged "working" copy.
 *
 * Renders the stage `conciergeProgress` says is current for the elapsed time.
 * It owns the ticker and nothing else: the copy, the timings and the decision
 * to show it at all live in the shared service, so iOS and Android cannot drift
 * into narrating the same wait differently.
 *
 * DELIBERATELY COPY-ONLY. It renders into the chat screen's EXISTING thinking
 * container and beside its existing spinner, so a Concierge wait and an
 * ordinary Elise wait are visually the same object with different words. A
 * second container here would have produced two subtly different indicators
 * that drift apart, which is a worse outcome than the duplication it avoids.
 *
 * IT NEVER REPORTS AN OUTCOME. There is no success state and no final tick.
 * The component unmounts when the send resolves, and the validated server
 * answer is the only thing that gets to say what was found.
 */

import { memo, useEffect, useRef, useState } from 'react';
import { View, Text, type StyleProp, type TextStyle, type ViewStyle } from 'react-native';
import {
  CONCIERGE_PROGRESS_STAGES,
  conciergeProgressStageAt,
  type ConciergeProgressStage,
} from '../../services/concierge/conciergeProgress';

/**
 * The stages are seconds apart, so a per-frame ticker would be pure battery
 * cost for a change the eye cannot see.
 */
const TICK_MS = 400;

interface Props {
  /** The chat screen's own copy styles, so the two indicators cannot diverge. */
  containerStyle?: StyleProp<ViewStyle>;
  titleStyle?: StyleProp<TextStyle>;
  subtitleStyle?: StyleProp<TextStyle>;
  /** Injected for tests; defaults to the shared stage list. */
  stages?: readonly ConciergeProgressStage[];
  /** Injected for tests so elapsed time is deterministic. */
  now?: () => number;
  testID?: string;
}

function ConciergeProgressCopyImpl({
  containerStyle,
  titleStyle,
  subtitleStyle,
  stages = CONCIERGE_PROGRESS_STAGES,
  now = Date.now,
  testID = 'concierge-progress',
}: Props) {
  // Captured on mount, so the elapsed clock starts when the WAIT starts rather
  // than whenever the first tick happens to land.
  const startedAt = useRef(now());
  const [elapsed, setElapsed] = useState(0);

  useEffect(() => {
    const id = setInterval(() => setElapsed(now() - startedAt.current), TICK_MS);
    return () => clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const stage = conciergeProgressStageAt(elapsed, stages);

  return (
    <View
      testID={testID}
      style={containerStyle}
      // One live region for the pair, so a screen reader announces a stage
      // change as a single sentence rather than two fragments. 'polite'
      // because this is progress, not an alert: it must never interrupt.
      accessible
      accessibilityRole="progressbar"
      accessibilityLiveRegion="polite"
      accessibilityLabel={`${stage.title} ${stage.subtitle}`}
    >
      <Text style={titleStyle} testID={`${testID}-title`}>
        {stage.title}
      </Text>
      <Text style={subtitleStyle} testID={`${testID}-subtitle`}>
        {stage.subtitle}
      </Text>
    </View>
  );
}

/**
 * Memoised: this lives in the chat list's footer and re-renders on its own
 * ticker. Without this it would also re-render whenever the list does, which
 * is every keystroke in the composer.
 */
export const ConciergeProgressCopy = memo(ConciergeProgressCopyImpl);
