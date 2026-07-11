import type { StyleChatInput, StyleChatProvider, StyleChatResult } from './types';

const PREVIEW_REPLY =
  "Elise is in preview mode. Once the full styling layer is connected, she'll use your scans, saved items, Dressing Rooms, and style preferences to help you compare looks and build retailer-neutral recommendations.";

const PREVIEW_UI_BLOCKS = [
  {
    type: 'style_tip',
    title: 'StyleChat Preview',
    body: 'Your personalized styling context will appear here.',
  },
];

function mockDelay(min = 600, max = 900): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min),
  );
}

export class MockStyleChatProvider implements StyleChatProvider {
  private messagesUsed = 0;

  async generateReply(input: StyleChatInput): Promise<StyleChatResult> {
    await mockDelay();
    this.messagesUsed += 1;

    return {
      message: {
        id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        sender: 'assistant',
        content: PREVIEW_REPLY,
        referencedScanIds: [],
        referencedSavedItemIds: [],
        referencedDressingRoomIds: [],
        referencedCatalogItems: [],
        uiBlocks: PREVIEW_UI_BLOCKS,
        provider: 'mock',
        model: undefined,
        tokenEstimate: 0,
        createdAt: new Date().toISOString(),
      },
      usage: {
        messagesUsed: this.messagesUsed,
        messagesLimit: 50,
      },
    };
  }
}
