import { NOTICE_LABEL, publicationDoiUrl, publicationMessage, type PublicationCheck } from '../../shared/publications';

/** Quiet for sources without reported issues; older reports have no checks to display. */
export function PublicationNotes({ checks }: { checks?: PublicationCheck[] }) {
  const rows = checks?.filter((c) => publicationMessage(c)) ?? [];
  if (!rows.length) return null;
  const excluded = rows.filter((c) => c.exclusion).length;
  const updated = rows.filter((c) => !c.exclusion && c.notices.length).length;
  const title = [excluded ? `${excluded} ${excluded === 1 ? 'source' : 'sources'} excluded` : '', updated ? `${updated} ${updated === 1 ? 'paper has updates' : 'papers have updates'}` : ''].filter(Boolean).join(' · ') || 'Some source updates could not be checked';
  return <details className="compact-details publication-notes">
    <summary>{title}</summary>
    <ul className="plain small">
      {rows.map((c) => <li key={c.paperId}>
        <strong>{c.title}</strong>
        <p>{publicationMessage(c)}</p>
        {c.notices.length > 0 && <ul className="plain">
          {c.notices.map((n, i) => <li key={i}>
            {n.doi ? <a href={publicationDoiUrl(n.doi)} target="_blank" rel="noreferrer">{NOTICE_LABEL[n.kind]} ↗</a> : NOTICE_LABEL[n.kind]}
            {n.date && ` · ${n.date}`}
          </li>)}
        </ul>}
      </li>)}
    </ul>
    <p className="hint">Crossref update records may be incomplete. {checks?.find((c) => c.checkedAt)?.checkedAt ? `Checked ${new Date(checks.find((c) => c.checkedAt)!.checkedAt!).toLocaleDateString()}.` : ''}</p>
  </details>;
}
