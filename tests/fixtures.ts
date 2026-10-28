/**
 * LABELLED TEST FIXTURES. These simulate upstream services (Meta, publishers) so integration
 * boundaries can be tested offline. They never run in production and do not verify live access.
 */

export function sse(content: string, usage = { prompt_tokens: 1000, completion_tokens: 200 }) {
  const parts = content.match(/[\s\S]{1,40}/g) ?? [''];
  const lines = parts.map((p) => `data: ${JSON.stringify({ model: 'muse-spark-1.3', choices: [{ delta: { content: p }, finish_reason: null }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ model: 'muse-spark-1.3', choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
  lines.push(`data: ${JSON.stringify({ model: 'muse-spark-1.3', choices: [], usage })}\n\n`, 'data: [DONE]\n\n');
  return new Response(lines.join(''), { headers: { 'content-type': 'text/event-stream' } });
}

/** Fake Meta that answers by schema name. Extraction quotes real sentences from the prompt's chunks, plus one fabricated quote. */
export function fakeMeta(opts: { failFirst?: number } = {}) {
  let failures = opts.failFirst ?? 0;
  const calls: string[] = [];
  const impl = async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith('https://api.crossref.org/works/')) return Response.json({ message: { DOI: decodeURIComponent(new URL(url).pathname.slice('/works/'.length)), title: ['Test metadata record'], 'updated-by': [] } });
    if (!url.startsWith('https://api.meta.ai/v1/chat/completions')) return new Response('unexpected', { status: 599 });
    const body = JSON.parse(String(init!.body));
    const name = body.response_format.json_schema.name as string;
    calls.push(name);
    if (failures > 0) {
      failures--;
      return new Response(JSON.stringify({ error: { type: 'server_error', code: 'service_overloaded', message: 'busy' } }), { status: 503, headers: { 'retry-after': '0' } });
    }
    const user = body.messages[1].content as string;
    if (name === 'evidence_extraction') {
      const chunks = [...user.matchAll(/<chunk ref="(C\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/g)].map((m) => ({ ref: m[1], text: m[2] }));
      const items = [];
      for (const c of chunks.slice(0, 3)) {
        const sentence = c.text.split(/(?<=\.)\s+/).find((s) => s.length > 40 && s.length < 280) ?? c.text.slice(0, 120);
        const num = /(\d+(?:\.\d+)?)\s*(°C|wt%|%|h|min|mL|g|MPa)/.exec(sentence);
        items.push({ chunk_ref: c.ref, category: num ? 'condition' : 'method_step', subject: 'test item', role: null, value_text: num ? num[0] : null, value_num: num ? Number(num[1]) : null, unit: num ? num[2] : null, conditions: null, quote: sentence, uncertainty: null });
      }
      if (chunks[0]) {
        items.push({ chunk_ref: chunks[0].ref, category: 'result', subject: 'fabricated', role: null, value_text: '999 MPa', value_num: 999, unit: 'MPa', conditions: null, quote: 'The film reached a tensile strength of 999 MPa after plasma curing.', uncertainty: null });
        const s = chunks[0].text.split(/(?<=\.)\s+/).find((x) => x.length > 40) ?? chunks[0].text.slice(0, 100);
        items.push({ chunk_ref: chunks[0].ref, category: 'result', subject: 'value mismatch', role: null, value_text: '123456', value_num: 123456, unit: 'g', conditions: null, quote: s, uncertainty: null });
      }
      return sse(JSON.stringify({ items, not_reported: ['drying humidity'] }));
    }
    if (name === 'evidence_check') {
      const refs = [...user.matchAll(/<evidence ref="(E\d+)">/g)].map((m) => m[1]);
      return sse(JSON.stringify({ checks: refs.map((r) => ({ evidence_ref: r, verdict: 'supported', note: 'quote matches' })) }));
    }
    if (name === 'research_proposal') {
      const evs = [...user.matchAll(/^(E\d+) \| (P\d+)/gm)].map((m) => ({ e: m[1], p: m[2] }));
      const e1 = evs[0];
      return sse(
        JSON.stringify({
          assessment: 'Test assessment.',
          assessment_evidence: [e1.e],
          approaches: [{ rank: 1, name: 'Approach A', summary: 's', summary_evidence: [e1.e], papers: [e1.p, 'P99'], synthesis_method: { name: 'Uncited test route', evidence: ['E9999'] }, equipment: [{ name: 'Uncited test instrument', purpose: 'synthesis', evidence: ['E9999'] }], ingredients: [{ name: 'starch', role: 'matrix', amount: null, evidence: [e1.e, 'E9999'] }], method: [{ step: 'cast', evidence: [] }], performance: [{ property: 'WVP', value: '1', test_conditions: null, evidence: ['E9999'] }], fit_to_brief: 'ok', risks: [], evidence_strength: 'moderate' }],
          ingredient_comparison: [],
          method_comparison: [],
          performance_comparison: [],
          conflicts: [],
          missing_evidence: ['none'],
          adaptations: [{ proposal: 'try more', basis: [e1.e], caveat: 'untested' }],
          next_experiments: [],
          not_established: [],
        }),
      );
    }
    if (name === 'grounded_answer') {
      const c = /<chunk ref="(Q\d+)"[^>]*>\n([\s\S]*?)\n<\/chunk>/.exec(user)!;
      return sse(JSON.stringify({ answer: 'Answer.', citations: [{ chunk_ref: c[1], quote: c[2].slice(0, 80) }], insufficient_evidence: false }));
    }
    return sse(JSON.stringify({ interpretation: 'x', target_properties: [], queries: [{ query: 'starch film water vapor', rationale: 'r' }], inclusion_criteria: [], exclusion_criteria: [] }));
  };
  return { impl: impl as typeof fetch, calls };
}
