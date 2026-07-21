/**
 * E-4 advice-intent detection.
 * Deterministic phrase signals first; safe fallback to general_style_advice.
 */

import type { EliseAdviceIntent } from './eliseAdviceTypes.ts';

type IntentRule = {
  intent: EliseAdviceIntent;
  patterns: RegExp[];
};

const RULES: IntentRule[] = [
  {
    intent: 'multi_look_generation',
    patterns: [
      /\b(three|3)\s+(ways|looks|outfits)\b/i,
      /\bmultiple\s+(ways|looks)\b/i,
      /\b(ways|looks)\s+to\s+(style|wear)\b/i,
    ],
  },
  {
    intent: 'purchase_advice',
    patterns: [
      /\b(should\s+i\s+buy|worth\s+buying|buy\s+this|purchase)\b/i,
      /\b(skip\s+this|do\s+i\s+need\s+this)\b/i,
      /\bis\s+this\s+worth\b/i,
    ],
  },
  {
    intent: 'find_owned_alternative',
    patterns: [
      /\b(do\s+i\s+(already\s+)?(own|have)\s+something\s+similar)\b/i,
      /\balready\s+(own|have)\b/i,
      /\bin\s+my\s+closet\b.*\b(similar|alternative|same)\b/i,
    ],
  },
  {
    intent: 'find_saved_alternative',
    patterns: [
      /\b(which\s+saved|saved\s+item|best\s+alternative)\b/i,
      /\bfrom\s+(my\s+)?saved\b/i,
    ],
  },
  {
    intent: 'wardrobe_gap',
    patterns: [
      /\b(what\s+am\s+i\s+missing|missing\s+piece|complete\s+(this\s+)?look)\b/i,
      /\bwardrobe\s+gap\b/i,
      /\bneed\s+to\s+(complete|finish)\b/i,
    ],
  },
  {
    intent: 'build_outfit',
    patterns: [
      /\bbuild\s+(an\s+)?outfit\b/i,
      /\bput\s+together\b/i,
      /\boutfit\s+using\b/i,
      /\bwithout\s+buying\b/i,
    ],
  },
  {
    intent: 'shoe_pairing',
    patterns: [/\b(what\s+)?shoes?\b/i, /\bfootwear\b/i],
  },
  {
    intent: 'accessory_pairing',
    patterns: [/\baccessor(y|ies)\b/i, /\bbag\b|\bbelt\b|\bjewelry\b/i],
  },
  {
    intent: 'layering_advice',
    patterns: [/\blayer(ing)?\b/i, /\bover\s+it\b|\bunderneath\b/i],
  },
  {
    intent: 'color_pairing',
    patterns: [
      /\bwhat\s+colou?rs?\b/i,
      /\bcolor\s+(pair|match|harmony)\b/i,
      /\bpair\s+with\b.*\bcolou?r/i,
    ],
  },
  {
    intent: 'seasonal_advice',
    patterns: [/\b(summer|winter|fall|autumn|spring)\b/i, /\bseason(al)?\b/i],
  },
  {
    intent: 'occasion_fit',
    patterns: [
      /\b(work\s+dinner|office|wedding|date\s+night|interview|cocktail)\b/i,
      /\boccasion\b|\bdress\s+code\b/i,
      /\bfor\s+(work|dinner|party|formal)\b/i,
    ],
  },
  {
    intent: 'compare_items',
    patterns: [/\bcompare\b/i, /\bwhich\s+(one|item)\s+(is\s+)?better\b/i],
  },
  {
    intent: 'style_current_item',
    patterns: [
      /\bwhat\s+goes\s+with\b/i,
      /\bhow\s+(do\s+i\s+)?(style|wear)\b/i,
      /\bpair\s+(this|it)\b/i,
      /\bstyl(e|ing)\s+this\b/i,
    ],
  },
];

export function classifyEliseAdviceIntent(
  message: string,
  options?: { preferClosetFirst?: boolean; noShopping?: boolean },
): EliseAdviceIntent {
  const text = typeof message === 'string' ? message.trim() : '';
  if (!text) return 'general_style_advice';

  for (const rule of RULES) {
    if (rule.patterns.some((re) => re.test(text))) {
      if (options?.noShopping && rule.intent === 'purchase_advice') {
        return 'find_owned_alternative';
      }
      return rule.intent;
    }
  }

  if (options?.preferClosetFirst && /\bcloset\b|\balready\s+own\b/i.test(text)) {
    return 'build_outfit';
  }

  return 'general_style_advice';
}

export function intentPrefersOwned(intent: EliseAdviceIntent): boolean {
  return (
    intent === 'build_outfit' ||
    intent === 'find_owned_alternative' ||
    intent === 'style_current_item' ||
    intent === 'wardrobe_gap' ||
    intent === 'multi_look_generation' ||
    intent === 'shoe_pairing' ||
    intent === 'accessory_pairing' ||
    intent === 'layering_advice' ||
    intent === 'color_pairing'
  );
}

export function intentAllowsCommerce(intent: EliseAdviceIntent, message: string): boolean {
  if (/\b(without\s+buying|no\s+shopping|from\s+what\s+i\s+(own|have)|closet\s+only)\b/i.test(message)) {
    return false;
  }
  return (
    intent === 'purchase_advice' ||
    intent === 'wardrobe_gap' ||
    intent === 'find_saved_alternative' ||
    /\b(buy|shop|purchase|new\s+product)\b/i.test(message)
  );
}

export function intentNeedsShared(intent: EliseAdviceIntent, message: string): boolean {
  return /\bshared\s+room\b|\bshared\s+with\b/i.test(message) || intent === 'compare_items';
}
