// SQL-statement shapes removed from model output. Each one requires the SQL
// context (issue #716): a bare verb such as "select", "create", "update" or
// "drop" is ordinary styling language and must reach the customer intact.
const SQL_STATEMENT_SHAPES: readonly RegExp[] = [
  /\bselect\s+(?:\*|count\s*\(|distinct\b)[^.\n]*?\bfrom\b/gi,
  /\binsert\s+into\b/gi,
  /\bdelete\s+from\b/gi,
  /\bupdate\s+[\w."]+\s+set\b/gi,
  /\b(?:drop|alter|create|truncate)\s+(?:table|database|schema|function|policy|role|index|view|trigger)\b/gi,
  /\bgrant\s+\w+(?:\s*,\s*\w+)*\s+on\b/gi,
];

export function stripUnsafeModelOutput(text: string): string {
  let out = text.replace(/```[\s\S]*?```/g, '');
  for (const shape of SQL_STATEMENT_SHAPES) out = out.replace(shape, '[removed]');
  return out
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
