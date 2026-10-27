import type { Env } from '../env';

import { callMetaJson, type UsageContext } from '../meta/client';
import { Answer, Check, Extraction, Proposal, Screening, SearchPlan, jsonSchemaOf } from '../meta/schemas';
import {
  CHECK_SYSTEM, EXTRACTION_SYSTEM, PROPOSAL_SYSTEM, QUESTION_SYSTEM, SCREENING_SYSTEM, SEARCH_PLANNING_SYSTEM, briefBlock, fence,
} from '../meta/prompts';
import { matchQuote, valueInQuote } from '../evidence/verify';
import { normalizeUnit } from '../evidence/units';
import { newId, nowIso, parseJson } from '../util';

export interface ChunkRow {
  id: string;
  seq: number;
  section: string | null;
  kind: string;
  label: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
}

const pages = (c: ChunkRow) => (c.page_start ? (c.page_end && c.page_end !== c.page_start ? `${c.page_start}-${c.page_end}` : `${c.page_start}`) : '');
const attr = (s: string) => fence(s).replace(/"/g, "'");

function chunkBlock(c: ChunkRow) {
  const p = pages(c);
  return `<chunk ref="C${c.seq}" section="${attr(c.section ?? '')}"${c.label ? ` label="${attr(c.label)}"` : ''}${p ? ` pages="${p}"` : ''}>\n${fence(c.text)}\n</chunk>`;
}

/** Stage 1: search planning. */
export async function planSearch(env: Env, ctx: UsageContext, brief: unknown, fetchImpl: typeof fetch = fetch) {
  return callMetaJson(env, ctx, {
    system: SEARCH_PLANNING_SYSTEM,
    user: `${briefBlock(brief)}\n\nProduce the search plan.`,
    schema: SearchPlan,
    jsonSchema: jsonSchemaOf(SearchPlan),
    schemaName: 'search_plan',
    maxCompletionTokens: 6000,
  }, fetchImpl);
}

/** Stage 1b: relevance screening of discovered candidates (title + abstract). */
export async function screenCandidates(env: Env, ctx: UsageContext, brief: unknown, items: { ref: string; title: string; abstract: string | null; year: number | null; venue: string | null }[], fetchImpl: typeof fetch = fetch) {
  const block = items
    .map((c) => `<candidate ref="${c.ref}">\nTitle: ${fence(c.title)}\nYear: ${c.year ?? 'unknown'}; Venue: ${fence(c.venue ?? 'unknown')}\nAbstract: ${fence((c.abstract ?? 'not available').slice(0, 1500))}\n</candidate>`)
    .join('\n');
  return callMetaJson(env, ctx, {
    system: SCREENING_SYSTEM,
    user: `${briefBlock(brief)}\n\n${block}\n\nRate every candidate.`,
    schema: Screening,
    jsonSchema: jsonSchemaOf(Screening),
    schemaName: 'screening',
    maxCompletionTokens: 8000,
  }, fetchImpl);
}

/** Groups a document's chunks into bounded windows for extraction (every chunk is covered). */
export function windows(chunks: ChunkRow[], maxChars = 14_000): string[][] {
  const out: string[][] = [];
  let cur: string[] = [];
  let size = 0;
  for (const c of chunks) {
    if (cur.length && size + c.text.length > maxChars) {
      out.push(cur);
      cur = [];
      size = 0;
    }
    cur.push(c.id);
    size += c.text.length;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Stage 2: paper-by-paper extraction over one window, followed by deterministic quote checks. */
export async function extractWindow(env: Env, ctx: UsageContext, brief: unknown, paper: { id: string; title: string; document_id: string }, chunkIds: string[], windowIndex: number, windowCount: number, fetchImpl: typeof fetch = fetch) {
  const placeholders = chunkIds.map(() => '?').join(',');
  const { results: chunks } = await env.DB.prepare(`SELECT id, seq, section, kind, label, page_start, page_end, text FROM chunks WHERE owner_id = ? AND document_id = ? AND id IN (${placeholders}) ORDER BY seq`)
    .bind(ctx.ownerId, paper.document_id, ...chunkIds)
    .all<ChunkRow>();
  if (!chunks.length) return { inserted: 0, rejected: 0, notReported: [] as string[] };

  const res = await callMetaJson(env, ctx, {
    system: EXTRACTION_SYSTEM,
    user: `${briefBlock(brief)}\n\n<document title="${attr(paper.title)}" part="${windowIndex + 1} of ${windowCount}">\n${chunks.map(chunkBlock).join('\n')}\n</document>\n\nExtract the evidence from these chunks.`,
    schema: Extraction,
    jsonSchema: jsonSchemaOf(Extraction),
    schemaName: 'evidence_extraction',
    maxCompletionTokens: 16000,
  }, fetchImpl);

  const bySeq = new Map(chunks.map((c) => [`C${c.seq}`, c]));
  const stmts: D1PreparedStatement[] = [];
  let rejected = 0;
  for (const it of res.data.items) {
    let chunk = bySeq.get(it.chunk_ref.trim());
    let match = chunk ? matchQuote(it.quote, chunk.text) : 'not_found';
    if (match === 'not_found') {
      // The model sometimes cites the neighbouring chunk; accept the quote only where it truly occurs.
      for (const c of chunks) {
        const m = matchQuote(it.quote, c.text);
        if (m !== 'not_found') {
          chunk = c;
          match = m;
          break;
        }
      }
    }
    if (!chunk) {
      rejected++;
      chunk = chunks[0];
    }
    let checkStatus = 'unchecked';
    let checkNote: string | null = null;
    if (match === 'not_found') {
      checkStatus = 'unsupported';
      checkNote = 'The quoted passage was not found in the document; this item is excluded from comparisons.';
      rejected++;
    } else if (it.value_num !== null && !valueInQuote(it.value_num, it.quote)) {
      checkStatus = 'unsupported';
      checkNote = `The value ${it.value_num} does not appear in the quoted passage; excluded from comparisons.`;
    }
    const norm = normalizeUnit(it.value_num, it.unit);
    stmts.push(
      env.DB.prepare(
        `INSERT INTO evidence (id, project_id, paper_id, document_id, chunk_id, owner_id, category, subject, role, value_text, value_num, unit,
          normalized_value, normalized_unit, conversion_note, conditions, quote, quote_match, check_status, check_note, uncertainty, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).bind(
        newId('ev'), ctx.projectId!, paper.id, paper.document_id, chunk.id, ctx.ownerId, it.category, it.subject, it.role, it.value_text, it.value_num, it.unit,
        norm.value, norm.unit, norm.note, it.conditions, it.quote, match, checkStatus, checkNote, it.uncertainty, nowIso(),
      ),
    );
  }
  if (stmts.length) await env.DB.batch(stmts);
  return { inserted: stmts.length, rejected, notReported: res.data.not_reported };
}

interface EvidenceRow {
  id: string;
  paper_id: string;
  category: string;
  subject: string;
  role: string | null;
  value_text: string | null;
  unit: string | null;
  conditions: string | null;
  quote: string;
  quote_match: string;
  check_status: string;
}

/** Stage 3: evidence checking of every item whose quote was found in the document. */
export async function checkPaper(env: Env, ctx: UsageContext, paperId: string, fetchImpl: typeof fetch = fetch) {
  const { results } = await env.DB.prepare(
    `SELECT id, paper_id, category, subject, role, value_text, unit, conditions, quote, quote_match, check_status FROM evidence
     WHERE owner_id = ? AND project_id = ? AND paper_id = ? AND quote_match != 'not_found' AND check_status = 'unchecked' ORDER BY created_at LIMIT 150`,
  )
    .bind(ctx.ownerId, ctx.projectId!, paperId)
    .all<EvidenceRow>();
  if (!results.length) return { checked: 0 };
  const refs = new Map(results.map((r, i) => [`E${i + 1}`, r]));
  const block = [...refs]
    .map(([ref, r]) => `<evidence ref="${ref}">\nClaim: ${fence(`${r.category}: ${r.subject}${r.role ? ` (${r.role})` : ''}${r.value_text ? ` = ${r.value_text}` : ''}${r.conditions ? ` [${r.conditions}]` : ''}`)}\nQuote: "${fence(r.quote)}"\n</evidence>`)
    .join('\n');
  const res = await callMetaJson(env, ctx, {
    system: CHECK_SYSTEM,
    user: `${block}\n\nCheck every item.`,
    schema: Check,
    jsonSchema: jsonSchemaOf(Check),
    schemaName: 'evidence_check',
    maxCompletionTokens: 12000,
  }, fetchImpl);
  const stmts = res.data.checks
    .filter((c) => refs.has(c.evidence_ref))
    .map((c) => env.DB.prepare('UPDATE evidence SET check_status = ?, check_note = ? WHERE id = ? AND owner_id = ?').bind(c.verdict, c.note, refs.get(c.evidence_ref)!.id, ctx.ownerId));
  if (stmts.length) await env.DB.batch(stmts);
  return { checked: stmts.length };
}

export interface ReportJson {
  proposal: Proposal;
  papers: Record<string, { id: string; title: string; doi: string | null; year: number | null }>;
  evidence: Record<string, string>;
  validation: { removedReferences: number; unsupportedStatements: string[]; evidenceUsed: number; papersUsed: number };
  model: string;
  generatedAt: string;
}

/** Stage 4: cross-paper comparison and proposal from checked evidence only. */
export async function compareAndPropose(env: Env, ctx: UsageContext, brief: unknown, fetchImpl: typeof fetch = fetch): Promise<ReportJson | null> {
  const { results: papers } = await env.DB.prepare(
    `SELECT DISTINCT p.id, p.title, p.doi, p.year FROM papers p JOIN evidence e ON e.paper_id = p.id
     WHERE p.owner_id = ? AND p.project_id = ? ORDER BY p.created_at`,
  )
    .bind(ctx.ownerId, ctx.projectId!)
    .all<{ id: string; title: string; doi: string | null; year: number | null }>();
  const { results: ev } = await env.DB.prepare(
    `SELECT id, paper_id, category, subject, role, value_text, unit, conditions, quote, quote_match, check_status FROM evidence
     WHERE owner_id = ? AND project_id = ? AND quote_match != 'not_found' AND check_status IN ('supported', 'partially_supported')
     ORDER BY paper_id, created_at LIMIT 450`,
  )
    .bind(ctx.ownerId, ctx.projectId!)
    .all<EvidenceRow>();
  if (!ev.length) return null;
  const paperRef = new Map<string, string>();
  papers.forEach((p, i) => paperRef.set(p.id, `P${i + 1}`));
  const evRef = new Map<string, EvidenceRow>();
  ev.forEach((e, i) => evRef.set(`E${i + 1}`, e));

  const paperLines = papers.map((p) => `${paperRef.get(p.id)}: ${fence(p.title)} (${p.year ?? 'n.d.'})`).join('\n');
  const evLines = [...evRef]
    .map(([ref, e]) => `${ref} | ${paperRef.get(e.paper_id)} | ${e.category} | ${fence(e.subject)}${e.role ? ` | role: ${fence(e.role)}` : ''}${e.value_text ? ` | ${fence(e.value_text)}` : ''}${e.conditions ? ` | conditions: ${fence(e.conditions)}` : ''}${e.check_status === 'partially_supported' ? ' | partially supported' : ''} | "${fence(e.quote.slice(0, 220))}"`)
    .join('\n');
  const res = await callMetaJson(env, ctx, {
    system: PROPOSAL_SYSTEM,
    user: `${briefBlock(brief)}\n\nPapers:\n${paperLines}\n\n<evidence>\n${evLines}\n</evidence>\n\nWrite the proposal.`,
    schema: Proposal,
    jsonSchema: jsonSchemaOf(Proposal),
    schemaName: 'research_proposal',
    maxCompletionTokens: 32000,
  }, fetchImpl);

  // Validate every citation: unknown evidence or paper refs are removed and counted.
  let removed = 0;
  const unsupported: string[] = [];
  const validE = (xs: string[]) => {
    const ok = xs.filter((x) => evRef.has(x));
    removed += xs.length - ok.length;
    return ok;
  };
  const validP = (x: string) => (paperRef.size && [...paperRef.values()].includes(x) ? x : (removed++, null));
  const p = res.data;
  for (const a of p.approaches) {
    a.papers = a.papers.map(validP).filter((x): x is string => x !== null);
    a.ingredients.forEach((i) => (i.evidence = validE(i.evidence)));
    a.method.forEach((m) => (m.evidence = validE(m.evidence)));
    a.performance = a.performance.filter((x) => (x.evidence = validE(x.evidence)).length > 0 || (unsupported.push(`${a.name}: ${x.property} = ${x.value}`), false));
    a.ingredients.filter((i) => !i.evidence.length).forEach((i) => unsupported.push(`${a.name}: ingredient ${i.name}`));
    a.method.filter((m) => !m.evidence.length).forEach((m) => unsupported.push(`${a.name}: step “${m.step.slice(0, 80)}”`));
  }
  for (const r of p.ingredient_comparison) r.uses = r.uses.filter((u) => validP(u.paper) && (u.evidence = validE(u.evidence)).length);
  for (const r of p.method_comparison) r.uses = r.uses.filter((u) => validP(u.paper) && (u.evidence = validE(u.evidence)).length);
  for (const r of p.performance_comparison) r.entries = r.entries.filter((u) => validP(u.paper) && (u.evidence = validE(u.evidence)).length);
  p.conflicts.forEach((c) => (c.evidence = validE(c.evidence)));
  p.adaptations.forEach((a) => (a.basis = validE(a.basis)));
  p.next_experiments.forEach((x) => (x.basis = validE(x.basis)));

  const used = new Set<string>();
  JSON.stringify(p).replace(/"E\d+"/g, (m) => (used.add(m.slice(1, -1)), m));
  const report: ReportJson = {
    proposal: p,
    papers: Object.fromEntries(papers.map((x) => [paperRef.get(x.id)!, { id: x.id, title: x.title, doi: x.doi, year: x.year }])),
    evidence: Object.fromEntries([...used].map((r) => [r, evRef.get(r)!.id])),
    validation: { removedReferences: removed, unsupportedStatements: unsupported, evidenceUsed: used.size, papersUsed: papers.length },
    model: res.model,
    generatedAt: nowIso(),
  };
  return report;
}

/** Source-grounded follow-up questions over the user's own retrieved chunks. */
export async function answerQuestion(env: Env, ctx: UsageContext, question: string, fetchImpl: typeof fetch = fetch) {
  const terms = [...new Set(question.toLowerCase().match(/[a-z0-9][a-z0-9\-]{2,}/g) ?? [])].slice(0, 8);
  if (!terms.length) return null;
  const like = terms.map(() => 'LOWER(c.text) LIKE ?').join(' OR ');
  const { results } = await env.DB.prepare(
    `SELECT c.id, c.seq, c.section, c.kind, c.label, c.page_start, c.page_end, c.text, p.title AS paper_title, p.id AS paper_id FROM chunks c JOIN papers p ON p.id = c.paper_id
     WHERE c.owner_id = ? AND c.project_id = ? AND (${like}) LIMIT 200`,
  )
    .bind(ctx.ownerId, ctx.projectId!, ...terms.map((t) => `%${t}%`))
    .all<ChunkRow & { paper_title: string; paper_id: string }>();
  const scored = results
    .map((c) => ({ c, s: terms.reduce((a, t) => a + (c.text.toLowerCase().split(t).length - 1), 0) }))
    .sort((a, b) => b.s - a.s)
    .slice(0, 10)
    .map((x) => x.c);
  if (!scored.length) return { answer: { answer: 'None of your retrieved papers mention these terms.', citations: [], insufficient_evidence: true }, chunks: [] };
  const refMap = new Map(scored.map((c, i) => [`Q${i + 1}`, c]));
  const block = [...refMap].map(([ref, c]) => `<chunk ref="${ref}" paper="${attr(c.paper_title)}" section="${attr(c.section ?? '')}"${pages(c) ? ` pages="${pages(c)}"` : ''}>\n${fence(c.text)}\n</chunk>`).join('\n');
  const res = await callMetaJson(env, ctx, {
    system: QUESTION_SYSTEM,
    user: `<document>\n${block}\n</document>\n\nQuestion: ${fence(question)}`,
    schema: Answer,
    jsonSchema: jsonSchemaOf(Answer),
    schemaName: 'grounded_answer',
    maxCompletionTokens: 6000,
  }, fetchImpl);
  const citations = res.data.citations
    .map((c) => {
      const chunk = refMap.get(c.chunk_ref);
      return chunk ? { chunkId: chunk.id, paperId: chunk.paper_id, paperTitle: chunk.paper_title, quote: c.quote, match: matchQuote(c.quote, chunk.text) } : null;
    })
    .filter((x) => x !== null);
  return { answer: res.data, citations, model: res.model };
}

export function briefOf(row: { brief_json: string | null }) {
  return parseJson<Record<string, unknown>>(row.brief_json, {});
}

