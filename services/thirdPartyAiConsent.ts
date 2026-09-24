/**
 * Consent to send a customer's content to an external AI service.
 *
 * WHAT THIS RECORDS. One fact per (feature, account): "this account agreed, on
 * this device, to <feature> sending its content to an external AI service, under
 * the wording identified by `version`". Nothing else. It is a gate the app
 * consults before a transmission, not a legal ledger, and it says so plainly:
 *
 *   - The record is DEVICE-LOCAL. It is not written to the server, so it is not
 *     an audit trail and it does not follow the account to another device. A new
 *     device asks again, which is the conservative direction.
 *   - The server-side legal ledger (legal_acceptances) is deliberately not
 *     touched here. Its acceptance types are a closed database constraint, so
 *     recording a new kind of consent there is a backend decision for the owner,
 *     not something a client change may quietly assume.
 *
 * WHY THIS IS A SHARED SERVICE AND NOT PART OF services/vto/. VTO-NC-010 bans
 * device storage in every VTO file, and "a try-on persists nothing" must stay
 * true of the VTO surfaces. The consent record is the one thing that has to
 * outlive a session, so it lives here, in a small service with no network
 * client and no knowledge of any feature's UI. Features name themselves through
 * the closed union below; adding one is a deliberate edit to this file.
 *
 * FAIL CLOSED, EVERYWHERE. No signed-in actor, an unknown feature, an empty
 * version, unreadable storage, corrupt JSON, a different version, a failed
 * write: every one of them reads as "no consent". The only route to `true` is a
 * record that was read back or written for the CURRENT actor at exactly the
 * version being asked about.
 *
 * ACCOUNT ISOLATION. The record is keyed by feature and account, both in device
 * storage and in the in-memory cache, and the cache is read for whichever actor
 * is current at the moment of the call. Account B on a device where account A
 * consented sees no consent, and an account switch that lands while a write is
 * in flight can never hand the new account the old account's tap.
 *
 * WHY A SYNCHRONOUS CHECK. The moment that matters is the tap that starts a
 * transmission. `hasThirdPartyAiConsentNow` answers from memory so that call
 * site never awaits, and so a consent that has just been granted is visible to
 * the very next line. `loadThirdPartyAiConsent` warms that memory from storage
 * ahead of time.
 */

import AsyncStorage from '@react-native-async-storage/async-storage';

import { getActorContext } from './actorContext';

/**
 * Closed on purpose. Every feature that sends content to an external AI service
 * names itself here, so the set of things a customer has been asked about is
 * reviewable in one line.
 */
export const THIRD_PARTY_AI_FEATURES = ['virtual_try_on'] as const;
export type ThirdPartyAiFeature = (typeof THIRD_PARTY_AI_FEATURES)[number];

const KEY_PREFIX = 'kscan.thirdPartyAiConsent.v1';

/** Device-storage key for one account's consent to one feature. */
export function thirdPartyAiConsentKey(feature: ThirdPartyAiFeature, actorId: string): string {
  return `${KEY_PREFIX}:${feature}:${actorId}`;
}

function cacheKey(feature: ThirdPartyAiFeature, actorId: string): string {
  return `${feature}:${actorId}`;
}

/** The consent version this process has seen granted, per feature and account. */
const consentCache = new Map<string, string>();

/**
 * Bumped on both sides of every grant and every withdrawal. A read that started
 * before either of them may hold a stale answer, and applying it would let an
 * old "no record" erase a consent the customer has just given.
 */
let mutationEpoch = 0;

function currentActorId(): string | null {
  const actorId = getActorContext().actorId;
  return typeof actorId === 'string' && actorId ? actorId : null;
}

function isKnownFeature(value: unknown): value is ThirdPartyAiFeature {
  return typeof value === 'string' && (THIRD_PARTY_AI_FEATURES as readonly string[]).includes(value);
}

function isUsableVersion(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** True only for a well-formed record at exactly the requested version. */
function isGrantedRecord(raw: string | null, version: string): boolean {
  if (typeof raw !== 'string' || !raw) return false;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return false;
    const record = parsed as Record<string, unknown>;
    if (record.version !== version) return false;
    return typeof record.grantedAt === 'string' && Number.isFinite(Date.parse(record.grantedAt));
  } catch {
    return false;
  }
}

