/**
 * Trust-separated TypeChat / TextScan prompt assembly.
 */

import { AI_INPUT_LIMITS, boundTextField } from './inputLimits.ts';
import {
  assemblePromptEnvelope,
  buildTrustedSystemRules,
  buildTypeChatUserInputSection,
  buildUntrustedSection,
} from './promptEnvelope.ts';

export type TypeChatPromptAssemblyInput = {
  systemRules: string;
  userQuery: string;
  commerceContext?: string | null;
  retrievedContext?: string | null;
};

export type TypeChatPromptAssembly = {
  systemText: string;
  userEnvelopeText: string;
  sectionLengths: Record<string, number>;
  ok: boolean;
  queryAccepted: boolean;
};

export function assembleTypeChatPrompt(
  input: TypeChatPromptAssemblyInput,
): TypeChatPromptAssembly {
  const queryBound = boundTextField(input.userQuery, AI_INPUT_LIMITS.typeChatQuery, {
    mode: 'reject',
    stripSecrets: true,
  });
  const systemText = buildTrustedSystemRules(input.systemRules);
  if (!queryBound.ok) {
    return {
      systemText,
      userEnvelopeText: '',
      sectionLengths: { system: systemText.length, user_input: 0 },
      ok: false,
      queryAccepted: false,
    };
  }

  const envelope = assemblePromptEnvelope([
    {
      name: 'commerce_context',
      trust: 'untrusted_external',
      body: input.commerceContext ?? '',
    },
    {
      name: 'retrieved_context',
      trust: 'untrusted_external',
      body: input.retrievedContext ?? '',
    },
    {
      name: 'user_input',
      trust: 'untrusted_user',
      body: queryBound.value,
    },
  ]);

  // Ensure the canonical helper is exercised for parity with Elise.
  const userInput = buildTypeChatUserInputSection(queryBound.value);
  const commerce = input.commerceContext
    ? buildUntrustedSection('commerce_context', input.commerceContext, AI_INPUT_LIMITS.commerceDescription)
    : '';

  return {
    systemText,
    userEnvelopeText: envelope.text || [commerce, userInput].filter(Boolean).join('\n\n'),
    sectionLengths: {
      system: systemText.length,
      user_input: userInput.length,
      commerce_context: commerce.length,
    },
    ok: envelope.ok,
    queryAccepted: true,
  };
}
