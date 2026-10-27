import { useEffect, useId, useRef, useState, type KeyboardEvent } from 'react';
import { materialQuery } from '../../shared/material-query';
import { api } from '../lib/api';

interface Suggestions { suggestions: string[]; available: boolean; source: 'PubChem' }
const cache = new Map<string, Suggestions>();

/** Free-form brief with optional compound-name completion. Selecting never starts a search. */
export function MaterialInput({ id, value, onChange, rows = 3, disabled = false }: {
  id: string; value: string; onChange: (value: string) => void; rows?: number; disabled?: boolean;
}) {
  const listId = `${useId()}-materials`;
  const input = useRef<HTMLTextAreaElement>(null);
  const [focused, setFocused] = useState(false);
  const [composing, setComposing] = useState(false);
  const [dismissed, setDismissed] = useState<string | null>(null);
  const [active, setActive] = useState(-1);
  const [result, setResult] = useState<{ query: string; data: Suggestions } | null>(null);
  const [loading, setLoading] = useState(false);
  const query = materialQuery(value);
  const enabled = focused && !disabled && !composing && Boolean(query) && dismissed !== query;

  useEffect(() => {
    if (!enabled || !query) { setLoading(false); return; }
    let current = true;
    const ctrl = new AbortController();
    const cached = cache.get(query.toLowerCase());
    if (cached) {
      setResult({ query, data: cached });
      setActive(-1);
      setLoading(false);
      return;
    }
    setLoading(true);
    const timer = setTimeout(async () => {
      try {
        const data = await api<Suggestions>(`/api/materials/suggestions?q=${encodeURIComponent(query)}`, { signal: ctrl.signal });
        if (!current) return;
        if (data.available) {
          if (cache.size >= 100) cache.delete(cache.keys().next().value!);
          cache.set(query.toLowerCase(), data);
        }
        setResult({ query, data });
        setActive(-1);
      } catch {
        if (current) setResult({ query, data: { suggestions: [], available: false, source: 'PubChem' } });
      } finally {
        if (current) setLoading(false);
      }
    }, 300);
    return () => { current = false; clearTimeout(timer); ctrl.abort(); };
  }, [query, enabled]);

  const data = enabled && result?.query === query ? result.data : null;
  const options = data?.suggestions ?? [];
  const expanded = enabled && options.length > 0;
  useEffect(() => {
    if (expanded && active >= 0) document.getElementById(`${listId}-${active}`)?.scrollIntoView({ block: 'nearest' });
  }, [active, expanded, listId]);
  const choose = (name: string) => {
    setDismissed(materialQuery(name));
    setActive(-1);
    onChange(name);
    input.current?.focus();
  };
  const keyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.nativeEvent.isComposing) return;
    if (event.key === 'Escape') {
      setDismissed(query);
      setActive(-1);
      return;
    }
    if (!expanded) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      setActive((index) => event.key === 'ArrowDown' ? (index + 1) % options.length : (index <= 0 ? options.length : index) - 1);
    } else if (event.key === 'Enter' && active >= 0) {
      event.preventDefault();
      choose(options[active]);
    }
  };

  return <div className="material-input">
    <textarea
      ref={input} id={id} rows={rows} value={value} disabled={disabled} maxLength={3000}
      role="combobox" aria-autocomplete="list" aria-haspopup="listbox" aria-expanded={expanded}
      aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && active >= 0 ? `${listId}-${active}` : undefined}
      autoComplete="off" onFocus={() => setFocused(true)} onBlur={() => setFocused(false)} onKeyDown={keyDown}
      onCompositionStart={() => setComposing(true)} onCompositionEnd={() => setComposing(false)}
      onChange={(event) => { setDismissed(null); setActive(-1); onChange(event.target.value); }}
    />
    {expanded && <div className="material-menu">
      <ul id={listId} role="listbox" aria-label="Material suggestions">
        {options.map((name, index) => <li
          id={`${listId}-${index}`} key={name} role="option" aria-selected={index === active}
          className={index === active ? 'active' : ''} onPointerDown={(event) => event.preventDefault()}
          onPointerMove={() => setActive(index)} onClick={() => choose(name)}
        >{name}</li>)}
      </ul>
      <p className="material-source">Compound suggestions · PubChem</p>
    </div>}
    <span className="sr-only" role="status" aria-live="polite">
      {enabled && loading ? 'Looking up compounds.' : expanded ? `${options.length} suggestions. Use the arrow keys to choose, then Enter.` : enabled && data?.available ? 'No compound suggestions.' : ''}
    </span>
    {enabled && data && !data.available && <p className="hint">Suggestions unavailable. You can keep typing.</p>}
  </div>;
}
