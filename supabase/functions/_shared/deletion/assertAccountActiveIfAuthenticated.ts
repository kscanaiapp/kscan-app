/**
 * Optional account-active guard for Edge Functions that may receive a JWT.
 * If Authorization Bearer is present, verify the user and reject pending_deletion.
 * If no Authorization header, leave request handling to the function.
 */
import { assertAccountActive, requireUser } from './common.ts';

export async function assertAccountActiveIfAuthenticated(req: Request): Promise<Response | null> {
  const authorization = req.headers.get('Authorization') ?? '';
  if (!authorization.toLowerCase().startsWith('bearer ')) {
    return null;
  }
  try {
    const user = await requireUser(req);
    await assertAccountActive(user.id);
    return null;
  } catch (error) {
    if (error instanceof Response) return error;
    return new Response(
      JSON.stringify({ error: 'ACCOUNT_DEACTIVATED', code: 'ACCOUNT_DEACTIVATED' }),
      { status: 403, headers: { 'Content-Type': 'application/json' } },
    );
  }
}
