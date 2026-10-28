import { useEffect, useRef, type ReactNode } from 'react';

const REACH = 260; // px around the box within which the light is drawn toward the cursor
const ORBIT_A = 17; // seconds per lap of the ambient drift
const ORBIT_B = 23;

/**
 * Wrapper for the compound box glow: two soft blobs of light behind the box. On their own they
 * drift slowly around it; with a mouse nearby they ease toward the cursor, the second trailing the
 * first, and the edge highlight turns to face them. Positions are eased every frame and written as
 * transforms, so nothing re-renders or re-lays out. Reduced motion keeps the light still; touch
 * and pen input get the drift only. The loop pauses, and the light hides, while the box is off-screen.
 */
export function GlowField({ busy, className = '', children }: { busy?: boolean; className?: string; children: ReactNode }) {
  const root = useRef<HTMLDivElement>(null);
  const lightA = useRef<HTMLSpanElement>(null);
  const lightB = useRef<HTMLSpanElement>(null);
  const busyRef = useRef(Boolean(busy));
  busyRef.current = Boolean(busy);

  useEffect(() => {
    const el = root.current;
    const a = lightA.current;
    const b = lightB.current;
    if (!el || !a || !b) return;
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)');

    let frame = 0;
    let last = 0;
    let visible = true;
    let thetaA = 2.4; // start on the lower left / upper right so the first frame is balanced
    let thetaB = 5.5;
    let near = 0;
    let pointer: { x: number; y: number } | null = null;
    const posA = { x: NaN, y: NaN };
    const posB = { x: NaN, y: NaN };
    let ringAngle = NaN;

    // Positions are kept relative to the box; the light layer is fixed to the window, so the box's
    // current window offset is added when placing.
    const place = (light: HTMLElement, p: { x: number; y: number }, glow: number, r: DOMRect) => {
      light.style.transform = `translate3d(${(r.left + p.x).toFixed(1)}px, ${(r.top + p.y).toFixed(1)}px, 0)`;
      light.style.opacity = glow.toFixed(3);
    };
    const orbit = (w: number, h: number, theta: number) => ({ x: w / 2 + Math.cos(theta) * w * 0.46, y: h / 2 + Math.sin(theta) * (h / 2 + 18) });
    // Frame-rate independent easing: `rate` is the fraction covered per 1/60 s.
    const ease = (rate: number, dt: number) => 1 - Math.pow(1 - rate, dt * 60);

    const tick = (now: number) => {
      frame = 0;
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60);
      last = now;
      const r = el.getBoundingClientRect();
      const w = r.width;
      const h = r.height;
      const speed = busyRef.current ? 3 : 1;
      thetaA += ((2 * Math.PI) / ORBIT_A) * dt * speed;
      thetaB -= ((2 * Math.PI) / ORBIT_B) * dt * speed;

      let target = 0;
      let cx = 0;
      let cy = 0;
      if (pointer) {
        const dx = Math.max(r.left - pointer.x, 0, pointer.x - r.right);
        const dy = Math.max(r.top - pointer.y, 0, pointer.y - r.bottom);
        target = Math.max(0, 1 - Math.hypot(dx, dy) / REACH);
        // Keep the light hugging the box even when the cursor is further out.
        cx = Math.min(w + 16, Math.max(-16, pointer.x - r.left));
        cy = Math.min(h + 16, Math.max(-16, pointer.y - r.top));
      }
      near += (target - near) * ease(0.05, dt);

      const oa = orbit(w, h, thetaA);
      const ob = orbit(w, h, thetaB);
      const ta = { x: oa.x + (cx - oa.x) * near, y: oa.y + (cy - oa.y) * near };
      const tb = { x: ob.x + (cx - ob.x) * near * 0.8, y: ob.y + (cy - ob.y) * near * 0.8 };
      if (Number.isNaN(posA.x)) {
        Object.assign(posA, ta);
        Object.assign(posB, tb);
      }
      const ka = ease(0.06, dt);
      const kb = ease(0.035, dt);
      posA.x += (ta.x - posA.x) * ka;
      posA.y += (ta.y - posA.y) * ka;
      posB.x += (tb.x - posB.x) * kb;
      posB.y += (tb.y - posB.y) * kb;
      place(a, posA, 0.8 + 0.2 * near, r);
      place(b, posB, 0.7 + 0.3 * near, r);

      // Turn the edge highlight toward the leading light (0deg = up, clockwise).
      const angle = (Math.atan2(posA.x - w / 2, -(posA.y - h / 2)) * 180) / Math.PI;
      if (Number.isNaN(ringAngle) || Math.abs(angle - ringAngle) > 0.4) {
        ringAngle = angle;
        el.style.setProperty('--ring-angle', `${angle.toFixed(1)}deg`);
      }
      if (visible && !document.hidden) frame = requestAnimationFrame(tick);
    };

    const start = () => {
      if (!frame && visible && !reduce.matches) {
        last = 0;
        frame = requestAnimationFrame(tick);
      }
    };
    const stop = () => {
      if (frame) cancelAnimationFrame(frame);
      frame = 0;
    };
    const still = () => {
      // Reduced motion: one balanced, motionless arrangement. The loop state is set to match, so
      // turning motion back on resumes from exactly where the lights are drawn instead of jumping.
      stop();
      const r = el.getBoundingClientRect();
      thetaA = 2.4;
      thetaB = 5.5;
      near = 0;
      Object.assign(posA, orbit(r.width, r.height, thetaA));
      Object.assign(posB, orbit(r.width, r.height, thetaB));
      place(a, posA, 0.8, r);
      place(b, posB, 0.7, r);
      ringAngle = (Math.atan2(posA.x - r.width / 2, -(posA.y - r.height / 2)) * 180) / Math.PI;
      el.style.setProperty('--ring-angle', `${ringAngle.toFixed(1)}deg`);
    };
    // Still mode has no frame loop, so re-place the lights whenever the box could have moved:
    // page scroll, window resize, the box resizing, or content above it changing the page height.
    const replace = () => {
      if (reduce.matches && visible) still();
    };
    const resized = new ResizeObserver(replace);

    const move = (e: PointerEvent) => {
      if (e.pointerType === 'mouse') pointer = { x: e.clientX, y: e.clientY };
    };
    const leave = () => {
      pointer = null;
    };
    const motionChange = () => (reduce.matches ? still() : start());
    // Hide the window-fixed lights and stop the loop once the box is well off-screen; the margin
    // exceeds how far the light reaches past the box, so nothing visible disappears.
    const io = new IntersectionObserver((entries) => {
      // Several entries can queue up before the callback runs; only the newest is current.
      const entry = entries[entries.length - 1];
      visible = entry.isIntersecting;
      if (visible) {
        delete el.dataset.offscreen;
        if (reduce.matches) still();
        else start();
      } else {
        el.dataset.offscreen = '';
        stop();
      }
    }, { rootMargin: '400px' });

    // Listen on every device: move() only follows mouse-type pointers, so touch and pen never pull
    // the light, while tablets with a trackpad or mouse (or one connected later) still get it.
    window.addEventListener('pointermove', move, { passive: true });
    document.documentElement.addEventListener('pointerleave', leave);
    document.addEventListener('visibilitychange', start);
    window.addEventListener('scroll', replace, { passive: true });
    window.addEventListener('resize', replace, { passive: true });
    reduce.addEventListener('change', motionChange);
    io.observe(el);
    resized.observe(el);
    resized.observe(document.body);
    if (reduce.matches) still();
    else start();

    return () => {
      stop();
      io.disconnect();
      resized.disconnect();
      window.removeEventListener('pointermove', move);
      document.documentElement.removeEventListener('pointerleave', leave);
      document.removeEventListener('visibilitychange', start);
      window.removeEventListener('scroll', replace);
      window.removeEventListener('resize', replace);
      reduce.removeEventListener('change', motionChange);
    };
  }, []);

  return (
    <div ref={root} className={`glow-field ${className}`.trim()} data-busy={busy || undefined}>
      <div className="glow-lights" aria-hidden="true">
        <span ref={lightA} className="glow-light glow-light-a" />
        <span ref={lightB} className="glow-light glow-light-b" />
      </div>
      {children}
    </div>
  );
}
