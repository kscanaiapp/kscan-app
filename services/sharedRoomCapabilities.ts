// Shared Dressing Room capability resolution — single source of truth.
//
// The V17 list card hard-coded every shared room as "Shared · View only",
// while production policy actually supports participant collaboration:
//   dressing_room_messages       participant SELECT + INSERT   (chat)
//   dressing_room_item_reactions participant SELECT/INSERT/UPDATE/DELETE
//   dressing_rooms / items       recipient SELECT (read policies, 20260724)
//   dressing_room_items          recipient INSERT/UPDATE/DELETE: NOT yet —
//                                ships with the contributions migration and
//                                stays dark behind SHARED_ROOM_CONTRIBUTIONS_V1.
//
// Membership model (actual schema): a single 'participant' role
// (dressing_room_participants.role CHECK) plus the Shared-With-Me
// membership (shared_room_memberships). There is no viewer/editor split;
// an ACTIVE recipient is a collaborator for chat + reactions, and the
// server (RLS/RPC) remains the security boundary — these capabilities
// only decide which controls the client presents.
//
// Administrative actions (rename, delete, manage members, revoke) are
// owner-only by policy and stay owner-only here.

import {
  DRESSING_ROOM_COLLABORATION_V1,
  DRESSING_ROOM_REACTIONS_V1,
  ELISE_SHARED_ROOM_EVIDENCE_V1,
  ROOM_CHAT_ENABLED,
  SHARED_ROOM_CONTRIBUTIONS_V1,
} from '../constants/featureFlags';
import type { SharedRoomMembershipSummary } from './sharedRoomMemberships';

export type SharedRoomCapabilities = {
  canView: boolean;
  canAddItems: boolean;
  canEditOwnItems: boolean;
  canRemoveOwnItems: boolean;
  canReact: boolean;
  canChat: boolean;
  canUseEliseEvidence: boolean;
  canRenameRoom: boolean;
  canManageMembers: boolean;
  canDeleteRoom: boolean;
};

export type SharedRoomAccessRole = 'owner' | 'collaborator' | 'viewer' | 'unavailable';

export type SharedRoomCapabilityInput = {
  /** True only when the caller is signed in with an active session. */
  isAuthenticated: boolean;
  /** True when the caller owns the room (owner surfaces, not Shared-With-Me). */
  isOwner: boolean;
  /** Shared-With-Me availability; anything but available/empty is inert. */
  availability: SharedRoomMembershipSummary['availability'];
};

const NO_CAPABILITIES: SharedRoomCapabilities = {
  canView: false,
  canAddItems: false,
  canEditOwnItems: false,
  canRemoveOwnItems: false,
  canReact: false,
  canChat: false,
  canUseEliseEvidence: false,
  canRenameRoom: false,
  canManageMembers: false,
  canDeleteRoom: false,
};

export function resolveSharedRoomCapabilities(
  input: SharedRoomCapabilityInput,
): SharedRoomCapabilities {
  const active = input.availability === 'available' || input.availability === 'empty';
  if (!active || !input.isAuthenticated) return { ...NO_CAPABILITIES };

  if (input.isOwner) {
    return {
      canView: true,
      canAddItems: true,
      canEditOwnItems: true,
      canRemoveOwnItems: true,
      canReact: DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_REACTIONS_V1,
      canChat: ROOM_CHAT_ENABLED,
      canUseEliseEvidence: true,
      canRenameRoom: true,
      canManageMembers: true,
      canDeleteRoom: true,
    };
  }

  return {
    canView: true,
    // Item contributions ship with the contributions migration; until it is
    // deployed the flag stays false so no control points at a denied mutation.
    canAddItems: SHARED_ROOM_CONTRIBUTIONS_V1,
    canEditOwnItems: SHARED_ROOM_CONTRIBUTIONS_V1,
    canRemoveOwnItems: SHARED_ROOM_CONTRIBUTIONS_V1,
    // Participant policies for these already exist in production.
    canReact: DRESSING_ROOM_COLLABORATION_V1 && DRESSING_ROOM_REACTIONS_V1,
    canChat: ROOM_CHAT_ENABLED,
    canUseEliseEvidence: ELISE_SHARED_ROOM_EVIDENCE_V1,
    canRenameRoom: false,
    canManageMembers: false,
    canDeleteRoom: false,
  };
}

export function sharedRoomAccessRole(
  input: SharedRoomCapabilityInput,
): SharedRoomAccessRole {
  const active = input.availability === 'available' || input.availability === 'empty';
  if (!active) return 'unavailable';
  if (input.isOwner) return 'owner';
  const caps = resolveSharedRoomCapabilities(input);
  return caps.canChat || caps.canReact || caps.canAddItems ? 'collaborator' : 'viewer';
}

/** Shared-With-Me card pill copy — accurate access, never implies ownership. */
export function sharedRoomStatusLabel(input: SharedRoomCapabilityInput): string {
  switch (sharedRoomAccessRole(input)) {
    case 'unavailable':
      return 'Shared · Unavailable';
    case 'collaborator':
      return 'Shared · Collaborator';
    default:
      return 'Shared · View only';
  }
}

/** Screen-reader access descriptor matching the visible pill. */
export function sharedRoomAccessA11y(input: SharedRoomCapabilityInput): string {
  switch (sharedRoomAccessRole(input)) {
    case 'unavailable':
      return 'no longer available, shared, view only';
    case 'collaborator':
      return 'shared, collaborator';
    default:
      return 'shared, view only';
  }
}
