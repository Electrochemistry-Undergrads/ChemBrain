import { api } from './api';

// The key lives only in this tab's memory. Never read it back from server-side storage,
// put it in a URL, persist it in browser storage, or include it in an upload.
let apiKey = '';
let state: Readonly<{ enabled: boolean; aiProcessingAttested: boolean }> = Object.freeze({ enabled: false, aiProcessingAttested: false });
const listeners = new Set<() => void>();

export const browserElsevierState = () => state;
export const subscribeBrowserElsevier = (listener: () => void) => {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
};

export function configureBrowserElsevier(key: string, aiProcessingAttested: boolean) {
  const clean = key.trim();
  if (!clean || clean.length > 500 || /\s/.test(clean)) throw new Error('Enter an Elsevier API key without spaces.');
  apiKey = clean;
  state = Object.freeze({ enabled: true, aiProcessingAttested });
  listeners.forEach((listener) => listener());
}

export function forgetBrowserElsevier() {
  apiKey = '';
  state = Object.freeze({ enabled: false, aiProcessingAttested: false });
  listeners.forEach((listener) => listener());
}

export function attestBrowserElsevier(aiProcessingAttested: boolean) {
  if (!state.enabled) return;
  state = Object.freeze({ enabled: true, aiProcessingAttested });
  listeners.forEach((listener) => listener());
}

export async function importBrowserElsevierPaper(projectId: string, paperId: string, doi: string) {
  const xml = await retrieveElsevierInBrowser(doi);
  const form = new FormData();
  form.set('file', xml, 'Elsevier-browser-article.xml');
  form.set('canRead', 'true'); // The researcher requested retrieval through their own API access.
  form.set('aiPermitted', String(state.aiProcessingAttested));
  return api<{ completeness: string }>(`/api/projects/${projectId}/papers/${paperId}/upload`, { form });
}

/** A browser CORS request uses the researcher's network, not the Cloudflare server's IP. */
export async function retrieveElsevierInBrowser(doi: string, fetchImpl: typeof fetch = fetch): Promise<Blob> {
  if (!apiKey) throw new Error('Enter your key under Elsevier from this browser first.');
  if (!/^10\.\d{4,9}\/\S+$/i.test(doi)) throw new Error('A valid article DOI is required.');
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 30_000);
  try {
    const path = doi.split('/').map(encodeURIComponent).join('/');
    const res = await fetchImpl(`https://api.elsevier.com/content/article/doi/${path}?view=FULL`, {
      headers: { 'X-ELS-APIKey': apiKey, accept: 'text/xml' },
      mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer', signal: controller.signal,
    });
    if (!res.ok) {
      await res.body?.cancel();
      throw new Error(res.status === 401 || res.status === 403
        ? `Elsevier did not authorize this article from your browser (HTTP ${res.status}). Check the key's ScienceDirect permissions and your campus or institutional VPN access.`
        : `Elsevier returned HTTP ${res.status} to your browser. Try again later.`);
    }
    const reader = res.body?.getReader();
    if (!reader) throw new Error('Elsevier returned an empty document.');
    const parts: Uint8Array[] = [];
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      total += value.byteLength;
      if (total > 20_000_000) {
        await reader.cancel();
        throw new Error('The article exceeds the 20 MB browser retrieval limit.');
      }
      parts.push(value);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const part of parts) { bytes.set(part, offset); offset += part.byteLength; }
    const xml = new TextDecoder().decode(bytes);
    const hasBody = /<(?:\w+:)?sections[\s>]/.test(xml) || /<(?:\w+:)?rawtext[\s>][\s\S]{2000,}/.test(xml);
    if (!/<full-text-retrieval-response[\s>]/.test(xml) || !/<originalText[\s>]/.test(xml) || !hasBody) {
      throw new Error('Elsevier returned metadata or an error page instead of full-text XML. This article may not be accessible through your key.');
    }
    return new Blob([bytes.buffer], { type: 'text/xml' });
  } catch (e) {
    // Do not surface raw fetch errors or upstream bodies, which could echo credentials.
    if (controller.signal.aborted) throw new Error('Elsevier browser retrieval timed out after 30 seconds.');
    if (e instanceof TypeError) throw new Error('The browser could not reach Elsevier. Add this website’s origin to the key’s CORS Domains and check your network access.');
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
