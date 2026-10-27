import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { materialQuery } from '../shared/material-query';
import { MaterialInput } from '../src/components/MaterialInput';
import { createMaterialSuggester } from '../server/search/materials';
import { Client, setupEnv } from './helpers';
import type { Env } from '../server/env';

// Fixture copied from PubChem's live autocomplete response for the user's example.
const compounds = ['Lithium manganese oxide (LiMn2O4)', 'Cobalt lithium manganese nickel oxide', 'Lithium manganese dioxide'];
const response = (names: unknown[] = compounds) => new Response(JSON.stringify({ status: { code: 0 }, dictionary_terms: { compound: names } }));

describe('material-name autocomplete', () => {
  it('limits lookups to short names while allowing formulas and free-form briefs in the editor', () => {
    expect(materialQuery('  Lithium  Manganese  ')).toBe('Lithium Manganese');
    expect(materialQuery('LiMn2O4')).toBe('LiMn2O4');
    expect(materialQuery('Li')).toBeNull();
    expect(materialQuery('A biodegradable film with low permeability\nand good flexibility')).toBeNull();
    expect(materialQuery('material '.repeat(12))).toBeNull();
    expect(materialQuery('https://example.com')).toBeNull();
    expect(materialQuery(null)).toBeNull();
  });

  it('returns named compounds from PubChem, deduplicates and caches equivalent lookups', async () => {
    const suggest = createMaterialSuggester();
    const upstream = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => response([...compounds, compounds[0].toUpperCase(), '<script>bad</script>', '', 42]));
    const result = await suggest('Lithium Manganese', upstream as typeof fetch);
    expect(result).toEqual({ suggestions: compounds, available: true, source: 'PubChem' });
    expect(upstream).toHaveBeenCalledTimes(1);
    expect(upstream.mock.calls[0][0]).toBe('https://pubchem.ncbi.nlm.nih.gov/rest/autocomplete/compound/Lithium%20Manganese/json?limit=6');
    const init = upstream.mock.calls[0][1] as RequestInit;
    expect(new Headers(init.headers).get('accept')).toBe('application/json');
    expect(new Headers(init.headers).has('authorization')).toBe(false);
    expect(new Headers(init.headers).has('cookie')).toBe(false);
    expect(await suggest('lithium manganese', upstream as typeof fetch)).toEqual(result);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('coalesces concurrent identical requests', async () => {
    const suggest = createMaterialSuggester();
    const upstream = vi.fn(async () => response());
    const results = await Promise.all([suggest('Titanium oxide', upstream as typeof fetch), suggest('TITANIUM OXIDE', upstream as typeof fetch)]);
    expect(results[0]).toEqual(results[1]);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('keeps autocomplete failure optional and does not cache temporary outages', async () => {
    const suggest = createMaterialSuggester();
    const upstream = vi.fn().mockResolvedValueOnce(new Response('maintenance', { status: 503 })).mockImplementation(async () => response([]));
    expect(await suggest('Graphene oxide', upstream as typeof fetch)).toEqual({ suggestions: [], available: false, source: 'PubChem' });
    expect(await suggest('Graphene oxide', upstream as typeof fetch)).toEqual({ suggestions: [], available: true, source: 'PubChem' });
    expect(upstream).toHaveBeenCalledTimes(2);
  });

  it('rejects an unexpected redirect without forwarding a lookup to another host', async () => {
    const suggest = createMaterialSuggester();
    const upstream = vi.fn(async () => new Response(null, { status: 302, headers: { location: 'https://unexpected.example/lookup' } }));
    expect((await suggest('Calcium phosphate', upstream as typeof fetch)).available).toBe(false);
    expect(upstream).toHaveBeenCalledTimes(1);
  });

  it('renders a blank labeled editor with combobox semantics and preserves arbitrary descriptions', () => {
    const html = renderToStaticMarkup(createElement(MaterialInput, { id: 'idea', value: 'An arbitrary material with processing constraints.', onChange: () => {} }));
    expect(html).not.toContain('placeholder=');
    expect(html).toContain('role="combobox"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('An arbitrary material with processing constraints.');
  });
});

let env: Env;
let dispose: () => Promise<void>;
beforeAll(async () => { ({ env, dispose } = await setupEnv({ MODEL_API_KEY: undefined })); });
afterAll(() => dispose());

describe('authenticated material suggestion API', () => {
  it('needs a workspace, ignores full briefs, and works without a model key', async () => {
    const upstream = vi.fn(async () => response());
    const c = new Client(env, upstream as typeof fetch);
    expect((await c.call('GET', '/api/materials/suggestions?q=Lithium')).status).toBe(401);
    await c.signup('autocomplete_user');
    const long = await c.call('GET', `/api/materials/suggestions?q=${encodeURIComponent('material '.repeat(20))}`);
    expect(long.data.suggestions).toEqual([]);
    expect(upstream).not.toHaveBeenCalled();
    const result = await c.call('GET', '/api/materials/suggestions?q=Lithium%20Manganese');
    expect(result.status).toBe(200);
    expect(result.data.suggestions[0]).toBe('Lithium manganese oxide (LiMn2O4)');
    expect(upstream).toHaveBeenCalledTimes(1);
  });
});
