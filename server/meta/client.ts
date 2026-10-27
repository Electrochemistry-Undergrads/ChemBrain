import type { z } from 'zod';
import { config, type Env } from '../env';
import { parseRetryAfter } from '../http/fetcher';
import { redact } from '../crypto/secrets';
import { newId, nowIso, sleep } from '../util';

/**
 * Meta Model API client (https://dev.meta.ai/docs). Uses the OpenAI-compatible
 * POST /v1/chat/completions endpoint with response_format json_schema, streamed so long
 * generations are not cut off by the non-streaming gateway time limit.
 */

export class MetaError extends Error {
  constructor(public code: 'not_configured' | 'auth' | 'billing' | 'rate_limited' | 'unavailable' | 'model_not_found' | 'bad_request' | 'timeout' | 'invalid_output' | 'budget' | 'refused', message: string, public retryable = false) {
    super(message);
  }
}

export interface UsageContext {
  ownerId: string;
  projectId?: string;
  jobId?: string;
  stage: 'search_planning' | 'screening' | 'extraction' | 'checking' | 'comparison' | 'question';
}

export interface JsonCall<T extends z.ZodTypeAny> {
  system: string;
  user: string;
  schema: T;
  /** JSON Schema sent to the API; must match `schema`. */
  jsonSchema: Record<string, unknown>;
  schemaName: string;
  maxCompletionTokens: number;
}

export interface CallResult<T> {
  data: T;
  model: string;
  promptTokens: number;
  completionTokens: number;
  finishReason: string | null;
}

export function metaConfigured(env: Env) {
  return Boolean(env.MODEL_API_KEY);
}

/** Tokens already spent by this user today (UTC). */
export async function tokensToday(env: Env, ownerId: string) {
  const since = new Date().toISOString().slice(0, 10);
  const r = await env.DB.prepare('SELECT COALESCE(SUM(prompt_tokens + completion_tokens), 0) AS t FROM model_usage WHERE owner_id = ? AND created_at >= ?')
    .bind(ownerId, since)
    .first<{ t: number }>();
  return r?.t ?? 0;
}

export async function callMetaJson<T extends z.ZodTypeAny>(env: Env, ctx: UsageContext, call: JsonCall<T>, fetchImpl: typeof fetch = fetch): Promise<CallResult<z.infer<T>>> {
  const cfg = config(env);
  if (!env.MODEL_API_KEY) throw new MetaError('not_configured', 'Meta analysis is not configured on this server (MODEL_API_KEY is not set).');
  const spent = await tokensToday(env, ctx.ownerId);
  if (spent >= cfg.dailyTokenBudget) throw new MetaError('budget', `Daily model budget reached (${cfg.dailyTokenBudget.toLocaleString()} tokens). It resets at midnight UTC.`);

  const body = {
    model: cfg.metaModel,
    messages: [
      { role: 'system', content: call.system },
      { role: 'user', content: call.user },
    ],
    max_completion_tokens: call.maxCompletionTokens,
    reasoning_effort: cfg.reasoningEffort,
    response_format: { type: 'json_schema', json_schema: { name: call.schemaName, schema: call.jsonSchema, strict: true } },
    stream: true,
    stream_options: { include_usage: true },
  };

  let lastErr: MetaError | null = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(Math.max(lastErrDelay(lastErr), 500 * 2 ** attempt * (0.75 + Math.random() * 0.5)));
    try {
      const out = await once(env, cfg.metaBaseUrl, body, fetchImpl);
      await recordUsage(env, ctx, cfg.metaModel, out.promptTokens, out.completionTokens);
      if (out.finishReason === 'length') throw new MetaError('invalid_output', 'The model ran out of output tokens before finishing its answer.', false);
      if (out.finishReason === 'content_filter') throw new MetaError('refused', 'The model declined to process this content.', false);
      let parsed: unknown;
      try {
        parsed = JSON.parse(out.content);
      } catch {
        throw new MetaError('invalid_output', 'The model returned output that is not valid JSON.', true);
      }
      const v = call.schema.safeParse(parsed);
      if (!v.success) throw new MetaError('invalid_output', 'The model output did not match the expected structure.', true);
      return { data: v.data, model: out.model || cfg.metaModel, promptTokens: out.promptTokens, completionTokens: out.completionTokens, finishReason: out.finishReason };
    } catch (e) {
      lastErr = e instanceof MetaError ? e : new MetaError('unavailable', 'Could not reach the Meta Model API.', true);
      (lastErr as MetaError & { retryAfter?: number }).retryAfter = (e as { retryAfter?: number }).retryAfter;
      if (!lastErr.retryable) throw lastErr;
    }
  }
  throw lastErr!;
}

function lastErrDelay(e: MetaError | null) {
  const ra = (e as (MetaError & { retryAfter?: number }) | null)?.retryAfter;
  return ra && ra < 10_000 ? ra : 0;
}

