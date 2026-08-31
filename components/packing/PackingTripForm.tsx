// K+ Packing Intelligence V1 — trip setup.
//
// DELIBERATELY SMALL. Four things: where, when, what kind of trip, what you
// will be doing. The premium feeling comes from what K Scan AI does NOT have
// to ask -- a generic packing assistant must ask "what clothes do you have"; K
// Scan AI already knows. A twenty-question travel form would throw that away.
//
// Activities are chips over a fixed vocabulary rather than free text, because
// they drive deterministic coverage on the server. The free-text note exists
// for everything the chips cannot say, and is treated as data end to end.

import React, { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { PrimaryButton } from '../luxury';
import {
  PACKING_ACTIVITIES,
  PACKING_ACTIVITY_LABELS,
  PACKING_TRIP_TYPES,
  PACKING_TRIP_TYPE_LABELS,
  type PackingActivity,
  type PackingTripDraft,
  type PackingTripType,
} from '../../types/packing';

const ISO_DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const MAX_NIGHTS = 30;

export function validateTripDraft(draft: PackingTripDraft): string | null {
  if (!draft.destination.trim()) return 'Where are you going?';
  if (!ISO_DATE_RE.test(draft.startDate) || !ISO_DATE_RE.test(draft.endDate)) {
    return 'Enter both dates as YYYY-MM-DD.';
  }
  const start = Date.parse(`${draft.startDate}T00:00:00Z`);
  const end = Date.parse(`${draft.endDate}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return 'Those dates are not valid.';
  // Re-render and compare so an impossible calendar date (2026-02-31) is
  // rejected here rather than silently rolling over into a different trip.
  if (
    new Date(start).toISOString().slice(0, 10) !== draft.startDate ||
    new Date(end).toISOString().slice(0, 10) !== draft.endDate
  ) {
    return 'Those dates are not valid.';
  }
  if (end < start) return 'Your return date is before your departure date.';
  if ((end - start) / 86_400_000 > MAX_NIGHTS) return `Trips longer than ${MAX_NIGHTS} nights are not supported yet.`;
  return null;
}

export function PackingTripForm({
  initial,
  busy,
  onSubmit,
}: {
  initial?: PackingTripDraft | null;
  busy?: boolean;
  onSubmit: (draft: PackingTripDraft) => void;
}) {
  const [destination, setDestination] = useState(initial?.destination ?? '');
  const [startDate, setStartDate] = useState(initial?.startDate ?? '');
  const [endDate, setEndDate] = useState(initial?.endDate ?? '');
  const [tripType, setTripType] = useState<PackingTripType>(initial?.tripType ?? 'leisure');
  const [activities, setActivities] = useState<PackingActivity[]>(initial?.activities ?? []);
  const [note, setNote] = useState(initial?.note ?? '');
  const [error, setError] = useState<string | null>(null);

  const draft = useMemo<PackingTripDraft>(
    () => ({ destination, startDate, endDate, tripType, activities, note }),
    [destination, startDate, endDate, tripType, activities, note],
  );

  const toggleActivity = (activity: PackingActivity) => {
    setActivities((current) =>
      current.includes(activity)
        ? current.filter((entry) => entry !== activity)
        : current.length >= 6
          ? current
          : [...current, activity],
    );
  };

  const submit = () => {
    const problem = validateTripDraft(draft);
    setError(problem);
    if (!problem) onSubmit(draft);
  };

  return (
    <View testID="packing-trip-form">
      <Text style={styles.label}>DESTINATION</Text>
      <TextInput
        value={destination}
        onChangeText={setDestination}
        placeholder="Miami"
        placeholderTextColor={LUXURY.colors.stone}
        style={styles.input}
        maxLength={80}
        accessibilityLabel="Trip destination"
        testID="packing-destination"
      />

      <View style={styles.dateRow}>
        <View style={styles.dateField}>
          <Text style={styles.label}>LEAVING</Text>
          <TextInput
            value={startDate}
            onChangeText={setStartDate}
            placeholder="2026-09-12"
            placeholderTextColor={LUXURY.colors.stone}
            style={styles.input}
            maxLength={10}
            autoCapitalize="none"
            accessibilityLabel="Departure date, year dash month dash day"
            testID="packing-start-date"
          />
        </View>
        <View style={styles.dateField}>
          <Text style={styles.label}>RETURNING</Text>
          <TextInput
            value={endDate}
            onChangeText={setEndDate}
            placeholder="2026-09-16"
            placeholderTextColor={LUXURY.colors.stone}
            style={styles.input}
            maxLength={10}
            autoCapitalize="none"
            accessibilityLabel="Return date, year dash month dash day"
            testID="packing-end-date"
          />
        </View>
      </View>

      <Text style={styles.label}>TRIP TYPE</Text>
      <View style={styles.chipRow}>
        {PACKING_TRIP_TYPES.map((type) => (
          <Chip
            key={type}
            label={PACKING_TRIP_TYPE_LABELS[type]}
            selected={tripType === type}
            onPress={() => setTripType(type)}
            testID={`packing-trip-type-${type}`}
          />
        ))}
      </View>

      <Text style={styles.label}>WHAT WILL YOU BE DOING?</Text>
      <View style={styles.chipRow}>
        {PACKING_ACTIVITIES.map((activity) => (
          <Chip
            key={activity}
            label={PACKING_ACTIVITY_LABELS[activity]}
            selected={activities.includes(activity)}
            onPress={() => toggleActivity(activity)}
            testID={`packing-activity-${activity}`}
          />
        ))}
      </View>

      <Text style={styles.label}>ANYTHING ELSE? (OPTIONAL)</Text>
      <TextInput
        value={note}
        onChangeText={setNote}
        placeholder="One dressy night, lots of walking"
        placeholderTextColor={LUXURY.colors.stone}
        style={[styles.input, styles.noteInput]}
        maxLength={300}
        multiline
        accessibilityLabel="Anything else about this trip"
        testID="packing-note"
      />

      {error ? (
        <Text style={styles.error} testID="packing-form-error">
          {error}
        </Text>
      ) : null}

      <PrimaryButton
        title="PACK FOR THIS TRIP"
        onPress={submit}
        loading={busy}
        disabled={busy}
        style={styles.cta}
        accessibilityLabel="Build a packing plan from my Closet"
        testID="packing-submit"
      />
    </View>
  );
}

function Chip({
  label,
  selected,
  onPress,
  testID,
}: {
  label: string;
  selected: boolean;
  onPress: () => void;
  testID: string;
}) {
  return (
    <Pressable
      onPress={onPress}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      accessibilityLabel={label}
      testID={testID}
      style={[styles.chip, selected && styles.chipSelected]}
    >
      <Text style={[styles.chipLabel, selected && styles.chipLabelSelected]}>{label}</Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  label: {
    ...LUXURY.typography.sectionLabel,
    marginTop: SPACING.lg,
    marginBottom: SPACING.sm,
  },
  input: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.ink,
    backgroundColor: LUXURY.colors.pearl,
    borderRadius: RADIUS.sm,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.md,
    minHeight: 48,
  },
  noteInput: {
    minHeight: 88,
    textAlignVertical: 'top',
  },
  dateRow: {
    flexDirection: 'row',
    gap: SPACING.md,
  },
  dateField: {
    flex: 1,
  },
  chipRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACING.sm,
  },
  chip: {
    paddingHorizontal: SPACING.md,
    paddingVertical: SPACING.sm,
    borderRadius: RADIUS.pill,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: LUXURY.colors.border,
    backgroundColor: LUXURY.colors.pearl,
    minHeight: 44,
    justifyContent: 'center',
  },
  chipSelected: {
    backgroundColor: LUXURY.colors.plum,
    borderColor: LUXURY.colors.plum,
  },
  chipLabel: {
    ...LUXURY.typography.body,
    fontSize: 14,
    color: LUXURY.colors.graphite,
  },
  chipLabelSelected: {
    color: LUXURY.colors.inverse,
  },
  error: {
    ...LUXURY.typography.body,
    color: LUXURY.colors.error,
    marginTop: SPACING.md,
  },
  cta: {
    marginTop: SPACING.xl,
  },
});
