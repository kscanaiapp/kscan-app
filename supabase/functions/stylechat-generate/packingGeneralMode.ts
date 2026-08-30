// K+ Packing Intelligence V1 — general packing mode (pure).
//
// WHAT THIS IS FOR. A traveller whose Closet does not yet hold enough usable
// evidence cannot be given a personalized plan honestly. The alternative is not
// a broken empty result and it is certainly not a plan padded with garments
// they do not own -- it is a clearly-labelled general guide, plus a plain
// explanation of why personalization is limited.
//
// DETERMINISTIC, AND NO MODEL CALL. The guide is derived from the trip's own
// requirements through the SAME requirement-to-role table the personalized path
// uses, so the two modes cannot disagree about what a beach day needs. That
// also means the fallback costs nothing, cannot time out, and cannot
// hallucinate.
//
// NOTHING HERE IS OWNED. Every entry is a garment CATEGORY, never an item, and
// the response carries mode: 'general' so no client can render these with the
// owned-item styling.

import {
  PACKING_ACTIVITY_LABELS,
  type PackingActivity,
  type PackingTripInput,
} from './packingContract.ts';

export interface PackingGeneralGuideSection {
  label: string;
  /** Garment categories, never item identities. */
  categories: string[];
}

export interface PackingGeneralGuide {
  sections: PackingGeneralGuideSection[];
  notes: string[];
}

const ESSENTIALS_BY_ACTIVITY: Record<PackingActivity, string[]> = {
  travel_day: ['A comfortable top', 'Easy trousers or jeans', 'Shoes you can walk in', 'A light layer'],
  casual_day: ['Everyday tops', 'A versatile bottom', 'Walking shoes'],
  dinner: ['A dressier top or a dress', 'A smart bottom', 'Dressier shoes'],
  work: ['Collared or smart tops', 'Tailored trousers or a skirt', 'Smart shoes', 'A blazer or jacket'],
  beach: ['Swimwear', 'A cover-up', 'Shorts or a light skirt', 'Sandals'],
  outdoors: ['A moisture-friendly base layer', 'Durable trousers', 'A warm mid layer', 'Weatherproof outerwear', 'Sturdy shoes'],
  workout: ['Training top', 'Training bottoms', 'Trainers'],
  formal_event: ['Formal dress or suiting', 'Formal shoes', 'An evening layer'],
  nightlife: ['An evening top or dress', 'A sharp bottom', 'Evening shoes'],
};

const BASELINE_ESSENTIALS = [
  'Tops for each day, with a couple that can be re-worn',
  'One or two bottoms that pair with most tops',
  'One pair of comfortable shoes',
  'A layer for cooler moments',
  'Underwear and socks for the trip length',
];

/**
 * A number of days, not a recommended quantity of any garment. Suggesting
 * "4 tops" would be inventing a packing formula this project has no evidence
 * for; naming the trip length lets the traveller apply their own judgement.
 */
function tripLengthNote(trip: PackingTripInput): string {
  const days = trip.nights + 1;
  return trip.nights === 0
    ? 'This is a single-day trip.'
    : `This trip covers ${days} days and ${trip.nights} ${trip.nights === 1 ? 'night' : 'nights'}.`;
}

export function buildGeneralPackingGuide(trip: PackingTripInput): PackingGeneralGuide {
  const sections: PackingGeneralGuideSection[] = [
    { label: 'Everyday essentials', categories: [...BASELINE_ESSENTIALS] },
  ];

  for (const activity of trip.activities) {
    sections.push({
      label: PACKING_ACTIVITY_LABELS[activity],
      categories: [...ESSENTIALS_BY_ACTIVITY[activity]],
    });
  }

  const notes = [
    tripLengthNote(trip),
    'These are general categories, not items from your Closet.',
    'Add more of what you own to your Closet and K Scan AI can pack your next trip from your actual wardrobe.',
  ];

  return { sections, notes };
}

/** The visible assistant message for general mode. Rendered from the guide. */
export function renderGeneralModeMessage(trip: PackingTripInput, reason: 'sparse_closet' | 'closet_unavailable'): string {
  const opening =
    reason === 'closet_unavailable'
      ? "I could not reach your Closet just now, so I can't pack from what you own yet."
      : 'Your Closet is still taking shape, so I do not have enough of your own pieces to build a personalized plan yet.';
  const nights = trip.nights === 1 ? '1 night' : `${trip.nights} nights`;
  return [
    opening,
    `Here is a general guide for ${nights} instead — it is a checklist of categories, not your clothes.`,
    'As you add more to your Closet, this becomes a plan built from what you actually own.',
  ].join(' ');
}
