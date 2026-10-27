export const nowIso = () => new Date().toISOString();

export function newId(prefix: string) {
  const b = crypto.getRandomValues(new Uint8Array(12));
  return `${prefix}_${[...b].map((x) => x.toString(16).padStart(2, '0')).join('')}`;
}

export function b64encode(bytes: ArrayBuffer | Uint8Array) {
  const u = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let s = '';
  for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode(...u.subarray(i, i + 0x8000));
  return btoa(s);
}

export function b64decode(s: string) {
  const bin = atob(s);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(data: string | ArrayBuffer | Uint8Array) {
  const buf = typeof data === 'string' ? new TextEncoder().encode(data) : new Uint8Array(data as ArrayBuffer);
  const h = await crypto.subtle.digest('SHA-256', buf);
  return [...new Uint8Array(h)].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export function timingSafeEqual(a: string, b: string) {
  if (a.length !== b.length) return false;
  let r = 0;
  for (let i = 0; i < a.length; i++) r |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return r === 0;
}

export function parseJson<T>(s: string | null | undefined, fallback: T): T {
  if (!s) return fallback;
  try {
    return JSON.parse(s) as T;
  } catch {
    return fallback;
  }
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Normalizes a DOI to lowercase without resolver prefixes. Returns null if it does not look like a DOI. */
export function normalizeDoi(input: string | null | undefined): string | null {
  if (!input) return null;
  let d = input.trim();
  d = d.replace(/^https?:\/\/(dx\.)?doi\.org\//i, '').replace(/^doi:\s*/i, '');
  d = d.toLowerCase();
  return /^10\.\d{4,9}\/\S+$/.test(d) ? d : null;
}
