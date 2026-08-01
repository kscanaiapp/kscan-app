// Mirror Selfie extraction session (Build 2.5 Step 3).
//
// THE ORCHESTRATOR. Owns the status machine, the run token, the temporary media
// and the typed handoff. Every other file in services/mirror/ is a pure stage
// this one sequences.
//
// ── THE HARD BOUNDARY ───────────────────────────────────────────────────────
//
// This module imports NOTHING from the candidate, Closet, Recent Scan, Scanner
// or commerce layers, and makes no network call of any kind. That is not a
// convention to be careful about — it is asserted by an executable test that
// reads this file's import list. The only value that ever leaves is a
// MirrorExtractionSelection: a session id and a list of {cropUri, cropKey}.
//
// ── CANCELLATION ────────────────────────────────────────────────────────────
//
// `runToken` is monotonic. Cancel increments it and returns immediately. Every
// await in the pipeline is followed by a token check, so a result computed
// against a dead token is discarded rather than written into state — and any
// file that late run created is deleted on the way out. Neither ML Kit nor
// Vision can be interrupted mid-inference, so this is how a cancel becomes
// instant and truthful without lying about the native runtime.
//
// ── ACTOR CHANGE ────────────────────────────────────────────────────────────
//
// A session belongs to the actor who started it. If the actor changes — sign
// out, account switch — the session is cancelled and its media destroyed before
// anything else can happen. A crop of one person's clothes must never be handed
// to the next account on the device.
//
// ── RETENTION ───────────────────────────────────────────────────────────────
//
//   normalized selfie   deleted the moment crop selection is accepted
//   rejected crops      deleted the moment they are discarded
//   approved crops      retained until Step 4 resolves, cancel, actor change,
//                       or the existing candidate TTL expires
//
// The asymmetry is the point: the photograph of the user's body has the
// shortest life of anything here.

import { isActorRequestCurrent } from '../actorContext';
import { MIRROR_SELFIE_V1_ACTIVE } from '../../constants/featureFlags';
import {
  isValidMirrorCropKey,
  isValidMirrorSessionId,
} from '../../types/mirrorExtraction';
import type {
  LocalMirrorGarmentCrop,
  MirrorExtractionErrorCode,
  MirrorExtractionSelection,
  MirrorExtractionSessionStatus,
  MirrorSourceType,
  NormalizedBounds,
} from '../../types/mirrorExtraction';
import {
  createMirrorSessionId,
  deleteMirrorNormalizedSource,
  deleteMirrorSession,
  deleteMirrorSessionFile,
} from './mirrorSessionStorage';
import { prepareMirrorSource } from './mirrorSourcePreparation';
import type { PreparedMirrorSource } from './mirrorSourcePreparation';
import { deriveGarmentRegions } from './mirrorGarmentRegions';
import { generateMirrorGarmentCrops } from './mirrorCropGeneration';
import { bucketPersonCount, resolvePrimaryPerson } from './mirrorPersonResolution';
import {
  unsupportedMirrorExtractionAdapter,
  createNativeMirrorExtractionAdapter,
} from './mirrorExtractionAdapter';
import type { MirrorDetectedPerson, MirrorExtractionAdapter } from './mirrorExtractionAdapter';
import {
  emitMirrorCropReviewCompleted,
  emitMirrorExtractionCancelled,
  emitMirrorExtractionCompleted,
  emitMirrorSourceSelected,
  emitMirrorValidationCompleted,
} from './mirrorTelemetry';

export type MirrorSessionSnapshot = {
  extractionSessionId: string;
  status: MirrorExtractionSessionStatus;
  sourceType: MirrorSourceType | null;
  crops: LocalMirrorGarmentCrop[];
  /** Ordered candidates when the user must choose. Null otherwise. */
  personChoices: NormalizedBounds[] | null;
  errorCode: MirrorExtractionErrorCode | null;
  /** True crop count, never truncated to the staging limit. */
  cropCount: number;
  selectedCount: number;
};

export type MirrorSessionController = {
  getSnapshot(): MirrorSessionSnapshot;
  subscribe(listener: (snapshot: MirrorSessionSnapshot) => void): () => void;
  /** Run the whole pipeline for one source image. */
  extractFromSource(input: {
    sourceUri: string;
    sourceType: MirrorSourceType;
    /** Picker-reported dimensions. See prepareMirrorSource — without these the
     *  minimum-size guard cannot fire, because a blind ceiling resize upscales. */
    sourceWidth?: number | null;
    sourceHeight?: number | null;
  }): Promise<void>;
  /** Answer the ambiguous-people question and continue. */
  choosePerson(index: number): Promise<void>;
  setCropSelected(cropKey: string, selected: boolean): void;
  discardCrop(cropKey: string): Promise<void>;
  /** Drop every generated crop and re-run against the same source. */
  retry(): Promise<void>;
  cancel(): Promise<void>;
  /**
   * Accept the current selection. Deletes the normalized selfie and returns the
   * typed Step 4 handoff — or null when nothing is selected, which is a valid
   * user choice and cleans the whole session.
   */
  acceptSelection(): Promise<MirrorExtractionSelection | null>;
};

