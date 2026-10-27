import { afterEach, describe, expect, it, vi } from 'vitest';
import { attestBrowserElsevier, browserElsevierState, configureBrowserElsevier, forgetBrowserElsevier, importBrowserElsevierPaper, retrieveElsevierInBrowser, subscribeBrowserElsevier } from '../src/lib/elsevier-browser';

// Labelled fixtures. Real CORS enforcement is verified separately in a browser on the live origin.
const xml = '<full-text-retrieval-response><originalText><ce:sections><ce:section>Methods and results</ce:section></ce:sections></originalText></full-text-retrieval-response>';
const key = 'browser-test-key-not-real';
afterEach(() => { forgetBrowserElsevier(); vi.useRealTimers(); vi.unstubAllGlobals(); });

describe('Elsevier browser retrieval', () => {
  it('imports only article XML and explicit AI permission, never the browser credential', async () => {
    configureBrowserElsevier(key, false);
    const requests: { url: string; init: RequestInit }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (input: string, init: RequestInit) => {
      requests.push({ url: input, init });
      return input.startsWith('https://api.elsevier.com') ? new Response(xml) : Response.json({ completeness: 'complete' });
    }));
    expect((await importBrowserElsevierPaper('project1', 'paper1', '10.1016/a')).completeness).toBe('complete');
    const upload = requests[1];
    expect(upload.url).toBe('/api/projects/project1/papers/paper1/upload');
    expect(upload.init.credentials).toBe('same-origin');
    expect(new Headers(upload.init.headers).has('x-els-apikey')).toBe(false);
    const form = upload.init.body as FormData;
    expect([...form.keys()]).toEqual(['file', 'canRead', 'aiPermitted']);
    expect(form.get('aiPermitted')).toBe('false');
    expect(await (form.get('file') as File).text()).toBe(xml);
    attestBrowserElsevier(true);
    await importBrowserElsevierPaper('project1', 'paper2', '10.1016/b');
    expect((requests[3].init.body as FormData).get('aiPermitted')).toBe('true');
  });
  it('keeps secrets out of observable state and clears the tab connection', () => {
    const listener = vi.fn();
    const unsubscribe = subscribeBrowserElsevier(listener);
    configureBrowserElsevier(key, false);
    expect(browserElsevierState()).toEqual({ enabled: true, aiProcessingAttested: false });
    expect(JSON.stringify(browserElsevierState())).not.toContain(key);
    attestBrowserElsevier(true);
    expect(browserElsevierState().aiProcessingAttested).toBe(true);
    forgetBrowserElsevier();
    expect(browserElsevierState()).toEqual({ enabled: false, aiProcessingAttested: false });
    expect(listener).toHaveBeenCalledTimes(3);
    unsubscribe();
  });
  it('uses a fixed HTTPS publisher endpoint with CORS, no cookies, and no key in the URL', async () => {
    configureBrowserElsevier(key, false);
    const f = vi.fn(async () => new Response(xml)) as unknown as typeof fetch;
    const result = await retrieveElsevierInBrowser('10.1016/a?target=https://other.invalid/#x', f);
    expect(await result.text()).toBe(xml);
    const [input, init] = vi.mocked(f).mock.calls[0];
    const url = new URL(String(input));
    expect(url.origin).toBe('https://api.elsevier.com');
    expect(url.search).toBe('?view=FULL');
    expect(url.toString()).not.toContain(key);
    expect(new Headers(init!.headers).get('x-els-apikey')).toBe(key);
    expect(new Headers(init!.headers).has('x-els-insttoken')).toBe(false);
    expect(init).toMatchObject({ mode: 'cors', credentials: 'omit', redirect: 'error', referrerPolicy: 'no-referrer' });
  });
  it('makes no request with missing credentials or a URL instead of a DOI', async () => {
    const f = vi.fn() as unknown as typeof fetch;
    await expect(retrieveElsevierInBrowser('10.1016/a', f)).rejects.toThrow(/Enter your key/);
    configureBrowserElsevier(key, false);
    await expect(retrieveElsevierInBrowser('https://other.invalid/', f)).rejects.toThrow(/valid article DOI/);
    expect(f).not.toHaveBeenCalled();
  });
  it('rejects metadata, HTML, and an abstract-only originalText', async () => {
    configureBrowserElsevier(key, false);
    for (const body of ['<full-text-retrieval-response><coredata/></full-text-retrieval-response>', '<html>Login</html>', '<full-text-retrieval-response><originalText><abstract>Summary only</abstract></originalText></full-text-retrieval-response>']) {
      await expect(retrieveElsevierInBrowser('10.1016/a', (async () => new Response(body)) as typeof fetch)).rejects.toThrow(/instead of full-text/);
    }
  });
  it('reports access and CORS failures without echoing upstream bodies or secrets', async () => {
    configureBrowserElsevier(key, false);
    const error = await retrieveElsevierInBrowser('10.1016/a', (async () => new Response(key, { status: 403 })) as typeof fetch).catch(e => e);
    expect(error.message).toMatch(/HTTP 403/);
    expect(error.message).not.toContain(key);
    const network = await retrieveElsevierInBrowser('10.1016/a', (async () => { throw new TypeError(key); }) as typeof fetch).catch(e => e);
    expect(network.message).toMatch(/CORS Domains/);
    expect(network.message).not.toContain(key);
  });
  it('caps article bytes before building an upload', async () => {
    configureBrowserElsevier(key, false);
    const stream = new ReadableStream<Uint8Array>({ start(controller) { controller.enqueue(new Uint8Array(20_000_001)); controller.close(); } });
    await expect(retrieveElsevierInBrowser('10.1016/a', (async () => new Response(stream)) as typeof fetch)).rejects.toThrow(/20 MB/);
  });
  it('aborts a stalled request after 30 seconds', async () => {
    vi.useFakeTimers();
    configureBrowserElsevier(key, false);
    const f = ((_url: RequestInfo | URL, init: RequestInit) => new Promise<Response>((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new Error('aborted'))))) as typeof fetch;
    const result = expect(retrieveElsevierInBrowser('10.1016/a', f)).rejects.toThrow(/timed out/);
    await vi.advanceTimersByTimeAsync(30_000);
    await result;
  });
});
