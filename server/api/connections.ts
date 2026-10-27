import { loadConnectorContext, PROVIDERS, testConnection } from '../connectors';
import type { ConnectionSettings, Provider } from '../connectors/types';
import { decryptSecret, encryptSecret, redact } from '../crypto/secrets';
import { ApiError, json } from '../http/respond';
import { newId, nowIso, parseJson } from '../util';
import type { Route } from './router';

/** Secret fields accepted per provider. Values are encrypted at rest and never returned to the browser. */
const FIELDS: Record<Provider, { key: string; required: boolean }[]> = {
  elsevier: [
    { key: 'apiKey', required: true },
    { key: 'instToken', required: false },
  ],
  wiley: [{ key: 'tdmToken', required: true }],
  springer: ['apiKey', 'metaApiKey', 'openAccessApiKey', 'fullTextApiKey'].map((key) => ({ key, required: false })),
};

function asProvider(p: string): Provider {
  if (!(PROVIDERS as string[]).includes(p)) throw new ApiError(404, 'not_found', 'Unknown publisher.');
  return p as Provider;
}

export const connectionRoutes: Route[] = [
  {
    method: 'GET',
    path: '/api/connections',
    handler: async ({ env, user }) => {
      const { results } = await env.DB.prepare('SELECT provider, secret_ciphertext IS NOT NULL AS has_secret, settings_json, last_test_at, last_test_json, updated_at FROM connections WHERE owner_id = ?')
        .bind(user.id)
        .all<{ provider: Provider; has_secret: number; settings_json: string; last_test_at: string | null; last_test_json: string | null; updated_at: string }>();
      const byProvider = Object.fromEntries(results.map((r) => [r.provider, r]));
      return json({
        encryptionConfigured: Boolean(env.CREDENTIALS_KEY),
        connections: PROVIDERS.map((p) => {
          const r = byProvider[p];
          return {
            provider: p,
            configured: Boolean(r?.has_secret),
            settings: parseJson<ConnectionSettings>(r?.settings_json, {}),
            savedFields: r ? parseJson<{ savedFields?: string[] }>(r.settings_json, {}).savedFields ?? [] : [],
            lastTestAt: r?.last_test_at ?? null,
            lastTest: parseJson(r?.last_test_json, null),
            updatedAt: r?.updated_at ?? null,
          };
        }),
      });
    },
  },
  {
    method: 'PUT',
    path: '/api/connections/:provider',
    handler: async ({ env, user, params, body }) => {
      const provider = asProvider(params.provider);
      if (!env.CREDENTIALS_KEY) throw new ApiError(503, 'no_encryption', 'Credential storage is not configured on this server (CREDENTIALS_KEY is missing), so credentials cannot be saved securely.');
      const b = await body<{ secrets?: Record<string, string>; settings?: ConnectionSettings }>();
      const existing = await env.DB.prepare('SELECT id, settings_json, secret_ciphertext, secret_iv FROM connections WHERE owner_id = ? AND provider = ?').bind(user.id, provider).first<{ id: string; settings_json: string; secret_ciphertext: string | null; secret_iv: string | null }>();
      const prevSettings = parseJson<ConnectionSettings & { savedFields?: string[] }>(existing?.settings_json, {});
      const settings: ConnectionSettings & { savedFields?: string[] } = {
        ...prevSettings,
        aiProcessingAttested: b.settings?.aiProcessingAttested ?? prevSettings.aiProcessingAttested ?? false,
        ...(provider === 'springer' ? { fullTextAgreement: b.settings?.fullTextAgreement ?? prevSettings.fullTextAgreement ?? false } : {}),
      };
      let cipher: { ciphertext: string; iv: string } | null = null;
      if (b.secrets) {
        const clean: Record<string, string> = {};
        if (existing?.secret_ciphertext && existing.secret_iv) {
          try {
            Object.assign(clean, JSON.parse(await decryptSecret(env.CREDENTIALS_KEY, user.id, provider, existing.secret_ciphertext, existing.secret_iv)));
          } catch {
            throw new ApiError(409, 'credentials_unreadable', 'The saved credentials can no longer be decrypted. Remove this connection and enter the credentials again.');
          }
        }
        for (const f of FIELDS[provider]) {
          const input = b.secrets[f.key];
          if (input !== undefined && typeof input !== 'string') throw new ApiError(400, 'bad_field', 'Credentials must be text.');
          const v = (input ?? '').trim();
          if (v.length > 500 || /\s/.test(v)) throw new ApiError(400, 'bad_field', 'Credentials cannot contain spaces and must be under 500 characters.');
          // Empty password inputs mean "keep saved", including optional institutional tokens.
          if (v) clean[f.key] = v;
        }
        if (FIELDS[provider].some((f) => f.required && !clean[f.key]) || !Object.keys(clean).length) {
          throw new ApiError(400, 'missing_field', 'Fill in at least one required credential.');
        }
        cipher = await encryptSecret(env.CREDENTIALS_KEY, user.id, provider, JSON.stringify(clean));
        settings.savedFields = Object.keys(clean);
      } else if (!existing?.secret_ciphertext) {
        throw new ApiError(400, 'missing_field', 'Enter your credentials.');
      }
      const now = nowIso();
      if (existing) {
        await env.DB.prepare(
          `UPDATE connections SET settings_json = ?, updated_at = ?, last_test_at = NULL, last_test_json = NULL${cipher ? ', secret_ciphertext = ?, secret_iv = ?' : ''} WHERE id = ? AND owner_id = ?`,
        )
          .bind(...[JSON.stringify(settings), now, ...(cipher ? [cipher.ciphertext, cipher.iv] : []), existing.id, user.id])
          .run();
      } else {
        await env.DB.prepare('INSERT INTO connections (id, owner_id, provider, secret_ciphertext, secret_iv, settings_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
          .bind(newId('con'), user.id, provider, cipher!.ciphertext, cipher!.iv, JSON.stringify(settings), now, now)
          .run();
      }
      return json({ ok: true });
    },
  },
  {
    method: 'POST',
    path: '/api/connections/:provider/test',
    handler: async ({ env, user, params, fetch }) => {
      const provider = asProvider(params.provider);
      const ctx = await loadConnectorContext(env, user.id, fetch);
      const secrets = Object.values((ctx.creds as Record<string, Record<string, string>>)[provider] ?? {});
      let checks = await testConnection(ctx, provider);
      // Defensive: upstream messages must never echo the user's credentials back.
      checks = checks.map((c) => ({ ...c, message: redact(c.message, secrets) }));
      const result = { ok: checks.some((c) => c.status === 'pass') && checks.every((c) => c.status !== 'fail'), checks, testedAt: nowIso(), live: true };
      await env.DB.prepare('UPDATE connections SET last_test_at = ?, last_test_json = ? WHERE owner_id = ? AND provider = ?').bind(result.testedAt, JSON.stringify(result), user.id, provider).run();
      return json(result);
    },
  },
  {
    method: 'DELETE',
    path: '/api/connections/:provider',
    handler: async ({ env, user, params }) => {
      const provider = asProvider(params.provider);
      // Revocation: the encrypted credential is deleted outright.
      await env.DB.prepare('DELETE FROM connections WHERE owner_id = ? AND provider = ?').bind(user.id, provider).run();
      return json({ ok: true });
    },
  },
];
