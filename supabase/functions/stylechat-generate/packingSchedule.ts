// Build 35 Packing Intelligence -- trip days and occasion slots (pure).
//
// A V1 plan was a list of looks keyed by occasion: "Dinner", "Daytime". It
// could not say WHEN anything is worn, so it could not say what repeats, and a
// four-day trip with two dinners got one dinner look. A slot is one occasion on
// one day -- "d3-dinner" -- and every look in a Build 35 plan belongs to one.
//
// SLOT IDS ARE DETERMINISTIC (`d{day}-{activity}`) because they are what a pin
// ("keep Saturday"), a local refinement ("make Friday casual") and the plan
// state all refer to. A regenerated plan for the same trip produces the same
// ids, so "Saturday" keeps meaning the same looks.
//
// LONG TRIPS. Only the first `maxPlannedDays` days are planned look by look.
// A later day REPEATS the looks of an earlier day with the same occasion, and
// the planner turns every repeat into a stated laundry assumption -- it never
// silently re-wears a top on day twelve.

import {
  PACKING_ACTIVITY_LABELS,
  PACKING_LIMITS,
  derivePackingSchedule,
  type PackingActivity,
  type PackingDaySchedule,
  type PackingTripInput,
} from './packingContract.ts';
import type { PackingFormalityShift } from './packingGarmentFacts.ts';

export interface PackingSlot {
  slotId: string;
  dayIndex: number;
  date: string;
  activity: PackingActivity;
  /** A traveller-requested formality change for this slot, if any. */
  formalityShift: PackingFormalityShift | null;
  /** The occasion originally scheduled, when a refinement changed it. */
  originalActivity: PackingActivity | null;
}

export interface PackingRepeatDay {
  dayIndex: number;
  date: string;
  activity: PackingActivity;
  repeatsSlotId: string;
}

export interface PackingSlotPlan {
  schedule: PackingDaySchedule[];
  slots: PackingSlot[];
  repeats: PackingRepeatDay[];
  /** Later-day occasions no planned slot could stand in for. */
  unplannedDays: Array<{ dayIndex: number; date: string; activity: PackingActivity }>;
  /** Day indexes that had no occasion and were given a daytime look. */
  filledDayIndexes: number[];
  totalDays: number;
}

export const SLOT_ID_RE = /^d([1-9]\d?)-([a-z_]+)$/;

export function slotIdFor(dayIndex: number, activity: PackingActivity): string {
  return `d${dayIndex + 1}-${activity}`;
}

export function buildPackingSlots(trip: PackingTripInput): PackingSlotPlan {
  const schedule =
    trip.schedule && trip.schedule.length > 0
      ? trip.schedule
      : derivePackingSchedule({
        startDate: trip.startDate,
        nights: trip.nights,
        activities: trip.activities,
        tripType: trip.tripType,
      });

  const slots: PackingSlot[] = [];
  const repeats: PackingRepeatDay[] = [];
  const unplannedDays: PackingSlotPlan['unplannedDays'] = [];
  const filledDayIndexes: number[] = [];

  for (const day of schedule) {
    let activities = day.activities;
    if (activities.length === 0) {
      activities = ['casual_day'];
      filledDayIndexes.push(day.dayIndex);
    }
    for (const activity of activities) {
      const planned = day.dayIndex < PACKING_LIMITS.maxPlannedDays;
      if (planned && slots.length < PACKING_LIMITS.maxSlots) {
        slots.push({
          slotId: slotIdFor(day.dayIndex, activity),
          dayIndex: day.dayIndex,
          date: day.date,
          activity,
          formalityShift: null,
          originalActivity: null,
        });
        continue;
      }
      // Prefer the same weekday-offset day, then the latest earlier slot with
      // the same occasion: a repeat should read as "wear Tuesday's look again".
      const sameOffset = slots.find(
        (slot) =>
          slot.activity === activity &&
          slot.dayIndex === day.dayIndex % PACKING_LIMITS.maxPlannedDays,
      );
      const latest = [...slots].reverse().find((slot) => slot.activity === activity);
      const source = sameOffset ?? latest;
      if (source) {
        repeats.push({ dayIndex: day.dayIndex, date: day.date, activity, repeatsSlotId: source.slotId });
      } else if (slots.length < PACKING_LIMITS.maxSlots) {
        slots.push({
          slotId: slotIdFor(day.dayIndex, activity),
          dayIndex: day.dayIndex,
          date: day.date,
          activity,
          formalityShift: null,
          originalActivity: null,
        });
      } else {
        unplannedDays.push({ dayIndex: day.dayIndex, date: day.date, activity });
      }
    }
  }

  return { schedule, slots, repeats, unplannedDays, filledDayIndexes, totalDays: schedule.length };
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function weekdayOf(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  return Number.isNaN(parsed.getTime()) ? date : WEEKDAYS[parsed.getUTCDay()];
}

/** "Friday, Oct 2". Timezone-free: a trip date is a calendar fact. */
export function dayLabel(date: string): string {
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return date;
  return `${WEEKDAYS[parsed.getUTCDay()]}, ${MONTHS[parsed.getUTCMonth()]} ${parsed.getUTCDate()}`;
}

/**
 * How a slot is named to a person: "Friday dinner". The date is added only when
 * the trip contains that weekday more than once, so the short form is never
 * ambiguous.
 */
export function slotLabel(slot: { date: string; activity: PackingActivity }, allDates: string[]): string {
  const weekday = weekdayOf(slot.date);
  const duplicates = new Set(allDates.filter((date) => weekdayOf(date) === weekday)).size > 1;
  const day = duplicates ? dayLabel(slot.date) : weekday;
  return `${day} ${PACKING_ACTIVITY_LABELS[slot.activity].toLowerCase()}`;
}
