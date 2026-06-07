// POST /api/style-chat/session — mock stub (no live LLM, no auth enforcement)
// Not production-safe. Auth must be added before enabling real LLM integration.

const ALLOWED_MODES = new Set([
  'general', 'outfit_advice', 'scan_refinement',
  'shopping_help', 'dressing_room', 'closet_planning', 'budget_finder',
]);

interface SessionRequestBody {
  mode?: unknown;
  title?: unknown;
}

export async function POST(request: Request): Promise<Response> {
  let body: SessionRequestBody = {};
  try {
    body = (await request.json()) as SessionRequestBody;
  } catch {
    return Response.json({ status: 'error', error: 'Invalid JSON' }, { status: 400 });
  }

  const mode =
    typeof body.mode === 'string' && ALLOWED_MODES.has(body.mode)
      ? body.mode
      : 'general';

  const title =
    typeof body.title === 'string' && body.title.trim()
      ? body.title.trim()
      : 'New Styling Session';

  return Response.json({
    status: 'success',
    session: {
      id: `mock-session-${Date.now()}`,
      title,
      mode,
    },
  });
}
