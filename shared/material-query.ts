/** Autocomplete is for a short material name, rather than a full research brief. */
export function materialQuery(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const query = value.trim().replace(/\s+/g, ' ');
  if (query.length < 3 || query.length > 80 || query.split(' ').length > 8 || !/\p{L}/u.test(query)) return null;
  if (/[\r\n<>\u0000-\u001f]/.test(value) || /https?:\/\//i.test(query)) return null;
  return query;
}
