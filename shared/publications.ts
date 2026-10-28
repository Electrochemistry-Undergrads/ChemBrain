/** A metadata check reports known updates, not a guarantee of a paper's reliability. */
export interface PublicationNotice {
  kind: 'retraction' | 'withdrawal' | 'concern' | 'correction' | 'reinstatement' | 'update';
  doi: string | null;
  date: string | null;
}

export interface PublicationCheck {
  paperId: string;
  title: string;
  doi: string | null;
  status: 'checked' | 'unavailable' | 'no_doi' | 'not_checked';
  checkedAt: string | null;
  notices: PublicationNotice[];
  exclusion: 'retracted' | 'withdrawn' | 'notice' | 'review_required' | null;
}

export const NOTICE_LABEL: Record<PublicationNotice['kind'], string> = {
  retraction: 'Retraction', withdrawal: 'Withdrawal', concern: 'Expression of concern',
  correction: 'Correction', reinstatement: 'Reinstatement', update: 'Publication update',
};

export function publicationMessage(check: PublicationCheck) {
  if (check.exclusion === 'review_required') return 'Retraction and reinstatement notices require review. Source excluded from the analysis.';
  if (check.exclusion === 'retracted') return 'Retracted paper excluded from the analysis.';
  if (check.exclusion === 'withdrawn') return 'Withdrawn paper excluded from the analysis.';
  if (check.exclusion === 'notice') return 'Update notice excluded as experimental evidence.';
  if (check.notices.some((n) => n.kind === 'concern')) return 'An expression of concern affects this paper. Review the notice before relying on its findings.';
  if (check.notices.length) return 'This paper has a publication update. Review the notice alongside its findings.';
  if (check.status === 'no_doi') return 'No DOI available to check publication updates.';
  if (check.status === 'not_checked') return 'Publication updates were not checked for this source.';
  if (check.status === 'unavailable') return 'Publication updates could not be checked.';
  return '';
}

export function publicationDoiUrl(doi: string) {
  return `https://doi.org/${encodeURIComponent(doi).replace(/[()]/g, (c) => c === '(' ? '%28' : '%29')}`;
}
