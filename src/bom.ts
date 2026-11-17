// Bill of materials, cut list (with stock nesting) and design checks from the model.
import { Model, Part, round } from './model.ts';
import { material, cameraPreset } from './params.ts';

export interface BomLine { group: string; item: string; spec: string; qty: number; unit: string; note?: string }
export interface Cut { mark: string; length: number; qty: number; ids: string[]; names: string[]; taps: string }
export interface StockBar { cuts: { mark: string; length: number }[]; waste: number }
export interface Check { ok: boolean; level: 'error' | 'warn' | 'info'; text: string }

export function cutList(m: Model): Cut[] {
  const groups = new Map<number, Part[]>();
  for (const pt of m.parts) if (pt.kind === 'member') {
    const L = round(pt.member!.length);
    groups.set(L, [...(groups.get(L) || []), pt]);
  }
  return [...groups.entries()].sort((a, b) => b[0] - a[0]).map(([length, pts], i) => ({
    mark: String.fromCharCode(65 + i), length, qty: pts.length, ids: pts.map(p => p.id), names: pts.map(p => p.name),
    taps: pts[0].id.startsWith('post') ? `${m.prof.endTap} tap, bottom end` : '',
  }));
}
export const markOf = (m: Model) => Object.fromEntries(cutList(m).flatMap(c => c.ids.map(id => [id, c.mark])));

// first-fit decreasing into stock bars, kerf between cuts
export function nest(m: Model): { bars: StockBar[]; tooLong: string[] } {
  const L = m.p.stockLength;
  if (!L) return { bars: [], tooLong: [] };
  const pieces = cutList(m).flatMap(c => Array.from({ length: c.qty }, () => ({ mark: c.mark, length: c.length }))).sort((a, b) => b.length - a.length);
  const bars: StockBar[] = [], tooLong: string[] = [];
  for (const pc of pieces) {
    if (pc.length > L) { tooLong.push(pc.mark); continue; }
    const used = (b: StockBar) => b.cuts.reduce((a, c) => a + c.length, 0) + m.p.kerf * b.cuts.length;
    const bar = bars.find(b => used(b) + pc.length <= L);
    if (bar) bar.cuts.push(pc); else bars.push({ cuts: [pc], waste: 0 });
  }
  for (const b of bars) b.waste = round(L - b.cuts.reduce((a, c) => a + c.length, 0) - m.p.kerf * (b.cuts.length - 1));
  return { bars, tooLong: [...new Set(tooLong)] };
}

export function bom(m: Model): BomLine[] {
  const p = m.p, prof = m.prof, out: BomLine[] = [];
  const count = (pre: string) => m.parts.filter(pt => pt.id.startsWith(pre)).length;
  // extrusion
  const cuts = cutList(m);
  const total = cuts.reduce((a, c) => a + c.length * c.qty, 0);
  if (p.stockLength) {
    const { bars } = nest(m);
    out.push({ group: 'Extrusion', item: `${prof.id} T-slot extrusion, stock`, spec: `${p.stockLength} mm lengths`, qty: bars.length, unit: 'pc', note: `${round(total / 1000)} m used of ${round((bars.length * p.stockLength) / 1000)} m` });
  } else for (const c of cuts) out.push({ group: 'Extrusion', item: `${prof.id} T-slot extrusion, cut to length`, spec: `${c.length} mm (mark ${c.mark})`, qty: c.qty, unit: 'pc', note: c.taps || undefined });

  // brackets and fasteners
  const corner = 4, lBr = count('bracket_');
  const boardScrews = (['worktop', 'shelf', 'panel_roof'] as const).filter(id => m.parts.some(pt => pt.id === id))
    .reduce((a, id) => a + (id === 'panel_roof' ? 4 : 2 * Math.ceil(p.width / 300) + 2 * Math.ceil(p.depth / 300)), 0);
  const camCount = m.cameras.length;
  out.push({ group: 'Brackets', item: `3-way corner bracket (${prof.id})`, spec: 'hidden / inside type, top corners', qty: corner, unit: 'pc' });
  if (lBr) out.push({ group: 'Brackets', item: `L bracket (${prof.id})`, spec: '2-hole inside corner bracket', qty: lBr, unit: 'pc' });
  const bracketScrews = corner * 3 + lBr * 2;
  out.push({ group: 'Fasteners', item: `${prof.screw} button-head screw`, spec: `${prof.screw === 'M5' ? 'M5×10' : prof.screw === 'M6' ? 'M6×12' : prof.screw === 'M8' ? 'M8×16' : '1/4-20 × 1/2"'}, for brackets`, qty: bracketScrews, unit: 'pc' });
  if (boardScrews) out.push({ group: 'Fasteners', item: `${prof.screw} countersunk screw`, spec: `${prof.screw} × ${Math.ceil((Math.max(p.worktop ? p.worktopThk : 0, p.shelf ? p.shelfThk : 0, p.panelThk) + 8) / 5) * 5} mm, for boards`, qty: boardScrews, unit: 'pc' });
  out.push({ group: 'Fasteners', item: prof.tnut, spec: 'drop-in (spring) type, so they fit after assembly', qty: bracketScrews + boardScrews + camCount * 2, unit: 'pc' });

  // base
  if (p.base === 'feet') out.push({ group: 'Base', item: 'Levelling foot', spec: `${prof.endTap} threaded stud, Ø40 base, ~${30} mm tall`, qty: 4, unit: 'pc' });
  else out.push({ group: 'Base', item: 'Swivel caster with brake', spec: `Ø${p.casterWheel} mm wheel, ${prof.endTap} threaded stem`, qty: 4, unit: 'pc', note: 'braked on all four' });

  // sheet goods
  for (const pt of m.parts.filter(q => q.kind === 'panel')) {
    const mat = material(pt.materialId!);
    out.push({ group: 'Panels', item: pt.name, spec: pt.spec, qty: 1, unit: 'pc', note: `${round(pt.mass)} kg${mat.cnc ? ', DXF in download' : ''}` });
  }
  // cameras
  for (const c of m.cameras) {
    const pre = cameraPreset(c.spec.preset);
    out.push({ group: 'Cameras', item: `Camera "${c.spec.name}"`, spec: `${pre.id === 'custom' ? 'Custom' : pre.name}, ${c.spec.width}×${c.spec.height}`, qty: 1, unit: 'pc' });
  }
  if (camCount) out.push({ group: 'Cameras', item: `Camera mount for ${prof.id} slot`, spec: `1/4-20 tripod screw, clamps with 2 × ${prof.screw} into T-nuts`, qty: camCount, unit: 'pc' });
  return out;
}