/**
 * Synchronous: has the CURRENT account consented to this feature at this
 * version? Answers from memory only, so it is false until a load or a grant has
 * put the answer there. False when nobody is signed in.
 */
export function hasThirdPartyAiConsentNow(feature: ThirdPartyAiFeature, version: string): boolean {
  if (!isKnownFeature(feature) || !isUsableVersion(version)) return false;
  const actorId = currentActorId();
  if (!actorId) return false;
  return consentCache.get(cacheKey(feature, actorId)) === version;
}

/**
 * Reads the current account's record from device storage and warms the cache.
 *
 * Any error, corrupt value or different version answers false AND clears that
 * cache entry: an unreadable record is not consent, and a warm entry the
 * storage no longer backs must not outlive it.
 */
export async function loadThirdPartyAiConsent(
  feature: ThirdPartyAiFeature,
  version: string,
): Promise<boolean> {
  if (!isKnownFeature(feature) || !isUsableVersion(version)) return false;
  const actorId = currentActorId();
  if (!actorId) return false;

  const startedAt = mutationEpoch;
  let granted = false;
  try {
    granted = isGrantedRecord(await AsyncStorage.getItem(thirdPartyAiConsentKey(feature, actorId)), version);
  } catch {
    granted = false;
  }

  // The account changed while storage was being read: nothing here belongs to
  // whoever is signed in now.
  if (currentActorId() !== actorId) return false;
  // A grant or a withdrawal landed while storage was being read. It is newer
  // than this read, so the cache already holds the truth.
  if (mutationEpoch !== startedAt) return hasThirdPartyAiConsentNow(feature, version);

  if (granted) consentCache.set(cacheKey(feature, actorId), version);
  else consentCache.delete(cacheKey(feature, actorId));
  return granted;
}

/**
 * Persists the current account's consent THEN makes it visible to the
 * synchronous check. False, with the cache untouched, when nobody is signed in
 * or the write fails: a choice that could not be saved is not consent.
 *
 * The actor is captured before the write and re-checked after it. If the
 * account changed in between, the cache is not set for anyone and the answer is
 * false -- the tap belongs to a session that is no longer the current one. The
 * record itself stays under the account that made it, so that account finds it
 * on its next load.
 */
export async function recordThirdPartyAiConsent(
  feature: ThirdPartyAiFeature,
  version: string,
  now: Date | number = Date.now(),
): Promise<boolean> {
  if (!isKnownFeature(feature) || !isUsableVersion(version)) return false;
  const actorId = currentActorId();
  if (!actorId) return false;

  mutationEpoch += 1;
  let stored = false;
  try {
    const grantedAt = new Date(now).toISOString();
    await AsyncStorage.setItem(
      thirdPartyAiConsentKey(feature, actorId),
      JSON.stringify({ version, grantedAt }),
    );
    stored = true;
  } catch {
    stored = false;
  }
  mutationEpoch += 1;

  if (!stored) return false;
  if (currentActorId() !== actorId) return false;
  consentCache.set(cacheKey(feature, actorId), version);
  return true;
}

/**
 * Removes the current account's consent to one feature, from memory and from
 * device storage. Memory goes first and synchronously, so the gate is closed
 * before the storage write resolves. Resolves false when nobody is signed in or
 * storage could not be updated -- a caller that offers withdrawal must surface
 * that, because a record that survives would be found again by the next load.
 *
 * Not wired to any screen yet: this is the API a Privacy screen control will
 * call, and it is covered by tests so it is ready when that control exists.
 */
export async function withdrawThirdPartyAiConsent(feature: ThirdPartyAiFeature): Promise<boolean> {
  if (!isKnownFeature(feature)) return false;
  const actorId = currentActorId();
  if (!actorId) return false;

  mutationEpoch += 1;
  consentCache.delete(cacheKey(feature, actorId));
  let removed = false;
  try {
    await AsyncStorage.removeItem(thirdPartyAiConsentKey(feature, actorId));
    removed = true;
  } catch {
    removed = false;
  }
  mutationEpoch += 1;
  return removed;
}
