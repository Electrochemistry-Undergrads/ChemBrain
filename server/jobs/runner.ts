import type { Env } from '../env';
import { config } from '../env';
import { loadConnectorContext, retrievePaper } from '../connectors';
import { publisherOf } from '../connectors/publishers';
import type { RetrievalAttempt } from '../connectors/types';
import { MetaError, metaConfigured } from '../meta/client';
import { DEMO_PAPERS } from '../demo/papers.generated';
import { ApiError, notFound } from '../http/respond';
import { newId, nowIso, parseJson } from '../util';
import { briefOf, checkPaper, compareAndPropose, extractWindow, windows, type ChunkRow } from './analysis';
import { aiPermissionFor, ingestDocument, parseStatusFor, retrievalStatusFor, type PaperRow } from './documents';

/**
 * Job orchestration. A job is a list of small tasks in D1 (retrieve → extract windows → check →
 * compare). Each POST /step claims one task under a lease, runs it within one request's limits,
 * and records the outcome. A crashed or abandoned step's lease expires and the task is reclaimed,
 * so jobs survive closed tabs, timeouts, and worker restarts; retryable failures back off.
 */

const LEASE_MS = 4 * 60_000;
const MAX_ATTEMPTS = 3;
const MAX_RATE_LIMIT_ATTEMPTS = 8;

interface TaskRow {
  id: string;
  kind: 'retrieve' | 'extract' | 'check' | 'compare';
  paper_id: string | null;
  payload_json: string | null;
  status: string;
  attempts: number;
  lease_until: number | null;
  seq: number;
}

interface JobRow {
  id: string;
  project_id: string;
  owner_id: string;
  status: string;
  tokens_used: number;
  token_budget: number;
  error: string | null;
}

class RetryLater extends Error {
  constructor(message: string, public delayMs: number, public rateLimit = false) {
    super(message);
  }
}

