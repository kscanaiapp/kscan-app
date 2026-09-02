// Elise "thinking" state.
//
// Two jobs, and the second is the important one: it looks like Elise is
// composing rather than like the app has frozen, AND after a threshold it stops
// claiming a speed it is not delivering. The copy escalation is honest, not
// decorative — a turn that has run past the escalation threshold really is
// doing more work (a fallback model, an incomplete-reply repair), and saying so
// is better than an indicator that reads identically at 1s and at 20s.
//
// Accessibility and motion:
//   - Reduce Motion collapses the animation to a static row; nothing else
//     changes, so the state is never conveyed by motion alone.
//   - The row is a polite live region announcing the current phase, so a
//     screen-reader user learns Elise is working and, later, that she is
//     taking longer — which is exactly what the dots convey visually.
//
// No new dependencies: React Native's own Animated driver, native-driven.

import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Animated, Easing, StyleSheet, Text, View } from 'react-native';

import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { ELISE_LOADING_COPY } from '../../constants/elise';
import { useReducedMotion } from '../../hooks/useReducedMotion';

/** After this long the copy stops promising a quick answer. */
export const ELISE_THINKING_ESCALATION_MS = 5_000;

const DOT_COUNT = 3;
const DOT_CYCLE_MS = 1_200;

export type EliseThinkingPhase = 'thinking' | 'taking_longer';

/** Pure: the phase for an elapsed duration. Exported for tests. */
export function resolveThinkingPhase(elapsedMs: number): EliseThinkingPhase {
  return elapsedMs >= ELISE_THINKING_ESCALATION_MS ? 'taking_longer' : 'thinking';
}

/** Pure: the copy for a phase. Exported for tests. */
export function thinkingCopyForPhase(phase: EliseThinkingPhase): {
  title: string;
  subtitle: string;
} {
  return phase === 'taking_longer'
    ? {
        title: ELISE_LOADING_COPY.thinkingLonger,
        subtitle: ELISE_LOADING_COPY.thinkingLongerSubtext,
      }
    : {
        title: ELISE_LOADING_COPY.thinking,
        subtitle: ELISE_LOADING_COPY.thinkingSubtext,
      };
}

function PulsingDots({ animate }: { animate: boolean }) {
  const progress = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    if (!animate) {
      progress.setValue(0);
      return;
    }
    const loop = Animated.loop(
      Animated.timing(progress, {
        toValue: DOT_COUNT,
        duration: DOT_CYCLE_MS,
        easing: Easing.linear,
        useNativeDriver: true,
      }),
    );
    loop.start();
    return () => {
      loop.stop();
      progress.setValue(0);
    };
  }, [animate, progress]);

  return (
    <View style={styles.dots} accessibilityElementsHidden importantForAccessibility="no-hide-descendants">
      {Array.from({ length: DOT_COUNT }, (_, index) => {
        // Each dot peaks a third of a cycle after the previous one, so the row
        // reads as a travelling swell rather than three independent blinks.
        const inputRange = [index - 1, index, index + 1, index + DOT_COUNT - 1, index + DOT_COUNT];
        const opacity = animate
          ? progress.interpolate({
              inputRange,
              outputRange: [0.28, 1, 0.28, 0.28, 1],
              extrapolate: 'clamp',
            })
          : 0.5;
        return (
          <Animated.View
            key={index}
            testID={`style-chat-thinking-dot-${index}`}
            style={[styles.dot, { opacity }]}
          />
        );
      })}
    </View>
  );
}

export function StyleChatThinkingIndicator({
  stylistDisplayName,
  /** Test seam: fixed elapsed time instead of a live timer. */
  elapsedMsOverride,
  copySlot,
}: {
  stylistDisplayName?: string;
  elapsedMsOverride?: number;
  /**
   * CONVERGENCE #282 + #284. Replaces the title/subtitle pair with a caller's
   * own copy, keeping this container, its dots, its Reduce Motion behaviour and
   * its layout.
   *
   * The Wardrobe Concierge narrates a longer wait in stages
   * (components/concierge/ConciergeProgressCopy), and that component was
   * written to render into "the chat screen's EXISTING thinking container and
   * beside its existing spinner, so a Concierge wait and an ordinary Elise wait
   * are visually the same object with different words". This slot is how that
   * stays true now that the container is a component rather than inline JSX:
   * one indicator, two vocabularies, instead of two indicators that drift.
   *
   * A slot occupant owns its own accessibility: the container drops its
   * derived label and live region so the child's announcement is what a screen
   * reader hears, rather than a stale Elise phrase masking it.
   */
  copySlot?: ReactNode;
}) {
  const reducedMotion = useReducedMotion();
  const [phase, setPhase] = useState<EliseThinkingPhase>(() =>
    resolveThinkingPhase(elapsedMsOverride ?? 0),
  );

  useEffect(() => {
    if (typeof elapsedMsOverride === 'number') {
      setPhase(resolveThinkingPhase(elapsedMsOverride));
      return;
    }
    // One timer, not an interval: there is exactly one escalation.
    setPhase('thinking');
    const timer = setTimeout(() => setPhase('taking_longer'), ELISE_THINKING_ESCALATION_MS);
    return () => clearTimeout(timer);
  }, [elapsedMsOverride]);

  const copy = useMemo(() => thinkingCopyForPhase(phase), [phase]);
  const name = stylistDisplayName?.trim() || 'Elise';
  const title = copy.title.replace('Elise', name);

  return (
    <View
      testID="style-chat-thinking-indicator"
      style={styles.container}
      accessibilityRole={copySlot ? undefined : 'progressbar'}
      accessibilityLiveRegion={copySlot ? 'none' : 'polite'}
      accessibilityLabel={copySlot ? undefined : `${title} ${copy.subtitle}`}
    >
      <PulsingDots animate={!reducedMotion} />
      {copySlot ?? (
        <View style={styles.copy}>
          <Text style={styles.title}>{title}</Text>
          <Text style={styles.subtitle}>{copy.subtitle}</Text>
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flexDirection: 'row',
    alignItems: 'center',
    marginHorizontal: SPACING.xl,
    marginTop: SPACING.sm,
    marginBottom: SPACING.md,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.lg,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
    gap: SPACING.md,
  },
  dots: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 5,
    width: 30,
    flexShrink: 0,
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: LUXURY.colors.plum,
  },
  copy: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    ...LUXURY.typography.bodyStrong,
    color: LUXURY.colors.plum,
    fontSize: 13,
    lineHeight: 19,
  },
  subtitle: {
    ...LUXURY.typography.caption,
    color: LUXURY.colors.stone,
    fontSize: 11,
    lineHeight: 16,
    letterSpacing: 0.4,
    marginTop: SPACING.xxs,
  },
});

/**
 * CONVERGENCE #282 + #284. The copy styles this indicator uses for its own
 * title and subtitle, exported so a `copySlot` occupant renders in exactly the
 * same type as the Elise copy it replaces. ConciergeProgressCopy takes these
 * as props for that reason -- "the chat screen's own copy styles, so the two
 * indicators cannot diverge" -- and this is where they now live.
 */
export const STYLE_CHAT_THINKING_COPY_STYLES = {
  container: styles.copy,
  title: styles.title,
  subtitle: styles.subtitle,
} as const;
