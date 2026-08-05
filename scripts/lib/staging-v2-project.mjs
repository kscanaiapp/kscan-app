/**
 * K Scan AI Staging v2 project identity.
 *
 * This is the ONLY place the Staging v2 write allow-list is seeded. Keeping it in
 * source control (rather than reading an env var) means the allow-list is
 * reviewable in a diff and cannot be widened at runtime by a mis-set variable.
 *
 * Until the project exists this stays empty, and every write-capable operation
 * fails closed with WRITE_ALLOW_LIST_EMPTY.
 */

export const STAGING_V2_PROJECT_NAME = 'K Scan AI Staging v2';
export const STAGING_V2_PROJECT_REF = '';
export const STAGING_V2_REGION = 'us-east-2';
export const STAGING_V2_ORGANIZATION_ID = 'dtcbsuytyjpvadcnyymn';
