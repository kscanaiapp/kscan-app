import { envOptional } from './common.ts';

type ProviderName = 'apple' | 'google' | 'email';
type ProviderResult = {
  provider: ProviderName;
  status: 'REVOKED' | 'ALREADY_REVOKED' | 'NOT_APPLICABLE' | 'BLOCKED';
  provider_subject_hash: string | null;
  grant_type: 'identity_sharing' | 'oauth_api' | 'not_applicable' | 'unknown';
  reason_code?: string;
};

type AuthIdentity = {
  id?: string | null;
  identity_id?: string | null;
  provider_id?: string | null;
  provider?: string | null;
  identity_data?: Record<string, unknown> | null;
};

function normalizedIdentityProvider(identity: AuthIdentity): ProviderName | null {
  const provider = String(identity.provider ?? '').trim().toLowerCase();
  return provider === 'apple' || provider === 'google' || provider === 'email' ? provider : null;
}

function providerSubject(identity: AuthIdentity): string | null {
  const direct = [identity.provider_id, identity.identity_id, identity.id]
    .find((value) => typeof value === 'string' && value.trim());
  if (typeof direct === 'string') return direct.trim();
  const sub = identity.identity_data?.sub;
  return typeof sub === 'string' && sub.trim() ? sub.trim() : null;
}

async function sha256(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

function blocked(
  provider: 'apple' | 'google',
  reasonCode: string,
  subjectHash: string | null,
): ProviderResult {
  return {
    provider,
    status: 'BLOCKED',
    provider_subject_hash: subjectHash,
    grant_type: 'unknown',
    reason_code: reasonCode,
  };
}

/**
 * Revokes provider authorization through the approved secret boundary.
 *
 * Supabase intentionally does not retain OAuth provider access/refresh tokens,
 * so the worker must never pretend an auth identity row is sufficient to revoke
 * Apple or Google. The configured broker owns encrypted token material and the
 * provider credentials. Its response is accepted only when terminal and
 * unambiguous; missing configuration or material fails closed.
 */
export async function revokeLinkedProviders(input: {
  authUser: { id: string; identities?: AuthIdentity[] | null };
  deletionRequestId: string;
}): Promise<{ ok: boolean; results: ProviderResult[] }> {
  const identities = Array.isArray(input.authUser.identities) ? input.authUser.identities : [];
  const relevant = identities
    .map((identity) => ({ identity, provider: normalizedIdentityProvider(identity) }))
    .filter((entry): entry is { identity: AuthIdentity; provider: ProviderName } => Boolean(entry.provider));

  if (relevant.length === 0) {
    return {
      ok: true,
      results: [{
        provider: 'email',
        status: 'NOT_APPLICABLE',
        provider_subject_hash: null,
        grant_type: 'not_applicable',
      }],
    };
  }

  const results: ProviderResult[] = [];
  const brokerUrl = envOptional('ACCOUNT_PROVIDER_REVOCATION_BROKER_URL')?.replace(/\/+$/, '');
  const brokerToken = envOptional('ACCOUNT_PROVIDER_REVOCATION_BROKER_TOKEN');

  for (const { identity, provider } of relevant) {
    if (provider === 'email') {
      results.push({
        provider,
        status: 'NOT_APPLICABLE',
        provider_subject_hash: null,
        grant_type: 'not_applicable',
      });
      continue;
    }

    const subject = providerSubject(identity);
    const subjectHash = subject ? await sha256(`${provider}:${subject}`) : null;
    if (!subject) {
      results.push(blocked(provider, 'PROVIDER_SUBJECT_UNAVAILABLE', subjectHash));
      continue;
    }
    if (!brokerUrl || !brokerToken) {
      results.push(blocked(provider, 'REVOCATION_SECRET_BOUNDARY_UNCONFIGURED', subjectHash));
      continue;
    }

    try {
      const response = await fetch(`${brokerUrl}/v1/account-lifecycle/revoke`, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${brokerToken}`,
        },
        body: JSON.stringify({
          provider,
          providerSubject: subject,
          authUserId: input.authUser.id,
          deletionRequestId: input.deletionRequestId,
        }),
      });
      const payload = await response.json().catch(() => ({}));
      const status = String(payload?.status ?? '').toUpperCase();
      const grantType = String(payload?.grantType ?? '').toLowerCase();
      const validGoogleGrant =
        provider !== 'google' || grantType === 'identity_sharing' || grantType === 'oauth_api';
      if (
        response.ok &&
        validGoogleGrant &&
        (status === 'REVOKED' || status === 'ALREADY_REVOKED')
      ) {
        results.push({
          provider,
          status,
          provider_subject_hash: subjectHash,
          grant_type: provider === 'google' ? grantType : 'identity_sharing',
        } as ProviderResult);
      } else {
        results.push(blocked(
          provider,
          !validGoogleGrant ? 'GOOGLE_GRANT_TYPE_AMBIGUOUS' : 'REVOCATION_RESULT_AMBIGUOUS',
          subjectHash,
        ));
      }
    } catch {
      results.push(blocked(provider, 'REVOCATION_BROKER_UNAVAILABLE', subjectHash));
    }
  }

  return {
    ok: results.every((result) => result.status !== 'BLOCKED'),
    results,
  };
}

