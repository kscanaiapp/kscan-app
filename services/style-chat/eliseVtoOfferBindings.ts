// Elise contextual Virtual Try-On — the actor-scoped, DEVICE-LOCAL binding.
//
// THE SEAM THIS CLOSES. A StyleChat message is stored in the cloud and can show
// up on another device. The garment behind an Elise upload cannot: it is a
// device-local Closet candidate. If the offer block on the message named that
// candidate, a device-local identity would be written into a synchronized
// record merely so a button survives.
//
// So the message carries an opaque random id and nothing else, and THIS store,
// on this device and under this account only, maps that id back to the exact
// garment interpretation the offer was created for:
//
//     assistant message ui_block { localBindingId }
//         -> (this device, current account) binding
//         -> candidateId + contentHash + canonical category + classification
//         -> the existing candidate authority re-checks every one of them
//
// WHAT A BINDING HOLDS. The fingerprint above, the conversation it belongs to,
// and when its candidate stops existing. It holds no photo, no bytes, no path
// or URL, no provider response, no K+ state and nothing the model produced.
//
// WHAT IT AUTHORIZES. Nothing. Resolving a binding only tells the caller which
// candidate to ask the candidate store about; the candidate store, the VTO
// eligibility authority, the K+ reader and the server all still decide for
// themselves on every tap.
//
// ACCOUNT ISOLATION. One storage key per account, every record stamped with the
// account that wrote it, and every read answers only for whichever account is
// current when it finishes. Account B cannot resolve account A's binding, and a
// read that straddles a sign-out answers "not found".
//
// DEVICE-LOCAL, DELIBERATELY. Nothing here is synchronized. On another device,
// or after a reinstall, the id on the message resolves to nothing and the offer
// reports itself unavailable. That is the intended outcome, not a gap: making
// the button portable would mean putting the garment in the cloud.
//
// WHY THIS IS NOT UNDER services/vto/. VTO-NC-010 bans device storage in every
// VTO file. The same reason services/featureAwareness.ts and
// services/thirdPartyAiConsent.ts are shared services.

import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Crypto from 'expo-crypto';

import { getActorContext } from '../actorContext';
import { isEliseVtoLocalBindingId } from './eliseVtoOffer';

const KEY_PREFIX = 'kscan.eliseVtoOfferBindings.v1';
const FILE_VERSION = 1;

/** Newest-first cap. A conversation gets one offer per garment, so this is far
 *  more than a 7-day candidate window can produce; it exists so the record can
 *  never grow without bound. */
export const MAX_ELISE_VTO_OFFER_BINDINGS = 60;

const MAX_FIELD_CHARS = 128;

/** The garment interpretation an offer was created for. */
export type EliseVtoOfferFingerprint = {
  candidateId: string;
  contentHash: string;
  contentHashVersion: string;
  canonicalCategory: string;
  classificationVersion: string;
};

export type EliseVtoOfferBinding = EliseVtoOfferFingerprint & {
  localBindingId: string;
  /** The conversation the offer belongs to. */
  sessionId: string;
  createdAt: string;
  /** The backing candidate's own expiry. Past it, the binding is dead weight. */
  expiresAt: string;
};

type BindingFile = {
  version: typeof FILE_VERSION;
  actorId: string;
  bindings: EliseVtoOfferBinding[];
};

/** Device-storage key for one account's bindings. */
export function eliseVtoOfferBindingsKey(actorId: string): string {
  return `${KEY_PREFIX}:${actorId}`;
}

/** One string per fingerprint. Used for equality only; never stored or sent. */
export function eliseVtoFingerprintKey(fingerprint: EliseVtoOfferFingerprint): string {
  return [
    fingerprint.candidateId,
    fingerprint.contentHash,
    fingerprint.contentHashVersion,
    fingerprint.canonicalCategory,
    fingerprint.classificationVersion,
  ].join('|');
}

function currentActorId(): string | null {
  const actorId = getActorContext().actorId;
  return typeof actorId === 'string' && actorId ? actorId : null;
}

