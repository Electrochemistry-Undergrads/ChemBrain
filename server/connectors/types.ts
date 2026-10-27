import type { Env } from '../env';

export type Provider = 'elsevier' | 'wiley' | 'springer';

export interface Credentials {
  elsevier?: { apiKey: string; instToken?: string };
  wiley?: { tdmToken: string };
  springer?: { apiKey?: string; metaApiKey?: string; openAccessApiKey?: string; fullTextApiKey?: string };
}

export interface ConnectionSettings {
  /** User attests their licence/agreement permits sending this publisher's content to Meta for analysis. */
  aiProcessingAttested?: boolean;
  /** Springer Nature only: user states they hold an approved full-text (TDM) agreement. */
  fullTextAgreement?: boolean;
}

export interface ConnectorContext {
  env: Env;
  userId: string;
  creds: Credentials;
  settings: Partial<Record<Provider, ConnectionSettings>>;
  fetch: typeof fetch;
}

export type RetrievalStatus =
  | 'full_text'
  | 'abstract_only'
  | 'not_entitled'
  | 'institutional_connection_required'
  | 'credentials_missing'
  | 'credentials_invalid'
  | 'agreement_required'
  | 'not_found'
  | 'rate_limited'
  | 'not_applicable'
  | 'failed';

export interface RetrievedFile {
  bytes: Uint8Array;
  contentType: string;
  format: 'jats' | 'elsevier_xml' | 'pdf';
  versionLabel: string;
  license?: string;
}

export interface RetrievalAttempt {
  connector: string;
  status: RetrievalStatus;
  reason: string;
  /** Entitlement as reported by the publisher, independent of whether retrieval worked. */
  entitlement?: 'entitled' | 'not_entitled' | 'open_access' | 'unknown';
  retryAfterMs?: number;
  file?: RetrievedFile;
}

export interface PaperRef {
  doi: string | null;
  title: string;
  publisher: string | null;
}

export interface TestCheck {
  name: string;
  status: 'pass' | 'fail' | 'warn' | 'skipped';
  message: string;
}

export interface Candidate {
  doi: string | null;
  title: string;
  authors: string | null;
  year: number | null;
  venue: string | null;
  publisher: string | null;
  abstract: string | null;
  landingUrl: string | null;
  license: string | null;
  source: string;
}
