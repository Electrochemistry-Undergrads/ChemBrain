import type { Env } from '../env';
import { requireLink, type LinkGrant } from '../auth/link';
import { checkCsrf, requireUser, type AuthUser } from '../auth/session';
import { ApiError, errorResponse, json, notFound } from '../http/respond';
import { authRoutes } from './auth';
import { connectionRoutes } from './connections';
import { jobRoutes } from './jobs';
import { linkRoutes } from './link';
import { paperRoutes } from './papers';
import { projectRoutes } from './projects';
import { reportRoutes } from './reports';
import { systemRoutes } from './system';
import { materialRoutes } from './materials';

export interface Ctx {
  env: Env;
  req: Request;
  params: Record<string, string>;
  user: AuthUser;
  /** Set on link routes: the project the link code may upload into. */
  link?: LinkGrant;
  fetch: typeof fetch;
  body<T = Record<string, unknown>>(): Promise<T>;
}

export interface Route {
  method: string;
  path: string;
  /** Public routes skip authentication. Everything else requires a signed-in user. */
  public?: boolean;
  /** Link routes are called by paperfetch with a project link code instead of a session. */
  link?: boolean;
  handler: (c: Ctx) => Promise<Response>;
}

const ROUTES: Route[] = [...systemRoutes, ...authRoutes, ...materialRoutes, ...projectRoutes, ...paperRoutes, ...linkRoutes, ...connectionRoutes, ...jobRoutes, ...reportRoutes];

const compiled = ROUTES.map((r) => ({
  ...r,
  re: new RegExp('^' + r.path.replace(/:([a-zA-Z]+)/g, '(?<$1>[A-Za-z0-9_.-]+)') + '$'),
}));

const MAX_JSON = 200_000;

export async function handleApi(req: Request, env: Env, fetchImpl: typeof fetch = fetch): Promise<Response> {
  try {
    const url = new URL(req.url);
    const path = url.pathname.replace(/\/+$/, '') || '/';
    let methodMismatch = false;
    for (const r of compiled) {
      const m = r.re.exec(path);
      if (!m) continue;
      if (r.method !== req.method) {
        methodMismatch = true;
        continue;
      }
      // Link routes carry a bearer code that browsers never attach on their own, so the
      // cookie-based CSRF check doesn't apply to them.
      const link = r.link ? await requireLink(env, req) : undefined;
      if (!link) checkCsrf(req);
      const user = link ? { id: link.ownerId, username: '' } : r.public ? ({ id: '', username: '' } as AuthUser) : await requireUser(env, req);
      let parsed: unknown;
      const ctx: Ctx = {
        env,
        req,
        params: { ...(m.groups ?? {}) },
        user,
        link,
        fetch: fetchImpl,
        async body<T>() {
          if (parsed !== undefined) return parsed as T;
          const text = await req.text();
          if (text.length > MAX_JSON) throw new ApiError(413, 'too_large', 'Request body is too large.');
          try {
            parsed = text ? JSON.parse(text) : {};
          } catch {
            throw new ApiError(400, 'bad_json', 'Request body must be JSON.');
          }
          return parsed as T;
        },
      };
      return await r.handler(ctx);
    }
    if (methodMismatch) return json({ error: { code: 'method_not_allowed', message: 'Method not allowed.' } }, 405);
    throw notFound();
  } catch (e) {
    return errorResponse(e);
  }
}
