import type { AvatarBrowState, AvatarExpression, AvatarSemanticMode } from '../types';

export interface ExpressionInput {
  semanticMode: AvatarSemanticMode;
  emphasis?: boolean;
  uncertainty?: boolean;
}

export function deriveExpression(input: ExpressionInput, tapActive: boolean): AvatarExpression {
  if (tapActive) return 'warm';
  if (input.uncertainty) return 'uncertain';
  if (input.semanticMode === 'thinking') return 'thinking';
  if (input.emphasis && input.semanticMode === 'speaking') return 'confident';
  if (input.semanticMode === 'listening' || input.semanticMode === 'reacting') return 'warm';
  return 'neutral';
}

export function deriveBrows(input: ExpressionInput): AvatarBrowState {
  if (input.semanticMode === 'thinking' || input.uncertainty) return 'focused';
  if (input.emphasis || input.semanticMode === 'listening') return 'raised';
  return 'neutral';
}
