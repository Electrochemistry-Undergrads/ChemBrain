import { redact } from '../crypto/secrets';

/** Errors carry a user-facing message that is safe to show; internals stay in `cause`. */
export class ApiError extends Error {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

export const notFound = () => new ApiError(404, 'not_found', 'Not found.');
export const badRequest = (msg: string) => new ApiError(400, 'bad_request', msg);

export function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers },
  });
}

export function errorResponse(err: unknown) {
  if (err instanceof ApiError) return json({ error: { code: err.code, message: err.message } }, err.status);
  // Never echo internal error text to the client: it may contain upstream bodies or configuration.
  // The server log gets a truncated, credential-redacted message for debugging.
  console.error('unhandled', err instanceof Error ? `${err.name}: ${redact(err.message, []).slice(0, 300)}` : typeof err);
  return json({ error: { code: 'internal', message: 'Something went wrong on the server. Please try again.' } }, 500);
}
