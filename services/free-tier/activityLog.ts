/**
 * Free Tier Utility Expansion — recent activity / wardrobe log (local only).
 * Capped ring buffer of lightweight events. No personal images, no sync.
 */

import {
  FREE_TIER_STORAGE_KEYS,
  type ActivityEvent,
  type ActivityEventType,
} from './wardrobeUtilityTypes';
import { readStore, updateStore } from './freeTierStorage';

const KEY = FREE_TIER_STORAGE_KEYS.activityLog;
const MAX_EVENTS = 50;

export async function loadActivityLog(): Promise<ActivityEvent[]> {
  const list = await readStore<ActivityEvent[]>(KEY, []);
  return Array.isArray(list) ? list : [];
}

/**
 * Record an activity event. Fire-and-forget safe: never throws, never blocks.
 * Labels should be short and non-sensitive, e.g. "Saved black blazer".
 */
export async function recordActivity(
  type: ActivityEventType,
  label: string,
  userId?: string
): Promise<void> {
  const safeLabel = typeof label === 'string' ? label.trim().slice(0, 80) : '';
  if (!safeLabel) return;
  const event: ActivityEvent = {
    id: 'act_' + Date.now() + '_' + Math.floor(Math.random() * 9999),
    type,
    label: safeLabel,
    createdAt: new Date().toISOString(),
  };
  await updateStore<ActivityEvent[]>(
    KEY,
    [],
    (current) => [event, ...current].slice(0, MAX_EVENTS),
    userId
  );
}
