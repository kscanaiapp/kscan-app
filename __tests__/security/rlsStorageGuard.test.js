#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  PUBLIC_BUCKET_ALLOWLIST,
  detectTablesWithoutRls,
  detectUnexpectedPublicBuckets,
  detectPublicBucketsWithoutUploadControls,
  detectDefinerFunctionsWithoutSearchPath,
} = require('../../security/scripts/rls-storage-guard');

test('PUBLIC_BUCKET_ALLOWLIST covers exactly legal-documents (style-library-images and investor-docs are non-public)', () => {
  assert.deepEqual(PUBLIC_BUCKET_ALLOWLIST, ['legal-documents']);
});

test('detectUnexpectedPublicBuckets: does not flag legal-documents using the real default allowlist', () => {
  const buckets = [{ name: 'legal-documents', public: true, fileSizeLimit: null, allowedMimeTypes: null }];
  assert.deepEqual(detectUnexpectedPublicBuckets(buckets), []);
});

test('detectPublicBucketsWithoutUploadControls: still flags legal-documents despite the allowlist -- allowlisting exempts "should this be public" only, not "is the upload path bounded"', () => {
  const buckets = [{ name: 'legal-documents', public: true, fileSizeLimit: null, allowedMimeTypes: null }];
  assert.deepEqual(detectPublicBucketsWithoutUploadControls(buckets), ['legal-documents']);
});

test('detectTablesWithoutRls: reports nothing when every table has RLS enabled', () => {
  const tables = [{ tableName: 'profiles', rlsEnabled: true }, { tableName: 'looks', rlsEnabled: true }];
  assert.deepEqual(detectTablesWithoutRls(tables), []);
});

test('detectTablesWithoutRls: flags a table with RLS disabled', () => {
  const tables = [{ tableName: 'profiles', rlsEnabled: true }, { tableName: 'new_table', rlsEnabled: false }];
  assert.deepEqual(detectTablesWithoutRls(tables), ['new_table']);
});

test('detectUnexpectedPublicBuckets: reports nothing when no bucket is public', () => {
  const buckets = [{ name: 'style-library-images', public: false }, { name: 'investor-docs', public: false }];
  assert.deepEqual(detectUnexpectedPublicBuckets(buckets), []);
});

test('detectUnexpectedPublicBuckets: flags a new public bucket not on the allowlist', () => {
  const buckets = [{ name: 'new-public-bucket', public: true }];
  assert.deepEqual(detectUnexpectedPublicBuckets(buckets), ['new-public-bucket']);
});

test('detectUnexpectedPublicBuckets: does not flag an explicitly allowlisted public bucket', () => {
  const buckets = [{ name: 'catalog-thumbnails', public: true }];
  assert.deepEqual(detectUnexpectedPublicBuckets(buckets, ['catalog-thumbnails']), []);
});

test('detectPublicBucketsWithoutUploadControls: flags a public bucket missing a size cap', () => {
  const buckets = [{ name: 'b1', public: true, fileSizeLimit: null, allowedMimeTypes: ['image/jpeg'] }];
  assert.deepEqual(detectPublicBucketsWithoutUploadControls(buckets), ['b1']);
});

test('detectPublicBucketsWithoutUploadControls: flags a public bucket missing a MIME allowlist', () => {
  const buckets = [{ name: 'b1', public: true, fileSizeLimit: 5242880, allowedMimeTypes: null }];
  assert.deepEqual(detectPublicBucketsWithoutUploadControls(buckets), ['b1']);
});

test('detectPublicBucketsWithoutUploadControls: does not flag a well-configured public bucket', () => {
  const buckets = [{ name: 'b1', public: true, fileSizeLimit: 5242880, allowedMimeTypes: ['image/jpeg'] }];
  assert.deepEqual(detectPublicBucketsWithoutUploadControls(buckets), []);
});

test('detectPublicBucketsWithoutUploadControls: ignores non-public buckets regardless of missing controls', () => {
  const buckets = [{ name: 'investor-docs', public: false, fileSizeLimit: null, allowedMimeTypes: null }];
  assert.deepEqual(detectPublicBucketsWithoutUploadControls(buckets), []);
});

test('detectDefinerFunctionsWithoutSearchPath: flags a SECURITY DEFINER function with no search_path', () => {
  const fns = [{ functionName: 'risky_fn', securityDefiner: true, searchPathSetting: null }];
  assert.deepEqual(detectDefinerFunctionsWithoutSearchPath(fns), ['risky_fn']);
});

test('detectDefinerFunctionsWithoutSearchPath: does not flag a SECURITY DEFINER function with search_path set', () => {
  const fns = [{ functionName: 'safe_fn', securityDefiner: true, searchPathSetting: 'search_path=public' }];
  assert.deepEqual(detectDefinerFunctionsWithoutSearchPath(fns), []);
});

test('detectDefinerFunctionsWithoutSearchPath: ignores SECURITY INVOKER functions regardless of search_path', () => {
  const fns = [{ functionName: 'trigger_fn', securityDefiner: false, searchPathSetting: null }];
  assert.deepEqual(detectDefinerFunctionsWithoutSearchPath(fns), []);
});
