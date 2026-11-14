import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import type { Source, Speaker } from '../../../shared/types';
import { fmtTime, parseTime } from '../../../shared/text';

export const SPEAKER_HUES = ['#8f7dff', '#ff7fb2', '#4fd6bd', '#ffb454', '#62adff', '#d08bff', '#9be36a', '#ff8d69'];
export const colorOf = (sp?: Speaker): string => SPEAKER_HUES[(sp?.color ?? 0) % SPEAKER_HUES.length];
export const initials = (name: string): string => {
  const m = name.match(/^Speaker (\d+)$/);
  if (m) return m[1];
  return name.split(/\s+/).map((w) => w[0]).join('').slice(0, 2).toUpperCase();
};

export function Avatar({ sp, size = 28 }: { sp?: Speaker; size?: number }) {
  const c = colorOf(sp);
  return (
    <span className="avatar" style={{ width: size, height: size, fontSize: size * 0.4, background: `color-mix(in oklab, ${c} 22%, transparent)`, color: c, boxShadow: `inset 0 0 0 1.5px color-mix(in oklab, ${c} 55%, transparent)` }}>
      {initials(sp?.name ?? '?')}
    </span>
  );
}

export function Spinner({ size = 14 }: { size?: number }) {
  return <span className="spinner" style={{ width: size, height: size }} />;
}

export function Ring({ value, size = 34 }: { value: number; size?: number }) {
  const r = size / 2 - 3;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} className="ring">
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-bg" />
      <circle cx={size / 2} cy={size / 2} r={r} className="ring-fg" strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0.02, Math.min(1, value)))} transform={`rotate(-90 ${size / 2} ${size / 2})`} />
    </svg>
  );
}

/** Click-away popover anchored under its trigger. */
export function Popover({ trigger, children, align = 'left', className = '' }: { trigger: (open: boolean, toggle: () => void) => ReactNode; children: (close: () => void) => ReactNode; align?: 'left' | 'right'; className?: string }) {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLSpanElement>(null);
  useEffect(() => {
    if (!open) return;
    const away = (e: MouseEvent) => !ref.current?.contains(e.target as Node) && setOpen(false);
    const esc = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    document.addEventListener('mousedown', away);
    document.addEventListener('keydown', esc);
    return () => {
      document.removeEventListener('mousedown', away);
      document.removeEventListener('keydown', esc);
    };
  }, [open]);
  return (
    <span className="pop-wrap" ref={ref}>
      {trigger(open, () => setOpen((o) => !o))}
      {open && <div className={`pop pop-${align} ${className}`}>{children(() => setOpen(false))}</div>}
    </span>
  );
}

