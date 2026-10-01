const DISPLAY_DATE_RE = /^(\d{2})\/(\d{2})\/(\d{4})$/;
const CANONICAL_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

export const PACKING_DATE_FORMAT_ERROR = 'Enter both dates as MM/DD/YYYY.';

type DateParts = { year: number; month: number; day: number };

function isLeapYear(year: number): boolean {
  return year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
}

function isValidDateParts({ year, month, day }: DateParts): boolean {
  if (month < 1 || month > 12 || day < 1) return false;
  const daysInMonth = [31, isLeapYear(year) ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= daysInMonth[month - 1];
}

function canonicalFromParts({ year, month, day }: DateParts): string {
  return `${year.toString().padStart(4, '0')}-${month.toString().padStart(2, '0')}-${day
    .toString()
    .padStart(2, '0')}`;
}

function canonicalParts(value: string): DateParts | null {
  const match = CANONICAL_DATE_RE.exec(value);
  if (!match) return null;
  const parts = { year: Number(match[1]), month: Number(match[2]), day: Number(match[3]) };
  return isValidDateParts(parts) ? parts : null;
}

export function parsePackingDisplayDate(value: string): string | null {
  const match = DISPLAY_DATE_RE.exec(value);
  if (!match) return null;
  const parts = { month: Number(match[1]), day: Number(match[2]), year: Number(match[3]) };
  return isValidDateParts(parts) ? canonicalFromParts(parts) : null;
}

export function formatPackingCanonicalDate(value: string): string {
  const parts = canonicalParts(value);
  if (!parts) return '';
  return `${parts.month.toString().padStart(2, '0')}/${parts.day
    .toString()
    .padStart(2, '0')}/${parts.year.toString().padStart(4, '0')}`;
}

export function isValidCanonicalPackingDate(value: string): boolean {
  return canonicalParts(value) !== null;
}

export function packingTripNights(startDate: string, endDate: string): number {
  const start = canonicalParts(startDate);
  const end = canonicalParts(endDate);
  if (!start || !end) return Number.NaN;
  const startUtc = Date.UTC(start.year, start.month - 1, start.day);
  const endUtc = Date.UTC(end.year, end.month - 1, end.day);
  return (endUtc - startUtc) / 86_400_000;
}

export function normalizePackingDateRange(
  startInput: string,
  endInput: string,
  maxNights: number,
):
  | { ok: true; startDate: string; endDate: string }
  | { ok: false; message: string } {
  const startDate = parsePackingDisplayDate(startInput);
  const endDate = parsePackingDisplayDate(endInput);
  if (!startDate || !endDate) return { ok: false, message: PACKING_DATE_FORMAT_ERROR };
  if (endDate < startDate) {
    return { ok: false, message: 'Your return date is before your departure date.' };
  }
  if (packingTripNights(startDate, endDate) > maxNights) {
    return { ok: false, message: `Trips longer than ${maxNights} nights are not supported yet.` };
  }
  return { ok: true, startDate, endDate };
}
