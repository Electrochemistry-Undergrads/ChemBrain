import { materialQuery } from '../../shared/material-query';
import { rateLimit } from '../auth/session';
import { json } from '../http/respond';
import { suggestMaterials } from '../search/materials';
import type { Route } from './router';

export const materialRoutes: Route[] = [{
  method: 'GET',
  path: '/api/materials/suggestions',
  handler: async ({ env, user, req, fetch }) => {
    const query = materialQuery(new URL(req.url).searchParams.get('q'));
    if (!query) return json({ suggestions: [], available: true, source: 'PubChem' });
    await rateLimit(env, `material-suggestions:${user.id}`, 60, 60);
    return json(await suggestMaterials(query, fetch));
  },
}];
