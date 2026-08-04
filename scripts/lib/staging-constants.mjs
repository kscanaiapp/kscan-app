/**
 * Canonical staging / production identity for K Scan AI deployment tooling.
 * Production must never be targeted by these scripts.
 */

export const STAGING_PROJECT_REF = 'yzqjvdfgefveprobvvyw';
export const PRODUCTION_PROJECT_REF = 'wyyuqfdxucjksghsmhry';
export const STAGING_URL = `https://${STAGING_PROJECT_REF}.supabase.co`;
export const PRODUCTION_URL = `https://${PRODUCTION_PROJECT_REF}.supabase.co`;

export const REQUIRED_STAGING_VARS = [
  'SUPABASE_ACCESS_TOKEN',
  'SUPABASE_STAGING_PROJECT_REF',
  'SUPABASE_STAGING_URL',
  'SUPABASE_STAGING_ANON_KEY',
];

export const PROHIBITED_SQL_PATTERNS = [
  { id: 'DROP_DATABASE', regex: /\bDROP\s+DATABASE\b/i },
  { id: 'DROP_SCHEMA', regex: /\bDROP\s+SCHEMA\b/i },
  { id: 'TRUNCATE', regex: /\bTRUNCATE\b/i },
  { id: 'DB_RESET', regex: /\bdb\s+reset\b/i },
  { id: 'MIGRATION_REPAIR', regex: /\bmigration\s+repair\b/i },
  { id: 'BLANKET_DB_PUSH', regex: /\bdb\s+push\b/i },
];

export const DESTRUCTIVE_REQUIRES_MANUAL = [
  { id: 'DROP_TABLE', regex: /\bDROP\s+TABLE\b/i },
  { id: 'DESTRUCTIVE_ALTER', regex: /\bALTER\s+TABLE\b[\s\S]{0,80}\bDROP\b/i },
];

export const MIGRATION_FILENAME_RE = /^(\d{12,14})_([a-zA-Z0-9_]+)\.sql$/;
