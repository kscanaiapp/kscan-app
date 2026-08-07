// Outfit decision service (AI Stylist expansion).
//
// Sharing, voting, and owner decision state for Dressing Room outfit
// decisions. All mutations go through SECURITY DEFINER RPCs (see
// supabase/migrations/20260711000002_outfit_decision_rooms.sql); direct table
// writes are denied by RLS, which keeps room snapshots immutable after share.
//
// Reads use the room-member RLS policies: the room owner and authenticated
// participants see groups/options/items; vote rows are visible only to their
// caster, and aggregate counts come from a definer RPC that never exposes
// voter identities.

import { supabase } from './supabaseClient';
import type {
  OutfitDecisionDetail,
  OutfitDecisionGroup,
  OutfitDecisionOptionItem,
  OutfitDecisionOptionWithItems,
} from '../types/styleObjects';

const SHARE_ERROR = 'Unable to share to this Dressing Room. Please try again.';
const VOTE_ERROR = 'Unable to save your vote. Please try again.';
const LOAD_ERROR = 'Unable to load outfit decisions.';
const DECISION_ERROR = 'Unable to update this decision. Please try again.';

export const DECISION_QUESTION_MAX_LENGTH = 140;

export const DECISION_QUESTION_PRESETS = [
  'Should I wear this?',
  'Which option works best?',
  'Help me improve this.',
] as const;

// Database errors never reach the user verbatim. A PostgREST/Postgres message
// (e.g. SQLSTATE 42501 "permission denied for function ...", or an RLS policy
// violation naming a table) discloses schema and policy detail and is not
// actionable copy. Callers render the thrown message directly, so only the
// authored neutral fallback is returned — matching the same-named helper in
// services/styleObjects.ts. Server-side enforcement is unchanged; only the
// user-facing wording is neutralised.
function safeError(_error: any, fallback: string) {
  return new Error(fallback);
}

