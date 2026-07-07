import { View, Text, StyleSheet, Pressable, ActivityIndicator } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { WEATHER_COPY } from '../../constants/weatherStyling';

// Prominent in-app disclosure shown only after clear styling intent, and only when
// the user is eligible (never on launch/onboarding/mount). Tapping "Continue"
// triggers the OS foreground-permission dialog in the caller.
export function StyleChatWeatherPrompt({
  onUseWeather,
  onNotNow,
  requesting,
}: {
  onUseWeather: () => void;
  onNotNow: () => void;
  requesting?: boolean;
}) {
  return (
    <View style={styles.card} accessibilityRole="summary">
      <Text style={styles.title}>{WEATHER_COPY.promptTitle}</Text>
      <Text style={styles.body}>{WEATHER_COPY.promptBody}</Text>
      <View style={styles.actions}>
        <Pressable
          onPress={onNotNow}
          disabled={requesting}
          style={styles.secondaryBtn}
          accessibilityRole="button"
          accessibilityLabel="Not now"
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          <Text style={styles.secondaryText}>{WEATHER_COPY.promptNotNow}</Text>
        </Pressable>
        <Pressable
          onPress={onUseWeather}
          disabled={requesting}
          style={styles.primaryBtn}
          accessibilityRole="button"
          accessibilityLabel="Continue and request location permission"
          accessibilityState={{ disabled: requesting, busy: requesting }}
          hitSlop={{ top: 6, bottom: 6, left: 6, right: 6 }}
        >
          {requesting ? (
            <ActivityIndicator size="small" color={LUXURY.colors.inverse} />
          ) : (
            <Text style={styles.primaryText}>{WEATHER_COPY.promptUse}</Text>
          )}
        </Pressable>
      </View>
    </View>
  );
}

// Compact ambient status. Hidden entirely when weather is off.
export function StyleChatWeatherChip({ label }: { label: string }) {
  return (
    <View style={styles.chip} accessibilityRole="text" accessibilityLabel={label}>
      <View style={styles.chipDot} />
      <Text style={styles.chipText}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.sm,
    paddingHorizontal: SPACING.lg,
    paddingVertical: SPACING.md,
    borderRadius: RADIUS.md,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.pearl,
  },
  title: {
    ...LUXURY.typography.body,
    fontSize: 14,
    fontWeight: '600',
    color: LUXURY.colors.ink,
    marginBottom: SPACING.xs,
  },
  body: {
    ...LUXURY.typography.caption,
    fontSize: 13,
    lineHeight: 18,
    color: LUXURY.colors.graphite,
    marginBottom: SPACING.sm,
  },
  actions: {
    flexDirection: 'row',
    justifyContent: 'flex-end',
    alignItems: 'center',
    gap: SPACING.sm,
  },
  secondaryBtn: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: SPACING.md,
  },
  secondaryText: {
    ...LUXURY.typography.caption,
    fontSize: 13,
    color: LUXURY.colors.graphite,
    letterSpacing: 0.4,
  },
  primaryBtn: {
    minHeight: 44,
    minWidth: 110,
    justifyContent: 'center',
    alignItems: 'center',
    paddingHorizontal: SPACING.lg,
    borderRadius: RADIUS.pill,
    backgroundColor: LUXURY.colors.plum,
    borderWidth: 1,
    borderColor: LUXURY.colors.plumSoft,
  },
  primaryText: {
    ...LUXURY.typography.caption,
    fontSize: 13,
    fontWeight: '600',
    color: LUXURY.colors.inverse,
    letterSpacing: 0.6,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    alignSelf: 'flex-start',
    gap: 6,
    marginHorizontal: SPACING.xl,
    marginBottom: SPACING.xs,
    paddingVertical: 4,
    paddingHorizontal: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: 1,
    borderColor: LUXURY.colors.hairline,
    backgroundColor: LUXURY.colors.ivory,
  },
  chipDot: {
    width: 6,
    height: 6,
    borderRadius: 3,
    backgroundColor: LUXURY.colors.gold,
  },
  chipText: {
    ...LUXURY.typography.caption,
    fontSize: 11,
    color: LUXURY.colors.stone,
    letterSpacing: 0.8,
  },
});
