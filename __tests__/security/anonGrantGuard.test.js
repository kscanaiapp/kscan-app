#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const {
  ANON_EXECUTE_ALLOWLIST,
  detectUnintendedAnonGrants,
  detectStaleAllowlistEntries,
} = require('../../security/scripts/anon-grant-guard');

test('ANON_EXECUTE_ALLOWLIST covers exactly the two reviewed public RPCs', () => {
  assert.deepEqual([...ANON_EXECUTE_ALLOWLIST].sort(), ['get_item_reaction_counts', 'get_public_room_preview']);
});

test('detectUnintendedAnonGrants: an allowlisted function with anon EXECUTE is not flagged', () => {
  const grants = [{ functionName: 'get_public_room_preview', anonCanExecute: true }];
  assert.deepEqual(detectUnintendedAnonGrants(grants), []);
});

test('detectUnintendedAnonGrants: a non-allowlisted function with anon EXECUTE is flagged', () => {
  const grants = [{ functionName: 'ensure_privacy_settings', anonCanExecute: true }];
  assert.deepEqual(detectUnintendedAnonGrants(grants), ['ensure_privacy_settings']);
});

test('detectUnintendedAnonGrants: a function without anon EXECUTE is never flagged, allowlisted or not', () => {
  const grants = [
    { functionName: 'ensure_privacy_settings', anonCanExecute: false },
    { functionName: 'get_public_room_preview', anonCanExecute: false },
  ];
  assert.deepEqual(detectUnintendedAnonGrants(grants), []);
});

test('detectUnintendedAnonGrants: a mixed snapshot flags only the unapproved grant', () => {
  const grants = [
    { functionName: 'get_public_room_preview', anonCanExecute: true },
    { functionName: 'reserve_provider_request', anonCanExecute: true },
    { functionName: 'complete_provider_request', anonCanExecute: false },
  ];
  assert.deepEqual(detectUnintendedAnonGrants(grants), ['reserve_provider_request']);
});

test('detectStaleAllowlistEntries: reports nothing when every allowlisted function still has anon EXECUTE live', () => {
  const grants = [
    { functionName: 'get_public_room_preview', anonCanExecute: true },
    { functionName: 'get_item_reaction_counts', anonCanExecute: true },
  ];
  assert.deepEqual(detectStaleAllowlistEntries(grants), []);
});

test('detectStaleAllowlistEntries: flags an allowlisted function whose grant was revoked live', () => {
  const grants = [
    { functionName: 'get_public_room_preview', anonCanExecute: true },
    { functionName: 'get_item_reaction_counts', anonCanExecute: false },
  ];
  assert.deepEqual(detectStaleAllowlistEntries(grants), ['get_item_reaction_counts']);
});
