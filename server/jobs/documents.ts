import type { Env } from '../env';
import { config } from '../env';
import { chunkDocument } from '../parsing/chunk';
import { parseElsevierXml } from '../parsing/elsevier';
import { parseJats } from '../parsing/jats';
import { parsePdf } from '../parsing/pdf';
import { assessCompleteness, checkIdentity, sniffContent, type Completeness, type IdentityCheck } from '../parsing/quality';
import type { ParsedDocument } from '../parsing/types';
import { isOpenLicense } from '../connectors/publishers';
import { newId, nowIso, sha256Hex } from '../util';

export interface PaperRow {
  id: string;
  project_id: string;
  owner_id: string;
  doi: string | null;
  title: string;
  publisher: string | null;
  license: string | null;
  user_access: string;
}

export interface IngestResult {
  ok: boolean;
  documentId?: string;
  completeness?: Completeness;
  identity?: IdentityCheck;
  chunkCount?: number;
  reason: string;
  license?: string;
}

export async function parseBytes(bytes: Uint8Array, format: 'jats' | 'elsevier_xml' | 'pdf' | 'auto', contentType: string | null): Promise<ParsedDocument> {
  const sniff = sniffContent(bytes, contentType).kind;
  if (sniff === 'html') throw new Error('The file is an HTML page (often a login or paywall page), not an article.');
  if (sniff === 'json') throw new Error('The file is a JSON error response, not an article.');
  if (format === 'pdf' || (format === 'auto' && sniff === 'pdf')) {
    if (sniff !== 'pdf') throw new Error('Expected a PDF but the file is not one.');
    return parsePdf(bytes);
  }
  const text = new TextDecoder().decode(bytes);
  if (format === 'elsevier_xml' || (format === 'auto' && text.includes('full-text-retrieval-response'))) return parseElsevierXml(text);
  if (format === 'jats' || (format === 'auto' && /<article[\s>]/.test(text))) return parseJats(text);
  throw new Error('Unrecognised file format. Upload a PDF, JATS XML, or Elsevier full-text XML.');
}

/**
 * Validates and stores a retrieved document: identity check, completeness check, chunking. Files
 * that are not the requested article (wrong DOI, login pages, abstracts) are rejected here and
 * never counted as retrieved full text.
 */
export async function ingestDocument(
  env: Env,
  paper: PaperRow,
  bytes: Uint8Array,
  meta: { connector: string; format: 'jats' | 'elsevier_xml' | 'pdf' | 'auto'; contentType: string | null; versionLabel: string; license?: string },
): Promise<IngestResult> {
  let doc: ParsedDocument;
  try {
    doc = await parseBytes(bytes, meta.format, meta.contentType);
  } catch (e) {
    return { ok: false, reason: e instanceof Error ? e.message : 'The document could not be parsed.' };
  }
  const identity = checkIdentity(doc, { doi: paper.doi, title: paper.title });
  if (identity.verdict === 'mismatch') return { ok: false, identity, reason: `Rejected: ${identity.reason}` };
  const { completeness, hasMethods, reason } = assessCompleteness(doc);
  const chunks = chunkDocument(doc).filter((c) => c.kind !== 'references');
  const sha = await sha256Hex(bytes);
  const documentId = newId('doc');
  const license = meta.license || doc.license || paper.license || undefined;

  let storageKey: string | null = null;
  if (env.DOCS && config(env).retainOriginals) {
    // Private, per-owner key. Never shared between users even for the same DOI.
    storageKey = `${paper.owner_id}/${paper.project_id}/${documentId}`;
    await env.DOCS.put(storageKey, bytes, { httpMetadata: { contentType: meta.contentType ?? 'application/octet-stream' } });
  }

  const stmts: D1PreparedStatement[] = [
    // Replace any earlier document for this paper (e.g. a re-upload).
    env.DB.prepare('DELETE FROM documents WHERE paper_id = ? AND owner_id = ?').bind(paper.id, paper.owner_id),
    env.DB.prepare(
      `INSERT INTO documents (id, paper_id, project_id, owner_id, connector, format, content_sha256, version_label, license, completeness,
        identity_json, page_count, char_count, section_count, has_methods, supplementary_json, parse_notes, storage_key, retrieved_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      documentId, paper.id, paper.project_id, paper.owner_id, meta.connector, doc.format, sha, meta.versionLabel, license ?? null, completeness,
      JSON.stringify(identity), doc.pageCount ?? null, chunks.reduce((a, c) => a + c.text.length, 0), new Set(doc.sections.map((s) => s.heading)).size,
      hasMethods ? 1 : 0, JSON.stringify(doc.supplementary), [reason, ...doc.notes].join(' '), storageKey, nowIso(),
    ),
  ];
  for (const c of chunks) {
    stmts.push(
      env.DB.prepare(
        'INSERT INTO chunks (id, document_id, paper_id, project_id, owner_id, seq, section, kind, label, page_start, page_end, text) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      ).bind(newId('chk'), documentId, paper.id, paper.project_id, paper.owner_id, c.seq, c.section, c.kind, c.label ?? null, c.pageStart ?? null, c.pageEnd ?? null, c.text),
    );
  }
  await env.DB.batch(stmts);
  return { ok: true, documentId, completeness, identity, chunkCount: chunks.length, reason, license };
}

export function retrievalStatusFor(c: Completeness) {
  return c === 'complete' || c === 'partial' ? 'full_text_retrieved' : c === 'abstract_only' ? 'abstract_only' : 'full_text_retrieved';
}

export function parseStatusFor(c: Completeness) {
  return c === 'complete' ? 'parsed' : c === 'unreadable' ? 'unreadable' : 'parsing_incomplete';
}

export function aiPermissionFor(license: string | null | undefined, attested: boolean) {
  if (isOpenLicense(license)) return 'open_license';
  return attested ? 'user_attested' : 'not_confirmed';
}
