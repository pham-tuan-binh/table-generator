// Bill of materials, cut list (with stock nesting) and design checks from the model.
import { Model, Part, round } from './model.ts';
import { material, cameraPreset, PROFILES, ProfileId } from './params.ts';
import { BRACKET_PRICE, boardSpan } from './structure.ts';

export interface BomLine { group: string; item: string; spec: string; qty: number; unit: string; note?: string }
export interface Cut { mark: string; prof: ProfileId; length: number; qty: number; ids: string[]; names: string[]; taps: string }
export interface StockBar { prof: ProfileId; cuts: { mark: string; length: number }[]; waste: number }
export interface Check { ok: boolean; level: 'error' | 'warn' | 'info'; text: string }

// one line per profile and length, largest profile first, longest first
export function cutList(m: Model): Cut[] {
  const groups = new Map<string, Part[]>();
  for (const pt of m.parts) if (pt.kind === 'member') {
    const key = `${pt.member!.prof}|${round(pt.member!.length)}`;
    groups.set(key, [...(groups.get(key) || []), pt]);
  }
  return [...groups.entries()]
    .map(([k, pts]) => ({ prof: k.split('|')[0] as ProfileId, length: Number(k.split('|')[1]), pts }))
    .sort((a, b) => PROFILES[b.prof].s - PROFILES[a.prof].s || b.length - a.length)
    .map(({ prof, length, pts }, i) => ({
      mark: String.fromCharCode(65 + i), prof, length, qty: pts.length, ids: pts.map(p => p.id), names: pts.map(p => p.name),
      taps: pts[0].id.startsWith('leg') ? `${PROFILES[prof].endTap} tap, bottom end` : '',
    }));
}
export const markOf = (m: Model) => Object.fromEntries(cutList(m).flatMap(c => c.ids.map(id => [id, c.mark])));

// first-fit decreasing into stock bars of each profile, kerf between cuts
export function nest(m: Model): { bars: StockBar[]; tooLong: string[] } {
  const L = m.p.stockLength;
  if (!L) return { bars: [], tooLong: [] };
  const bars: StockBar[] = [], tooLong: string[] = [];
  const used = (b: StockBar) => b.cuts.reduce((a, c) => a + c.length, 0) + m.p.kerf * b.cuts.length;
  const pieces = cutList(m).flatMap(c => Array.from({ length: c.qty }, () => ({ prof: c.prof, mark: c.mark, length: c.length }))).sort((a, b) => b.length - a.length);
  for (const pc of pieces) {
    if (pc.length > L) { tooLong.push(pc.mark); continue; }
    const bar = bars.find(b => b.prof === pc.prof && used(b) + pc.length <= L);
    if (bar) bar.cuts.push(pc); else bars.push({ prof: pc.prof, cuts: [pc], waste: 0 });
  }
  for (const b of bars) b.waste = round(L - b.cuts.reduce((a, c) => a + c.length, 0) - m.p.kerf * (b.cuts.length - 1));
  return { bars, tooLong: [...new Set(tooLong)] };
}

// rough material cost: extrusion by the metre plus brackets
export function cost(m: Model): number {
  const ext = m.parts.filter(p => p.member).reduce((a, p) => a + (p.member!.length / 1000) * PROFILES[p.member!.prof].price, 0);
  return ext + m.parts.filter(p => p.id.startsWith('bracket_')).length * BRACKET_PRICE + 4 * 4 + 8 * BRACKET_PRICE;
}

const SCREW: Record<string, string> = { M5: 'M5×10', M6: 'M6×12', M8: 'M8×16', '1/4-20': '1/4-20 × 1/2"' };

export const slotOf = (id: ProfileId) => Math.round(PROFILES[id].slot);

