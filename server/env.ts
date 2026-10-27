/** Bindings and configuration available to server code. Secrets are server-side only. */
export interface Env {
  DB: D1Database;
  /** Optional private R2 bucket for original documents. Without it only parsed text is kept. */
  DOCS?: R2Bucket;
  ASSETS?: Fetcher;
  /** Meta Model API key (secret). */
  MODEL_API_KEY?: string;
  META_BASE_URL?: string;
  META_MODEL?: string;
  META_REASONING_EFFORT?: string;
  /** Max model tokens (prompt + completion) one analysis job may spend. */
  META_JOB_TOKEN_BUDGET?: string;
  /** Max model tokens one user may spend per UTC day. */
  META_DAILY_TOKEN_BUDGET?: string;
  /** Base64 32-byte key used to encrypt stored publisher credentials (secret). */
  CREDENTIALS_KEY?: string;
  /** Contact address for polite API pools (Crossref etc). Server-side only, never rendered. */
  CONTACT_EMAIL?: string;
  PASSWORD_ITERATIONS?: string;
  ALLOW_SIGNUP?: string;
  /** Create a private guest workspace per browser instead of showing a sign-in page. */
  ALLOW_GUESTS?: string;
  /** Keep original retrieved files in R2 after parsing ("true") or delete them. */
  RETAIN_ORIGINALS?: string;
}

export function config(env: Env) {
  return {
    metaBaseUrl: (env.META_BASE_URL || 'https://api.meta.ai/v1').replace(/\/+$/, ''),
    metaModel: env.META_MODEL || 'muse-spark-1.3',
    reasoningEffort: env.META_REASONING_EFFORT || 'medium',
    jobTokenBudget: intOr(env.META_JOB_TOKEN_BUDGET, 1_500_000),
    dailyTokenBudget: intOr(env.META_DAILY_TOKEN_BUDGET, 3_000_000),
    passwordIterations: Math.min(intOr(env.PASSWORD_ITERATIONS, 100_000), 100_000),
    allowSignup: env.ALLOW_SIGNUP !== 'false',
    allowGuests: env.ALLOW_GUESTS !== 'false',
    retainOriginals: env.RETAIN_ORIGINALS === 'true',
  };
}

function intOr(v: string | undefined, d: number) {
  const n = v ? Number.parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? n : d;
}