export async function startJob(env: Env, ownerId: string, projectId: string) {
  const { results: papers } = await env.DB.prepare('SELECT id FROM papers WHERE owner_id = ? AND project_id = ? AND selected = 1 ORDER BY created_at')
    .bind(ownerId, projectId)
    .all<{ id: string }>();
  if (!papers.length) throw new ApiError(400, 'no_papers', 'Select at least one paper to analyse.');
  const running = await env.DB.prepare("SELECT id FROM jobs WHERE owner_id = ? AND project_id = ? AND status IN ('running', 'paused')").bind(ownerId, projectId).first();
  if (running) throw new ApiError(409, 'job_running', 'An analysis is already in progress for this project. Resume or cancel it first.');
  const jobId = newId('job');
  const now = nowIso();
  const stmts = [
    env.DB.prepare('INSERT INTO jobs (id, project_id, owner_id, status, token_budget, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(jobId, projectId, ownerId, 'running', config(env).jobTokenBudget, now, now),
    ...papers.map((p, i) =>
      env.DB.prepare('INSERT INTO job_tasks (id, job_id, owner_id, seq, kind, paper_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(newId('task'), jobId, ownerId, i, 'retrieve', p.id, now),
    ),
    env.DB.prepare('INSERT INTO job_tasks (id, job_id, owner_id, seq, kind, updated_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId('task'), jobId, ownerId, 10_000_000, 'compare', now),
  ];
  await env.DB.batch(stmts);
  return jobId;
}

async function getJob(env: Env, ownerId: string, jobId: string) {
  const job = await env.DB.prepare('SELECT id, project_id, owner_id, status, tokens_used, token_budget, error FROM jobs WHERE id = ? AND owner_id = ?').bind(jobId, ownerId).first<JobRow>();
  if (!job) throw notFound();
  return job;
}

export async function jobProgress(env: Env, ownerId: string, jobId: string) {
  const job = await getJob(env, ownerId, jobId);
  const { results } = await env.DB.prepare('SELECT kind, status, COUNT(*) AS n, MIN(lease_until) AS next_at FROM job_tasks WHERE job_id = ? AND owner_id = ? GROUP BY kind, status')
    .bind(jobId, ownerId)
    .all<{ kind: string; status: string; n: number; next_at: number | null }>();
  const { results: failures } = await env.DB.prepare("SELECT kind, paper_id, error FROM job_tasks WHERE job_id = ? AND owner_id = ? AND status = 'failed' ORDER BY seq LIMIT 50")
    .bind(jobId, ownerId)
    .all<{ kind: string; paper_id: string | null; error: string | null }>();
  const waiting = results.filter((r) => r.status === 'pending' && r.next_at && r.next_at > Date.now()).map((r) => r.next_at!);
  return {
    job: { id: job.id, status: job.status, tokensUsed: job.tokens_used, tokenBudget: job.token_budget, error: job.error },
    tasks: results.map(({ kind, status, n }) => ({ kind, status, n })),
    failures,
    nextRunAt: waiting.length && !results.some((r) => r.status === 'pending' && (!r.next_at || r.next_at <= Date.now())) ? Math.min(...waiting) : null,
  };
}

export async function setJobStatus(env: Env, ownerId: string, jobId: string, status: 'running' | 'cancelled') {
  const job = await getJob(env, ownerId, jobId);
  if (status === 'running' && !['paused', 'failed', 'complete_with_errors'].includes(job.status) && job.status !== 'running') {
    throw new ApiError(409, 'not_resumable', 'This analysis cannot be resumed.');
  }
  const stmts = [env.DB.prepare('UPDATE jobs SET status = ?, error = NULL, updated_at = ? WHERE id = ? AND owner_id = ?').bind(status, nowIso(), jobId, ownerId)];
  if (status === 'running') {
    // Resume: give failed tasks another round of attempts.
    stmts.push(env.DB.prepare("UPDATE job_tasks SET status = 'pending', attempts = 0, lease_until = NULL WHERE job_id = ? AND owner_id = ? AND status = 'failed'").bind(jobId, ownerId));
    if (job.status === 'paused') stmts.push(env.DB.prepare('UPDATE jobs SET token_budget = token_budget + ? WHERE id = ? AND owner_id = ?').bind(config(env).jobTokenBudget, jobId, ownerId));
  }
  await env.DB.batch(stmts);
}

/** Claims and runs the next runnable task. Safe to call concurrently from several tabs. */
export async function runStep(env: Env, ownerId: string, jobId: string, fetchImpl: typeof fetch = fetch) {
  const job = await getJob(env, ownerId, jobId);
  if (job.status !== 'running') return { ran: null as string | null, ...(await jobProgress(env, ownerId, jobId)) };
  const now = Date.now();
  const { results: open } = await env.DB.prepare("SELECT id, kind, paper_id, payload_json, status, attempts, lease_until, seq FROM job_tasks WHERE job_id = ? AND owner_id = ? AND status IN ('pending', 'running') ORDER BY seq")
    .bind(jobId, ownerId)
    .all<TaskRow>();

  if (!open.length) {
    const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_tasks WHERE job_id = ? AND owner_id = ? AND status = 'failed'").bind(jobId, ownerId).first<{ n: number }>();
    await env.DB.prepare('UPDATE jobs SET status = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(failed?.n ? 'complete_with_errors' : 'complete', nowIso(), jobId, ownerId).run();
    return { ran: null, ...(await jobProgress(env, ownerId, jobId)) };
  }

  const unfinished = (pred: (t: TaskRow) => boolean) => open.some(pred);
  const task = open.find((t) => {
    const ready = t.status === 'pending' ? !t.lease_until || t.lease_until <= now : (t.lease_until ?? 0) < now;
    if (!ready) return false;
    if (t.kind === 'check') return !unfinished((o) => o.paper_id === t.paper_id && (o.kind === 'extract' || o.kind === 'retrieve'));
    if (t.kind === 'compare') return !unfinished((o) => o.id !== t.id);
    return true;
  });
  if (!task) return { ran: null, ...(await jobProgress(env, ownerId, jobId)) };

  const claimed = await env.DB.prepare(
    `UPDATE job_tasks SET status = 'running', lease_until = ?, attempts = attempts + 1, updated_at = ?
     WHERE id = ? AND owner_id = ? AND (status = 'pending' OR (status = 'running' AND lease_until < ?)) RETURNING attempts`,
  )
    .bind(now + LEASE_MS, nowIso(), task.id, ownerId, now)
    .first<{ attempts: number }>();
  if (!claimed) return { ran: null, ...(await jobProgress(env, ownerId, jobId)) };

  try {
    await execute(env, job, task, fetchImpl);
    await env.DB.prepare("UPDATE job_tasks SET status = 'done', lease_until = NULL, error = NULL, updated_at = ? WHERE id = ? AND owner_id = ?").bind(nowIso(), task.id, ownerId).run();
  } catch (e) {
    await recordFailure(env, job, task, claimed.attempts, e);
  }
  return { ran: task.kind, ...(await jobProgress(env, ownerId, jobId)) };
}

async function recordFailure(env: Env, job: JobRow, task: TaskRow, attempts: number, e: unknown) {
  const msg = e instanceof Error && (e instanceof RetryLater || e instanceof MetaError || e instanceof ApiError) ? e.message : 'Unexpected error while processing this step.';
  if (e instanceof MetaError && e.code === 'budget') {
    await env.DB.batch([
      env.DB.prepare("UPDATE job_tasks SET status = 'pending', lease_until = NULL, attempts = attempts - 1, error = ? WHERE id = ?").bind(msg, task.id),
      env.DB.prepare("UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE id = ? AND owner_id = ?").bind(msg, nowIso(), job.id, job.owner_id),
    ]);
    return;
  }
  if (e instanceof MetaError && ['not_configured', 'auth', 'billing', 'model_not_found'].includes(e.code)) {
    // Configuration problems affect every Meta task; pause instead of burning attempts.
    await env.DB.batch([
      env.DB.prepare("UPDATE job_tasks SET status = 'pending', lease_until = NULL, attempts = attempts - 1, error = ? WHERE id = ?").bind(msg, task.id),
      env.DB.prepare("UPDATE jobs SET status = 'paused', error = ?, updated_at = ? WHERE id = ? AND owner_id = ?").bind(msg, nowIso(), job.id, job.owner_id),
    ]);
    return;
  }
  const retryable = e instanceof RetryLater || (e instanceof MetaError && e.retryable);
  const limit = e instanceof RetryLater && e.rateLimit ? MAX_RATE_LIMIT_ATTEMPTS : MAX_ATTEMPTS;
  if (retryable && attempts < limit) {
    const delay = e instanceof RetryLater ? e.delayMs : 5000 * attempts;
    await env.DB.prepare("UPDATE job_tasks SET status = 'pending', lease_until = ?, error = ?, updated_at = ? WHERE id = ?").bind(Date.now() + delay, msg, nowIso(), task.id).run();
    return;
  }
  await env.DB.prepare("UPDATE job_tasks SET status = 'failed', lease_until = NULL, error = ?, updated_at = ? WHERE id = ?").bind(msg, nowIso(), task.id).run();
  if (task.paper_id && task.kind !== 'retrieve') {
    await env.DB.prepare("UPDATE papers SET analysis_status = 'partial', updated_at = ? WHERE id = ? AND owner_id = ?").bind(nowIso(), task.paper_id, job.owner_id).run();
  }
}

async function execute(env: Env, job: JobRow, task: TaskRow, fetchImpl: typeof fetch) {
  const project = await env.DB.prepare('SELECT id, brief_json FROM projects WHERE id = ? AND owner_id = ?').bind(job.project_id, job.owner_id).first<{ id: string; brief_json: string | null }>();
  if (!project) throw new ApiError(404, 'not_found', 'Project not found.');
  const ctx = { ownerId: job.owner_id, projectId: job.project_id, jobId: job.id };
  if (task.kind !== 'retrieve' && job.tokens_used >= job.token_budget) {
    throw new MetaError('budget', `This analysis reached its model budget (${job.token_budget.toLocaleString()} tokens). Resume to allow another budget increment.`);
  }
  switch (task.kind) {
    case 'retrieve':
      return retrieveTask(env, job, task, fetchImpl);
    case 'extract': {
      const p = parseJson<{ chunkIds: string[]; window: number; windows: number; documentId: string; title: string }>(task.payload_json, { chunkIds: [], window: 0, windows: 1, documentId: '', title: '' });
      await extractWindow(env, { ...ctx, stage: 'extraction' }, briefOf(project), { id: task.paper_id!, title: p.title, document_id: p.documentId }, p.chunkIds, p.window, p.windows, fetchImpl);
      return;
    }
    case 'check': {
      await checkPaper(env, { ...ctx, stage: 'checking' }, task.paper_id!, fetchImpl);
      const failed = await env.DB.prepare("SELECT COUNT(*) AS n FROM job_tasks WHERE job_id = ? AND paper_id = ? AND kind = 'extract' AND status = 'failed'").bind(job.id, task.paper_id).first<{ n: number }>();
      await env.DB.prepare('UPDATE papers SET analysis_status = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(failed?.n ? 'partial' : 'analysis_complete', nowIso(), task.paper_id, job.owner_id).run();
      return;
    }
    case 'compare': {
      const report = await compareAndPropose(env, { ...ctx, stage: 'comparison' }, briefOf(project), fetchImpl);
      if (!report) throw new ApiError(422, 'no_evidence', 'No verified evidence was extracted, so no proposal could be written. Check the retrieval and permission statuses of your papers.');
      await env.DB.prepare('INSERT INTO reports (id, project_id, owner_id, job_id, model, report_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .bind(newId('rep'), job.project_id, job.owner_id, job.id, report.model, JSON.stringify(report), nowIso())
        .run();
      return;
    }
  }
}

const STATUS_RANK: Record<string, number> = { institutional_connection_required: 4, permission_required: 3, abstract_only: 2, retrieval_failed: 1 };

function paperStatusFrom(a: RetrievalAttempt) {
  switch (a.status) {
    case 'full_text':
      return 'full_text_retrieved';
    case 'abstract_only':
      return 'abstract_only';
    case 'institutional_connection_required':
      return 'institutional_connection_required';
    case 'not_entitled':
    case 'agreement_required':
    case 'credentials_missing':
    case 'credentials_invalid':
      return 'permission_required';
    default:
      return 'retrieval_failed';
  }
}

async function retrieveTask(env: Env, job: JobRow, task: TaskRow, fetchImpl: typeof fetch) {
  const paper = await env.DB.prepare('SELECT id, project_id, owner_id, doi, title, publisher, license, user_access, discovered_via FROM papers WHERE id = ? AND owner_id = ?')
    .bind(task.paper_id, job.owner_id)
    .first<PaperRow & { discovered_via: string }>();
  if (!paper) return;
  const existing = await env.DB.prepare('SELECT id, completeness, license, connector FROM documents WHERE paper_id = ? AND owner_id = ? ORDER BY retrieved_at DESC LIMIT 1')
    .bind(paper.id, job.owner_id)
    .first<{ id: string; completeness: string; license: string | null; connector: string }>();
  const ctx = await loadConnectorContext(env, job.owner_id, fetchImpl);
  const provider = publisherOf(paper.doi, paper.publisher);

  let documentId: string | null = existing?.id ?? null;
  let license = existing?.license ?? paper.license;
  let attested = existing?.connector === 'user_upload_attested' || Boolean(provider && ctx.settings[provider]?.aiProcessingAttested);
  let log: RetrievalAttempt[] = [];

  if (!existing) {
    if (paper.discovered_via === 'demo_bundle') {
      const demo = DEMO_PAPERS.find((d) => d.doi.toLowerCase() === paper.doi);
      if (!demo) throw new ApiError(500, 'demo_missing', 'Demo paper not found in the bundle.');
      log = [{ connector: 'demo_bundle', status: 'full_text', reason: `Bundled demonstration copy (${demo.license}, from Europe PMC ${demo.pmcid}). Not a live publisher call.`, entitlement: 'open_access' }];
      const r = await ingestDocument(env, paper, new TextEncoder().encode(demo.xml), { connector: 'demo_bundle', format: 'jats', contentType: 'application/xml', versionLabel: `Demonstration copy of the CC BY 4.0 article from Europe PMC (${demo.pmcid})`, license: 'https://creativecommons.org/licenses/by/4.0/' });
      if (!r.ok) throw new ApiError(500, 'demo_parse', r.reason);
      documentId = r.documentId!;
      license = r.license ?? license;
      await finishRetrieval(env, paper, 'full_text_retrieved', r.reason, log, 'open_access', parseStatusFor(r.completeness!), license);
    } else {
      const { attempts, success } = await retrievePaper(ctx, paper);
      log = attempts;
      const access = attempts.some((a) => a.entitlement === 'open_access') ? 'open_access' : attempts.some((a) => a.entitlement === 'entitled') ? 'entitled' : paper.user_access;
      if (!success) {
        const rl = attempts.find((a) => a.status === 'rate_limited' && a.retryAfterMs !== undefined);
        if (rl && rl.retryAfterMs! < 15 * 60_000) {
          await saveLog(env, paper, attempts);
          throw new RetryLater(rl.reason, Math.max(rl.retryAfterMs!, 1000), true);
        }
        const best = attempts.map(paperStatusFrom).sort((a, b) => (STATUS_RANK[b] ?? 0) - (STATUS_RANK[a] ?? 0))[0] ?? 'retrieval_failed';
        const reason = attempts.find((a) => paperStatusFrom(a) === best)?.reason ?? 'No connector could retrieve this paper.';
        await finishRetrieval(env, paper, best, reason, attempts, access, 'not_parsed', license);
        return;
      }
      const f = success.file!;
      const r = await ingestDocument(env, paper, f.bytes, { connector: success.connector, format: f.format, contentType: f.contentType, versionLabel: f.versionLabel, license: f.license });
      if (!r.ok) {
        log.push({ connector: 'validation', status: 'failed', reason: r.reason });
        await finishRetrieval(env, paper, 'retrieval_failed', r.reason, log, access, 'not_parsed', license);
        return;
      }
      documentId = r.documentId!;
      license = r.license ?? license;
      const status = retrievalStatusFor(r.completeness!);
      await finishRetrieval(env, paper, status, status === 'abstract_only' ? `Only the abstract was available: ${r.reason}` : success.reason, log, access, parseStatusFor(r.completeness!), license);
      if (status === 'abstract_only') return;
    }
  } else {
    attested ||= existing.connector === 'demo_bundle';
  }

  // Decide whether Meta may process this paper, then queue extraction windows and the check.
  const permission = aiPermissionFor(license, attested);
  await env.DB.prepare('UPDATE papers SET ai_permission = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(permission, nowIso(), paper.id, job.owner_id).run();
  if (permission === 'not_confirmed') {
    await env.DB.prepare("UPDATE papers SET analysis_status = 'not_started', retrieval_reason = COALESCE(retrieval_reason, '') || ? WHERE id = ? AND owner_id = ?")
      .bind(' AI processing not confirmed: the licence is not open and you have not confirmed that your agreement permits analysis with Meta.', paper.id, job.owner_id)
      .run();
    return;
  }
  if (!metaConfigured(env)) {
    throw new MetaError('not_configured', 'Meta analysis is not configured on this server (MODEL_API_KEY is not set). Retrieval and parsing finished; analysis will run once it is configured.');
  }
  const { results: chunks } = await env.DB.prepare('SELECT id, seq, section, kind, label, page_start, page_end, text FROM chunks WHERE document_id = ? AND owner_id = ? ORDER BY seq')
    .bind(documentId, job.owner_id)
    .all<ChunkRow>();
  const wins = windows(chunks);
  const now = nowIso();
  const base = 1000 + task.seq * 1000;
  await env.DB.batch([
    env.DB.prepare('DELETE FROM evidence WHERE paper_id = ? AND owner_id = ?').bind(paper.id, job.owner_id),
    ...wins.map((ids, i) =>
      env.DB.prepare('INSERT INTO job_tasks (id, job_id, owner_id, seq, kind, paper_id, payload_json, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)').bind(
        newId('task'), job.id, job.owner_id, base + i, 'extract', paper.id, JSON.stringify({ chunkIds: ids, window: i, windows: wins.length, documentId, title: paper.title }), now,
      ),
    ),
    env.DB.prepare('INSERT INTO job_tasks (id, job_id, owner_id, seq, kind, paper_id, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').bind(newId('task'), job.id, job.owner_id, base + 999, 'check', paper.id, now),
    env.DB.prepare("UPDATE papers SET analysis_status = 'in_progress', updated_at = ? WHERE id = ? AND owner_id = ?").bind(now, paper.id, job.owner_id),
  ]);
}

async function saveLog(env: Env, paper: PaperRow, attempts: RetrievalAttempt[]) {
  await env.DB.prepare('UPDATE papers SET retrieval_log_json = ?, updated_at = ? WHERE id = ? AND owner_id = ?').bind(JSON.stringify(attempts.map(stripFile)), nowIso(), paper.id, paper.owner_id).run();
}

const stripFile = ({ file: _f, ...a }: RetrievalAttempt) => a;

async function finishRetrieval(env: Env, paper: PaperRow, status: string, reason: string, attempts: RetrievalAttempt[], access: string, parseStatus: string, license: string | null) {
  await env.DB.prepare(
    'UPDATE papers SET retrieval_status = ?, retrieval_reason = ?, retrieval_log_json = ?, user_access = ?, parse_status = ?, license = ?, updated_at = ? WHERE id = ? AND owner_id = ?',
  )
    .bind(status, reason, JSON.stringify(attempts.map(stripFile)), access, parseStatus, license, nowIso(), paper.id, paper.owner_id)
    .run();
}
