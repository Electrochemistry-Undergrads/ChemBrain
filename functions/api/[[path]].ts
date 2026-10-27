import { handleApi } from '../../server/api/router';
import type { Env } from '../../server/env';

// Cloudflare Pages Function: all /api/* requests are handled by the server router.
export const onRequest: PagesFunction<Env> = ({ request, env }) => handleApi(request, env);
