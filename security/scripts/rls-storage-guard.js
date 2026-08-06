#!/usr/bin/env node
'use strict';

/**
 * Perimeter-drift detection for RLS and Storage exposure. Pure functions
 * only -- a CI step collects the live snapshots (pg_class.relrowsecurity
 * per public-schema table, storage.buckets rows, SECURITY DEFINER
 * pg_proc.proconfig search_path settings) and passes them in.
 */

// Buckets allowed to be `public: true`. style-library-images and
// investor-docs are non-public. legal-documents is deliberately public --
// see supabase/migrations/20260805121000_legal_documents_bucket_parity.sql,
// which mirrors production (wyyuqfdxucjksghsmhry)'s existing bucket
// byte-for-byte, including its public flag: production serves legal
// documents (ToS/privacy policy) via public read with no row-level policy,
// same as staging now does. Adding a name here is a reviewable one-line
// diff, same shape as the anon-execute allowlist.
const PUBLIC_BUCKET_ALLOWLIST = ['legal-documents'];

// tables: [{ tableName, rlsEnabled }]. Flags any table with RLS disabled --
// a newly exposed table lacking RLS is the single highest-severity finding
// this guard checks for.
function detectTablesWithoutRls(tables) {
  return tables.filter((t) => !t.rlsEnabled).map((t) => t.tableName);
}

// buckets: [{ name, public, fileSizeLimit, allowedMimeTypes }].
function detectUnexpectedPublicBuckets(buckets, allowlist = PUBLIC_BUCKET_ALLOWLIST) {
  const approved = new Set(allowlist);
  return buckets.filter((b) => b.public && !approved.has(b.name)).map((b) => b.name);
}

// A public bucket (even an allowlisted one) with no size or MIME
// restriction is a distinct finding from "shouldn't be public at all" --
// an unrestricted upload path is a cost/abuse vector on its own.
function detectPublicBucketsWithoutUploadControls(buckets) {
  return buckets
    .filter((b) => b.public && (!b.fileSizeLimit || !b.allowedMimeTypes || b.allowedMimeTypes.length === 0))
    .map((b) => b.name);
}

// definerFunctions: [{ functionName, securityDefiner, searchPathSetting }].
// searchPathSetting is the raw proconfig entry (e.g. "search_path=public")
// or null/undefined if unset. Only SECURITY DEFINER functions carry the
// classic search-path-hijack risk.
function detectDefinerFunctionsWithoutSearchPath(definerFunctions) {
  return definerFunctions
    .filter((f) => f.securityDefiner && !f.searchPathSetting)
    .map((f) => f.functionName);
}

module.exports = {
  PUBLIC_BUCKET_ALLOWLIST,
  detectTablesWithoutRls,
  detectUnexpectedPublicBuckets,
  detectPublicBucketsWithoutUploadControls,
  detectDefinerFunctionsWithoutSearchPath,
};
