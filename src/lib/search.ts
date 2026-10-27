import { api } from './api';

export type SearchStage = 'planning' | 'searching' | 'ranking';

export const STAGE_TEXT: Record<SearchStage, string> = {
  planning: 'Preparing search…',
  searching: 'Finding papers…',
  ranking: 'Sorting matches…',
};

/** One-click search: plan queries from the description, discover papers, then rank them if Meta is available. */
export async function runSearch(projectId: string, onStage: (s: SearchStage) => void) {
  onStage('planning');
  const { plan } = await api<{ plan: { method: string } }>(`/api/projects/${projectId}/plan`, { method: 'POST' });
  onStage('searching');
  const found = await api<{ added: number; totalCandidates: number; sourceErrors: string[] }>(`/api/projects/${projectId}/discover`, { method: 'POST' });
  if (plan.method === 'meta' && found.added > 0) {
    onStage('ranking');
    await api(`/api/projects/${projectId}/screen`, { method: 'POST' }).catch(() => undefined); // keyword ranking remains if this fails
  }
  return found;
}