function mapGroup(row: any): OutfitDecisionGroup {
  return {
    id: row.id,
    dressingRoomId: row.dressing_room_id,
    createdBy: row.created_by ?? null,
    title: row.title ?? null,
    question: row.question,
    occasion: row.occasion ?? null,
    status: row.status,
    chosenOptionId: row.chosen_option_id ?? null,
    wearingConfirmedAt: row.wearing_confirmed_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapOptionItem(row: any): OutfitDecisionOptionItem {
  return {
    id: row.id,
    optionId: row.option_id,
    sourceType: row.source_type ?? null,
    itemRole: row.item_role ?? null,
    sortOrder: row.sort_order,
    snapshotVersion: row.snapshot_version,
    snapshotPayload: row.snapshot_payload ?? {},
    imageUrl: row.image_url ?? null,
    storageBucket: row.storage_bucket ?? null,
    storagePath: row.storage_path ?? null,
    createdAt: row.created_at,
  };
}

async function createSignedStorageUrl(bucket?: string | null, path?: string | null) {
  if (!bucket || !path) return null;
  const { data, error } = await supabase.storage.from(bucket).createSignedUrl(path, 60 * 60);
  if (error) return null;
  return data?.signedUrl ?? null;
}

async function resolveOptionItemImages(items: OutfitDecisionOptionItem[]): Promise<OutfitDecisionOptionItem[]> {
  return Promise.all(
    items.map(async (item) => {
      if (item.imageUrl || !item.storageBucket || !item.storagePath) return item;
      const signedUrl = await createSignedStorageUrl(item.storageBucket, item.storagePath);
      return signedUrl ? { ...item, imageUrl: signedUrl } : item;
    }),
  );
}

/**
 * Shares 1–3 Looks (owner-only) to a Dressing Room as one decision group with
 * immutable snapshot options. Look order in `lookIds` is preserved: manual
 * shares keep the owner's chosen order, AI shares pass canonical variation
 * order. Returns the created decision group id.
 */
export async function shareLooksToRoom(input: {
  roomId: string;
  lookIds: string[];
  question: string;
  title?: string | null;
}): Promise<string> {
  const question = String(input.question ?? '').trim();
  if (!question) throw new Error('Add a question for your room.');
  if (question.length > DECISION_QUESTION_MAX_LENGTH) {
    throw new Error(`Questions must be ${DECISION_QUESTION_MAX_LENGTH} characters or fewer.`);
  }
  if (!Array.isArray(input.lookIds) || input.lookIds.length < 1 || input.lookIds.length > 3) {
    throw new Error('Share between 1 and 3 Looks.');
  }

  const { data, error } = await supabase.rpc('share_looks_to_outfit_decision', {
    p_room_id: input.roomId,
    p_look_ids: input.lookIds,
    p_question: question,
    p_title: input.title ?? null,
  });
  if (error) throw safeError(error, SHARE_ERROR);
  const groupId = typeof data === 'string' ? data : null;
  if (!groupId) throw new Error(SHARE_ERROR);
  return groupId;
}

/** Loads all decision groups for a room with options, item snapshots, and counts. */
export async function listRoomOutfitDecisions(roomId: string): Promise<OutfitDecisionDetail[]> {
  const { data: groupRows, error: groupError } = await supabase
    .from('outfit_decision_groups')
    .select('*')
    .eq('dressing_room_id', roomId)
    .order('created_at', { ascending: false });
  if (groupError) throw safeError(groupError, LOAD_ERROR);

  const groups = (groupRows ?? []).map(mapGroup);
  if (groups.length === 0) return [];

  const groupIds = groups.map((group) => group.id);
  const { data: optionRows, error: optionError } = await supabase
    .from('outfit_decision_options')
    .select('*')
    .in('group_id', groupIds)
    .order('sort_order', { ascending: true });
  if (optionError) throw safeError(optionError, LOAD_ERROR);

  const optionIds = (optionRows ?? []).map((row: any) => row.id);
  const { data: itemRows, error: itemError } = optionIds.length
    ? await supabase
        .from('outfit_decision_option_items')
        .select('*')
        .in('option_id', optionIds)
        .order('sort_order', { ascending: true })
    : { data: [], error: null as any };
  if (itemError) throw safeError(itemError, LOAD_ERROR);

  const itemsByOption = new Map<string, OutfitDecisionOptionItem[]>();
  for (const row of itemRows ?? []) {
    const item = mapOptionItem(row);
    const list = itemsByOption.get(item.optionId) ?? [];
    list.push(item);
    itemsByOption.set(item.optionId, list);
  }

  // Aggregate counts per group (definer RPC; identities never exposed).
  const countsByOption = new Map<string, number>();
  await Promise.all(
    groupIds.map(async (groupId) => {
      const { data: counts } = await supabase.rpc('get_outfit_decision_vote_counts', {
        p_group_id: groupId,
      });
      for (const row of (counts ?? []) as Array<{ option_id: string; vote_count: number }>) {
        countsByOption.set(row.option_id, Number(row.vote_count) || 0);
      }
    }),
  );

  // The caller's own votes (RLS returns only their rows).
  const myVotes = new Map<string, string>();
  const { data: voteRows } = await supabase
    .from('outfit_decision_votes')
    .select('group_id,option_id')
    .in('group_id', groupIds);
  for (const row of voteRows ?? []) {
    myVotes.set(String(row.group_id), String(row.option_id));
  }

  return Promise.all(
    groups.map(async (group) => {
      const options: OutfitDecisionOptionWithItems[] = await Promise.all(
        (optionRows ?? [])
          .filter((row: any) => row.group_id === group.id)
          .map(async (row: any) => ({
            id: row.id,
            groupId: row.group_id,
            sourceType: row.source_type,
            sourceLookId: row.source_look_id ?? null,
            title: row.title ?? null,
            explanation: row.explanation ?? null,
            variation: row.variation ?? null,
            sortOrder: row.sort_order,
            snapshotVersion: row.snapshot_version,
            createdAt: row.created_at,
            voteCount: countsByOption.get(row.id) ?? 0,
            items: await resolveOptionItemImages(
              itemsByOption.get(row.id) ?? [],
            ),
          })),
      );
      return {
        group,
        options,
        myVoteOptionId: myVotes.get(group.id) ?? null,
      };
    }),
  );
}

/** Casts or changes the caller's vote (one active vote per group). */
export async function castOutfitDecisionVote(groupId: string, optionId: string): Promise<void> {
  const { error } = await supabase.rpc('cast_outfit_decision_vote', {
    p_group_id: groupId,
    p_option_id: optionId,
  });
  if (error) throw safeError(error, VOTE_ERROR);
}

/** Owner-only: select the winning option. */
export async function chooseOutfitDecisionWinner(groupId: string, optionId: string): Promise<void> {
  const { error } = await supabase.rpc('set_outfit_decision_state', {
    p_group_id: groupId,
    p_action: 'choose_winner',
    p_option_id: optionId,
  });
  if (error) throw safeError(error, DECISION_ERROR);
}

/** Owner-only: mark "I'm wearing this" on the chosen option. */
export async function confirmWearingOutfitDecision(groupId: string): Promise<void> {
  const { error } = await supabase.rpc('set_outfit_decision_state', {
    p_group_id: groupId,
    p_action: 'confirm_wearing',
  });
  if (error) throw safeError(error, DECISION_ERROR);
}

/** Owner-only: close or reopen a decision. */
export async function setOutfitDecisionOpenState(groupId: string, open: boolean): Promise<void> {
  const { error } = await supabase.rpc('set_outfit_decision_state', {
    p_group_id: groupId,
    p_action: open ? 'reopen' : 'close',
  });
  if (error) throw safeError(error, DECISION_ERROR);
}

/**
 * Public, sanitized decision preview for a shared-room token. Read-only;
 * aggregate counts only; no voter or owner identities. Backed by
 * get_public_room_decision_preview (the legacy get_public_room_preview
 * contract is untouched).
 */
export async function getPublicRoomDecisionPreview(shareToken: string): Promise<{
  status: 'available' | 'unavailable' | 'malformed';
  decisions: Array<{
    groupId: string;
    question: string;
    status: string;
    occasion?: string | null;
    chosenOptionId?: string | null;
    wearingConfirmed: boolean;
    options: Array<{
      optionId: string;
      title?: string | null;
      explanation?: string | null;
      variation?: string | null;
      sortOrder: number;
      voteCount: number;
      items: Array<{
        title?: string | null;
        category?: string | null;
        color?: string | null;
        itemRole?: string | null;
        sortOrder: number;
        imageUrl?: string | null;
      }>;
    }>;
  }>;
}> {
  const { data, error } = await supabase.rpc('get_public_room_decision_preview', {
    p_share_token: shareToken,
  });
  if (error) throw safeError(error, LOAD_ERROR);
  const payload = (data ?? {}) as any;
  const status = payload.status === 'available' ? 'available' : payload.status === 'malformed' ? 'malformed' : 'unavailable';
  return {
    status,
    decisions: Array.isArray(payload.decisions) ? payload.decisions : [],
  };
}
