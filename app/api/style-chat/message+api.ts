// POST /api/style-chat/message — DEPRECATED mock stub. Not called by the mobile app.
// As of v0.4, live AI goes through the stylechat-generate Supabase Edge Function.
// This file is retained for reference; do not use it for real AI calls.
// It has no auth enforcement and must not be wired to a live LLM.

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
        "Elise is in preview mode. Once the full styling layer is connected, she'll use your scans, saved items, Dressing Rooms, and style preferences to help you compare looks and build retailer-neutral recommendations.",
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
