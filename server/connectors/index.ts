import type { Env } from '../env';
import { decryptSecret } from '../crypto/secrets';
import { parseJson } from '../util';
import { crossrefSearch } from './crossref';
import { elsevierRetrieve, testElsevier } from './elsevier';
import { europePmcRetrieve, europePmcSearch } from './europepmc';
import { publisherOf } from './publishers';
import { springerRetrieve, springerSearch, testSpringer } from './springer';
import type { Candidate, ConnectionSettings, ConnectorContext, Credentials, PaperRef, Provider, RetrievalAttempt, TestCheck } from './types';
import { testWiley, wileyRetrieve } from './wiley';

export const PROVIDERS: Provider[] = ['elsevier', 'wiley', 'springer'];

/** Loads and decrypts this user's own publisher credentials. Never shared across users. */
export async function loadConnectorContext(env: Env, userId: string, fetchImpl: typeof fetch = fetch): Promise<ConnectorContext> {
  const { results } = await env.DB.prepare('SELECT provider, secret_ciphertext, secret_iv, settings_json FROM connections WHERE owner_id = ?')
    .bind(userId)
    .all<{ provider: Provider; secret_ciphertext: string | null; secret_iv: string | null; settings_json: string }>();
  const creds: Credentials = {};
  const settings: Partial<Record<Provider, ConnectionSettings>> = {};
  for (const r of results) {
    settings[r.provider] = parseJson<ConnectionSettings>(r.settings_json, {});
    if (r.secret_ciphertext && r.secret_iv && env.CREDENTIALS_KEY) {
      try {
        const plain = JSON.parse(await decryptSecret(env.CREDENTIALS_KEY, userId, r.provider, r.secret_ciphertext, r.secret_iv));
        (creds as Record<string, unknown>)[r.provider] = plain;
      } catch {
        /* undecryptable (key rotated): treated as missing credentials */
      }
    }
  }
  return { env, userId, creds, settings, fetch: fetchImpl };
}

/**
 * Tries the publisher's own connector first (structured XML preferred), then open-access
 * repositories. Every attempt is returned so the UI can show exactly why retrieval failed.
 */
export async function retrievePaper(ctx: ConnectorContext, paper: PaperRef): Promise<{ attempts: RetrievalAttempt[]; success: RetrievalAttempt | null; provider: Provider | null }> {
  const provider = publisherOf(paper.doi, paper.publisher);
  const attempts: RetrievalAttempt[] = [];
  const done = () => ({ attempts, success: attempts.find((a) => a.status === 'full_text' && a.file) ?? null, provider });

  if (provider === 'elsevier') attempts.push(await elsevierRetrieve(ctx, paper));
  if (provider === 'springer') attempts.push(...(await springerRetrieve(ctx, paper)));
  if (done().success) return done();
  // Europe PMC open-access copies are cheap and need no credentials; try before Wiley's slow,
  // rate-limited PDF route.
  attempts.push(await europePmcRetrieve(paper, ctx.fetch));
  if (done().success) return done();
  if (provider === 'wiley') attempts.push(await wileyRetrieve(ctx, paper));
  return done();
}

export async function testConnection(ctx: ConnectorContext, provider: Provider): Promise<TestCheck[]> {
  if (provider === 'elsevier') return testElsevier(ctx);
  if (provider === 'wiley') return testWiley(ctx);
  return testSpringer(ctx);
}

function titleKey(t: string) {
  return t.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim().slice(0, 120);
}

/** Runs each query against Crossref, Europe PMC and (with the user's key) Springer Nature; dedupes by DOI and title. */
export async function discover(ctx: ConnectorContext, queries: string[], perSource = 12) {
  const seen = new Map<string, Candidate>();
  const errors: string[] = [];
  const add = (c: Candidate) => {
    const k = c.doi ?? titleKey(c.title);
    const prev = seen.get(k) ?? (c.doi ? undefined : [...seen.values()].find((p) => titleKey(p.title) === titleKey(c.title)));
    if (prev) {
      prev.abstract ??= c.abstract;
      prev.publisher ??= c.publisher;
      prev.license ??= c.license;
      prev.doi ??= c.doi;
      if (!prev.source.includes(c.source)) prev.source += `,${c.source}`;
      return;
    }
    seen.set(k, { ...c });
  };
  for (const q of queries) {
    const jobs: [string, Promise<Candidate[]>][] = [
      ['Crossref', crossrefSearch(ctx.env, q, perSource, ctx.fetch)],
      ['Europe PMC', europePmcSearch(q, perSource, ctx.fetch)],
    ];
    if (ctx.creds.springer?.apiKey) jobs.push(['Springer Nature', springerSearch(ctx, q, perSource)]);
    const settled = await Promise.allSettled(jobs.map((j) => j[1]));
    settled.forEach((r, i) => {
      if (r.status === 'fulfilled') r.value.forEach((c) => add(c));
      else errors.push(`${jobs[i][0]}: ${(r.reason as Error).message ?? 'search failed'}`);
    });
  }
  return { candidates: [...seen.values()], errors: [...new Set(errors)] };
}
