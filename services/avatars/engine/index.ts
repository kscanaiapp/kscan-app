/**
 * K Scan Avatar Engine V10 — public surface.
 *
 * Nothing below imports React, React Native, Expo, Supabase, ElevenLabs, an
 * audio player, a store, a navigator, a feature flag or an asset. The engine is
 * plain TypeScript and is expected to stay that way; `__tests__/avatarEnginePurity.test.js`
 * enforces it.
 */

export * from './version';
export * from './types';
export * from './contract';
export * from './config';
export * from './validation/generation';
export * from './validation/alignment';
export * from './speech/viseme';
export * from './speech/compileTimeline';
export * from './speech/TimelineCursor';
export * from './speech/fallback';
export * from './motion/blink';
export * from './motion/expression';
export * from './motion/gaze';
export * from './motion/composite';
export * from './package/manifest';
export * from './package/validate';
export * from './instrumentation/metrics';
export * from './runtime/AvatarRuntime';
