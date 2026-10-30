/** C011: validate the socket's DNS answers, not a separate preflight lookup.
 * HTTPS retains the original hostname for Host/SNI/certificate verification;
 * the checked addresses are handed directly to that connection's lookup.
 * https://nodejs.org/api/http.html#httprequesturl-options-callback
 * https://nodejs.org/api/dns.html#dnslookuphostname-options-callback
 */
import { lookup as systemLookup, type LookupAddress } from 'node:dns';
import { Agent, request } from 'node:https';
import { isIP, type LookupFunction } from 'node:net';
import { Readable } from 'node:stream';
import { assertSafeRemoteMediaUrl, isNonPublicHost } from './safeRemoteMedia.ts';

export type MediaResolver = (hostname: string, callback: (error: Error | null, addresses: LookupAddress[]) => void) => void;

const resolveAddresses: MediaResolver = (hostname, callback) => {
  systemLookup(hostname, { all: true, verbatim: true }, callback);
};

export function createPublicMediaLookup(resolve: MediaResolver = resolveAddresses): LookupFunction {
  return (hostname, options, callback) => {
    const done = callback as unknown as (error: Error | null, address?: string | LookupAddress[], family?: number) => void;
    try {
      resolve(hostname, (error, addresses) => {
        if (error) { done(error); return; }
        if (!Array.isArray(addresses) || addresses.length === 0 || addresses.some(row =>
          !row || ![4, 6].includes(row.family) || isIP(row.address) !== row.family || isNonPublicHost(row.address))) {
          done(Object.assign(new Error('remote_media_dns_not_public'), { code: 'EACCES' }));
          return;
        }
        // Node's auto-family selection requests all addresses. Never permit a
        // private fallback, and never re-resolve after making this decision.
        if (typeof options === 'object' && options.all) done(null, addresses);
        else done(null, addresses[0].address, addresses[0].family);
      });
    } catch (error) { done(error instanceof Error ? error : new Error('remote_media_dns_failed')); }
  };
}

/** Fetch-compatible GET seam. Redirects remain manual in the calling adapter;
 * its existing timer/body cap cover this streaming response as before.
 * No environment proxy can perform a second, unchecked DNS resolution.
 */
export function publicMediaFetch(url: string, init: RequestInit, requestImpl: typeof request = request): Promise<Response> {
  const checked = assertSafeRemoteMediaUrl(url);
  if (!checked.ok || (init.method && init.method !== 'GET') || init.redirect !== 'manual') {
    return Promise.reject(new Error('remote_media_request_refused'));
  }
  if (init.signal?.aborted) return Promise.reject(new DOMException('Aborted', 'AbortError'));
  const agentOptions = { keepAlive: false, lookup: createPublicMediaLookup(), proxyEnv: {} };
  const agent = new Agent(agentOptions);
  return new Promise((resolve, reject) => {
    const req = requestImpl(checked.url, {
      method: 'GET', agent, signal: init.signal ?? undefined,
      rejectUnauthorized: true, maxHeaderSize: 32 * 1024,
      headers: { accept: '*/*', 'accept-encoding': 'identity' },
    }, response => {
      try {
        const headers = new Headers();
        for (let i = 0; i < response.rawHeaders.length; i += 2) {
          headers.append(response.rawHeaders[i], response.rawHeaders[i + 1]);
        }
        const status = response.statusCode ?? 502;
        if (status < 200 || status > 599) throw new Error('remote_media_invalid_status');
        if ((status >= 300 && status < 400) || status === 204 || status === 205) {
          response.destroy(); agent.destroy();
          resolve(new Response(null, { status, headers }));
          return;
        }
        response.once('end', () => agent.destroy());
        response.once('close', () => agent.destroy());
        resolve(new Response(Readable.toWeb(response) as ReadableStream<Uint8Array>, { status, headers }));
      } catch (error) {
        response.destroy(); agent.destroy(); reject(error);
      }
    });
    req.once('error', error => {
      agent.destroy();
      reject(init.signal?.aborted ? new DOMException('Aborted', 'AbortError') : error);
    });
    req.end();
  });
}
