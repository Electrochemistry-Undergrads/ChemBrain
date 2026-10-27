import { ApiError, json } from '../http/respond';
import { answerQuestion, type ReportJson } from '../jobs/analysis';
import { MetaError } from '../meta/client';
import { newId, nowIso, parseJson } from '../util';
import { coverage, ownedProject } from './access';
import type { Route } from './router';
import type { Env } from '../env';

interface EvidenceOut {
  id: string;
  paper_id: string;
  chunk_id: string;
  category: string;
  subject: string;
  role: string | null;
  value_text: string | null;
  value_num: number | null;
  unit: string | null;
  normalized_value: number | null;
  normalized_unit: string | null;
  conversion_note: string | null;
  conditions: string | null;
  quote: string;
  quote_match: string;
  check_status: string;
  check_note: string | null;
  uncertainty: string | null;
  section: string | null;
  label: string | null;
  page_start: number | null;
  page_end: number | null;
}

async function evidenceFor(env: Env, ownerId: string, projectId: string) {
  const { results } = await env.DB.prepare(
    `SELECT e.id, e.paper_id, e.chunk_id, e.category, e.subject, e.role, e.value_text, e.value_num, e.unit, e.normalized_value, e.normalized_unit,
       e.conversion_note, e.conditions, e.quote, e.quote_match, e.check_status, e.check_note, e.uncertainty, c.section, c.label, c.page_start, c.page_end
     FROM evidence e JOIN chunks c ON c.id = e.chunk_id WHERE e.owner_id = ? AND e.project_id = ? ORDER BY e.paper_id, e.created_at`,
  )
    .bind(ownerId, projectId)
    .all<EvidenceOut>();
  return results;
}

async function latestReport(env: Env, ownerId: string, projectId: string) {
  const r = await env.DB.prepare('SELECT id, model, report_json, created_at FROM reports WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 1')
    .bind(projectId, ownerId)
    .first<{ id: string; model: string; report_json: string; created_at: string }>();
  return r ? { id: r.id, model: r.model, createdAt: r.created_at, report: parseJson<ReportJson | null>(r.report_json, null) } : null;
}

async function papersFor(env: Env, ownerId: string, projectId: string) {
  const { results } = await env.DB.prepare(
    `SELECT p.id, p.doi, p.title, p.authors, p.year, p.venue, p.publisher, p.license, p.user_access, p.retrieval_status, p.parse_status, p.ai_permission, p.analysis_status,
       d.version_label, d.completeness, d.connector FROM papers p LEFT JOIN documents d ON d.paper_id = p.id AND d.owner_id = p.owner_id
     WHERE p.owner_id = ? AND p.project_id = ? AND p.selected = 1 ORDER BY p.created_at`,
  )
    .bind(ownerId, projectId)
    .all<Record<string, unknown> & { id: string; doi: string | null; title: string }>();
  return results;
}