async function once(env: Env, base: string, body: unknown, fetchImpl: typeof fetch) {
  const ctrl = new AbortController();
  // First event must arrive within 120 s; afterwards each read resets the idle timer.
  let timer = setTimeout(() => ctrl.abort(), 120_000);
  let res: Response;
  try {
    res = await fetchImpl(`${base}/chat/completions`, {
      method: 'POST',
      headers: { authorization: `Bearer ${env.MODEL_API_KEY}`, 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify(body),
      signal: ctrl.signal,
    });
  } catch {
    clearTimeout(timer);
    throw new MetaError(ctrl.signal.aborted ? 'timeout' : 'unavailable', ctrl.signal.aborted ? 'The Meta Model API did not respond in time.' : 'Could not reach the Meta Model API.', true);
  }
  if (!res.ok) {
    clearTimeout(timer);
    throw await classify(env, res);
  }
  const reader = res.body!.getReader();
  const dec = new TextDecoder();
  let buf = '';
  let content = '';
  let model = '';
  let finishReason: string | null = null;
  let promptTokens = 0;
  let completionTokens = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      clearTimeout(timer);
      timer = setTimeout(() => ctrl.abort(), 90_000);
      if (done) break;
      buf += dec.decode(value, { stream: true });
      let nl: number;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        let chunk: StreamChunk;
        try {
          chunk = JSON.parse(data);
        } catch {
          continue;
        }
        if (chunk.error) throw new MetaError('unavailable', 'The Meta Model API reported an error during generation.', true);
        model = chunk.model || model;
        const choice = chunk.choices?.[0];
        if (choice?.delta?.content) content += choice.delta.content;
        if (choice?.finish_reason) finishReason = choice.finish_reason;
        if (chunk.usage) {
          promptTokens = chunk.usage.prompt_tokens ?? promptTokens;
          completionTokens = chunk.usage.completion_tokens ?? completionTokens;
        }
      }
    }
  } catch (e) {
    if (e instanceof MetaError) throw e;
    throw new MetaError('timeout', 'The Meta Model API stream stalled.', true);
  } finally {
    clearTimeout(timer);
  }
  if (!promptTokens) promptTokens = Math.ceil(JSON.stringify(body).length / 4); // conservative estimate when usage is omitted
  if (!completionTokens) completionTokens = Math.ceil(content.length / 3);
  return { content, model, finishReason, promptTokens, completionTokens };
}

interface StreamChunk {
  model?: string;
  error?: unknown;
  choices?: { delta?: { content?: string | null }; finish_reason?: string | null }[];
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

async function classify(env: Env, res: Response): Promise<MetaError> {
  let code = '';
  try {
    const j = (await res.json()) as { error?: { code?: string; type?: string; message?: string } };
    code = j.error?.code || j.error?.type || '';
  } catch {
    /* empty or non-JSON body */
  }
  const retryAfter = parseRetryAfter(res.headers.get('retry-after'));
  const mk = (c: MetaError['code'], msg: string, retry = false) => Object.assign(new MetaError(c, redact(msg, [env.MODEL_API_KEY]), retry), { retryAfter });
  switch (res.status) {
    case 401:
      return mk('auth', 'The Meta API key was rejected. Check MODEL_API_KEY in the server configuration.');
    case 402:
      return mk('billing', 'The Meta account has no available credits or billing is not configured.');
    case 403:
      return mk('auth', 'The Meta API key is not permitted to use this model or endpoint.');
    case 404:
      return mk('model_not_found', `The configured model is not available to this Meta account${code === 'model_not_found' ? '' : ' (or the endpoint was not found)'}.`);
    case 413:
      return mk('bad_request', 'The request to the Meta API was too large.');
    case 429:
      return mk('rate_limited', 'The Meta API rate limit was reached.', true);
    case 504:
      return mk('timeout', 'The Meta API timed out before starting a response.', false);
    case 500:
    case 503:
      return mk('unavailable', 'The Meta API is temporarily unavailable.', true);
    default:
      return mk('bad_request', `The Meta API rejected the request (HTTP ${res.status}${code ? `, ${code}` : ''}).`);
  }
}

async function recordUsage(env: Env, ctx: UsageContext, model: string, p: number, c: number) {
  const stmts = [
    env.DB.prepare('INSERT INTO model_usage (id, owner_id, project_id, job_id, stage, model, prompt_tokens, completion_tokens, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)').bind(
      newId('use'), ctx.ownerId, ctx.projectId ?? null, ctx.jobId ?? null, ctx.stage, model, p, c, nowIso(),
    ),
  ];
  if (ctx.jobId) stmts.push(env.DB.prepare('UPDATE jobs SET tokens_used = tokens_used + ? WHERE id = ? AND owner_id = ?').bind(p + c, ctx.jobId, ctx.ownerId));
  await env.DB.batch(stmts);
}

/** Lightweight availability check used by the settings screen: GET /v1/models/{model}. */
export async function checkModel(env: Env, fetchImpl: typeof fetch = fetch) {
  const cfg = config(env);
  if (!env.MODEL_API_KEY) return { ok: false, model: cfg.metaModel, message: 'MODEL_API_KEY is not set on the server.' };
  try {
    const res = await fetchImpl(`${cfg.metaBaseUrl}/models/${encodeURIComponent(cfg.metaModel)}`, { headers: { authorization: `Bearer ${env.MODEL_API_KEY}` } });
    if (res.ok) return { ok: true, model: cfg.metaModel, message: 'Model available to this account.' };
    const err = await classify(env, res);
    return { ok: false, model: cfg.metaModel, message: err.message };
  } catch {
    return { ok: false, model: cfg.metaModel, message: 'Could not reach the Meta Model API.' };
  }
}
