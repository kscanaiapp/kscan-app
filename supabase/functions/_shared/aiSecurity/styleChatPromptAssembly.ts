/**
 * Trust-separated StyleChat / Elise prompt assembly.
 * System role carries rules (+ optional trusted server context only).
 * Untrusted data is serialized into typed envelope sections on the user turn.
 */

import { AI_INPUT_LIMITS, boundTextField } from './inputLimits.ts';
import {
  assemblePromptEnvelope,
  buildTrustedServerContext,
  buildTrustedSystemRules,
  buildUntrustedSection,
  buildUserInputSection,
  type ConversationTurn,
} from './promptEnvelope.ts';

export type StyleChatPromptAssemblyInput = {
  systemRules: string;
  trustedServerContext?: string | null;
  userMessage: string;
  conversation?: ConversationTurn[];
  visualContextBlock?: string | null;
  attachmentContextBlock?: string | null;
  closetContext?: string | null;
  signatureStyleContext?: string | null;
  commerceContext?: string | null;
  sharedContext?: string | null;
  focusText?: string | null;
};

export type StyleChatPromptAssembly = {
  systemText: string;
  userEnvelopeText: string;
  sectionLengths: Record<string, number>;
  ok: boolean;
  totalChars: number;
};

export function assembleStyleChatPrompt(
  input: StyleChatPromptAssemblyInput,
): StyleChatPromptAssembly {
  const systemParts = [buildTrustedSystemRules(input.systemRules)];
  if (input.trustedServerContext) {
    const trusted = buildTrustedServerContext(input.trustedServerContext);
    if (trusted) systemParts.push(trusted);
  }
  const systemText = systemParts.filter(Boolean).join('\n\n');

  const focusBound = input.focusText
    ? boundTextField(input.focusText, AI_INPUT_LIMITS.focusText, {
        mode: 'truncate',
        stripSecrets: true,
      })
    : null;
  const userBodyParts = [input.userMessage];
  if (focusBound?.ok) {
    userBodyParts.push(`focus_text=${focusBound.value}`);
  }

  const envelope = assemblePromptEnvelope([
    {
      name: 'closet_context',
      trust: 'untrusted_derived',
      body: input.closetContext ?? '',
    },
    {
      name: 'signature_style_context',
      trust: 'untrusted_derived',
      body: input.signatureStyleContext ?? '',
    },
    {
      name: 'visual_context',
      trust: 'untrusted_derived',
      body: input.visualContextBlock ?? '',
    },
    {
      name: 'attachment_context',
      trust: 'untrusted_derived',
      body: input.attachmentContextBlock ?? '',
    },
    {
      name: 'commerce_context',
      trust: 'untrusted_external',
      body: input.commerceContext ?? '',
    },
    {
      name: 'shared_context',
      trust: 'untrusted_external',
      body: input.sharedContext ?? '',
    },
    {
      name: 'user_input',
      trust: 'untrusted_user',
      body: userBodyParts.join('\n'),
    },
  ]);

  // Conversation remains role-separated via provider turns; optional bounded mirror
  // can be included for injection tests without collapsing roles into system text.
  const conversationMirror = input.conversation?.length
    ? buildUntrustedSection(
        'conversation_context',
        input.conversation
          .slice(-AI_INPUT_LIMITS.conversationHistoryMessages)
          .map((turn) => `${turn.role}: ${turn.content}`)
          .join('\n'),
        AI_INPUT_LIMITS.conversationMessage *
          AI_INPUT_LIMITS.conversationHistoryMessages,
      )
    : '';

  const userEnvelopeText = [conversationMirror, envelope.text].filter(Boolean).join('\n\n');
  const userSection = buildUserInputSection(input.userMessage);

  const sectionLengths: Record<string, number> = {
    system: systemText.length,
    user_envelope: userEnvelopeText.length,
    user_input: userSection.length,
    visual_context: (input.visualContextBlock ?? '').length,
    attachment_context: (input.attachmentContextBlock ?? '').length,
    closet_context: (input.closetContext ?? '').length,
    signature_style_context: (input.signatureStyleContext ?? '').length,
  };

  const totalChars = systemText.length + userEnvelopeText.length;
  return {
    systemText,
    userEnvelopeText,
    sectionLengths,
    ok: envelope.ok && totalChars <= AI_INPUT_LIMITS.totalPromptChars,
    totalChars,
  };
}