const INLINE = /(\*\*[^*\n]+\*\*|\*[^*\s][^*\n]*\*|`[^`\n]+`|\[\d{1,2}(?::\d{2}){1,2}\]|\[\d{1,2}\])/g;

/** Minimal markdown for model output, with clickable [m:ss] timestamps and [n] source citations. */
export function Md({ text, onTime, sources, onSource }: { text: string; onTime?: (t: number) => void; sources?: Source[]; onSource?: (s: Source) => void }) {
  const inline = (s: string, key: string): ReactNode[] =>
    s.split(INLINE).map((part, i) => {
      const k = `${key}-${i}`;
      if (/^\*\*.+\*\*$/.test(part)) return <strong key={k}>{part.slice(2, -2)}</strong>;
      if (/^\*.+\*$/.test(part)) return <em key={k}>{part.slice(1, -1)}</em>;
      if (/^`.+`$/.test(part)) return <code key={k}>{part.slice(1, -1)}</code>;
      const cite = part.match(/^\[(.+)\]$/);
      if (cite) {
        const t = parseTime(cite[1]);
        if (t !== null && onTime) return <button key={k} className="cite time" onClick={() => onTime(t)}>{cite[1]}</button>;
        const src = sources?.find((x) => String(x.n) === cite[1]);
        if (src && onSource) return <button key={k} className="cite" title={`${src.title} · ${fmtTime(src.t)}`} onClick={() => onSource(src)}>{src.n}</button>;
      }
      return part;
    });
  const blocks: ReactNode[] = [];
  let list: { ordered: boolean; items: string[] } | null = null;
  const flush = () => {
    if (!list) return;
    const items = list.items.map((it, i) => <li key={i}>{inline(it, `l${blocks.length}-${i}`)}</li>);
    blocks.push(list.ordered ? <ol key={blocks.length}>{items}</ol> : <ul key={blocks.length}>{items}</ul>);
    list = null;
  };
  for (const raw of text.split('\n')) {
    const line = raw.trimEnd();
    const li = line.match(/^\s*(?:([-*•])|(\d+)[.)])\s+(.*)$/);
    if (li) {
      const ordered = !!li[2];
      if (!list || list.ordered !== ordered) {
        flush();
        list = { ordered, items: [] };
      }
      list.items.push(li[3]);
      continue;
    }
    flush();
    if (!line.trim()) continue;
    const h = line.match(/^#{1,4}\s+(.*)$/);
    if (h) blocks.push(<p key={blocks.length} className="md-h">{inline(h[1], `h${blocks.length}`)}</p>);
    else blocks.push(<p key={blocks.length}>{inline(line, `p${blocks.length}`)}</p>);
  }
  flush();
  return <div className="md">{blocks}</div>;
}

type Levels = () => { level: number; bands: Uint8Array };

/**
 * The orb: a living shape that breathes when idle and swells with the voice it hears.
 * Four translucent lobes orbit each other; a ring of fine lines shows the spectrum.
 */
export function Orb({ size, levels, intensity = 1 }: { size: number; levels?: Levels; intensity?: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = ref.current!;
    const dpr = Math.min(2, window.devicePixelRatio || 1);
    cv.width = cv.height = size * dpr;
    const ctx = cv.getContext('2d')!;
    let raf = 0;
    let L = 0;
    let t = Math.random() * 100;
    let last = performance.now();
    const hues = [['#7d6bff', '#4c3bff'], ['#ff6fae', '#ff3d8b'], ['#ffb65c', '#ff7a3d'], ['#3fd9c4', '#2a9df4']];
    const still = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const draw = (now: number) => {
      const dt = Math.min(0.05, (now - last) / 1000);
      last = now;
      const lv = levels?.() ?? { level: 0, bands: null as Uint8Array | null };
      L += (lv.level - L) * (lv.level > L ? 0.35 : 0.08);
      t += dt * (still ? 0.15 : 0.55 + L * 2.2);
      const light = document.documentElement.dataset.theme === 'light';
      const W = size * dpr, c = W / 2, R = W * 0.3;
      ctx.clearRect(0, 0, W, W);
      ctx.save();
      ctx.globalCompositeOperation = light ? 'multiply' : 'screen';
      ctx.filter = `blur(${W * 0.022}px)`;
      hues.forEach(([a, b], k) => {
        const ox = Math.cos(t * (0.5 + k * 0.13) + k * 1.7) * R * (0.16 + L * 0.2);
        const oy = Math.sin(t * (0.43 + k * 0.11) + k * 2.3) * R * (0.16 + L * 0.2);
        const base = R * (0.78 + 0.07 * k + L * 0.3 * intensity);
        ctx.beginPath();
        for (let i = 0; i <= 96; i++) {
          const a0 = (i / 96) * Math.PI * 2;
          const r = base * (1 + (0.05 + 0.2 * L) * Math.sin(3 * a0 + t * (0.9 + 0.2 * k) + k) + (0.03 + 0.1 * L) * Math.sin(5 * a0 - t * 1.3 + 2 * k) + 0.015 * Math.sin(9 * a0 + t * 2.1));
          const x = c + ox + Math.cos(a0) * r, y = c + oy + Math.sin(a0) * r;
          if (i) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
        }
        ctx.closePath();
        const g = ctx.createRadialGradient(c + ox, c + oy, base * 0.1, c + ox, c + oy, base * 1.15);
        g.addColorStop(0, a + (light ? 'cc' : 'e6'));
        g.addColorStop(0.65, b + (light ? '77' : '88'));
        g.addColorStop(1, b + '00');
        ctx.fillStyle = g;
        ctx.fill();
      });
      ctx.restore();
      // bright core
      const core = ctx.createRadialGradient(c, c, 0, c, c, R * (0.55 + L * 0.5));
      core.addColorStop(0, light ? 'rgba(255,255,255,.95)' : 'rgba(255,255,255,.9)');
      core.addColorStop(0.4, light ? 'rgba(255,255,255,.4)' : 'rgba(255,240,250,.28)');
      core.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = core;
      ctx.beginPath();
      ctx.arc(c, c, R * (0.55 + L * 0.5), 0, Math.PI * 2);
      ctx.fill();
      // spectrum ring
      const bands = lv.bands;
      const n = 72;
      ctx.lineCap = 'round';
      ctx.lineWidth = Math.max(1, W * 0.004);
      for (let i = 0; i < n; i++) {
        const a0 = (i / n) * Math.PI * 2 - Math.PI / 2;
        const mirrored = i < n / 2 ? i : n - i;
        const v = bands ? bands[Math.min(bands.length - 1, Math.floor((mirrored / (n / 2)) * 40))] / 255 : 0;
        const amp = v * W * 0.085 * intensity + W * 0.004 * (1 + Math.sin(t * 1.5 + i * 0.5));
        const r0 = R * 1.5;
        ctx.strokeStyle = light ? `rgba(60,50,120,${0.14 + v * 0.5})` : `rgba(255,255,255,${0.1 + v * 0.55})`;
        ctx.beginPath();
        ctx.moveTo(c + Math.cos(a0) * r0, c + Math.sin(a0) * r0);
        ctx.lineTo(c + Math.cos(a0) * (r0 + amp), c + Math.sin(a0) * (r0 + amp));
        ctx.stroke();
      }
      raf = requestAnimationFrame(draw);
    };
    raf = requestAnimationFrame(draw);
    return () => cancelAnimationFrame(raf);
  }, [size, levels, intensity]);
  return <canvas ref={ref} className="orb" style={{ width: size, height: size }} />;
}

/** Tiny static waveform for list rows. */
export function Spark({ peaks, bars = 56, color }: { peaks: number[]; bars?: number; color?: string }) {
  if (!peaks.length) return <svg className="spark" viewBox={`0 0 ${bars * 3} 28`} />;
  const step = peaks.length / bars;
  const top = Math.max(0.05, ...peaks);
  return (
    <svg className="spark" viewBox={`0 0 ${bars * 3} 28`} preserveAspectRatio="none">
      {Array.from({ length: bars }, (_, i) => {
        let m = 0;
        for (let j = Math.floor(i * step); j < Math.max(Math.floor(i * step) + 1, Math.floor((i + 1) * step)); j++) m = Math.max(m, peaks[j] ?? 0);
        const h = Math.max(1.5, (m / top) * 26);
        return <rect key={i} x={i * 3} y={14 - h / 2} width={1.6} height={h} rx={0.8} fill={color ?? 'currentColor'} />;
      })}
    </svg>
  );
}

/** Player waveform, tinted by whoever is speaking. The played part is a brighter copy clipped to the progress. */
export function Waveform({ peaks, duration, colorAt, marks, progressRef, onSeek }: { peaks: number[]; duration: number; colorAt: (t: number) => string; marks: { t: number; label: string }[]; progressRef: React.RefObject<HTMLDivElement | null>; onSeek: (t: number) => void }) {
  const wrap = useRef<HTMLDivElement>(null);
  const base = useRef<HTMLCanvasElement>(null);
  const lit = useRef<HTMLCanvasElement>(null);
  const [w, setW] = useState(600);
  const [hover, setHover] = useState<number | null>(null);
  useLayoutEffect(() => {
    const ro = new ResizeObserver(([e]) => setW(Math.max(100, Math.floor(e.contentRect.width))));
    ro.observe(wrap.current!);
    return () => ro.disconnect();
  }, []);
  useEffect(() => {
    const H = 44, dpr = Math.min(2, window.devicePixelRatio || 1);
    const bars = Math.floor(w / 3);
    const top = Math.max(0.08, ...peaks);
    for (const [cv, alpha] of [[base.current!, 0.3], [lit.current!, 1]] as const) {
      cv.width = w * dpr;
      cv.height = H * dpr;
      cv.style.width = `${w}px`;
      const ctx = cv.getContext('2d')!;
      ctx.scale(dpr, dpr);
      ctx.clearRect(0, 0, w, H);
      ctx.globalAlpha = alpha;
      for (let i = 0; i < bars; i++) {
        const a = Math.floor((i / bars) * peaks.length), b = Math.max(a + 1, Math.floor(((i + 1) / bars) * peaks.length));
        let m = 0;
        for (let j = a; j < b; j++) m = Math.max(m, peaks[j] ?? 0);
        const h = Math.max(2, Math.pow(m / top, 0.8) * (H - 6));
        ctx.fillStyle = colorAt(((i + 0.5) / bars) * duration);
        ctx.beginPath();
        ctx.roundRect(i * 3, (H - h) / 2, 2, h, 1);
        ctx.fill();
      }
    }
  }, [peaks, duration, w, colorAt]);
  const at = (e: React.MouseEvent) => {
    const r = wrap.current!.getBoundingClientRect();
    return Math.max(0, Math.min(1, (e.clientX - r.left) / r.width)) * duration;
  };
  return (
    <div className="wave" ref={wrap} onMouseMove={(e) => setHover(at(e))} onMouseLeave={() => setHover(null)} onClick={(e) => onSeek(at(e))}>
      <canvas ref={base} />
      <div className="wave-lit" ref={progressRef}><canvas ref={lit} /></div>
      {marks.map((m, i) => (
        <span key={i} className="wave-mark" style={{ left: `${(m.t / Math.max(1, duration)) * 100}%` }} title={`${fmtTime(m.t)} · ${m.label}`} />
      ))}
      {hover !== null && <span className="wave-hover" style={{ left: `${(hover / Math.max(1, duration)) * 100}%` }}><i>{fmtTime(hover)}</i></span>}
    </div>
  );
}

export const relDay = (ts: number): string => {
  const d = new Date(ts), now = new Date();
  const days = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()) / 864e5);
  if (days === 0) return 'Today';
  if (days === 1) return 'Yesterday';
  if (days < 7) return 'This week';
  if (days < 31) return 'This month';
  return d.toLocaleDateString(undefined, { month: 'long', year: 'numeric' });
};
export const clock = (ts: number): string => new Date(ts).toLocaleTimeString(undefined, { hour: 'numeric', minute: '2-digit' });
export const dayLabel = (ts: number): string => new Date(ts).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
export const gb = (bytes: number): string => (bytes >= 1e9 ? `${(bytes / 1e9).toFixed(1)} GB` : `${Math.round(bytes / 1e6)} MB`);
