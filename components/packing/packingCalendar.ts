import { isValidCanonicalPackingDate, packingTripNights } from './packingDates';

/** Date-only arithmetic: UTC is used only as a stable Gregorian calculation
 * axis. Canonical strings, never timestamps, cross the form/API boundary. */
export function packingCalendarDate(year: number, month: number, day: number): string {
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}
export function packingToday(now = new Date()): string {
  return packingCalendarDate(now.getFullYear(), now.getMonth() + 1, now.getDate());
}
export function packingCalendarMonth(date: string, offset = 0): string {
  const [year, month] = date.split('-').map(Number);
  const index = year * 12 + month - 1 + offset;
  return packingCalendarDate(Math.floor(index / 12), ((index % 12) + 12) % 12 + 1, 1);
}
function calendarAxis(date: string): Date {
  const [year, month, day] = date.split('-').map(Number);
  const axis = new Date(0);
  axis.setUTCFullYear(year, month - 1, day);
  axis.setUTCHours(12, 0, 0, 0);
  return axis;
}
export function packingCalendarLabel(date: string, monthOnly = false): string {
  return calendarAxis(date).toLocaleDateString(undefined, {
    timeZone: 'UTC', year: 'numeric', month: 'long',
    ...(monthOnly ? {} : { weekday: 'long', day: 'numeric' }),
  });
}
export function packingCalendarCells(month: string): (string | null)[] {
  const first = calendarAxis(month);
  const cells: (string | null)[] = Array(first.getUTCDay()).fill(null);
  const year = first.getUTCFullYear(), m = first.getUTCMonth() + 1;
  for (let day = 1; day <= 31; day++) {
    const date = packingCalendarDate(year, m, day);
    if (isValidCanonicalPackingDate(date)) cells.push(date);
  }
  while (cells.length % 7) cells.push(null);
  return cells;
}
export function packingReturnSelectable(start: string, date: string, maxNights: number): boolean {
  return isValidCanonicalPackingDate(start) && isValidCanonicalPackingDate(date)
    && date >= start && packingTripNights(start, date) <= maxNights;
}
