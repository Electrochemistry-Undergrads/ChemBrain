import type { Provider } from './types';

/** DOI prefixes registered to each publisher (Crossref member prefixes, primary ones only). */
const PREFIXES: Record<Provider, string[]> = {
  elsevier: ['10.1016', '10.1006', '10.1053', '10.1067', '10.1078', '10.1205', '10.3182'],
  wiley: ['10.1002', '10.1111', '10.1046', '10.1113', '10.1034'],
  springer: ['10.1007', '10.1038', '10.1186', '10.1057', '10.1140', '10.1365', '10.1245'],
};

export function publisherOf(doi: string | null, publisherName?: string | null): Provider | null {
  if (doi) {
    const prefix = doi.split('/')[0];
    for (const [p, list] of Object.entries(PREFIXES) as [Provider, string[]][]) if (list.includes(prefix)) return p;
  }
  const n = (publisherName || '').toLowerCase();
  if (n.includes('elsevier')) return 'elsevier';
  if (n.includes('wiley')) return 'wiley';
  if (n.includes('springer') || n.includes('nature')) return 'springer';
  return null;
}

export const PROVIDER_LABEL: Record<Provider, string> = {
  elsevier: 'Elsevier (ScienceDirect)',
  wiley: 'Wiley',
  springer: 'Springer Nature',
};

const OPEN = /creativecommons\.org\/(licenses\/(by|by-sa|by-nc|by-nc-sa|by-nd|by-nc-nd)\/|publicdomain\/zero)|\bcc[- ]by\b|\bcc0\b|creative commons attribution/i;

/** True for Creative Commons / public-domain licences. */
export function isOpenLicense(license: string | null | undefined) {
  return Boolean(license && OPEN.test(license));
}
