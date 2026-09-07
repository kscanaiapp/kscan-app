'use strict';

/**
 * L1.5 — PRODUCTION CONTEXT-ASSEMBLY VALIDATION (spec sections 30/31).
 *
 * This module imports and EXECUTES real, unmodified production pure
 * functions from supabase/functions/_shared/aiSecurity and
 * supabase/functions/stylechat-generate with SYNTHETIC inputs, capturing the
 * exact text payload that would be sent to the model provider WITHOUT ever
 * making the network call. Zero production files are modified. See
 * authority/contextAssemblyMap.json ("seamAvailability") for the full
 * inventory and the constraint list (no refactor, no DI, no monkey-patching,
 * no live requests).
 *
 * Node's native TypeScript type-stripping (unflagged as of the pinned
 * worktree's Node v24.14.0; available with --experimental-strip-types from
 * Node 22.6+) makes `import()` of these Deno-style .ts files work directly,
 * because they use only erasable TS syntax (interfaces/type aliases, no
 * enums/decorators/namespaces) and no Deno-specific globals. If a future
 * Node version or CI sandbox removes that support, every function below is
 * wrapped so a load failure degrades to `available: false` (BLOCKED_SEAM)
 * rather than crashing the run.
 */

const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

function fileUrl(relPath) {
  const abs = path.resolve(REPO_ROOT, relPath);
  return `file://${abs.replace(/\\/g, '/')}`;
}

let cachedModules = null;
let loadError = null;

async function loadProductionModules() {
  if (cachedModules || loadError) return { modules: cachedModules, error: loadError };
  try {
    const [inputLimits, promptEnvelope, styleChatPromptAssembly, eliseAdvicePrompt, eliseOwnershipProseSafety, contextMessages] =
      await Promise.all([
        import(fileUrl('supabase/functions/_shared/aiSecurity/inputLimits.ts')),
        import(fileUrl('supabase/functions/_shared/aiSecurity/promptEnvelope.ts')),
        import(fileUrl('supabase/functions/_shared/aiSecurity/styleChatPromptAssembly.ts')),
        import(fileUrl('supabase/functions/stylechat-generate/eliseAdvicePrompt.ts')),
        import(fileUrl('supabase/functions/stylechat-generate/eliseOwnershipProseSafety.ts')),
        import(fileUrl('supabase/functions/stylechat-generate/contextMessages.ts')),
      ]);
    cachedModules = {
      inputLimits,
      promptEnvelope,
      styleChatPromptAssembly,
      eliseAdvicePrompt,
      eliseOwnershipProseSafety,
      contextMessages,
    };
    return { modules: cachedModules, error: null };
  } catch (err) {
    loadError = err;
    return { modules: null, error: err };
  }
}

/**
 * Run the real assembleStyleChatPrompt with synthetic Closet/Signature-Style/
 * conversation/user-message inputs and capture the resulting envelope.
 */
async function captureContextAssembly(input) {
  const { modules, error } = await loadProductionModules();
  if (!modules) {
    return {
      available: false,
      reason: `L1.5: BLOCKED_SEAM -- production module import failed: ${error ? error.message : 'unknown error'}`,
    };
  }

  const { assembleStyleChatPrompt } = modules.styleChatPromptAssembly;
  const assembly = assembleStyleChatPrompt({
    systemRules: input.systemRules || 'Instrument-validation synthetic system rules.',
    userMessage: input.userMessage,
    closetContext: input.closetContext || '',
    signatureStyleContext: input.signatureStyleContext || '',
    styleDnaContext: input.styleDnaContext || '',
    conversation: input.conversation || [],
  });

  return {
    available: true,
    provenance: 'PROVEN AGAINST PRODUCTION CONTEXT-ASSEMBLY CODE (styleChatPromptAssembly.ts, real execution)',
    systemText: assembly.systemText,
    userEnvelopeText: assembly.userEnvelopeText,
    sectionLengths: assembly.sectionLengths,
    ok: assembly.ok,
    totalChars: assembly.totalChars,
  };
}

/**
 * Run the real Elise advice prompt-block builder with a synthetic shortlist
 * of candidates built from a fixture Closet, capturing the actual grounding
 * text the model would receive for a Concierge-capability turn.
 */
async function captureAdvicePromptBlock(input) {
  const { modules, error } = await loadProductionModules();
  if (!modules) {
    return { available: false, reason: `L1.5: BLOCKED_SEAM -- ${error ? error.message : 'unknown error'}` };
  }
  const { buildEliseAdvicePromptBlock, deriveWardrobeContextMode } = modules.eliseAdvicePrompt;

  const promptBlock = buildEliseAdvicePromptBlock({
    intent: input.intent,
    focused: input.focused,
    shortlist: input.shortlist,
    wardrobeGap: input.wardrobeGap || null,
    purchaseAdvice: null,
    looks: null,
    conciergeV1: input.conciergeV1 !== false,
  });
  const wardrobeContextMode = deriveWardrobeContextMode(input.shortlist, input.focused);

  return {
    available: true,
    provenance: 'PROVEN AGAINST PRODUCTION CONTEXT-ASSEMBLY CODE (eliseAdvicePrompt.ts, real execution)',
    promptBlock,
    wardrobeContextMode,
  };
}

/**
 * Run the real ownership/absence prose-safety guards against synthetic
 * model-output text and a synthetic shortlist -- this is the same production
 * function this lane's authority map documents as the fourth line of
 * defense (authority/conciergeSourceMap.json ownershipAndAbsenceGuards).
 */
async function captureOwnershipGuard(input) {
  const { modules, error } = await loadProductionModules();
  if (!modules) {
    return { available: false, reason: `L1.5: BLOCKED_SEAM -- ${error ? error.message : 'unknown error'}` };
  }
  const { enforceOwnershipProseSafety, enforceClosetAbsenceProseSafety } = modules.eliseOwnershipProseSafety;

  const ownershipVerdict = enforceOwnershipProseSafety({
    text: input.text,
    shortlist: input.shortlist,
    focus: input.focus || null,
    neutralFallback: input.neutralFallback || 'Here are a few versatile options to consider.',
  });

  const absenceVerdict = enforceClosetAbsenceProseSafety({
    text: ownershipVerdict.safeText,
    evidence: input.absenceEvidence || null,
    neutralFallback: input.neutralFallback || 'Here are a few versatile options to consider.',
  });

  return {
    available: true,
    provenance: 'PROVEN AGAINST PRODUCTION SAFETY GUARD (eliseOwnershipProseSafety.ts, real execution)',
    ownershipVerdict,
    absenceVerdict,
  };
}

/** Run the real conversation-history windowing function on synthetic rows. */
async function captureConversationWindow(rows, limit) {
  const { modules, error } = await loadProductionModules();
  if (!modules) {
    return { available: false, reason: `L1.5: BLOCKED_SEAM -- ${error ? error.message : 'unknown error'}` };
  }
  const { selectRecentModelContextMessages } = modules.contextMessages;
  const windowed = selectRecentModelContextMessages(rows, limit);
  return {
    available: true,
    provenance: 'PROVEN AGAINST PRODUCTION CONTEXT-ASSEMBLY CODE (contextMessages.ts, real execution)',
    windowed,
  };
}

module.exports = {
  loadProductionModules,
  captureContextAssembly,
  captureAdvicePromptBlock,
  captureOwnershipGuard,
  captureConversationWindow,
};
