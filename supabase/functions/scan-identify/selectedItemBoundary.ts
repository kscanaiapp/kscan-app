/** Narrow Edge adapter for the canonical selected-item protocol. */

// @ts-ignore Deno local imports require explicit TypeScript extensions.
import { buildSelectedItemFocusPrompt, validateSelectedItemContext, type ProviderSelectedItemContext, type SelectedItemValidationResult } from '../../../services/selectedItemContextProtocol.ts';

export type { ProviderSelectedItemContext };

export function validateSelectedItemContextForEdge(raw: unknown): SelectedItemValidationResult {
  return validateSelectedItemContext(raw);
}

export function buildSelectedItemInvalidPublicError() {
  return {
    error: true,
    message: 'Invalid selected item context.',
    code: 'SELECTED_ITEM_INVALID',
  } as const;
}

export type SelectedItemImagePromptPart =
  | { text: string }
  | { inline_data: { mime_type: string; data: string } };

/** Preserve legacy parts exactly when context is absent; append focus when present. */
export function buildSelectedItemImagePromptParts(
  generalPrompt: string,
  imageBase64: string,
  mimeType: string,
  context: ProviderSelectedItemContext | null,
): SelectedItemImagePromptPart[] {
  const parts: SelectedItemImagePromptPart[] = [{ text: generalPrompt }];
  if (context) parts.push({ text: buildSelectedItemFocusPrompt(context) });
  parts.push({ inline_data: { mime_type: mimeType, data: imageBase64 } });
  return parts;
}
