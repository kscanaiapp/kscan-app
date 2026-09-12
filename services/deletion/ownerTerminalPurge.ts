/**
 * Owner-scoped terminal local cleanup.
 *
 * WIRING, NOT A NEW PURGE SYSTEM. Every destructive call below is an existing
 * primitive this repository already shipped and deliberately left unwired —
 * several of them say so in their own doc comments ("intentionally not wired to
 * any production deletion caller", "terminal purge waits for a confirmed
 * server-side purge"). Repair 07 is the caller they were waiting for. Five
 * further primitives of the same shape were added alongside this module for the
 * dressing-room stores, the saved-look return context and the stylist voice
 * preference, which had per-record actor tagging but no way to erase a
 * NON-CURRENT actor.
 *
 * THE ONE RULE THAT SHAPES EVERYTHING HERE: the target actor is supplied, never
 * inferred. Terminal cleanup runs after the departed actor's session is gone
 * and frequently while a DIFFERENT actor is signed in, so anything that
 * resolves "the current actor" is the wrong tool. That is also why this module
 * calls no blanket helper: no AsyncStorage.clear(), no SecureStore sweep, no
 * `clearAll*` variant, no signOut, no `resetActorScopedRuntimeState`. Each of
 * those would take the signed-in actor's data with it.
 *
 * DELIBERATELY NOT PURGED HERE:
 *  - StyleChat composer drafts, today-weather, VTO media/derivatives, K+ status,
 *    Packing runtime, stylist identity and the memory caches. These are
 *    SINGLE-SLOT or in-memory stores that `resetActorScopedRuntimeState` already
 *    clears on every actor transition, so the departed actor's copy is gone
 *    before terminal cleanup ever runs — and the slot now holds the CURRENT
 *    actor's data, so touching it here would be the actor-isolation bug this
 *    module exists to avoid.
 *  - Device-scoped state: the Watchlist device id and push-disabled marker,
 *    feature-freeze config, privacy preferences, location-disclosure
 *    acknowledgement, hidden-content/hidden-user moderation lists, free-tier
 *    device stores, mirror sessions and the avatar animation engine choice.
 *    None of these is filed under an owner, and this repair does not
 *    reclassify device state as user-owned deletion data.
 *
 * IDEMPOTENT AND RESUMABLE. Every step tolerates already-done: a manifest with
 * no matching records, an AsyncStorage key that is already absent, a directory
 * that no longer exists. A partially failed run reports `complete: false`, and
 * the caller MUST leave the marker in place so the remaining work is retried.
 */

import { purgeLocalScansForOwner } from '../library';
import { purgeLocalClosetForOwner } from '../closetLibrary';
import { purgeLocalClosetCandidatesForOwner } from '../closetCandidateLibrary';
import { purgeClosetSyncStateForOwner } from '../closet/closetSyncStore';
import { purgeClosetRestoreMediaCacheForOwner } from '../closet/closetRestoreMedia';
import { purgeSavedLooksForActor } from '../privateSavedLookStore';
import { purgeDressingRoomSessionsForActor } from '../privateDressingRoomSessionStore';
import { purgeDressingRoomCompositionsForActor } from '../privateDressingRoomCompositionStore';
import { purgeDressingRoomInteractionsForActor } from '../privateDressingRoomInteractionStore';
import { purgeSavedLookReturnContextForActor } from '../privateSavedLookReturnContext';
import { purgeStylistVoicePreferenceForActor } from '../../stores/stylistVoicePreferenceStore';
import { clearSignatureStylePreferencesForUser } from '../signature-style/localSignatureStylePreferences';
import { clearLocalSignatureStyleForUser } from '../signature-style/localSignatureStyleFeedbackStore';
import { clearReasonsForUser } from '../signature-style/localSignatureStyleReasons';
import { clearCachedPackingPlan } from '../packing/packingPlanCache';
import { clearOnboardingComplete } from '../onboardingCompletion';

export type PurgeStepResult = { step: string; ok: boolean };

export type OwnerPurgeResult = {
  /** True only when EVERY step reported success. The marker turns on this. */
  complete: boolean;
  ownerId: string;
  steps: PurgeStepResult[];
};

/**
 * Signature Style files its local records under `user:<supabase user id>` —
 * see app/style-chat/[sessionId].tsx, which is where that key is minted. The
 * marker stores the raw id, so the derivation lives here rather than being
 * baked into the stored record, where a later change to the Signature Style
 * key shape would silently orphan every existing marker.
 */
export function signatureStyleUserKey(ownerId: string): string {
  return `user:${ownerId}`;
}

type PurgeDeps = Partial<{
  purgeScans: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeCloset: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeClosetCandidates: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeClosetSync: (ownerId: string) => Promise<void>;
  purgeClosetRestoreMedia: (ownerId: string) => Promise<void>;
  purgeSavedLooks: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeDressingRoomSessions: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeDressingRoomCompositions: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeDressingRoomInteractions: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeSavedLookReturnContext: (ownerId: string) => Promise<{ ok: boolean }>;
  purgeStylistVoicePreference: (ownerId: string) => Promise<{ ok: boolean }>;
  clearSignatureStylePreferences: (userKey: string) => Promise<void>;
  clearSignatureStyleFeedback: (userKey: string) => Promise<void>;
  clearSignatureStyleReasons: (userKey: string) => Promise<void>;
  clearPackingPlanCache: (ownerId: string) => Promise<void>;
  clearOnboarding: (ownerId: string) => Promise<void>;
}>;

