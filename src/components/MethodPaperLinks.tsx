import { paperHref, paperJournal, type ReportPaper } from '../../shared/papers';

export function MethodPaperLinks({ papers }: { papers: ReportPaper[] }) {
  if (!papers.length) return null;
  return <div className="method-paper-links">
    {papers.map((paper) => {
      const href = paperHref(paper);
      const journal = paperJournal(paper);
      return href ? <a key={paper.id} href={href} title={paper.title} aria-label={`Read ${paper.title} — ${journal}`} target="_blank" rel="noreferrer">{journal} ↗</a>
        : <span key={paper.id} title={paper.title}>{journal}</span>;
    })}
  </div>;
}
