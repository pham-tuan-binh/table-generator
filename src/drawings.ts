// Dimensioned orthographic drawings (top, front, side) as SVG, drawn from the model's boxes.
import { Model, Part, Box, memberBox, round } from './model.ts';

type View = 'top' | 'front' | 'side';
const FILL: Record<string, string> = { frame: '#e3e5e8', panel: '#f3f3f0', worktop: '#efe4d3', shelf: '#efe4d3', hw: '#b9bcc1', dark: '#55565b', cam: '#9fb6d6' };

function project(b: Box, v: View) {
  const [x, y, z] = b.c, [sx, sy, sz] = b.s;
  // u right, w up on paper, d toward the viewer
  if (v === 'top') return { u: x, w: y, du: sx, dw: sy, d: z + sz / 2 };
  if (v === 'front') return { u: x, w: z, du: sx, dw: sz, d: -y + sy / 2 };
  return { u: y, w: z, du: sy, dw: sz, d: x + sx / 2 };
}

function solids(m: Model): { part: Part; box: Box }[] {
  const out: { part: Part; box: Box }[] = [];
  for (const pt of m.parts) {
    if (pt.kind === 'camera') continue;
    if (pt.member) out.push({ part: pt, box: memberBox(pt.member, m.s) });
    else {
      for (const b of pt.boxes) out.push({ part: pt, box: b });
      for (const c of pt.cyls) {
        const lo = [0, 1, 2].map(i => Math.min(c.a[i], c.b[i])), hi = [0, 1, 2].map(i => Math.max(c.a[i], c.b[i]));
        const ax = [0, 1, 2].map(i => (Math.abs(c.a[i] - c.b[i]) > 1e-6 ? 0 : 1));
        out.push({ part: pt, box: { c: [0, 1, 2].map(i => (lo[i] + hi[i]) / 2) as [number, number, number], s: [0, 1, 2].map(i => hi[i] - lo[i] + ax[i] * 2 * c.r) as [number, number, number] } });
      }
    }
  }
  return out;
}

function drawing(m: Model, v: View, title: string, ref: number): string {
  const p = m.p, items = solids(m).map(s => ({ ...s, q: project(s.box, v) })).sort((a, b) => a.q.d - b.q.d);
  const xs = items.flatMap(i => [i.q.u - i.q.du / 2, i.q.u + i.q.du / 2]), ws = items.flatMap(i => [i.q.w - i.q.dw / 2, i.q.w + i.q.dw / 2]);
  const u0 = Math.min(...xs), u1 = Math.max(...xs), w0 = Math.min(...ws), w1 = Math.max(...ws);
  const span = ref, pad = span * 0.16, fs = span * 0.022, sw = span * 0.0016;
  const X = (u: number) => u, Y = (w: number) => -w;
  const vb = [u0 - pad * 0.6, -w1 - pad * 0.6, u1 - u0 + pad * 1.9, w1 - w0 + pad * 1.6];
  const o: string[] = [`<svg viewBox="${vb.map(round).join(' ')}" width="${round((vb[2] / ref) * 520)}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="${title} view" font-family="ui-monospace, Menlo, monospace">`];
  o.push(`<text x="${vb[0] + fs * 0.6}" y="${vb[1] + fs * 1.6}" font-size="${fs}" font-weight="700" fill="#14171a">${title}</text>`);
  for (const it of items) {
    const { u, w, du, dw } = it.q;
    o.push(`<rect x="${round(X(u - du / 2))}" y="${round(Y(w + dw / 2))}" width="${round(du)}" height="${round(dw)}" fill="${FILL[it.part.role]}" stroke="#2a2d31" stroke-width="${round(sw)}"/>`);
  }
  // cameras as dots with names
  m.cameras.forEach((c, i) => {
    const pp = v === 'top' ? [c.pos[0], c.pos[1]] : v === 'front' ? [c.pos[0], c.pos[2]] : [c.pos[1], c.pos[2]];
    o.push(`<circle cx="${round(pp[0])}" cy="${round(-pp[1])}" r="${round(fs * 0.4)}" fill="#0a6cff"/><text x="${round(pp[0] + fs * 0.6)}" y="${round(-pp[1] - fs * 0.4 + i * fs * 0.95)}" font-size="${round(fs * 0.8)}" fill="#0a6cff" paint-order="stroke" stroke="#fff" stroke-width="${round(fs * 0.25)}">${c.spec.name}</text>`);
  });
  // dimensions: horizontal below, vertical on the right
  const dim = (a: number, b: number, at: number, horiz: boolean, label: string, left = false) => {
    const tk = fs * 0.4;
    if (horiz) {
      const y = Y(at);
      o.push(`<g stroke="#4a4f57" stroke-width="${round(sw)}"><line x1="${a}" y1="${round(y)}" x2="${b}" y2="${round(y)}"/><line x1="${a}" y1="${round(y - tk)}" x2="${a}" y2="${round(y + tk)}"/><line x1="${b}" y1="${round(y - tk)}" x2="${b}" y2="${round(y + tk)}"/></g>`);
      o.push(`<text x="${round((a + b) / 2)}" y="${round(y - fs * 0.35)}" font-size="${fs}" text-anchor="middle" fill="#14171a" paint-order="stroke" stroke="#fff" stroke-width="${round(fs * 0.3)}">${label}</text>`);
    } else {
      const x = X(at);
      o.push(`<g stroke="#4a4f57" stroke-width="${round(sw)}"><line x1="${round(x)}" y1="${round(Y(a))}" x2="${round(x)}" y2="${round(Y(b))}"/><line x1="${round(x - tk)}" y1="${round(Y(a))}" x2="${round(x + tk)}" y2="${round(Y(a))}"/><line x1="${round(x - tk)}" y1="${round(Y(b))}" x2="${round(x + tk)}" y2="${round(Y(b))}"/></g>`);
      o.push(`<text x="${round(x + (left ? -fs * 0.4 : fs * 0.4))}" y="${round(Y((a + b) / 2) + fs * 0.35)}" font-size="${fs}" text-anchor="${left ? 'end' : 'start'}" fill="#14171a" paint-order="stroke" stroke="#fff" stroke-width="${round(fs * 0.3)}">${label}</text>`);
    }
  };
  const W = p.width, D = p.depth;
  if (v === 'top') {
    dim(-W / 2, W / 2, w0 - pad * 0.35, true, `${round(W)}`);
    dim(-D / 2, D / 2, u1 + pad * 0.25, false, `${round(D)}`);
  } else {
    const a = v === 'front' ? W : D;
    dim(-a / 2, a / 2, -pad * 0.35, true, `${round(a)}`);
    const xr = u1 + pad * 0.18;
    dim(0, m.topZ, xr + pad * 0.5, false, `${round(m.topZ)}`);
    dim(0, m.worktopZ, xr, false, `${round(m.worktopZ)}`);
    if (p.lowerRing !== 'none') dim(0, p.lowerHeight, u0 - pad * 0.2, false, `${round(p.lowerHeight)}`, true);
  }
  o.push('</svg>');
  return o.join('');
}

export function drawingsSvg(m: Model) {
  const ref = Math.max(m.p.width, m.p.depth, m.topZ);
  return { top: drawing(m, 'top', 'Top', ref), front: drawing(m, 'front', 'Front', ref), side: drawing(m, 'side', 'Side (from the right)', ref) };
}
