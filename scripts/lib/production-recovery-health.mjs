// The pre-#710 RevenueCat bundle rejects every non-POST method with 405.
// This exception is tied to its reviewed source bytes, never a version number
// (Supabase increments versions when restoring the same source).
const LEGACY_RC_TREE = 'fdde08b9b39092a87ca531912e7b2d57332b3c6e22294653b75d86d560142bb4';

export function recoveryOptionsStatuses(functionName, capture) {
  if (functionName === 'kplus-revenuecat-webhook'
      && capture?.function_name === functionName
      && capture?.target === 'wyyuqfdxucjksghsmhry'
      && capture?.verify_jwt === false
      && capture?.tree_digest === LEGACY_RC_TREE) return [405];
  return [200, 204];
}

export function recoveryHealthResult(functionName, capture, status, body) {
  return { status, ok: recoveryOptionsStatuses(functionName, capture).includes(status)
    && body.length <= 8192
    && !/BOOT_ERROR|service_role|eyJ[a-zA-Z0-9_-]{10}|sbp_|sb_secret_|password/i.test(body) };
}
