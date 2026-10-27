import { config } from '../env';
import { json } from '../http/respond';
import { checkModel, metaConfigured, tokensToday } from '../meta/client';
import type { Route } from './router';

export const systemRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/health',
    public: true,
    handler: async ({ env, req }) => {
      let build: unknown = null;
      try {
        const r = await env.ASSETS?.fetch(new URL('/build-info.json', req.url));
        if (r?.ok) build = await r.json();
      } catch {
        /* build info is optional in local dev */
      }
      let db = false;
      try {
        db = Boolean(await env.DB.prepare('SELECT 1 AS ok').first());
      } catch {
        db = false;
      }
      // Only booleans and the public commit id: never secret values or account identifiers.
      return json({
        ok: db,
        build,
        services: {
          database: db,
          documentStorage: Boolean(env.DOCS),
          metaConfigured: metaConfigured(env),
          credentialEncryption: Boolean(env.CREDENTIALS_KEY),
        },
        metaModel: config(env).metaModel,
      });
    },
  },
  {
    method: 'GET',
    path: '/api/meta/status',
    handler: async ({ env, user, fetch }) => {
      const status = await checkModel(env, fetch);
      const cfg = config(env);
      return json({ ...status, usedToday: await tokensToday(env, user.id), dailyBudget: cfg.dailyTokenBudget, jobBudget: cfg.jobTokenBudget });
    },
  },
];
