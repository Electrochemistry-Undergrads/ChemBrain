import { b64decode, b64encode } from '../util';

/**
 * Publisher credentials are encrypted with AES-256-GCM. The key is derived per user with HKDF
 * from the CREDENTIALS_KEY secret, and the user id plus provider are bound as associated data,
 * so a ciphertext copied to another row or user fails to decrypt.
 */
async function deriveKey(master: string, userId: string) {
  const raw = b64decode(master);
  if (raw.length < 32) throw new Error('CREDENTIALS_KEY must be at least 32 bytes (base64).');
  const base = await crypto.subtle.importKey('raw', raw, 'HKDF', false, ['deriveKey']);
  return crypto.subtle.deriveKey(
    { name: 'HKDF', hash: 'SHA-256', salt: new TextEncoder().encode('chembrain-credentials-v1'), info: new TextEncoder().encode(userId) },
    base,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt'],
  );
}

export async function encryptSecret(master: string, userId: string, provider: string, plaintext: string) {
  const key = await deriveKey(master, userId);
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv, additionalData: new TextEncoder().encode(`${userId}:${provider}`) },
    key,
    new TextEncoder().encode(plaintext),
  );
  return { ciphertext: b64encode(ct), iv: b64encode(iv) };
}

export async function decryptSecret(master: string, userId: string, provider: string, ciphertext: string, iv: string) {
  const key = await deriveKey(master, userId);
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: b64decode(iv), additionalData: new TextEncoder().encode(`${userId}:${provider}`) },
    key,
    b64decode(ciphertext),
  );
  return new TextDecoder().decode(pt);
}

/** Replaces any occurrence of known secret values in text destined for logs, errors, or exports. */
export function redact(text: string, secrets: (string | undefined | null)[]) {
  let out = text;
  for (const s of secrets) {
    if (s && s.length >= 6) out = out.split(s).join('[redacted]');
  }
  // Common credential shapes, in case an upstream echoes a key we did not know about.
  return out
    .replace(/(api[_-]?key|apikey|insttoken|authtoken|token|authorization)(["'\s:=]+)(Bearer\s+)?[A-Za-z0-9._\-]{12,}/gi, '$1$2[redacted]')
    .replace(/LLM_\d+[A-Za-z0-9_\-]{8,}/g, '[redacted]');
}
