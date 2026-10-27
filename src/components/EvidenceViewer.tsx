import { useEffect, useState } from 'react';
import { api } from '../lib/api';
import { Badge, Drawer, Notice, Spinner } from './ui';

interface Chunk {
  id: string;
  seq: number;
  section: string | null;
  kind: string;
  label: string | null;
  page_start: number | null;
  page_end: number | null;
  text: string;
  paper_title: string;
  doi: string | null;
  version_label: string | null;
  format: string;
}

/** Finds the quote in the passage, tolerating whitespace differences, and returns [start, end]. */
function locate(text: string, quote: string): [number, number] | null {
  const i = text.indexOf(quote);
  if (i >= 0) return [i, i + quote.length];
  const words = quote.trim().split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  if (!words.length) return null;
  const m = new RegExp(words.join('[\\s\\-\\u00ad]*'), 'i').exec(text);
  return m ? [m.index, m.index + m[0].length] : null;
}

export function EvidenceViewer({ projectId, target, onClose }: { projectId: string; target: { chunkId: string; quote: string; title?: string; status?: string } | null; onClose: () => void }) {
  const [chunk, setChunk] = useState<Chunk | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    if (!target) return;
    setChunk(null);
    setErr('');
    api<{ chunk: Chunk }>(`/api/projects/${projectId}/chunks/${target.chunkId}`).then((r) => setChunk(r.chunk)).catch((e) => setErr(e.message));
  }, [projectId, target]);
  if (!target) return null;
  const loc = chunk ? locate(chunk.text, target.quote) : null;
  const pages = chunk?.page_start ? `p. ${chunk.page_start}${chunk.page_end && chunk.page_end !== chunk.page_start ? `–${chunk.page_end}` : ''}` : null;
  return (
    <Drawer open onClose={onClose} title="Source passage">
      {err && <Notice tone="bad">{err}</Notice>}
      {!chunk && !err && <Spinner />}
      {chunk && (
        <div className="evidence-view">
          {target.title && <p className="ev-claim">{target.title}</p>}
          <p className="small">
            <strong>{chunk.paper_title}</strong>
            {chunk.doi && (
              <>
                {' '}
                ·{' '}
                <a href={`https://doi.org/${chunk.doi}`} target="_blank" rel="noreferrer">
                  doi:{chunk.doi}
                </a>
              </>
            )}
          </p>
          <p className="small muted">
            {[chunk.section, chunk.label, pages, `chunk ${chunk.seq + 1}`].filter(Boolean).join(' · ')}
            <br />
            {chunk.version_label}
          </p>
          {target.status && <Badge tone={target.status === 'supported' ? 'good' : target.status === 'unsupported' ? 'bad' : 'warn'}>{target.status.replace(/_/g, ' ')}</Badge>}
          {!loc && <Notice tone="warn">The quoted text could not be located exactly in this passage.</Notice>}
          <blockquote className="passage">
            {loc ? (
              <>
                {chunk.text.slice(0, loc[0])}
                <mark>{chunk.text.slice(loc[0], loc[1])}</mark>
                {chunk.text.slice(loc[1])}
              </>
            ) : (
              chunk.text
            )}
          </blockquote>
          <p className="hint">Paper text is shown exactly as retrieved and parsed. Tables from PDFs may lose their layout.</p>
        </div>
      )}
    </Drawer>
  );
}
