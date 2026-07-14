import { assertEquals } from 'https://deno.land/std@0.220.0/testing/asserts.ts';
import {
  hasGreetingUiBlock,
  selectRecentModelContextMessages,
  type ContextMessageRow,
} from './contextMessages.ts';

function msg(
  sender: 'user' | 'assistant',
  content: string,
  uiBlocks?: unknown[],
): ContextMessageRow {
  return { sender, content, ui_blocks: uiBlocks };
}

Deno.test('five genuine messages plus one greeting produce five context messages', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'Hi, I’m Elise. How can I style you today?', [{ type: 'greeting' }]),
    msg('user', 'I need outfit ideas'),
    msg('assistant', 'What is the occasion?'),
    msg('user', 'A dinner party'),
    msg('assistant', 'Great, here is an idea'),
    msg('user', 'Thanks'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 5);
  assertEquals(result.map((m) => m.content), [
    'Thanks',
    'Great, here is an idea',
    'A dinner party',
    'What is the occasion?',
    'I need outfit ideas',
  ]);
});

Deno.test('six genuine messages plus one greeting produce all six genuine messages', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'Greeting', [{ type: 'greeting' }]),
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 6);
  assertEquals(result.map((m) => m.content), ['a3', 'u3', 'a2', 'u2', 'a1', 'u1']);
});

Deno.test('more than six genuine messages plus a greeting produce the newest six genuine messages', () => {
  const rows: ContextMessageRow[] = [
    msg('user', 'old1'),
    msg('assistant', 'old2'),
    msg('assistant', 'Greeting', [{ type: 'greeting' }]),
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
    msg('user', 'u4'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 6);
  assertEquals(result.map((m) => m.content), ['a2', 'u2', 'a1', 'u1', 'old2', 'old1']);
});

Deno.test('greeting marker in any ui_blocks position is detected', () => {
  assertEquals(hasGreetingUiBlock(msg('assistant', 'x', [{ type: 'greeting' }])), true);
  assertEquals(
    hasGreetingUiBlock(msg('assistant', 'x', [{ type: 'why_this_works' }, { type: 'greeting' }])),
    true,
  );
  assertEquals(
    hasGreetingUiBlock(msg('assistant', 'x', [{ type: 'greeting' }, { type: 'stylechat_actions' }])),
    true,
  );
  assertEquals(hasGreetingUiBlock(msg('assistant', 'x', [{ type: 'why_this_works' }])), false);
  assertEquals(hasGreetingUiBlock(msg('assistant', 'x', [])), false);
  assertEquals(hasGreetingUiBlock(msg('assistant', 'x')), false);
});

Deno.test('greeting among the newest fetched rows does not displace a genuine message', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'Greeting', [{ type: 'greeting' }]),
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 6);
  assertEquals(result.every((m) => m.content !== 'Greeting'), true);
});

Deno.test('two unexpected greeting rows within the bounded lookback are excluded', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'Greeting 1', [{ type: 'greeting' }]),
    msg('user', 'u1'),
    msg('assistant', 'Greeting 2', [{ type: 'greeting' }]),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 5);
  assertEquals(result.map((m) => m.content), ['u3', 'a2', 'u2', 'a1', 'u1']);
});

Deno.test('source rows remain unchanged', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'Greeting', [{ type: 'greeting' }]),
    msg('user', 'u1'),
  ];

  selectRecentModelContextMessages(rows, 6);

  assertEquals(rows.length, 2);
  assertEquals(rows[0].ui_blocks, [{ type: 'greeting' }]);
});

Deno.test('chronological order matches the prior provider contract', () => {
  const rows: ContextMessageRow[] = [
    msg('assistant', 'newest'),
    msg('user', 'middle'),
    msg('assistant', 'oldest'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.map((m) => m.content), ['oldest', 'middle', 'newest']);
});

Deno.test('transcript without greetings behaves exactly as before', () => {
  const rows: ContextMessageRow[] = [
    msg('user', 'u1'),
    msg('assistant', 'a1'),
    msg('user', 'u2'),
    msg('assistant', 'a2'),
    msg('user', 'u3'),
    msg('assistant', 'a3'),
    msg('user', 'u4'),
    msg('assistant', 'a4'),
  ];

  const result = selectRecentModelContextMessages(rows, 6);

  assertEquals(result.length, 6);
  assertEquals(result.map((m) => m.content), ['a3', 'u3', 'a2', 'u2', 'a1', 'u1']);
});
