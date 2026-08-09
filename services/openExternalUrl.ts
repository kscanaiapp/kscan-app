// Guarded external-link opener for provider-supplied URLs.
//
// Product, listing and marketplace URLs reach the client as free-form strings
// inside third-party / model-generated JSON (see services/textScan.ts, which
// accepts any of productUrl / product_url / purchaseUrl / url / link /
// affiliateUrl). Handing such a string straight to Linking.openURL lets a
// compromised or malformed upstream response choose the scheme as well as the
// destination — javascript:, file:, content:, intent:, market:, or an https URL
// aimed at loopback / RFC1918 space.
//
// The classification rules already exist in ./commerceDestination
// (isSafeCommerceUrl: https only, no embedded credentials, no private host).
// This module is the single place those rules are applied at the moment a URL
// is handed to the OS, so every commerce-ish surface shares one guard instead
// of re-deriving it.

import { Linking } from 'react-native';
import { isSafeCommerceUrl } from './commerceDestination';

/**
 * Opens a provider-supplied URL only when it classifies as a safe https
 * destination.
 *
 * Returns false — without touching Linking — for a rejected URL, so the caller
 * can surface its own "link unavailable" copy rather than silently doing
 * nothing. A genuine open failure (no handler installed, user cancelled the
 * chooser) also returns false, so callers need only one failure branch.
 */
export async function openExternalUrl(value: unknown): Promise<boolean> {
  const safe = isSafeCommerceUrl(value);
  if (!safe) return false;
  try {
    await Linking.openURL(safe);
    return true;
  } catch {
    return false;
  }
}
