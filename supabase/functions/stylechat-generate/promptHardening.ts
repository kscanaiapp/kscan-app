export function stripUnsafeModelOutput(text: string): string {
  return text
    .replace(/```[\s\S]*?```/g, '')
    .replace(/\b(?:select|insert|update|delete|drop|alter|create)\s+(?:from|into|table|database)?/gi, '[removed]')
    .replace(/\b(?:rpc|storage|route|mutation|sql)\s*:/gi, '[removed]:')
    .trim();
}

export function escapePromptData(value: string): string {
  return JSON.stringify(
    value
      .replace(/[\u0000-\u001f\u007f]/g, ' ')
      .replace(/\[/g, '(')
      .replace(/\]/g, ')')
      .replace(/</g, '(')
      .replace(/>/g, ')')
      .replace(/`/g, "'")
      .replace(/\s+/g, ' ')
      .trim(),
  );
}
