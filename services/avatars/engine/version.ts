/**
 * Avatar Engine identifiers.
 *
 * Three different numbers describe this engine and they must never be
 * conflated. They move independently and mean different things:
 *
 *   ENGINE_PRODUCT_VERSION   'V10'   The generation of the engine as a piece of
 *                                    product work. Successor to the V9
 *                                    integration candidate. This is the name
 *                                    used in reports and planning.
 *
 *   ENGINE_PACKAGE_VERSION   '10.0.0' Semver of the engine module itself. The
 *                                    V9 candidate shipped as
 *                                    @kscan/avatar-animation-engine 9.0.0; V10
 *                                    is vendored into the app rather than
 *                                    published, so this is a declared version
 *                                    for provenance, not an npm coordinate.
 *
 *   AVATAR_ENGINE_CONTRACT_VERSION  2  The host/engine wire contract. Bumped
 *                                    only by a BREAKING change to the snapshot
 *                                    or frame shape. It is deliberately NOT
 *                                    tied to the product version: V10 speaks
 *                                    contract 2, and a future V11 may still
 *                                    speak contract 2.
 *
 * "V10" is not contract 10 and not package 10.0.0 by coincidence of naming.
 * Anything reporting engine identity must state which of the three it means.
 */

export const ENGINE_PRODUCT_VERSION = 'V10' as const;
export const ENGINE_PACKAGE_VERSION = '10.0.0' as const;

export interface AvatarEngineIdentity {
  productVersion: typeof ENGINE_PRODUCT_VERSION;
  packageVersion: typeof ENGINE_PACKAGE_VERSION;
  contractVersion: number;
}

/** Derived from the V9 candidate; recorded so provenance survives the rename. */
export const ENGINE_DERIVED_FROM = Object.freeze({
  productVersion: 'V9',
  packageVersion: '9.0.0',
  packageName: '@kscan/avatar-animation-engine',
});
