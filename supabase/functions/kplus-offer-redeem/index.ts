/**
 * Authenticated offer-code ingestion boundary.
 *
 * Raw codes exist only in request memory long enough to compute a keyed HMAC.
 * Logs, telemetry, database calls and responses never receive the raw value.
 */
import {
  assertAccountActive,
  corsHeaders,
  isEligibleAccountActor,
  json,
  logEvent,
  requireUser,
  rpc,
  shortUserId,
} from '../_shared/deletion/common.ts';
import {
  decodeOfferCodeHmacSecret,
  digestOfferCode,
  KPLUS_OFFER_CODE_HMAC_SECRET_ENV,
  normalizeOfferCodeForDigest,
  sanitizeOfferRedemptionResult,
} from './offerCodeContract.ts';

const MAX_BODY_BYTES = 1024;
const MAX_CODE_CHARACTERS = 128;
const REDEMPTION_RPC = 'redeem_kplus_offer_code';

async function parseBody(req: Request): Promise<{ code: string } | null> {
  const declared = Number(req.headers.get('content-length') ?? '0');
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) return null;

  try {
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return null;
    const body = JSON.parse(raw) as unknown;
    if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
    const input = body as Record<string, unknown>;
    if (Object.keys(input).length !== 1 || typeof input.code !== 'string') return null;
    const normalized = normalizeOfferCodeForDigest(input.code);
    if (!normalized || normalized.length > MAX_CODE_CHARACTERS) return null;
    return { code: input.code };
  } catch {
    return null;
  }
}

Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: corsHeaders });
  if (req.method !== 'POST') return json({ result: 'ERROR' }, 405);

  let user;
  try {
    user = await requireUser(req);
  } catch (response) {
    return response instanceof Response ? response : json({ result: 'UNAVAILABLE' }, 401);
  }

  if (!isEligibleAccountActor(user)) return json({ result: 'NOT_ELIGIBLE' });
  try {
    await assertAccountActive(user.id);
  } catch {
    return json({ result: 'NOT_ELIGIBLE' });
  }

  // No query parameter or body field can nominate an actor. Unknown body keys
  // (including userId/actorId/customerId) make the request malformed.
  if ([...new URL(req.url).searchParams.keys()].length > 0) return json({ result: 'ERROR' }, 400);
  const body = await parseBody(req);
  if (!body) return json({ result: 'INVALID' });

  let digest: string;
  try {
    const secret = decodeOfferCodeHmacSecret(Deno.env.get(KPLUS_OFFER_CODE_HMAC_SECRET_ENV));
    digest = await digestOfferCode(body.code, secret);
  } catch {
    logEvent('kplus_offer_configuration_error', { uid: shortUserId(user.id) });
    return json({ result: 'UNAVAILABLE' });
  }

  try {
    const response = await rpc(REDEMPTION_RPC, {
      p_actor_id: user.id,
      p_code_digest: digest,
    });
    if (!response.ok) {
      logEvent('kplus_offer_redemption_result', {
        uid: shortUserId(user.id),
        result: 'ERROR',
      });
      return json({ result: 'ERROR' });
    }

    const payload = await response.json() as Record<string, unknown>;
    const result = sanitizeOfferRedemptionResult(payload?.result);
    logEvent('kplus_offer_redemption_result', {
      uid: shortUserId(user.id),
      result,
    });
    return json({
      result,
      entitlementRefreshRequired: result === 'SUCCESS' && payload?.entitlementRefreshRequired === true,
    });
  } catch {
    logEvent('kplus_offer_redemption_result', {
      uid: shortUserId(user.id),
      result: 'ERROR',
    });
    return json({ result: 'ERROR' });
  }
});
