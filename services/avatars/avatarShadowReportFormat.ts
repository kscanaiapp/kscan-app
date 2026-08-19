import type { AvatarShadowReport, ShadowUtteranceRecord } from './avatarShadowBridge';
import { getAvatarShadowReport } from './avatarShadowBridge';

/**
 * Capture surface for the Sarah shadow dataset.
 *
 * `getAvatarShadowReport()` returns an in-memory object, which is not something
 * a person holding a device can read. This renders it as a plain text block in
 * the exact field names the QA protocol asks for, so a device run can be pasted
 * straight into the results table without anyone re-deriving anything.
 *
 * Emission is development-only. The formatter itself is a pure function so the
 * shape can be tested without a device.
 *
 * Privacy: every value below is a number, a boolean, or a fixed enum name. The
 * report it reads from cannot carry speech text, alignment characters, audio,
 * voice ids, tokens or user identifiers, so neither can this.
 */

function ms(value: number | null | undefined, digits = 1): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function rate(value: number | null | undefined, digits = 2): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return value.toFixed(digits);
}

function verdict(value: boolean): string {
  return value ? 'PASS' : 'FAIL';
}

/** One utterance, in the protocol's field names. */
export function formatShadowUtterance(record: ShadowUtteranceRecord, index: number): string {
  const agreement = record.comparisons > 0 ? record.agreements / record.comparisons : null;
  const span = record.playbackSpanSeconds;
  const legacyPerSec = span > 0 ? record.legacyTransitions / span : null;
  const v10PerSec = span > 0 ? record.v10Transitions / span : null;

  return [
    `-- SAMPLE ${index + 1} (generation ${record.speechGeneration}) --`,
    `AUDIO_START                     ${ms(record.audioStartMs)} ms`,
    `PLAYBACK_TO_FIRST_MOUTH_LEGACY  ${ms(record.legacyFirstMouthMs)} ms`,
    `PLAYBACK_TO_FIRST_MOUTH_V10     ${ms(record.v10FirstMouthMs)} ms`,
    `LEGACY_TRANSITIONS_PER_SEC      ${rate(legacyPerSec)}`,
    `V10_TRANSITIONS_PER_SEC         ${rate(v10PerSec)}`,
    `FRAME_AGREEMENT                 ${rate(agreement)}`,
    `COMPLETION_RESET                ${record.completed ? 'yes' : 'no'}`,
    `INTERRUPTION_RESET              ${record.interrupted ? 'yes' : 'no'}`,
    `LEGACY_ANIMATED                 ${record.legacyAnimated ? 'yes' : 'no'}`,
    `V10_ANIMATED                    ${record.v10Animated ? 'yes' : 'no'}`,
    `PLAYBACK_SPAN_SEC               ${rate(span)}`,
  ].join('\n');
}

/**
 * The whole run. Session-level engine measurements first, then one block per
 * utterance, then the human-judgment template that has to be filled in by
 * someone actually watching the avatar.
 */
export function formatAvatarShadowReport(report: AvatarShadowReport): string {
  const engine = report.engine;
  const counters = engine.counters;

  const header = [
    '===== K SCAN AVATAR V10 — SARAH SHADOW DATASET =====',
    '',
    `OBSERVATIONS                    ${report.observations}`,
    `UTTERANCES                      ${report.utterances.length}`,
    '',
    `TIMELINE_COMPILE_MS             p50 ${ms(engine.timelineCompileMs.p50, 3)}  p95 ${ms(engine.timelineCompileMs.p95, 3)}  max ${ms(engine.timelineCompileMs.max, 3)}  n=${engine.timelineCompileMs.count}`,
    `FRAME_CALC_P50                  ${ms(engine.frameCalcMs.p50, 3)} ms`,
    `FRAME_CALC_P95                  ${ms(engine.frameCalcMs.p95, 3)} ms`,
    `FRAME_CALC_MAX                  ${ms(engine.frameCalcMs.max, 3)} ms`,
    '',
    `ALIGNMENT_INPUT                 ${counters.ALIGNMENT_INPUT_EVENTS}`,
    `ALIGNMENT_RETAINED              ${counters.ALIGNMENT_RETAINED_EVENTS}`,
    `ALIGNMENT_DISCARDED             ${counters.ALIGNMENT_DISCARDED_EVENTS}`,
    '',
    `LEGACY_TRANSITIONS_PER_SEC      ${rate(report.legacy.transitionsPerSecond)}  (session)`,
    `V10_TRANSITIONS_PER_SEC         ${rate(report.v10.transitionsPerSecond)}  (session)`,
    `FRAME_AGREEMENT                 ${rate(report.v10.agreementRate)}  (session)`,
    '',
    `STALL_HOLD                      ${counters.PLAYBACK_HOLD_EVENTS} hold events`,
    `COMPLETION_RESET                legacy ${report.legacy.resets.completion} / v10 ${counters.RESET_COMPLETION}`,
    `INTERRUPTION_RESET              legacy ${report.legacy.resets.interruption} / v10 ${counters.RESET_INTERRUPTION}`,
    `NEW_UTTERANCE_RESET             legacy ${report.legacy.resets.newUtterance} / v10 ${counters.RESET_NEW_UTTERANCE}`,
    `AVATAR_SWITCH_RESET             ${counters.RESET_AVATAR_SWITCH}`,
    `REPEAT_UTTERANCE                ${verdict(report.repeatUtterancePasses)}`,
    `STALE_FRAME_REJECTIONS          ${report.v10.staleFrameRejections}`,
    `ENGINE_ERRORS                   ${report.v10.calculationErrors}`,
    `NEUTRAL_FRAMES                  ${report.v10.neutralFrames}`,
    '',
    `TIMERS_AFTER_TEARDOWN           ${engine.activeEngineTimersAfterTeardown}`,
    `SUBSCRIPTIONS_AFTER_TEARDOWN    ${engine.activeEngineSubscriptionsAfterTeardown}`,
    '',
    'FRAME_REASONS',
    ...Object.entries(report.v10.frameReasons)
      .sort((a, b) => b[1] - a[1])
      .map(([reason, count]) => `  ${reason.padEnd(28)}${count}`),
  ];

  const samples = report.utterances.map((record, index) => formatShadowUtterance(record, index));

  const judgment = [
    '',
    '===== HUMAN VISUAL JUDGMENT (fill in per sample) =====',
    'Cannot be derived from telemetry — someone has to watch the face.',
    '',
    ...report.utterances.map((_, index) =>
      [
        `-- SAMPLE ${index + 1} --`,
        'MOUTH SYNC      legacy / V10 / tie',
        'CADENCE         natural / too busy / too sluggish',
        'LABIALS         correct / overclosed / underclosed',
        'PAUSES          good / chatters / hangs',
        'FACE STABILITY  pass / fail',
        '',
      ].join('\n'),
    ),
    '=====================================================',
  ];

  return [...header, '', ...samples, ...judgment].join('\n');
}

/**
 * Development-only emit. Matches the repository's existing `__DEV__` trace
 * convention so a device run surfaces the dataset in Metro, Xcode console or
 * logcat with nothing to install and nothing to remember to call.
 */
export function emitAvatarShadowReport(): void {
  if (typeof __DEV__ === 'undefined' || !__DEV__) return;
  console.info(`\n${formatAvatarShadowReport(getAvatarShadowReport())}\n`);
}