/**
 * Runs one step, converting every failure mode into `ok: false`.
 *
 * A throw, a rejected promise and an explicit `{ ok: false }` are all the same
 * thing to the caller: this subsystem was not cleaned, so the marker stays and
 * the whole run is retried later. Nothing is allowed to escape and abort the
 * remaining steps — one broken subsystem must not prevent the other fifteen
 * from being cleaned.
 */
async function runStep(
  step: string,
  // Deliberately `unknown`, not `Promise<unknown>`: services/library.js and
  // services/closetLibrary.js are JavaScript whose JSDoc declares a plain
  // object return, so TypeScript infers a value-or-promise union for them.
  // Awaiting an already-settled value is correct either way.
  operation: () => unknown,
): Promise<PurgeStepResult> {
  try {
    const result = await operation();
    if (result && typeof result === 'object' && 'ok' in result) {
      return { step, ok: (result as { ok: unknown }).ok === true };
    }
    // A void primitive that did not throw has done its work; the underlying
    // helpers swallow their own I/O errors and are idempotent by design.
    return { step, ok: true };
  } catch {
    return { step, ok: false };
  }
}

/**
 * Destroys every owner-scoped local record belonging to `ownerId`.
 *
 * Fails closed on a blank owner: an empty string would match the ownerless
 * signed-out partition in several of these stores, which is device-local
 * history that no account deletion may take.
 *
 * Steps run sequentially. Several of these stores serialise through their own
 * mutation queues, and running them in parallel would only interleave waiting,
 * while making a partial failure much harder to reason about.
 */
export async function purgeOwnerScopedLocalData(
  ownerId: string,
  deps: PurgeDeps = {},
): Promise<OwnerPurgeResult> {
  const owner = typeof ownerId === 'string' ? ownerId.trim() : '';
  if (!owner) {
    return { complete: false, ownerId: '', steps: [{ step: 'owner_scope', ok: false }] };
  }

  const userKey = signatureStyleUserKey(owner);

  const steps: PurgeStepResult[] = [];
  steps.push(await runStep('recent_scans', () => (deps.purgeScans ?? purgeLocalScansForOwner)(owner)));
  steps.push(await runStep('closet_items', () => (deps.purgeCloset ?? purgeLocalClosetForOwner)(owner)));
  steps.push(
    await runStep('closet_candidates', () =>
      (deps.purgeClosetCandidates ?? purgeLocalClosetCandidatesForOwner)(owner),
    ),
  );
  steps.push(
    await runStep('closet_sync_state', () =>
      (deps.purgeClosetSync ?? purgeClosetSyncStateForOwner)(owner),
    ),
  );
  steps.push(
    await runStep('closet_restore_media', () =>
      (deps.purgeClosetRestoreMedia ?? purgeClosetRestoreMediaCacheForOwner)(owner),
    ),
  );
  steps.push(
    await runStep('saved_looks', () => (deps.purgeSavedLooks ?? purgeSavedLooksForActor)(owner)),
  );
  steps.push(
    await runStep('dressing_room_sessions', () =>
      (deps.purgeDressingRoomSessions ?? purgeDressingRoomSessionsForActor)(owner),
    ),
  );
  steps.push(
    await runStep('dressing_room_compositions', () =>
      (deps.purgeDressingRoomCompositions ?? purgeDressingRoomCompositionsForActor)(owner),
    ),
  );
  steps.push(
    await runStep('dressing_room_interactions', () =>
      (deps.purgeDressingRoomInteractions ?? purgeDressingRoomInteractionsForActor)(owner),
    ),
  );
  steps.push(
    await runStep('saved_look_return_context', () =>
      (deps.purgeSavedLookReturnContext ?? purgeSavedLookReturnContextForActor)(owner),
    ),
  );
  steps.push(
    await runStep('stylist_voice_preference', () =>
      (deps.purgeStylistVoicePreference ?? purgeStylistVoicePreferenceForActor)(owner),
    ),
  );
  steps.push(
    await runStep('signature_style_preferences', () =>
      (deps.clearSignatureStylePreferences ?? clearSignatureStylePreferencesForUser)(userKey),
    ),
  );
  steps.push(
    await runStep('signature_style_feedback', () =>
      (deps.clearSignatureStyleFeedback ?? clearLocalSignatureStyleForUser)(userKey),
    ),
  );
  steps.push(
    await runStep('signature_style_reasons', () =>
      (deps.clearSignatureStyleReasons ?? clearReasonsForUser)(userKey),
    ),
  );
  steps.push(
    await runStep('packing_plan_cache', () =>
      (deps.clearPackingPlanCache ?? clearCachedPackingPlan)(owner),
    ),
  );
  steps.push(
    await runStep('onboarding_completion', () =>
      (deps.clearOnboarding ?? clearOnboardingComplete)(owner),
    ),
  );

  return { complete: steps.every((s) => s.ok), ownerId: owner, steps };
}
