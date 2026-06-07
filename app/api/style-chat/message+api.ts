// POST /api/style-chat/message — mock stub (no live LLM, no auth enforcement)
// Not production-safe. Auth must be added before enabling real LLM integration.

interface MessageRequestBody {
  sessionId?: unknown;
  message?: unknown;
  context?: {
    scanId?: string | null;
    savedItemIds?: string[];
    dressingRoomId?: string | null;
  };
}

function mockDelay(min = 600, max = 900): Promise<void> {
  return new Promise(resolve =>
    setTimeout(resolve, Math.floor(Math.random() * (max - min + 1)) + min),
  );
}

export async function POST(request: Request): Promise<Response> {
  let body: MessageRequestBody = {};
  try {
    body = (await request.json()) as MessageRequestBody;
  } catch {
    return Response.json({ status: 'error', error: 'Invalid JSON' }, { status: 400 });
  }

  if (!body.sessionId || typeof body.sessionId !== 'string') {
    return Response.json({ status: 'error', error: 'sessionId required' }, { status: 400 });
  }
  if (!body.message || typeof body.message !== 'string' || !body.message.trim()) {
    return Response.json({ status: 'error', error: 'message required' }, { status: 400 });
  }

  await mockDelay();

  return Response.json({
    status: 'success',
    message: {
      id: `mock-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      sender: 'assistant',
      content:
        "StyleChat is in preview mode. Once the AI stylist layer is connected, I'll use your scans, saved items, Dressing Rooms, and style preferences to help you compare looks and build retailer-neutral recommendations.",
      referencedScanIds: [],
      referencedSavedItemIds: [],
      referencedDressingRoomIds: [],
      referencedCatalogItems: [],
      uiBlocks: [
        {
          type: 'style_tip',
          title: 'StyleChat Preview',
          body: 'Your personalized styling context will appear here.',
        },
      ],
    },
    usage: {
      messagesUsed: 1,
      messagesLimit: 50,
    },
  });
}