// every screw on the frame: which bracket, which thread, and which slot its T-nut drops into.
// A bracket is sized for the smaller of the two profiles it joins; its T-nuts match the slot
// of each profile they go into.
export function fastenings(m: Model) {
  const brackets: Record<string, number> = {}, nuts: Record<string, number> = {}, button: Record<string, number> = {}, countersunk: Record<string, number> = {};
  const add = (o: Record<string, number>, k: string, n = 1) => (o[k] = (o[k] || 0) + n);
  const smaller = (a: ProfileId, b: ProfileId) => (PROFILES[a].s <= PROFILES[b].s ? a : b);
  const joint = (a: ProfileId, b: ProfileId) => {
    const br = smaller(a, b), thread = PROFILES[br].screw;
    add(brackets, br); add(button, thread, 2);
    add(nuts, `${thread}|${slotOf(a)}`); add(nuts, `${thread}|${slotOf(b)}`);
  };
  const { legs, rails, lower, box } = m.profs;
  for (const br of m.parts.filter(q => q.id.startsWith('bracket_'))) {
    if (br.id.startsWith('bracket_post_')) { joint(box.id, rails.id); continue; }
    const host = br.id.replace(/^bracket_/, '').replace(/_[01]$/, '');
    const hp = m.parts.find(q => q.id === host)!.member!.prof;
    const other = host.startsWith('rail_') ? legs.id : host.startsWith('shelf_support') ? lower.id : host === 'bar_overhead' ? box.id : rails.id;
    joint(hp, other);
  }
  add(button, box.screw, 12); add(nuts, `${box.screw}|${slotOf(box.id)}`, 12);   // 3-way corners
  const boardN = 2 * Math.ceil(m.p.width / 300) + 2 * Math.ceil(m.p.depth / 300);
  const board = (prof: typeof rails, n: number) => { add(countersunk, prof.screw, n); add(nuts, `${prof.screw}|${slotOf(prof.id)}`, n); };
  if (m.p.worktop) board(rails, boardN);
  if (m.p.shelf) board(lower, boardN);
  if (m.p.panels.roof) board(box, 4);
  for (const c of m.cameras) { const mb = m.parts.find(q => q.id === c.spec.mount)?.member; if (mb) { add(button, PROFILES[mb.prof].screw, 2); add(nuts, `${PROFILES[mb.prof].screw}|${slotOf(mb.prof)}`, 2); } }
  return { brackets, nuts, button, countersunk };
}

const art = (n: number) => `${n === 8 || n === 18 ? 'an' : 'a'} ${n}`;
// how the frame goes together and what to buy for it, in plain sentences
export function joins(m: Model): string[] {
  const { legs, rails, lower, box } = m.profs, p = m.p, out: string[] = [];
  const used = [...new Set([legs.id, rails.id, ...(p.lowerRing !== 'none' ? [lower.id] : []), box.id])].sort();
  const bySlot = (n: number) => used.filter(id => slotOf(id) === n);
  const six = bySlot(6), eight = bySlot(8);
  out.push(`Buy ${[six.length ? `${six.join(' and ')} with a 6 mm slot` : '', eight.length ? `${eight.join(' and ')} with an 8 mm slot` : ''].filter(Boolean).join(', and ')}.` + (eight.length > 1 ? ` Get the 8 mm slot sizes from one maker so one kind of T-nut fits both.` : ''));
  const ring = (what: string, r: typeof rails) => r.id === legs.id
    ? `${what} to legs: one ${r.id} L bracket under each rail end, ${r.screw} screws into T-nuts in both.`
    : `${what} (${r.id}) to legs (${legs.id}): the rails run on the legs' centre lines, so a ${r.id} L bracket under each end reaches the legs' slot. Use ${r.screw} screws, with T-nuts for ${art(slotOf(r.id))} mm slot in the rail and ${art(slotOf(legs.id))} mm slot in the leg.`;
  out.push(ring('Worktop rails', rails));
  if (p.lowerRing !== 'none') out.push(ring(p.shelf ? 'Shelf rails' : 'Lower rails', lower));
  if (m.supportCount) out.push(`Worktop supports to rails: an L bracket on the side of each end, into the rails' inner slot.`);
  out.push(`Box posts (${box.id}) stand on the leg tops, centred on them, each held by two ${box.id} L brackets screwed into the worktop rails' top slots` + (rails.id !== box.id ? ` (${box.screw} T-nuts for ${art(slotOf(rails.id))} mm slot)` : '') + `. The worktop is notched at each corner to clear them.`);
  out.push(`Top corners of the box: 3-way hidden corner brackets for ${box.id}.`);
  out.push(`${p.base === 'feet' ? 'Feet' : 'Casters'}: tap the bottom end of each leg ${legs.endTap}.`);
  return out;
}

