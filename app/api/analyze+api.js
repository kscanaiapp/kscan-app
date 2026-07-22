// Permanent tombstone for the retired Expo-hosted analysis route.
// Canonical Scanner and TextScan traffic uses the authenticated Supabase
// scan-identify Edge Function. This route must never invoke an LLM provider.

const tombstone = () => Response.json(
  {
    status: 'FAILED',
    error: 'LEGACY_ANALYZE_DISABLED',
    message: 'This legacy analysis route is no longer available.',
  },
  {
    status: 410,
    headers: {
      'Cache-Control': 'no-store',
    },
  },
);

export async function GET() {
  return tombstone();
}

export async function POST() {
  return tombstone();
}
