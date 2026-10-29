import { supabase } from './supabaseClient';
import { createActorRequest, isActorRequestCurrent } from './actorContext';
import { AI_PROCESSING_VERSION } from '../constants/legal';

export type GeminiPermissionSnapshot = { granted: boolean; revision: number };

async function permissionRpc(expectedActorId: string, granted?: boolean, revision?: number): Promise<GeminiPermissionSnapshot> {
  const scope = createActorRequest();
  if (!expectedActorId || scope.actorId !== expectedActorId) throw new Error('Account changed. Please retry.');
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 8000);
  try {
    const { data, error } = await supabase.rpc(
      granted === undefined ? 'get_ai_processing_permission' : 'set_ai_processing_permission',
      { p_expected_user_id: expectedActorId, ...(granted === undefined ? {} : { p_granted: granted, p_expected_revision: revision }) },
    ).abortSignal(controller.signal);
    if (!isActorRequestCurrent(scope)) throw new Error('Account changed. Please retry.');
    if (error || !data || Array.isArray(data) || data.user_id !== expectedActorId
      || data.policy_version !== AI_PROCESSING_VERSION || typeof data.granted !== 'boolean'
      || !Number.isSafeInteger(data.revision) || data.revision < 0
      || (granted !== undefined && data.revision <= (revision ?? -1))
      || (granted !== undefined && data.granted !== granted)) throw new Error('Permission could not be verified.');
    return { granted: data.granted, revision: data.revision };
  } finally { clearTimeout(timeout); }
}

export function readGeminiProcessingPermission(actorId: string): Promise<GeminiPermissionSnapshot> {
  return permissionRpc(actorId);
}
export function setGeminiProcessingPermission(actorId: string, granted: boolean, revision: number): Promise<GeminiPermissionSnapshot> {
  if (typeof granted !== 'boolean' || !Number.isSafeInteger(revision) || revision < 0) return Promise.reject(new Error('Invalid permission.'));
  return permissionRpc(actorId, granted, revision);
}