function boundedString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 && value.length <= MAX_FIELD_CHARS
    ? value
    : null;
}

function isoInstant(value: unknown): string | null {
  return typeof value === 'string' && Number.isFinite(Date.parse(value)) ? value : null;
}

function parseBinding(raw: unknown): EliseVtoOfferBinding | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const localBindingId = isEliseVtoLocalBindingId(record.localBindingId) ? record.localBindingId : null;
  const sessionId = boundedString(record.sessionId);
  const candidateId = boundedString(record.candidateId);
  const contentHash = boundedString(record.contentHash);
  const contentHashVersion = boundedString(record.contentHashVersion);
  const canonicalCategory = boundedString(record.canonicalCategory);
  const classificationVersion = boundedString(record.classificationVersion);
  const createdAt = isoInstant(record.createdAt);
  const expiresAt = isoInstant(record.expiresAt);
  if (
    !localBindingId || !sessionId || !candidateId || !contentHash || !contentHashVersion
    || !canonicalCategory || !classificationVersion || !createdAt || !expiresAt
  ) {
    return null;
  }
  // Reconstructed field by field: nothing else in a stored record survives a read.
  return {
    localBindingId,
    sessionId,
    candidateId,
    contentHash,
    contentHashVersion,
    canonicalCategory,
    classificationVersion,
    createdAt,
    expiresAt,
  };
}

/**
 * A stored value, parsed for ONE account. Anything that is not a well-formed
 * file written by exactly that account reads as empty: a corrupt value, another
 * version, or a record stamped with a different account never yields a binding.
 */
export function parseEliseVtoOfferBindingFile(raw: string | null, actorId: string): EliseVtoOfferBinding[] {
  if (typeof raw !== 'string' || !raw) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return [];
  const file = parsed as Record<string, unknown>;
  if (file.version !== FILE_VERSION || file.actorId !== actorId || !Array.isArray(file.bindings)) return [];
  const bindings: EliseVtoOfferBinding[] = [];
  const seen = new Set<string>();
  for (const entry of file.bindings) {
    const binding = parseBinding(entry);
    if (!binding || seen.has(binding.localBindingId)) continue;
    seen.add(binding.localBindingId);
    bindings.push(binding);
  }
  return bindings;
}

function isLive(binding: EliseVtoOfferBinding, nowMs: number): boolean {
  return Date.parse(binding.expiresAt) > nowMs;
}

async function readBindings(actorId: string): Promise<EliseVtoOfferBinding[]> {
  try {
    return parseEliseVtoOfferBindingFile(
      await AsyncStorage.getItem(eliseVtoOfferBindingsKey(actorId)),
      actorId,
    );
  } catch {
    return [];
  }
}

async function writeBindings(actorId: string, bindings: EliseVtoOfferBinding[]): Promise<boolean> {
  try {
    const key = eliseVtoOfferBindingsKey(actorId);
    if (bindings.length === 0) {
      await AsyncStorage.removeItem(key);
      return true;
    }
    const file: BindingFile = { version: FILE_VERSION, actorId, bindings };
    await AsyncStorage.setItem(key, JSON.stringify(file));
    return true;
  } catch {
    return false;
  }
}

/** One writer at a time per account, so two offers created back to back cannot
 *  each read the old file and lose the other's entry. */
const writeQueues = new Map<string, Promise<unknown>>();

function enqueue<T>(actorId: string, task: () => Promise<T>): Promise<T> {
  const previous = writeQueues.get(actorId) ?? Promise.resolve();
  const next = previous.then(task, task);
  writeQueues.set(actorId, next.catch(() => undefined));
  return next;
}

function newLocalBindingId(): string | null {
  try {
    const bytes = Crypto.getRandomBytes(16);
    const id = Array.from(bytes, (byte: number) => byte.toString(16).padStart(2, '0')).join('');
    return isEliseVtoLocalBindingId(id) ? id : null;
  } catch {
    // No secure randomness means no id, and therefore no offer. A guessable or
    // repeated id is worse than a missing button.
    return null;
  }
}

