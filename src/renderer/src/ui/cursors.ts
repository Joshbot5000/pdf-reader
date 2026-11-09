/**
 * Tool cursors drawn from the app's icons: a pen, highlighter, eraser and
 * roller that show what the pointer will do. Each has a white halo so it stays
 * visible on dark and light parts of a page, and the pen and highlighter take
 * the colour currently selected.
 */
import * as L from 'lucide-static';

const inner = (svg: string) => svg.slice(svg.indexOf('>', svg.indexOf('<svg')) + 1, svg.lastIndexOf('</svg>'));

function cursor(icon: string, hotX: number, hotY: number, color = '#16161d', fallback = 'crosshair'): string {
  const paths = inner(icon);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="28" height="28" viewBox="-2 -2 28 28" fill="none" stroke-linecap="round" stroke-linejoin="round">` +
    `<g stroke="#ffffff" stroke-width="4.5">${paths}</g>` +
    `<g stroke="${color}" stroke-width="2">${paths}</g>` +
    `</svg>`;
  return `url("data:image/svg+xml,${encodeURIComponent(svg)}") ${hotX} ${hotY}, ${fallback}`;
}

/** Darken a colour so a pale highlighter colour is still visible as an outline. */
function darken(hex: string, amount = 0.35) {
  const n = parseInt(hex.slice(1), 16);
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.round(v * (1 - amount)));
  return `rgb(${c.join(',')})`;
}

// Hotspots are the drawing tip of each icon (in the 28px cursor box).
export const cursors = {
  pen: (color: string) => cursor(L.Pencil, 3, 25, color),
  highlighter: (color: string) => cursor(L.Highlighter, 4, 25, darken(color)),
  eraser: () => cursor(L.Eraser, 7, 23, '#16161d', 'cell'),
  whiteout: () => cursor(L.PaintRoller, 8, 25, '#16161d'),
};
