import React, { useRef, useState } from 'react';
import { AccessibilityInfo, findNodeHandle, Modal, Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { LUXURY, RADIUS, SPACING } from '../../constants/theme';
import { formatPackingTripDate, isValidCanonicalPackingDate } from './packingDates';
import { packingCalendarCells, packingCalendarLabel, packingCalendarMonth, packingReturnSelectable, packingToday } from './packingCalendar';

type Field = 'start' | 'end';
export function PackingDateRangePicker({ startDate, endDate, initialField, maxNights, onCancel, onConfirm }: {
  startDate: string; endDate: string; initialField: Field; maxNights: number;
  onCancel: () => void; onConfirm: (start: string, end: string) => void;
}) {
  const insets = useSafeAreaInsets();
  const [start, setStart] = useState(isValidCanonicalPackingDate(startDate) ? startDate : '');
  const [end, setEnd] = useState(packingReturnSelectable(startDate, endDate, maxNights) ? endDate : '');
  const [field, setField] = useState<Field>(initialField === 'end' && start ? 'end' : 'start');
  const today = packingToday();
  const [month, setMonth] = useState(() => packingCalendarMonth(
    initialField === 'end' && end ? end : start || today,
  ));
  const heading = useRef<Text>(null);
  const valid = packingReturnSelectable(start, end, maxNights);
  const cells = packingCalendarCells(month);
  const choose = (date: string) => {
    if (field === 'end') {
      if (!packingReturnSelectable(start, date, maxNights)) return;
      setEnd(date);
      AccessibilityInfo.announceForAccessibility(`Returning ${packingCalendarLabel(date)}. Confirm your trip dates.`);
    } else {
      setStart(date);
      if (!packingReturnSelectable(date, end, maxNights)) setEnd('');
      setField('end');
      AccessibilityInfo.announceForAccessibility(`Leaving ${packingCalendarLabel(date)}. Select your return date.`);
    }
  };
  return (
    <Modal visible animationType="slide" presentationStyle="pageSheet" allowSwipeDismissal
      onRequestClose={onCancel} testID="packing-calendar-modal"
      onShow={() => { const node = findNodeHandle(heading.current); if (node) AccessibilityInfo.setAccessibilityFocus(node); }}>
      <View style={[styles.root, { paddingTop: insets.top, paddingBottom: insets.bottom }]} accessibilityViewIsModal>
        <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
          <Text ref={heading} style={styles.title} accessibilityRole="header">Travel dates</Text>
          <Text style={styles.help} accessibilityLiveRegion="polite">{field === 'start' ? 'Select your departure date' : 'Select your return date'} · Up to {maxNights} nights</Text>
          <View style={styles.row}>
            {(['start', 'end'] as const).map(key => (
              <Pressable key={key} style={[styles.field, field === key && styles.focused]}
                testID={`packing-calendar-${key}`} accessibilityRole="button"
                accessibilityLabel={`${key === 'start' ? 'Leaving' : 'Returning'} ${formatPackingTripDate(key === 'start' ? start : end) || 'not selected'}`}
                accessibilityState={{ selected: field === key, disabled: key === 'end' && !start }} disabled={key === 'end' && !start}
                onPress={() => { setField(key); const date = key === 'start' ? start : end || start; if (date) setMonth(packingCalendarMonth(date)); }}>
                <Text style={styles.label}>{key === 'start' ? 'LEAVING' : 'RETURNING'}</Text>
                <Text style={styles.value}>{formatPackingTripDate(key === 'start' ? start : end) || 'DD-MM-YYYY'}</Text>
              </Pressable>
            ))}
          </View>
          <View style={styles.monthBar}>
            <Pressable style={styles.nav} accessibilityRole="button" accessibilityLabel="Previous month" testID="packing-calendar-previous"
              disabled={month === '0001-01-01'} onPress={() => setMonth(packingCalendarMonth(month, -1))}><Text style={styles.arrow}>‹</Text></Pressable>
            <Text style={styles.month} accessibilityRole="header" accessibilityLiveRegion="polite" testID="packing-calendar-month">{packingCalendarLabel(month, true)}</Text>
            <Pressable style={styles.nav} accessibilityRole="button" accessibilityLabel="Next month" testID="packing-calendar-next"
              disabled={month === '9999-12-01'} onPress={() => setMonth(packingCalendarMonth(month, 1))}><Text style={styles.arrow}>›</Text></Pressable>
          </View>
          <ScrollView horizontal contentContainerStyle={styles.gridScroll} showsHorizontalScrollIndicator={false}>
            <View style={styles.grid}>
              <View style={styles.row} accessible={false} importantForAccessibility="no-hide-descendants">
                {['S', 'M', 'T', 'W', 'T', 'F', 'S'].map((day, i) => <Text key={i} style={styles.weekday}>{day}</Text>)}
              </View>
              {Array.from({ length: cells.length / 7 }, (_, week) => (
                <View key={week} style={styles.row}>
                  {cells.slice(week * 7, week * 7 + 7).map((date, i) => {
                    if (!date) return <View key={`blank-${i}`} style={styles.day} />;
                    const departure = date === start, returning = date === end;
                    const within = Boolean(start && end && date > start && date < end);
                    const disabled = field === 'end' && !packingReturnSelectable(start, date, maxNights);
                    const description = [packingCalendarLabel(date), date === today && 'Today', departure && 'Departure', returning && 'Return', within && 'In trip range'].filter(Boolean).join('. ');
                    return <Pressable key={date} testID={`packing-calendar-day-${date}`} disabled={disabled}
                      accessibilityRole="button" accessibilityLabel={description}
                      accessibilityState={{ disabled, selected: departure || returning || within }}
                      onPress={() => choose(date)}
                      style={[styles.day, within && styles.range, departure && styles.departure, returning && styles.returning, date === today && styles.today, disabled && styles.disabled]}>
                      <Text style={[styles.dayText, departure && styles.departureText, date === today && styles.todayText]}>{Number(date.slice(8))}</Text>
                      {departure || returning ? <Text style={[styles.marker, departure && styles.departureText]}>{departure && returning ? 'L/R' : departure ? 'L' : 'R'}</Text> : null}
                    </Pressable>;
                  })}
                </View>
              ))}
            </View>
          </ScrollView>
          <Text style={styles.help}>L · Leaving     R · Returning     Outlined day · Today</Text>
          <Pressable testID="packing-calendar-confirm" accessibilityRole="button" accessibilityLabel="Confirm trip dates" accessibilityState={{ disabled: !valid }}
            disabled={!valid} style={[styles.confirm, !valid && styles.disabled]} onPress={() => { if (valid) onConfirm(start, end); }}>
            <Text style={styles.confirmText}>CONFIRM DATES</Text>
          </Pressable>
          <Pressable testID="packing-calendar-cancel" accessibilityRole="button" onPress={onCancel} style={styles.cancel}><Text style={styles.value}>Cancel</Text></Pressable>
        </ScrollView>
      </View>
    </Modal>
  );
}
const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: LUXURY.colors.ivory },
  content: { width: '100%', maxWidth: 560, alignSelf: 'center', paddingHorizontal: 6, paddingVertical: SPACING.md, gap: SPACING.md },
  title: { ...LUXURY.typography.displayTitle, color: LUXURY.colors.ink, paddingHorizontal: SPACING.sm },
  help: { ...LUXURY.typography.body, color: LUXURY.colors.graphite, paddingHorizontal: SPACING.sm },
  row: { flexDirection: 'row' },
  field: { flex: 1, padding: SPACING.sm, minHeight: 64, borderWidth: 1, borderColor: LUXURY.colors.border, borderRadius: RADIUS.sm },
  focused: { borderColor: LUXURY.colors.plum },
  label: { ...LUXURY.typography.sectionLabel },
  value: { ...LUXURY.typography.body, color: LUXURY.colors.ink },
  monthBar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between' },
  month: { ...LUXURY.typography.body, color: LUXURY.colors.ink, fontWeight: '600', flex: 1, textAlign: 'center' },
  nav: { minWidth: 44, minHeight: 44, alignItems: 'center', justifyContent: 'center' },
  arrow: { fontSize: 30, color: LUXURY.colors.plum },
  gridScroll: { flexGrow: 1 },
  grid: { flex: 1, minWidth: 308 },
  weekday: { flex: 1, minWidth: 44, textAlign: 'center', color: LUXURY.colors.graphite, paddingVertical: SPACING.sm },
  day: { flex: 1, minWidth: 44, minHeight: 52, alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: 'transparent' },
  dayText: { ...LUXURY.typography.body, color: LUXURY.colors.ink },
  marker: { fontSize: 10, color: LUXURY.colors.ink, fontWeight: '700' },
  range: { backgroundColor: LUXURY.colors.plumMuted },
  departure: { backgroundColor: LUXURY.colors.plum, borderRadius: RADIUS.sm },
  departureText: { color: LUXURY.colors.inverse },
  returning: { backgroundColor: LUXURY.colors.goldLight, borderRadius: RADIUS.sm },
  todayText: { textDecorationLine: 'underline' },
  today: { borderColor: LUXURY.colors.plum, borderStyle: 'dashed' },
  disabled: { opacity: 0.35 },
  confirm: { minHeight: 48, padding: SPACING.md, backgroundColor: LUXURY.colors.plum, borderRadius: RADIUS.sm, alignItems: 'center', justifyContent: 'center' },
  confirmText: { ...LUXURY.typography.sectionLabel, color: LUXURY.colors.inverse },
  cancel: { minHeight: 48, alignItems: 'center', justifyContent: 'center' },
});
