import { isValidUuid, json, rest } from './deletion/common.ts';

// Must match the explicit provider/content disclosure in the mobile legal constants.
export const GEMINI_CONSENT_VERSION = 'v2_google_gemini';

type ReadReceipt = (path: string) => Promise<Response>;
const readAuthority: ReadReceipt = (path) => rest(path, { signal: AbortSignal.timeout(3000) });

/** The actor must come from verified Auth, never from request-body identity. */
export async function requireGeminiConsent(
  actorId: string | null,
  readReceipt: ReadReceipt = readAuthority,
  readPermission: ReadReceipt = readAuthority,
): Promise<Response | null> {
  const denied = () => json({ error: 'AI processing consent required.', errorCode: 'AI_PROCESSING_CONSENT_REQUIRED' }, 403);
  if (!actorId || !isValidUuid(actorId)) return denied();
  try {
    const query = new URLSearchParams({
      select: 'user_id,acceptance_type,policy_version',
      user_id: `eq.${actorId}`,
      acceptance_type: 'eq.ai_processing',
      policy_version: `eq.${GEMINI_CONSENT_VERSION}`,
      limit: '1',
    });
    const response = await readReceipt(`legal_acceptances?${query}`);
    if (!response.ok) throw new Error('receipt_unavailable');
    const rows: unknown = await response.json();
    if (!Array.isArray(rows) || rows.length !== 1) return denied();
    const row = rows[0];
    if (row?.user_id !== actorId || row?.acceptance_type !== 'ai_processing'
      || row?.policy_version !== GEMINI_CONSENT_VERSION) return denied();
    // No row preserves an existing current receipt. A withdrawal overrides it
    // across devices until an explicit authenticated re-consent; lookup errors
    // (including a not-yet-promoted migration) fail closed, never imply consent.
    const permissionQuery = new URLSearchParams({
      select: 'user_id,policy_version,granted', user_id: `eq.${actorId}`, limit: '2',
    });
    const permissionResponse = await readPermission(`ai_processing_permissions?${permissionQuery}`);
    if (!permissionResponse.ok) throw new Error('permission_unavailable');
    const permissions: unknown = await permissionResponse.json();
    if (!Array.isArray(permissions) || permissions.length > 1) throw new Error('invalid_permission');
    if (permissions.length === 0) return null;
    const permission = permissions[0];
    if (permission?.user_id !== actorId || permission?.policy_version !== GEMINI_CONSENT_VERSION
      || typeof permission?.granted !== 'boolean') throw new Error('invalid_permission');
    return permission.granted ? null : denied();
  } catch {
    return json({ error: 'AI processing consent unavailable.', errorCode: 'AI_PROCESSING_CONSENT_UNAVAILABLE' }, 503);
  }
}