/**
 * The binding for one fingerprint in one conversation, if this account already
 * has one. This is what makes the automatic offer appear at most once per
 * garment per conversation.
 */
export async function findEliseVtoOfferBinding(input: {
  sessionId: string;
  fingerprint: EliseVtoOfferFingerprint;
  nowMs?: number;
}): Promise<EliseVtoOfferBinding | null> {
  const actorId = currentActorId();
  if (!actorId || !input.sessionId) return null;
  const nowMs = input.nowMs ?? Date.now();
  const wanted = eliseVtoFingerprintKey(input.fingerprint);
  const bindings = await readBindings(actorId);
  if (currentActorId() !== actorId) return null;
  return (
    bindings.find(
      (binding) =>
        binding.sessionId === input.sessionId
        && isLive(binding, nowMs)
        && eliseVtoFingerprintKey(binding) === wanted,
    ) ?? null
  );
}

/**
 * Records a new binding for the current account and returns it.
 *
 * Returns null — and so produces no offer — when nobody is signed in, the
 * input is malformed, an id cannot be generated, the account changed during the
 * write, or the record could not be saved. A binding that was not durably
 * written must not be referenced from a message.
 */
export async function createEliseVtoOfferBinding(input: {
  sessionId: string;
  fingerprint: EliseVtoOfferFingerprint;
  expiresAt: string;
  nowMs?: number;
}): Promise<EliseVtoOfferBinding | null> {
  const actorId = currentActorId();
  if (!actorId) return null;
  const nowMs = input.nowMs ?? Date.now();
  const localBindingId = newLocalBindingId();
  if (!localBindingId) return null;

  const binding = parseBinding({
    ...input.fingerprint,
    localBindingId,
    sessionId: input.sessionId,
    createdAt: new Date(nowMs).toISOString(),
    expiresAt: input.expiresAt,
  });
  if (!binding || !isLive(binding, nowMs)) return null;

  const saved = await enqueue(actorId, async () => {
    const existing = (await readBindings(actorId)).filter((entry) => isLive(entry, nowMs));
    // Newest first, bounded. Expired entries were dropped just above.
    const next = [binding, ...existing].slice(0, MAX_ELISE_VTO_OFFER_BINDINGS);
    return writeBindings(actorId, next);
  });
  if (!saved || currentActorId() !== actorId) return null;
  return binding;
}

/**
 * Resolves an opaque id from a message to this account's binding on this
 * device, or null.
 *
 * Null covers every "not here" alike: nobody signed in, a malformed id, another
 * account's message, another device, a reinstall, an expired candidate. The
 * caller reports all of them the same bounded way and never falls back to some
 * other garment.
 */
export async function resolveEliseVtoOfferBinding(
  localBindingId: unknown,
  options: { nowMs?: number } = {},
): Promise<EliseVtoOfferBinding | null> {
  if (!isEliseVtoLocalBindingId(localBindingId)) return null;
  const actorId = currentActorId();
  if (!actorId) return null;
  const nowMs = options.nowMs ?? Date.now();
  const bindings = await readBindings(actorId);
  // The account may have changed while storage was being read.
  if (currentActorId() !== actorId) return null;
  const binding = bindings.find((entry) => entry.localBindingId === localBindingId);
  return binding && isLive(binding, nowMs) ? binding : null;
}

/**
 * Best-effort cleanup when a conversation is deleted. Removes that
 * conversation's bindings for the current account and nothing else: the Closet
 * candidates themselves belong to the attachment lifecycle, not to this store.
 */
export async function removeEliseVtoOfferBindingsForSession(sessionId: string): Promise<void> {
  const actorId = currentActorId();
  if (!actorId || !sessionId) return;
  await enqueue(actorId, async () => {
    const existing = await readBindings(actorId);
    const next = existing.filter((binding) => binding.sessionId !== sessionId);
    if (next.length !== existing.length) await writeBindings(actorId, next);
  }).catch(() => undefined);
}