export function bom(m: Model): BomLine[] {
  const p = m.p, out: BomLine[] = [];
  // extrusion
  const cuts = cutList(m);
  if (p.stockLength) {
    const { bars } = nest(m);
    for (const id of [...new Set(bars.map(b => b.prof))]) {
      const mine = bars.filter(b => b.prof === id), usedMm = mine.reduce((a, b) => a + b.cuts.reduce((x, c) => x + c.length, 0), 0);
      out.push({ group: 'Extrusion', item: `${id} T-slot extrusion, ${slotOf(id as ProfileId)} mm slot, stock`, spec: `${p.stockLength} mm lengths`, qty: mine.length, unit: 'pc', note: `${round(usedMm / 1000)} m used of ${round((mine.length * p.stockLength) / 1000)} m` });
    }
  } else for (const c of cuts) out.push({ group: 'Extrusion', item: `${c.prof} T-slot extrusion, ${slotOf(c.prof)} mm slot, cut to length`, spec: `${c.length} mm (mark ${c.mark})`, qty: c.qty, unit: 'pc', note: c.taps || undefined });

  // brackets, and the screws and T-nuts each one needs, counted by the slot they go into
  const f = fastenings(m);
  for (const [prof, n] of Object.entries(f.brackets)) out.push({ group: 'Brackets', item: `L bracket for ${prof}`, spec: '2-hole inside corner bracket', qty: n, unit: 'pc' });
  out.push({ group: 'Brackets', item: `3-way corner bracket for ${m.profs.box.id}`, spec: 'hidden type, top corners of the box', qty: 4, unit: 'pc' });
  for (const [k, n] of Object.entries(f.nuts).sort()) { const [thread, slot] = k.split('|'); out.push({ group: 'Fasteners', item: `${thread} T-nut for ${slot} mm slot`, spec: 'drop-in type, fits after assembly', qty: n, unit: 'pc' }); }
  for (const [thread, n] of Object.entries(f.button)) out.push({ group: 'Fasteners', item: `${thread} button-head screw`, spec: `${SCREW[thread]}, for brackets`, qty: n, unit: 'pc' });
  for (const [thread, n] of Object.entries(f.countersunk)) out.push({ group: 'Fasteners', item: `${thread} countersunk screw`, spec: 'length = board thickness + 8 mm, for boards', qty: n, unit: 'pc' });

  // base
  const tap = m.profs.legs.endTap;
  if (p.base === 'feet') out.push({ group: 'Base', item: 'Levelling foot', spec: `${tap} threaded stud, Ø40 base, ~30 mm tall`, qty: 4, unit: 'pc' });
  else out.push({ group: 'Base', item: 'Swivel caster with brake', spec: `Ø${p.casterWheel} mm wheel, ${tap} threaded stem`, qty: 4, unit: 'pc', note: 'braked on all four' });

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
  if (m.cameras.length) out.push({ group: 'Cameras', item: 'Camera mount for T-slot', spec: '1/4-20 tripod screw, clamps with 2 screws into T-nuts', qty: m.cameras.length, unit: 'pc' });
  return out;
}

export function checks(m: Model): Check[] {
  const p = m.p, out: Check[] = [], box = m.profs.box;
  const c = (ok: boolean, level: Check['level'], text: string) => out.push({ ok, level, text });
  if (p.stockLength) {
    const { tooLong } = nest(m);
    c(!tooLong.length, 'error', tooLong.length ? `Pieces ${tooLong.join(', ')} are longer than the ${p.stockLength} mm stock. Use longer stock or cut to length.` : `Every piece fits the ${p.stockLength} mm stock.`);
  }
  c(p.panelThk <= box.slot - 0.3, 'error', p.panelThk <= box.slot - 0.3 ? `${p.panelThk} mm walls fit the ${box.slot} mm slot.` : `${p.panelThk} mm walls do not fit the ${box.slot} mm slot of the ${box.id} box frame. Use ${Math.floor((box.slot - 0.3) * 2) / 2} mm or thinner.`);
  const ratio = m.topZ / Math.min(p.width, p.depth);
  c(ratio <= 2.5, 'warn', ratio <= 2.5 ? `Height is ${ratio.toFixed(1)}× the narrowest side: stable.` : `Height is ${ratio.toFixed(1)}× the narrowest side: it can tip. Widen the base or fix it to the wall.`);
  const z = m.sizing;
  c(z.ok, 'error', z.ok ? `Carries ${p.load} kg: rails sag ${z.sag.toFixed(1)} mm, the worktop moves ${z.sway.toFixed(1)} mm, legs have a safety factor of ${z.buckling.toFixed(0)}.` : `Even 4040 is not enough for ${p.load} kg at this size (sag ${z.sag.toFixed(1)} of ${z.sagLimit.toFixed(1)} mm allowed, sway ${z.sway.toFixed(1)} mm). Add the lower rails or make it smaller.`);
  if (p.base === 'casters') c(p.lowerRing === 'full', 'warn', p.lowerRing === 'full' ? 'Casters with a full lower ring: the legs are tied together.' : 'Casters without a full lower ring load the post ends sideways. Add the full lower ring.');
  const free = (p.width - 2 * m.profs.legs.s) / (m.supportCount + 1), lim = boardSpan(p.worktopThk);
  if (p.worktop) c(free <= lim, 'warn', free <= lim ? `Worktop spans ${round(free)} mm between supports.` : `Worktop spans ${round(free)} mm between supports at ${p.worktopThk} mm: it will flex under an arm. Add supports or a thicker board.`);
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
