'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runModule, createRenderer, createReactNativeStub, deepStub, byTestId, byType, textContent } = require('./helpers/componentRenderer');
const dates = runModule('components/packing/packingDates.ts', {}, { jsx: false });
const calendar = runModule('components/packing/packingCalendar.ts', { './packingDates': dates }, { jsx: false });
function rig(os, initial = {}) {
  const renderer = createRenderer();
  let submitted = [], keyboardDismissals = 0;
  const rn = { ...createReactNativeStub({ platformOS: os }), findNodeHandle: () => null,
    Keyboard: { dismiss: () => keyboardDismissals++ } };
  const Picker = runModule('components/packing/PackingDateRangePicker.tsx', {
    ...renderer.runtimeModules, 'react-native': rn,
    'react-native-safe-area-context': { useSafeAreaInsets: () => ({ top: 0, bottom: 0 }) },
    '../../constants/theme': deepStub(), './packingDates': dates, './packingCalendar': calendar,
  });
  const { PackingTripForm } = runModule('components/packing/PackingTripForm.tsx', {
    ...renderer.runtimeModules, 'react-native': rn, '../../constants/theme': deepStub(),
    '../luxury': { PrimaryButton: 'PrimaryButton' }, './packingDates': dates,
    './PackingDateRangePicker': Picker, '../../types/packing': runModule('types/packing.ts', {}, { jsx: false }),
  });
  const element = renderer.jsx(PackingTripForm, { initial: { destination: 'Paris', startDate: '2026-12-29', endDate: '2027-01-02', tripType: 'leisure', activities: ['dinner'], note: 'Keep my note', ...initial }, onSubmit: draft => submitted.push(draft) });
  const render = () => renderer.render(element);
  const node = id => { const found = byTestId(render(), id); assert.ok(found.length, `missing ${id}`); return found[found.length - 1]; };
  return { renderer, render, node, tap: id => node(id).props.onPress(), submitted, keyboardDismissals: () => keyboardDismissals };
}
for (const os of ['ios', 'android']) {
  test(`${os}: edit cross-year range, confirm, reopen and preserve canonical generation payload`, () => {
    const r = rig(os);
    r.tap('packing-start-date');
    assert.equal(r.keyboardDismissals(), 1);
    assert.match(textContent(r.render()), /December 2026/);
    r.tap('packing-calendar-day-2026-12-30');
    r.tap('packing-calendar-next');
    r.tap('packing-calendar-day-2027-01-03');
    assert.equal(r.node('packing-calendar-day-2027-01-01').props.accessibilityState.selected, true);
    assert.match(r.node('packing-calendar-day-2027-01-03').props.accessibilityLabel, /Return/);
    assert.equal(r.submitted.length, 0, 'selection never triggers paid generation');
    r.tap('packing-calendar-confirm');
    assert.equal(byTestId(r.render(), 'packing-calendar-modal').length, 0);
    assert.match(textContent(r.render()), /30-12-2026/);
    assert.match(textContent(r.render()), /03-01-2027/);
    r.tap('packing-end-date');
    assert.match(textContent(r.node('packing-calendar-month')), /January 2027/);
    r.tap('packing-calendar-cancel');
    r.tap('packing-submit');
    assert.equal(r.submitted.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(r.submitted[0])), { destination: 'Paris', startDate: '2026-12-30', endDate: '2027-01-03', tripType: 'leisure', activities: ['dinner'], note: 'Keep my note' });
  });
  test(`${os}: cancellation, Android back and iOS swipe callbacks preserve saved dates`, () => {
    const r = rig(os);
    r.tap('packing-start-date');
    r.tap('packing-calendar-day-2026-12-31');
    r.node('packing-calendar-modal').props.onRequestClose();
    r.tap('packing-submit');
    assert.equal(r.submitted[0].startDate, '2026-12-29');
    assert.equal(r.submitted[0].endDate, '2027-01-02');
    r.tap('packing-start-date');
    r.tap('packing-calendar-day-2026-12-28');
    r.tap('packing-calendar-cancel');
    r.tap('packing-submit');
    assert.equal(r.submitted[1].startDate, '2026-12-29');
  });
  test(`${os}: reversed and over-limit returns disabled, same-day is valid, leap day selectable`, () => {
    const r = rig(os, { startDate: '2028-02-28', endDate: '2028-02-29' });
    r.tap('packing-end-date');
    const disabled = r.node('packing-calendar-day-2028-02-27');
    assert.equal(disabled.props.disabled, true);
    disabled.props.onPress(); // Also guard a stale/programmatic callback.
    r.tap('packing-calendar-confirm');
    r.tap('packing-submit');
    assert.equal(r.submitted[0].endDate, '2028-02-29');
    const sameDay = rig(os, { startDate: '2028-02-28', endDate: '2028-02-29' });
    sameDay.tap('packing-start-date');
    sameDay.tap('packing-calendar-day-2028-02-29');
    sameDay.tap('packing-calendar-day-2028-02-29');
    sameDay.tap('packing-calendar-confirm');
    sameDay.tap('packing-submit');
    assert.equal(sameDay.submitted[0].startDate, '2028-02-29');
    assert.equal(sameDay.submitted[0].endDate, '2028-02-29');
    const limit = rig(os, { startDate: '2028-02-29', endDate: '2028-02-29' });
    limit.tap('packing-end-date');
    limit.tap('packing-calendar-next');
    assert.equal(limit.node('packing-calendar-day-2028-03-31').props.disabled, true);
  });
  test(`${os}: empty form requires two valid tapped dates; no manual date inputs`, () => {
    const r = rig(os, { startDate: '', endDate: '' });
    const inputIds = byType(r.render(), 'TextInput').map(n => n.props.testID);
    assert.deepEqual(inputIds, ['packing-destination', 'packing-note']);
    r.tap('packing-end-date');
    assert.equal(r.node('packing-calendar-confirm').props.disabled, true);
    const today = calendar.packingToday();
    const day = r.node(`packing-calendar-day-${today}`);
    assert.match(day.props.accessibilityLabel, /Today/);
    day.props.onPress();
    assert.equal(r.node('packing-calendar-confirm').props.disabled, true);
    r.tap(`packing-calendar-day-${today}`);
    assert.equal(r.node('packing-calendar-confirm').props.disabled, false);
  });
}
test('Gregorian month grids, leap years, range limits, and local-calendar today are stable', () => {
  assert.equal(dates.formatPackingTripDate('2028-02-29'), '29-02-2028');
  assert.equal(calendar.packingCalendarMonth('2026-12-29', 1), '2027-01-01');
  assert.equal(calendar.packingCalendarMonth('2027-01-02', -1), '2026-12-01');
  assert.ok(calendar.packingCalendarCells('2028-02-01').includes('2028-02-29'));
  assert.ok(!calendar.packingCalendarCells('2100-02-01').includes('2100-02-29'));
  assert.equal(calendar.packingReturnSelectable('2026-10-01', '2026-10-31', 30), true);
  assert.equal(calendar.packingReturnSelectable('2026-10-01', '2026-11-01', 30), false);
  assert.equal(calendar.packingReturnSelectable('2026-10-01', '2026-09-30', 30), false);
});
test('selected calendar days and DST range lengths do not drift across time zones', () => {
  const previous = process.env.TZ;
  try {
    for (const zone of ['UTC', 'America/New_York', 'America/Los_Angeles', 'Pacific/Kiritimati', 'Pacific/Honolulu']) {
      process.env.TZ = zone;
      assert.match(calendar.packingCalendarLabel('2028-02-29'), /29/);
      assert.equal(dates.packingTripNights('2026-03-07', '2026-03-09'), 2);
      assert.equal(dates.packingTripNights('2026-10-31', '2026-11-02'), 2);
      assert.equal(calendar.packingToday(new Date(2026, 9, 17, 23, 30)), '2026-10-17');
      assert.ok(calendar.packingCalendarCells('2026-11-01').includes('2026-11-01'));
    }
  } finally { if (previous === undefined) delete process.env.TZ; else process.env.TZ = previous; }
});
