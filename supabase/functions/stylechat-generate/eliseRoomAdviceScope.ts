import type { EliseVisualContextEnvelope } from './eliseVisualContextTypes.ts';

export type EliseRoomAdviceScope =
  | { kind: 'none'; roomId: null }
  | { kind: 'unresolved'; roomId: null }
  | { kind: 'owned_room'; roomId: string }
  | { kind: 'shared_room'; roomId: string };

export type EliseRequestedRoomSource = 'dressing_room' | 'shared_room';

/** Client input can only narrow retrieval; it can never establish authority. */
export function requestedEliseRoomSource(rawActiveContext: unknown): EliseRequestedRoomSource | null {
  if (!rawActiveContext || typeof rawActiveContext !== 'object' || Array.isArray(rawActiveContext)) {
    return null;
  }
  const source = (rawActiveContext as Record<string, unknown>).source;
  return source === 'dressing_room' || source === 'shared_room' ? source : null;
}

/**
 * Constrains S7 wardrobe retrieval when the active Elise context is a room.
 *
 * A room request is authoritative only after the normal server resolver has
 * verified one exact room. If that resolution is missing, mixed, or
 * contradictory, callers must retrieve no wardrobe fallback at all. This
 * prevents a stale/foreign room reference from silently widening into Closet,
 * Recent Scan, inspiration, or another Dressing Room.
 */
export function resolveEliseRoomAdviceScope(
  envelope: EliseVisualContextEnvelope | null,
  requestedRoomSource: EliseRequestedRoomSource | null = null,
): EliseRoomAdviceScope {
  // A declared room context whose resolver failed must not widen into normal
  // wardrobe retrieval. The raw declaration is used only to fail closed.
  if (!envelope) {
    return requestedRoomSource
      ? { kind: 'unresolved', roomId: null }
      : { kind: 'none', roomId: null };
  }

  const envelopeRoomSource = envelope.requestSource === 'dressing_room'
    ? 'dressing_room'
    : envelope.requestSource === 'shared_room'
    ? 'shared_room'
    : null;
  if (requestedRoomSource && envelopeRoomSource !== requestedRoomSource) {
    return { kind: 'unresolved', roomId: null };
  }
  const effectiveRoomSource = requestedRoomSource ?? envelopeRoomSource;
  const expectedSource = effectiveRoomSource === 'dressing_room'
    ? 'owned_room_item'
    : effectiveRoomSource === 'shared_room'
    ? 'shared_room_item'
    : null;
  if (!expectedSource) return { kind: 'none', roomId: null };

  const verifiedRoomEvidence = envelope.evidence.filter((evidence) =>
    evidence.sourceType === expectedSource &&
    evidence.trust === 'server_verified' &&
    evidence.roomId
  );
  const roomIds = [...new Set(verifiedRoomEvidence.map((evidence) => evidence.roomId!))];
  if (roomIds.length !== 1) return { kind: 'unresolved', roomId: null };

  const relationship = expectedSource === 'owned_room_item' ? 'owned' : 'shared';
  if (verifiedRoomEvidence.some((evidence) => evidence.actorRelationship !== relationship)) {
    return { kind: 'unresolved', roomId: null };
  }

  return {
    kind: expectedSource === 'owned_room_item' ? 'owned_room' : 'shared_room',
    roomId: roomIds[0],
  };
}
