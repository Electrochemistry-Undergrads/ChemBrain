import { useEffect, useRef, type ReactNode } from 'react';

const REACH = 220; // px around the box within which the light follows the cursor

/**
 * Wrapper for the compound box glow. With a mouse, a soft light follows the cursor around the
 * edge and halo, fading in as the pointer approaches and out as it leaves. Position is written to
 * CSS variables once per frame, so React never re-renders. Touch input and reduced-motion users
 * keep the ambient drift only.
 */
export function GlowField({ busy, className = '', children }: { busy?: boolean; className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !window.matchMedia('(hover: hover) and (pointer: fine)').matches) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');
    let frame = 0;
    let x = 0;
    let y = 0;
    const paint = () => {
      frame = 0;
      const r = el.getBoundingClientRect();
      const dx = Math.max(r.left - x, 0, x - r.right);
      const dy = Math.max(r.top - y, 0, y - r.bottom);
      const near = Math.max(0, 1 - Math.hypot(dx, dy) / REACH);
      el.style.setProperty('--mx', `${(x - r.left).toFixed(1)}px`);
      el.style.setProperty('--my', `${(y - r.top).toFixed(1)}px`);
      el.style.setProperty('--glow-near', near.toFixed(3));
    };
    const move = (e: PointerEvent) => {
      if (e.pointerType !== 'mouse' || reduce.matches) return;
      x = e.clientX;
      y = e.clientY;
      if (!frame) frame = requestAnimationFrame(paint);
    };
    const leave = () => el.style.setProperty('--glow-near', '0');
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    return () => {
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      if (frame) cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <div ref={ref} className={`glow-field ${className}`.trim()} data-busy={busy || undefined}>
      {children}
    </div>
  );
}
