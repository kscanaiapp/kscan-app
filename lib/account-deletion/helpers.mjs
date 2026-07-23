// Small runtime-neutral helpers shared by the account-deletion CLI, the
// hard-delete pipeline, and future worker code. Pure functions only - no
// fs/path/process and no Supabase-specific types, so this module is safe to
// import from Node scripts, Deno edge functions, or a browser bundle.

export function shortUserId(userId) {
  return typeof userId === 'string' && userId.length > 8 ? `${userId.slice(0, 8)}...` : 'unknown';
}

export function appendNote(existing, note) {
  const trimmed = typeof existing === 'string' ? existing.trim() : '';
  return trimmed ? `${trimmed}\n${note}` : note;
}

export function isMissingResourceError(error) {
  const code = String(error?.code ?? '').toUpperCase();
  const message = String(error?.message ?? '').toLowerCase();
  return (
    code === '42P01' ||
    code === 'PGRST205' ||
    message.includes('does not exist') ||
    message.includes('could not find the table') ||
    message.includes('schema cache') ||
    message.includes('bucket not found')
  );
}

export async function failIfError(result, label) {
  if (result.error) {
    throw new Error(`${label}: ${result.error.message}`);
  }
  return result;
}

export const ELIGIBLE_TRANSFER_STATUSES = ['active'];
export const INELIGIBLE_TRANSFER_STATUSES = ['pending_deletion', 'locked', 'suspended', 'deleted'];
