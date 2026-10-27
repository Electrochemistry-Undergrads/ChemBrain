import { sleep } from '../util';

export interface FetchPolicy {
  /** Name used in failure messages, e.g. "Elsevier". */
  service: string;
  timeoutMs?: number;
  /** Retries after the first attempt, for 429/5xx/network errors only. */
  retries?: number;
  /** Minimum spacing between requests to this service from one isolate (documented rate limits). */
  minIntervalMs?: number;
  /** Hostnames a redirect may go to. Redirects elsewhere are refused rather than followed. */
  redirectHosts?: string[];
  maxRedirects?: number;
  /** Return redirects to the caller without following them (e.g. a download availability probe). */
  followRedirects?: boolean;
  /**
   * Follow HTTPS redirects to hosts outside redirectHosts, but only after removing these request
   * headers (credentials are never forwarded to another host). Used for signed file-delivery URLs.
   */
  foreignRedirectStripHeaders?: string[];
  /** Never wait longer than this for Retry-After; fail instead so the job step can be retried later. */
  maxRetryAfterMs?: number;
}

export class UpstreamError extends Error {
  constructor(
    public kind: 'timeout' | 'network' | 'rate_limited' | 'http' | 'redirect_refused',
    public status: number | null,
    message: string,
    public retryAfterMs?: number,
  ) {
    super(message);
  }
}

const lastCall = new Map<string, number>();

async function pace(service: string, minIntervalMs: number) {
  const prev = lastCall.get(service) ?? 0;
  const wait = prev + minIntervalMs - Date.now();
  if (wait > 0) await sleep(wait);
  lastCall.set(service, Date.now());
}

export function parseRetryAfter(h: string | null): number | undefined {
  if (!h) return undefined;
  const s = Number(h);
  if (Number.isFinite(s)) return Math.max(0, s * 1000);
  const t = Date.parse(h);
  return Number.isFinite(t) ? Math.max(0, t - Date.now()) : undefined;
}

/**
 * fetch with a timeout, bounded retries (exponential backoff with jitter, honoring Retry-After),
 * per-service pacing, and manual redirect handling restricted to known publisher hosts.
 * Non-retryable HTTP statuses are returned to the caller so connectors can classify them.
 */
export async function policyFetch(url: string, init: RequestInit, policy: FetchPolicy, fetchImpl: typeof fetch = fetch): Promise<Response> {
  const retries = policy.retries ?? 2;
  const timeoutMs = policy.timeoutMs ?? 20_000;
  const maxRetryAfter = policy.maxRetryAfterMs ?? 8_000;
  let lastErr: UpstreamError | null = null;

  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const backoff = Math.min(4000, 500 * 2 ** (attempt - 1)) * (0.75 + Math.random() * 0.5);
      await sleep(Math.max(backoff, lastErr?.retryAfterMs ?? 0));
    }
    if (policy.minIntervalMs) await pace(policy.service, policy.minIntervalMs);
    try {
      const res = await fetchFollowing(url, init, policy, timeoutMs, fetchImpl);
      if (res.status === 429 || res.status === 503 || res.status === 502 || res.status === 500 || res.status === 504) {
        const ra = parseRetryAfter(res.headers.get('retry-after'));
        lastErr = new UpstreamError(
          res.status === 429 ? 'rate_limited' : 'http',
          res.status,
          res.status === 429 ? `${policy.service} rate limit reached.` : `${policy.service} returned a temporary error (HTTP ${res.status}).`,
          ra,
        );
        await res.body?.cancel();
        if (ra !== undefined && ra > maxRetryAfter) break; // too long to wait inside a request
        continue;
      }
      return res;
    } catch (e) {
      if (e instanceof UpstreamError && e.kind === 'redirect_refused') throw e;
      lastErr =
        e instanceof UpstreamError
          ? e
          : new UpstreamError('network', null, `Could not reach ${policy.service}.`);
    }
  }
  throw lastErr ?? new UpstreamError('network', null, `Could not reach ${policy.service}.`);
}

async function fetchFollowing(url: string, init: RequestInit, policy: FetchPolicy, timeoutMs: number, fetchImpl: typeof fetch) {
  let current = url;
  let headers = new Headers(init.headers);
  const maxRedirects = policy.maxRedirects ?? 3;
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    let res: Response;
    try {
      res = await fetchImpl(current, { ...init, headers, redirect: 'manual', signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new UpstreamError('timeout', null, `${policy.service} did not respond within ${Math.round(timeoutMs / 1000)} s.`);
      throw new UpstreamError('network', null, `Could not reach ${policy.service}.`);
    } finally {
      clearTimeout(timer);
    }
    if (res.status < 300 || res.status >= 400 || !res.headers.get('location')) return res;
    if (policy.followRedirects === false) return res;
    const next = new URL(res.headers.get('location')!, current);
    await res.body?.cancel();
    const allowed = policy.redirectHosts ?? [];
    const known = allowed.some((h) => next.hostname === h || next.hostname.endsWith(`.${h}`));
    if (next.protocol === 'https:' && !known && policy.foreignRedirectStripHeaders) {
      headers = new Headers(headers);
      for (const h of policy.foreignRedirectStripHeaders) headers.delete(h);
      if (init.method && init.method !== 'GET') throw new UpstreamError('redirect_refused', res.status, `${policy.service} redirected a non-GET request.`);
    } else if (next.protocol !== 'https:' || !known) {
      throw new UpstreamError('redirect_refused', res.status, `${policy.service} redirected to an unexpected site (${next.hostname}); the redirect was not followed.`);
    }
    current = next.toString();
  }
  throw new UpstreamError('redirect_refused', null, `${policy.service} redirected too many times.`);
}

/** Reads a response body with a size cap so a runaway upstream cannot exhaust memory. */
export async function readCapped(res: Response, maxBytes: number): Promise<Uint8Array> {
  const reader = res.body?.getReader();
  if (!reader) return new Uint8Array();
  const parts: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel();
      throw new UpstreamError('http', res.status, `Document exceeds the ${Math.round(maxBytes / 1e6)} MB limit.`);
    }
    parts.push(value);
  }
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) {
    out.set(p, o);
    o += p.byteLength;
  }
  return out;
}