export type CreateMirrorSessionDeps = {
  adapter?: MirrorExtractionAdapter;
  actorRequest?: { actorId: string | null; epoch: number; requestId: string };
  resolveActive?: () => boolean;
  isActorCurrent?: (request: unknown) => boolean;
  prepareSource?: typeof prepareMirrorSource;
  generateCrops?: typeof generateMirrorGarmentCrops;
  now?: () => number;
  createSessionId?: () => string;
  storage?: {
    deleteSession?: typeof deleteMirrorSession;
    deleteNormalizedSource?: typeof deleteMirrorNormalizedSource;
    deleteFile?: typeof deleteMirrorSessionFile;
  };
};

export function createMirrorExtractionSession(
  deps: CreateMirrorSessionDeps = {},
): MirrorSessionController {
  const resolveActive = deps.resolveActive ?? (() => MIRROR_SELFIE_V1_ACTIVE);
  const isActorCurrent = deps.isActorCurrent ?? isActorRequestCurrent;
  const prepareSource = deps.prepareSource ?? prepareMirrorSource;
  const generateCrops = deps.generateCrops ?? generateMirrorGarmentCrops;
  const now = deps.now ?? (() => Date.now());
  const adapter =
    deps.adapter ??
    (resolveActive() ? createNativeMirrorExtractionAdapter() : unsupportedMirrorExtractionAdapter);
  const storage = {
    deleteSession: deps.storage?.deleteSession ?? deleteMirrorSession,
    deleteNormalizedSource: deps.storage?.deleteNormalizedSource ?? deleteMirrorNormalizedSource,
    deleteFile: deps.storage?.deleteFile ?? deleteMirrorSessionFile,
  };

  const extractionSessionId = (deps.createSessionId ?? createMirrorSessionId)();
  const actorRequest = deps.actorRequest ?? null;

  let status: MirrorExtractionSessionStatus = 'selecting_source';
  let sourceType: MirrorSourceType | null = null;
  let errorCode: MirrorExtractionErrorCode | null = null;
  let crops: LocalMirrorGarmentCrop[] = [];
  let prepared: PreparedMirrorSource | null = null;
  let personCandidates: MirrorDetectedPerson[] | null = null;
  let runToken = 0;
  let cancelled = false;

  const listeners = new Set<(snapshot: MirrorSessionSnapshot) => void>();

  function snapshot(): MirrorSessionSnapshot {
    return {
      extractionSessionId,
      status,
      sourceType,
      crops: crops.map((c) => ({ ...c })),
      personChoices: personCandidates ? personCandidates.map((p) => ({ ...p.bounds })) : null,
      errorCode,
      cropCount: crops.length,
      selectedCount: crops.filter((c) => c.selected).length,
    };
  }

  function publish(): void {
    const current = snapshot();
    for (const listener of listeners) {
      try {
        listener(current);
      } catch {
        /* a subscriber fault never breaks the pipeline */
      }
    }
  }

  function setStatus(next: MirrorExtractionSessionStatus): void {
    status = next;
    publish();
  }

  function fail(code: MirrorExtractionErrorCode): void {
    errorCode = code;
    status = 'failed';
    publish();
  }

  /** A token is live only if it is the newest AND the actor has not changed. */
  function isLive(token: number): boolean {
    if (cancelled || token !== runToken) return false;
    if (actorRequest && !isActorCurrent(actorRequest)) return false;
    return true;
  }

  async function purgeCrops(): Promise<void> {
    const existing = crops;
    crops = [];
    for (const crop of existing) {
      await storage.deleteFile(crop.cropUri, extractionSessionId);
    }
  }

  async function runPipeline(
    token: number,
    explicitChoiceIndex: number | null,
  ): Promise<void> {
    const startedAt = now();

    // ── person detection ────────────────────────────────────────────────────
    setStatus('resolving_person');
    let supported = false;
    try {
      supported = await adapter.isSupported();
    } catch {
      supported = false;
    }
    if (!isLive(token)) return;

    if (!supported) {
      emitMirrorExtractionCompleted({
        outcome: 'unsupported',
        personCountBucket: '0',
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: false,
        personSelectionRequired: false,
        errorCode: 'mirror_extraction_unsupported',
      });
      fail('mirror_extraction_unsupported');
      return;
    }

    const detection = await adapter.detectPersons({ imageUri: prepared.inferenceUri });
    if (!isLive(token)) return;

    if (detection.kind !== 'ok') {
      const code: MirrorExtractionErrorCode =
        detection.kind === 'unsupported' ? 'mirror_extraction_unsupported' : 'mirror_extraction_failed';
      emitMirrorExtractionCompleted({
        outcome: detection.kind === 'unsupported' ? 'unsupported' : 'failed',
        personCountBucket: '0',
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: detection.kind !== 'unsupported',
        personSelectionRequired: false,
        errorCode: code,
      });
      fail(code);
      return;
    }

    const resolution = resolvePrimaryPerson(detection.persons, { explicitChoiceIndex });

    if (resolution.kind === 'none') {
      emitMirrorExtractionCompleted({
        outcome: 'no_person',
        personCountBucket: '0',
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: true,
        personSelectionRequired: false,
        errorCode: 'mirror_no_person_detected',
      });
      fail('mirror_no_person_detected');
      return;
    }

    if (resolution.kind === 'ambiguous') {
      // Stop and ask. No garment is derived from a person we are not sure about,
      // and the candidates are never merged into a combined box.
      personCandidates = resolution.candidates;
      emitMirrorExtractionCompleted({
        outcome: 'ambiguous_people',
        personCountBucket: bucketPersonCount(resolution.personCount),
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: true,
        personSelectionRequired: true,
        errorCode: 'mirror_multiple_people_ambiguous',
      });
      errorCode = 'mirror_multiple_people_ambiguous';
      setStatus('resolving_person');
      return;
    }

    personCandidates = null;

    // ── region derivation ───────────────────────────────────────────────────
    setStatus('extracting_garments');
    const regions = deriveGarmentRegions(resolution.person);
    if (!isLive(token)) return;

    if (regions.length === 0) {
      emitMirrorExtractionCompleted({
        outcome: 'no_regions',
        personCountBucket: bucketPersonCount(resolution.personCount),
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: true,
        personSelectionRequired: false,
        errorCode: 'mirror_no_garments_detected',
      });
      fail('mirror_no_garments_detected');
      return;
    }

    // ── crop generation ─────────────────────────────────────────────────────
    setStatus('generating_crops');
    const generated = await generateCrops(
      {
        extractionSessionId,
        normalizedSourceUri: prepared.normalizedUri,
        normalizedWidth: prepared.normalizedWidth,
        normalizedHeight: prepared.normalizedHeight,
        sourceImageIndex: 0,
        regions,
      },
      { isCancelled: () => !isLive(token) },
    );

    if (!isLive(token)) {
      // A late batch is not allowed to revive a dead session — and its files
      // are not allowed to outlive it either.
      for (const crop of generated.crops) {
        await storage.deleteFile(crop.cropUri, extractionSessionId);
      }
      return;
    }

    if (generated.crops.length === 0) {
      emitMirrorExtractionCompleted({
        outcome: 'no_regions',
        personCountBucket: bucketPersonCount(resolution.personCount),
        cropCount: 0,
        reviewCount: 0,
        durationMs: now() - startedAt,
        extractionSupported: true,
        personSelectionRequired: false,
        errorCode: 'mirror_no_garments_detected',
      });
      fail('mirror_no_garments_detected');
      return;
    }

    crops = generated.crops;
    errorCode = null;

    emitMirrorExtractionCompleted({
      outcome: 'extracted',
      personCountBucket: bucketPersonCount(resolution.personCount),
      cropCount: crops.length,
      reviewCount: crops.filter((c) => c.localConfidenceBucket !== 'high').length,
      durationMs: now() - startedAt,
      extractionSupported: true,
      personSelectionRequired: false,
      errorCode: null,
    });

    setStatus('reviewing_crops');
  }

  return {
    getSnapshot: snapshot,

    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },

    async extractFromSource({ sourceUri, sourceType: type, sourceWidth, sourceHeight }) {
      // (1) The master gate. Nothing below runs while it is false.
      if (resolveActive() !== true) {
        fail('mirror_extraction_unsupported');
        return;
      }
      // (2) Actor currency, before a single byte is copied.
      if (actorRequest && !isActorCurrent(actorRequest)) {
        fail('mirror_actor_changed');
        return;
      }
      if (!isValidMirrorSessionId(extractionSessionId)) {
        fail('mirror_session_storage_failed');
        return;
      }

      cancelled = false;
      runToken += 1;
      const token = runToken;

      sourceType = type;
      errorCode = null;
      personCandidates = null;
      await purgeCrops();

      emitMirrorSourceSelected({ sourceType: type, sourceCount: 1 });

      setStatus('validating');
      const preparation = await prepareSource({
        extractionSessionId,
        sourceUri,
        sourceWidth,
        sourceHeight,
      });
      if (!isLive(token)) {
        await storage.deleteSession(extractionSessionId);
        return;
      }

      if (preparation.kind !== 'ok') {
        emitMirrorValidationCompleted({ outcome: 'rejected', errorCode: preparation.errorCode });
        // A source that failed validation has no reason to persist. Whatever
        // partial copy was made is destroyed here, not at some later sweep.
        await storage.deleteSession(extractionSessionId);
        prepared = null;
        fail(preparation.errorCode);
        return;
      }

      emitMirrorValidationCompleted({ outcome: 'accepted', errorCode: null });
      prepared = preparation.source;

      await runPipeline(token, null);
    },

    async choosePerson(index) {
      if (!prepared || !personCandidates) return;
      if (!Number.isInteger(index) || index < 0 || index >= personCandidates.length) return;
      if (actorRequest && !isActorCurrent(actorRequest)) {
        await this.cancel();
        return;
      }
      cancelled = false;
      runToken += 1;
      errorCode = null;
      await runPipeline(runToken, index);
    },

    setCropSelected(cropKey, selected) {
      if (!isValidMirrorCropKey(cropKey)) return;
      let changed = false;
      crops = crops.map((crop) => {
        if (crop.cropKey !== cropKey || crop.selected === selected) return crop;
        changed = true;
        return { ...crop, selected: Boolean(selected) };
      });
      if (changed) publish();
    },

    async discardCrop(cropKey) {
      if (!isValidMirrorCropKey(cropKey)) return;
      const target = crops.find((crop) => crop.cropKey === cropKey);
      if (!target) return;
      crops = crops.filter((crop) => crop.cropKey !== cropKey);
      // Discard means gone, now — not marked hidden and swept later.
      await storage.deleteFile(target.cropUri, extractionSessionId);
      publish();
    },

    async retry() {
      if (!prepared) return;
      if (actorRequest && !isActorCurrent(actorRequest)) {
        await this.cancel();
        return;
      }
      cancelled = false;
      runToken += 1;
      const token = runToken;
      errorCode = null;
      personCandidates = null;
      // Old crops go BEFORE the new run, so a retry can never leave the
      // previous attempt's files behind or blend them into the new result.
      await purgeCrops();
      publish();
      await runPipeline(token, null);
    },

    async cancel() {
      cancelled = true;
      runToken += 1;
      emitMirrorExtractionCancelled({ status, cropCount: crops.length });
      crops = [];
      prepared = null;
      personCandidates = null;
      await storage.deleteSession(extractionSessionId);
      status = 'cancelled';
      publish();
    },

    async acceptSelection() {
      if (status !== 'reviewing_crops') return null;
      if (actorRequest && !isActorCurrent(actorRequest)) {
        await this.cancel();
        return null;
      }

      const selected = crops.filter((crop) => crop.selected);

      // Zero approved crops is a legitimate answer, not a system error. The
      // whole session goes, including the selfie, and nothing is handed on.
      if (selected.length === 0) {
        emitMirrorCropReviewCompleted({
          cropCount: crops.length,
          selectedCount: 0,
          outcome: 'zero_selected',
        });
        crops = [];
        prepared = null;
        await storage.deleteSession(extractionSessionId);
        status = 'completed';
        publish();
        return null;
      }

      // Rejected crops are destroyed now. They were never staged, so nothing
      // downstream can be holding a reference to one.
      const rejected = crops.filter((crop) => !crop.selected);
      for (const crop of rejected) {
        await storage.deleteFile(crop.cropUri, extractionSessionId);
      }
      crops = selected;

      // THE SELFIE GOES HERE. Extraction is finished, retry is no longer
      // offered from this state, and nothing downstream needs the source — so
      // the photograph of the user's body has no remaining purpose.
      await storage.deleteNormalizedSource(extractionSessionId);
      prepared = null;

      emitMirrorCropReviewCompleted({
        cropCount: crops.length,
        selectedCount: selected.length,
        outcome: 'accepted',
      });

      status = 'completed';
      publish();

      // The complete ordered list. Step 3 does NOT partition it at eight —
      // Step 4 owns the staging limit and the batching that goes with it.
      return {
        extractionSessionId,
        crops: selected.map((crop) => ({ cropUri: crop.cropUri, cropKey: crop.cropKey })),
      };
    },
  };
}