export function checks(m: Model): Check[] {
  const p = m.p, s = m.s, out: Check[] = [];
  const c = (ok: boolean, level: Check['level'], text: string) => out.push({ ok, level, text });
  const postL = m.topZ - m.baseH;
  if (p.stockLength) {
    const { tooLong } = nest(m);
    c(!tooLong.length, 'error', tooLong.length ? `Pieces ${tooLong.join(', ')} are longer than the ${p.stockLength} mm stock. Use longer stock or cut to length.` : `Every piece fits the ${p.stockLength} mm stock.`);
  }
  c(p.panelThk <= m.prof.slot - 0.3, 'error', p.panelThk <= m.prof.slot - 0.3 ? `${p.panelThk} mm walls fit the ${m.prof.slot} mm slot.` : `${p.panelThk} mm walls do not fit the ${m.prof.slot} mm slot of ${m.prof.id}. Use ${Math.floor((m.prof.slot - 0.3) * 2) / 2} mm or thinner.`);
  const ratio = m.topZ / Math.min(p.width, p.depth);
  c(ratio <= 2.5, 'warn', ratio <= 2.5 ? `Height is ${ratio.toFixed(1)}× the narrowest side: stable.` : `Height is ${ratio.toFixed(1)}× the narrowest side: it can tip. Widen the base or fix it to the wall.`);
  const slender = postL / s;
  c(slender <= 60 || p.lowerRing === 'full', 'warn', slender <= 60 || p.lowerRing === 'full' ? `Posts are braced (${round(postL)} mm long, ${m.prof.id}).` : `Posts are ${round(postL)} mm of ${m.prof.id} with no full lower ring: it will sway. Add the lower ring or use a bigger profile.`);
  if (p.base === 'casters') c(p.lowerRing === 'full', 'warn', p.lowerRing === 'full' ? 'Casters with a full lower ring: the legs are tied together.' : 'Casters without a full lower ring load the post ends sideways. Add the full lower ring.');
  const span = p.width - 2 * s;
  const sup = m.supportCount, free = span / (sup + 1);
  if (p.worktop) c(free <= 650 || p.worktopThk >= 18, 'warn', free <= 650 || p.worktopThk >= 18 ? `Worktop spans ${round(free)} mm between supports.` : `Worktop spans ${round(free)} mm between supports at ${p.worktopThk} mm: it will flex under an arm. Add supports or a thicker board.`);
  if (p.shelf) c(p.lowerHeight >= 80 + p.shelfThk, 'info', `Shelf is ${round(p.tableHeight - p.lowerHeight - (p.worktop ? 0 : 0) - s)} mm clear below the worktop rails.`);
  for (const cam of m.cameras) {
    if (!cam.valid) { c(false, 'error', `Camera "${cam.spec.name}": ${cam.note}.`); continue; }
    const [lo, hi] = m.bbox, inside = cam.pos.every((v, i) => v >= lo[i] - 300 && v <= hi[i] + 300);
    c(inside, 'warn', inside ? `Camera "${cam.spec.name}" mounted on ${m.parts.find(q => q.id === cam.spec.mount)?.name.toLowerCase()}.` : `Camera "${cam.spec.name}" sits far outside the frame.`);
  }
  if (p.panels.roof && m.cameras.some(cm => cm.pos[2] > m.topZ)) c(false, 'warn', 'A camera sits above the roof and will see only the roof.');
  return out;
}

export function bomCsv(m: Model): string {
  const rows = [['group', 'item', 'spec', 'qty', 'unit', 'note'], ...bom(m).map(l => [l.group, l.item, l.spec, String(l.qty), l.unit, l.note || ''])];
  return rows.map(r => r.map(v => /[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v).join(',')).join('\n') + '\n';
}
export function cutCsv(m: Model): string {
  return ['mark,length_mm,qty,taps,parts', ...cutList(m).map(c => `${c.mark},${c.length},${c.qty},${c.taps},"${c.names.join('; ')}"`)].join('\n') + '\n';
}
