import { b64decode, b64encode, timingSafeEqual } from '../util';

/** PBKDF2-SHA256. The Workers runtime caps iterations at 100,000. */
export async function hashPassword(password: string, iterations: number, saltB64?: string) {
  const salt = saltB64 ? b64decode(saltB64) : crypto.getRandomValues(new Uint8Array(16));
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt, iterations }, key, 256);
  return { hash: b64encode(bits), salt: b64encode(salt), iterations };
}

export async function verifyPassword(password: string, stored: { hash: string; salt: string; iterations: number }) {
  const { hash } = await hashPassword(password, stored.iterations, stored.salt);
  return timingSafeEqual(hash, stored.hash);
}

export function validateNewPassword(pw: string): string | null {
  if (pw.length < 10) return 'Use at least 10 characters.';
  if (pw.length > 200) return 'Use at most 200 characters.';
  return null;
}

export function validateUsername(u: string): string | null {
  if (!/^[a-zA-Z0-9_.-]{3,32}$/.test(u)) return 'Usernames are 3–32 letters, digits, dots, dashes, or underscores.';
  if (u.includes('@')) return 'Please choose a username rather than an email address.';
  return null;
}