export const reportRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/projects/:id/evidence',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      return json({ evidence: await evidenceFor(env, user.id, params.id) });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/report',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      return json({ report: await latestReport(env, user.id, params.id) });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/export.json',
    handler: async ({ env, user, params }) => {
      const p = await ownedProject(env, user.id, params.id);
      const data = await exportData(env, user.id, p);
      return new Response(JSON.stringify(data, null, 2), {
        headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="chembrain-${p.id}.json"`, 'cache-control': 'no-store' },
      });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/export.md',
    handler: async ({ env, user, params }) => {
      const p = await ownedProject(env, user.id, params.id);
      const md = toMarkdown(await exportData(env, user.id, p));
      return new Response(md, {
        headers: { 'content-type': 'text/markdown; charset=utf-8', 'content-disposition': `attachment; filename="chembrain-${p.id}.md"`, 'cache-control': 'no-store' },
      });
    },
  },
  {
    method: 'GET',
    path: '/api/projects/:id/questions',
    handler: async ({ env, user, params }) => {
      await ownedProject(env, user.id, params.id);
      const { results } = await env.DB.prepare('SELECT id, question, answer_json, created_at FROM questions WHERE project_id = ? AND owner_id = ? ORDER BY created_at DESC LIMIT 50').bind(params.id, user.id).all<{ id: string; question: string; answer_json: string; created_at: string }>();
      return json({ questions: results.map((q) => ({ ...q, answer: parseJson(q.answer_json, null), answer_json: undefined })) });
    },
  },
  {
    method: 'POST',
    path: '/api/projects/:id/questions',
    handler: async ({ env, user, params, body, fetch }) => {
      await ownedProject(env, user.id, params.id);
      const { question = '' } = await body<{ question?: string }>();
      const q = question.trim().slice(0, 1000);
      if (q.length < 5) throw new ApiError(400, 'short', 'Ask a complete question.');
      try {
        const res = await answerQuestion(env, { ownerId: user.id, projectId: params.id, stage: 'question' }, q, fetch);
        if (!res) throw new ApiError(400, 'no_terms', 'Ask a question with specific terms (ingredients, properties, methods).');
        await env.DB.prepare('INSERT INTO questions (id, project_id, owner_id, question, answer_json, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(newId('qst'), params.id, user.id, q, JSON.stringify(res), nowIso()).run();
        return json(res);
      } catch (e) {
        if (e instanceof MetaError) throw new ApiError(e.code === 'not_configured' ? 503 : 502, `meta_${e.code}`, e.message);
        throw e;
      }
    },
  },
];

async function exportData(env: Env, ownerId: string, p: { id: string; name: string; brief_json: string | null; is_demo: number }) {
  const [papers, evidence, report, cov] = await Promise.all([papersFor(env, ownerId, p.id), evidenceFor(env, ownerId, p.id), latestReport(env, ownerId, p.id), coverage(env, ownerId, p.id)]);
  return {
    generator: 'ChemBrain',
    exportedAt: nowIso(),
    notice: 'AI-assisted research plan generated from the cited sources. It has not been experimentally validated and requires researcher review.',
    project: { id: p.id, name: p.name, demonstration: Boolean(p.is_demo), brief: parseJson(p.brief_json, null) },
    coverage: cov,
    papers,
    evidence,
    report,
  };
}

function cite(papers: Record<string, { title: string; doi: string | null; year: number | null }>, ref: string) {
  const p = papers[ref];
  return p ? `[${ref}]` : '';
}

export function toMarkdown(d: Awaited<ReturnType<typeof exportData>>) {
  const L: string[] = [];
  const brief = (d.project.brief ?? {}) as Record<string, string>;
  const r = d.report?.report;
  const evById = new Map(d.evidence.map((e) => [e.id, e]));
  const refToEv = r?.evidence ?? {};
  const evNum = new Map<string, number>();
  const evCite = (refs: string[]) =>
    refs
      .map((ref) => refToEv[ref])
      .filter(Boolean)
      .map((id) => {
        if (!evNum.has(id)) evNum.set(id, evNum.size + 1);
        return `[^e${evNum.get(id)}]`;
      })
      .join('');
  L.push(`# ${d.project.name}`, '');
  if (d.project.demonstration) L.push('> **Demonstration project.** Papers are bundled CC BY 4.0 copies from Europe PMC, not live publisher retrievals.', '');
  L.push(`> ${d.notice}`, '', `Exported ${d.exportedAt}${d.report ? ` · Analysis model: ${d.report.model} · Report generated ${d.report.createdAt}` : ''}`, '');
  L.push('## Product brief', '');
  for (const [k, v] of Object.entries(brief)) if (v) L.push(`- **${k.replace(/([A-Z])/g, ' $1').toLowerCase()}:** ${v}`);
  L.push('', '## Retrieval coverage', '');
  const c = d.coverage;
  L.push(`| Metric | Count |`, `|---|---|`);
  for (const [k, v] of Object.entries(c)) L.push(`| ${k.replace(/_/g, ' ')} | ${v} |`);
  L.push('');
  if (!r) {
    L.push('_No proposal has been generated yet._', '');
  } else {
    const p = r.proposal;
    L.push('## Assessment', '', p.assessment, '');
    L.push('## Ranked approaches', '');
    for (const a of [...p.approaches].sort((x, y) => x.rank - y.rank)) {
      L.push(`### ${a.rank}. ${a.name} (${a.evidence_strength} evidence) ${a.papers.map((x) => cite(r.papers, x)).join(' ')}`, '', a.summary, '');
      if (a.ingredients.length) L.push('**Ingredients (as published)**', '', ...a.ingredients.map((i) => `- ${i.name}${i.role ? ` — ${i.role}` : ''}${i.amount ? `: ${i.amount}` : ''} ${evCite(i.evidence)}`), '');
      if (a.method.length) L.push('**Method (as published)**', '', ...a.method.map((m, i) => `${i + 1}. ${m.step} ${evCite(m.evidence)}`), '');
      if (a.performance.length) L.push('**Reported performance**', '', ...a.performance.map((m) => `- ${m.property}: ${m.value}${m.test_conditions ? ` (${m.test_conditions})` : ''} ${evCite(m.evidence)}`), '');
      L.push(`**Fit to brief:** ${a.fit_to_brief}`, '');
      if (a.risks.length) L.push('**Risks:** ' + a.risks.join('; '), '');
    }
    if (p.ingredient_comparison.length) {
      L.push('## Ingredient comparison', '', '| Ingredient | Role | Uses |', '|---|---|---|');
      for (const i of p.ingredient_comparison) L.push(`| ${i.ingredient} | ${i.role ?? ''} | ${i.uses.map((u) => `${cite(r.papers, u.paper)} ${u.amount ?? ''} ${evCite(u.evidence)}`).join('<br>')} |`);
      L.push('');
    }
    if (p.method_comparison.length) {
      L.push('## Experimental-method comparison', '', '| Method | Uses | Note |', '|---|---|---|');
      for (const m of p.method_comparison) L.push(`| ${m.method} | ${m.uses.map((u) => `${cite(r.papers, u.paper)} ${u.conditions ?? ''} ${evCite(u.evidence)}`).join('<br>')} | ${m.note ?? ''} |`);
      L.push('');
    }
    if (p.performance_comparison.length) {
      L.push('## Reported performance and test conditions', '');
      for (const m of p.performance_comparison) {
        L.push(`### ${m.property}${m.comparable ? '' : ' (not directly comparable)'}`, '', m.comparability_note, '', '| Paper | Value | Test conditions |', '|---|---|---|');
        for (const e of m.entries) L.push(`| ${cite(r.papers, e.paper)} | ${e.value} ${evCite(e.evidence)} | ${e.test_conditions ?? 'not reported'} |`);
        L.push('');
      }
    }
    if (p.conflicts.length) L.push('## Conflicting findings', '', ...p.conflicts.map((x) => `- **${x.topic}:** ${x.description} ${evCite(x.evidence)}`), '');
    if (p.missing_evidence.length) L.push('## Missing evidence', '', ...p.missing_evidence.map((x) => `- ${x}`), '');
    if (p.adaptations.length) L.push('## ChemBrain’s proposed adaptations (not published; require review)', '', ...p.adaptations.map((x) => `- ${x.proposal} ${evCite(x.basis)} _Caveat: ${x.caveat}_`), '');
    if (p.next_experiments.length) {
      L.push('## Proposed next experiments', '');
      for (const x of p.next_experiments) L.push(`### ${x.title}`, '', x.rationale, '', `**Design:** ${x.design}`, '', `**Measure:** ${x.measurements.join('; ')} ${evCite(x.basis)}`, '');
    }
    if (p.not_established.length) L.push('## What the sources do not establish', '', ...p.not_established.map((x) => `- ${x}`), '');
    if (r.validation.removedReferences || r.validation.unsupportedStatements.length) {
      L.push('## Citation validation', '', `${r.validation.removedReferences} model citations referred to unknown evidence and were removed.`, ...r.validation.unsupportedStatements.map((s) => `- Uncited statement removed or flagged: ${s}`), '');
    }
    L.push('## Papers', '');
    for (const [ref, paper] of Object.entries(r.papers)) L.push(`- **[${ref}]** ${paper.title} (${paper.year ?? 'n.d.'})${paper.doi ? ` https://doi.org/${paper.doi}` : ''}`);
    L.push('', '## Evidence', '');
    for (const [id, n] of evNum) {
      const e = evById.get(id);
      if (!e) continue;
      const loc = [e.section, e.label, e.page_start ? `p. ${e.page_start}${e.page_end && e.page_end !== e.page_start ? `–${e.page_end}` : ''}` : null].filter(Boolean).join(', ');
      const paperRef = Object.entries(r.papers).find(([, v]) => v.id === e.paper_id)?.[0] ?? '';
      L.push(`[^e${n}]: [${paperRef}] ${loc} — “${e.quote}” (${e.check_status.replace(/_/g, ' ')}${e.conversion_note ? `; ${e.conversion_note}` : ''})`);
    }
  }
  return L.join('\n') + '\n';
}
