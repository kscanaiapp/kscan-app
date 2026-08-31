#!/usr/bin/env node
/**
 * Resolves eas.json build profiles the way the EAS CLI actually builds them:
 * a profile with `extends: <parent>` inherits the parent's fields (env,
 * android, ios merged; everything else taken from the parent unless the
 * child overrides it) rather than being read as the flat, literal object in
 * the file.
 *
 * `staging-certification` (Build 34 Android certification) is the first
 * profile on this line to use `extends`, and intentionally carries no `env`
 * of its own so it can never drift from the staging backend it certifies
 * (see __tests__/easConfigIntegrity.test.js). Any test that enumerates
 * "every build profile" must resolve inheritance through this helper —
 * reading `eas.build[name].env` directly sees `undefined` for such a
 * profile and misclassifies it as shipping every flag dark.
 */

'use strict';

function resolveEasBuildProfile(eas, name, seen = new Set()) {
  const build = eas.build || {};
  const profile = build[name];
  if (!profile) return undefined;
  if (!profile.extends) return profile;

  if (seen.has(name)) {
    throw new Error(`eas.json build profile "${name}" has a circular "extends" chain`);
  }
  seen.add(name);

  const parent = resolveEasBuildProfile(eas, profile.extends, seen);
  return {
    ...parent,
    ...profile,
    env: { ...(parent?.env ?? {}), ...(profile.env ?? {}) },
    android: { ...(parent?.android ?? {}), ...(profile.android ?? {}) },
    ios: { ...(parent?.ios ?? {}), ...(profile.ios ?? {}) },
  };
}

/** Returns { [profileName]: resolvedProfile } for every profile in eas.build. */
function resolveEasBuildProfiles(eas) {
  const build = eas.build || {};
  const resolved = {};
  for (const name of Object.keys(build)) {
    resolved[name] = resolveEasBuildProfile(eas, name);
  }
  return resolved;
}

module.exports = { resolveEasBuildProfile, resolveEasBuildProfiles };
