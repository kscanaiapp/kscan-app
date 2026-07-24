/**
 * Trust classification for content that may enter a model prompt.
 * Stored or retrieved content does not become trusted merely by persistence.
 */

export type AIContentTrust =
  | 'trusted_system'
  | 'trusted_server_context'
  | 'untrusted_user'
  | 'untrusted_derived'
  | 'untrusted_external';

export type PromptSectionName =
  | 'kscan_system_rules'
  | 'trusted_server_context'
  | 'user_input'
  | 'conversation_context'
  | 'visual_context'
  | 'attachment_context'
  | 'closet_context'
  | 'signature_style_context'
  | 'style_dna_context'
  | 'commerce_context'
  | 'shared_context'
  | 'retrieved_context';

export const UNTRUSTED_SECTION_NAMES: readonly PromptSectionName[] = [
  'user_input',
  'conversation_context',
  'visual_context',
  'attachment_context',
  'closet_context',
  'signature_style_context',
  'style_dna_context',
  'commerce_context',
  'shared_context',
  'retrieved_context',
] as const;

export const TRUST_FOR_SECTION: Record<PromptSectionName, AIContentTrust> = {
  kscan_system_rules: 'trusted_system',
  trusted_server_context: 'trusted_server_context',
  user_input: 'untrusted_user',
  conversation_context: 'untrusted_user',
  visual_context: 'untrusted_derived',
  attachment_context: 'untrusted_derived',
  closet_context: 'untrusted_derived',
  signature_style_context: 'untrusted_derived',
  style_dna_context: 'untrusted_derived',
  commerce_context: 'untrusted_external',
  shared_context: 'untrusted_external',
  retrieved_context: 'untrusted_external',
};

export function isUntrustedTrust(trust: AIContentTrust): boolean {
  return (
    trust === 'untrusted_user' ||
    trust === 'untrusted_derived' ||
    trust === 'untrusted_external'
  );
}
