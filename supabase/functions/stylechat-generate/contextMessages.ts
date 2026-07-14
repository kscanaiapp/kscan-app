/**
 * Pure helpers for selecting the recent-message window that is sent to the model.
 *
 * Greeting messages are persisted as assistant rows but must not consume slots in
 * the model context window because the system prompt already conveys stylist identity.
 */

export interface ContextMessageRow {
  sender: string;
  content: string;
  ui_blocks?: unknown[] | null;
}

export function hasGreetingUiBlock(message: ContextMessageRow): boolean {
  return (
    Array.isArray(message.ui_blocks) &&
    message.ui_blocks.some(
      (block) =>
        block != null &&
        typeof block === 'object' &&
        (block as { type?: string }).type === 'greeting',
    )
  );
}

/**
 * Select the newest non-greeting messages for the model context.
 *
 * Input rows must be ordered newest-first. The returned array is in chronological
 * order (oldest first), matching the previous provider contract.
 */
export function selectRecentModelContextMessages(
  rows: ContextMessageRow[],
  limit: number,
): { sender: string; content: string }[] {
  const nonGreeting = rows.filter((row) => !hasGreetingUiBlock(row));
  const newest = nonGreeting.slice(0, limit);
  return newest.reverse().map(({ sender, content }) => ({ sender, content }));
}
