/**
 * K Scan AI Staging project identity — the in-place rebuild target.
 *
 * This project is NOT replaced. Its name, reference, and URL are retained; only
 * its application-facing backend is rebuilt to match the production contract.
 *
 * The write allow-list is seeded here, in source control, rather than from an
 * environment variable — so it is reviewable in a diff and cannot be widened at
 * runtime by a mis-set variable.
 */

export const STAGING_PROJECT_NAME = 'K Scan AI Staging';
export const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
export const STAGING_PROJECT_URL = 'https://yzqjvdfgefveprobvvyw.supabase.co';
export const STAGING_REGION = 'us-west-1';
export const STAGING_ORGANIZATION_ID = 'dtcbsuytyjpvadcnyymn';

/**
 * Objects that must survive every rebuild operation untouched.
 *
 * The Waitlist carries retained real signups and the website sale/share opt-out
 * table carries real website privacy requests. Neither may be dropped,
 * truncated, altered, reseeded, or migrated elsewhere during this phase.
 */
export const PROTECTED_TABLES = Object.freeze([
  'public.waitlist_signups',
  'public.website_sale_share_opt_out_requests',
]);
