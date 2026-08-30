// pushDelivery.ts — K5-C6: notification delivery primitive.
//
// Sends via Expo's push service (the correct transport for an Expo-managed
// app; no separate FCM/APNs credential wiring needed). This module owns
// exactly one thing: turning an already-decided event into a bounded,
// non-sensitive push payload and POSTing it.
//
// SECURITY (§54): the payload carries only an internal Watch id, an event
// type, and short display text derived from data the user already saved on
// their own Watch (never raw retailer/provider payloads, never a retailer
// redirect URL, never a provider identifier). Tap-through resolves entirely
// client-side, from the app's own RLS-scoped row -- see app/+native-intent.ts
// / the default expo-router handling for /watchlist/[watchId].

const EXPO_PUSH_URL = 'https://exp.host/--/api/v2/push/send';
const MAX_TITLE_LEN = 80;
const MAX_BODY_LEN = 160;

function readEnv(name: string): string | undefined {
  try {
    // deno-lint-ignore no-explicit-any
    const v = (globalThis as any)?.Deno?.env?.get?.(name);
    return typeof v === 'string' ? v.trim() : undefined;
  } catch {
    return undefined;
  }
}

function clamp(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export interface WatchPushEvent {
  watchId: string;
  eventType: 'target_price_reached' | 'price_decreased' | 'listing_unavailable' | 'listing_available_again';
  displayTitle: string;
  priceText: string | null;
}

function buildNotification(event: WatchPushEvent): { title: string; body: string } {
  const item = clamp(event.displayTitle, 60);
  switch (event.eventType) {
    case 'target_price_reached':
      return {
        title: 'Your target price was reached',
        body: clamp(`${item}${event.priceText ? ` is now ${event.priceText}` : ''}`, MAX_BODY_LEN),
      };
    case 'price_decreased':
      return {
        title: 'Price dropped',
        body: clamp(`${item}${event.priceText ? ` is now ${event.priceText}` : ''}`, MAX_BODY_LEN),
      };
    case 'listing_unavailable':
      return { title: 'Listing no longer available', body: clamp(item, MAX_BODY_LEN) };
    case 'listing_available_again':
      return { title: 'Listing is back', body: clamp(item, MAX_BODY_LEN) };
    default:
      return { title: clamp('Watchlist update', MAX_TITLE_LEN), body: clamp(item, MAX_BODY_LEN) };
  }
}

export interface PushSendResult {
  attempted: boolean;
  ok: boolean;
  errorCode?: string;
}

/**
 * Sends one push for one event to one already-resolved device token.
 * Never throws -- a delivery failure must never fail the refresh cycle that
 * triggered it (the price/event write already committed independently).
 */
export async function sendWatchPush(
  pushToken: string,
  event: WatchPushEvent,
): Promise<PushSendResult> {
  if (!pushToken) return { attempted: false, ok: false, errorCode: 'no_token' };
  const notification = buildNotification(event);
  const accessToken = readEnv('EXPO_PUSH_ACCESS_TOKEN');

  try {
    const response = await fetch(EXPO_PUSH_URL, {
      method: 'POST',
      headers: {
        Accept: 'application/json',
        'Accept-Encoding': 'gzip, deflate',
        'Content-Type': 'application/json',
        ...(accessToken ? { Authorization: `Bearer ${accessToken}` } : {}),
      },
      body: JSON.stringify([
        {
          to: pushToken,
          title: clamp(notification.title, MAX_TITLE_LEN),
          body: notification.body,
          // Only an internal id -- see the file header. The client resolves
          // everything else from its own RLS-scoped read of this Watch.
          data: { watchId: event.watchId, eventType: event.eventType, deepLink: `kscan://watchlist/${event.watchId}` },
        },
      ]),
    });
    if (!response.ok) {
      return { attempted: true, ok: false, errorCode: `http_${response.status}` };
    }
    const payload = await response.json().catch(() => null);
    const ticket = Array.isArray(payload?.data) ? payload.data[0] : null;
    if (ticket?.status === 'error') {
      return { attempted: true, ok: false, errorCode: String(ticket.details?.error ?? 'ticket_error') };
    }
    return { attempted: true, ok: true };
  } catch {
    return { attempted: true, ok: false, errorCode: 'network_error' };
  }
}
