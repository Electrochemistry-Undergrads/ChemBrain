import { useEffect, useRef, type ReactNode } from 'react';
import type { Tone } from '../lib/labels';

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size * 0.9} height={size} viewBox="0 0 36 40" fill="none" aria-hidden="true">
      <path d="m18 3 14 8v18l-14 8-14-8V11Z" stroke="currentColor" strokeWidth="1.8" />
      <path d="m18 12 7 4v8l-7 4-7-4v-8Z" stroke="currentColor" strokeWidth="1.3" />
      <circle cx="18" cy="20" r="2.7" fill="currentColor" />
    </svg>
  );
}

export function Badge({ tone = 'neutral', children, title }: { tone?: Tone; children: ReactNode; title?: string }) {
  return (
    <span className={`badge badge-${tone}`} title={title}>
      {children}
    </span>
  );
}

export function StatusBadge({ map, value }: { map: Record<string, [string, Tone, string?]>; value: string | null | undefined }) {
  const v = map[value ?? ''] ?? [value ?? '—', 'neutral' as Tone, ''];
  return (
    <Badge tone={v[1]} title={v[2] || undefined}>
      {v[0]}
    </Badge>
  );
}

export function Notice({ tone = 'info', children }: { tone?: Tone; children: ReactNode }) {
  return (
    <div className={`notice notice-${tone}`} role={tone === 'bad' ? 'alert' : 'status'}>
      {children}
    </div>
  );
}

export function Spinner({ label = 'Loading' }: { label?: string }) {
  return (
    <span className="spinner" role="status" aria-label={label}>
      <span aria-hidden="true" />
    </span>
  );
}

export function Drawer({ open, onClose, title, children }: { open: boolean; onClose: () => void; title: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const prev = document.activeElement as HTMLElement | null;
    ref.current?.focus();
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => {
      window.removeEventListener('keydown', onKey);
      prev?.focus();
    };
  }, [open, onClose]);
  if (!open) return null;
  return (
    <div className="drawer-backdrop" onClick={onClose}>
      <div className="drawer" role="dialog" aria-modal="true" aria-label={title} tabIndex={-1} ref={ref} onClick={(e) => e.stopPropagation()}>
        <div className="drawer-head">
          <h2>{title}</h2>
          <button className="btn btn-ghost" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>
        <div className="drawer-body">{children}</div>
      </div>
    </div>
  );
}

export function Stat({ label, value, hint }: { label: string; value: ReactNode; hint?: string }) {
  return (
    <div className="stat" title={hint}>
      <div className="stat-value">{value}</div>
      <div className="stat-label">{label}</div>
    </div>
  );
}
