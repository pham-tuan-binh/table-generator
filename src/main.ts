// One sidebar over the world. Everything lives in it: the selected part, every parameter,
// cameras, an assembly timeline, the parts list, view toggles and the downloads.
// The design is kept in the URL hash, so a link is the design.
import JSZip from 'jszip';
import { Params, DEFAULTS, MATERIALS, CAMERA_PRESETS, CASTERS, LIMITS, normalize, toHash, fromHash, clone, material, cameraPreset, PanelFace, Face } from './params.ts';
import { buildModel, Model, Part, round } from './model.ts';
import { createWorld, Hit, PlaceHit } from './world.ts';
import { bom, cutList, nest, checks, bomCsv, cost, joins } from './bom.ts';
import { bundle, cameraJson, Files } from './export/bundle.ts';
import { glb } from './export/glb.ts';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const $$ = <T extends HTMLElement = HTMLElement>(s: string, r: ParentNode = document) => [...r.querySelectorAll(s)] as T[];
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let P: Params = fromHash(location.hash.slice(1));
let M: Model = buildModel(P);
let sel: { id: string; place: PlaceHit | null } | null = null;
let pipCam: string | null = P.cameras[0]?.id ?? null, pipOn = true;
let stepIdx = -1;   // -1 = the finished table; otherwise an index into M.steps
let markOf: Record<string, string> = {};

// ------------------------------------------------------------------ fields
type Opt = [string | number, string];
interface F { key: keyof Params; label: string; type: 'num' | 'seg' | 'select' | 'bool' | 'color' | 'range'; unit?: string; options?: Opt[]; show?: (p: Params) => boolean; swatches?: string[] }
const FRAME_SW = ['#eef0f2', '#d4d7db', '#9a9fa6', '#4b5058', '#232427'];
const PANEL_SW = ['#f4f4f2', '#dfe2e6', '#b9bec6', '#cfe3ee', '#2b2c30'];
const BOARD_SW = ['#2f3a52', '#3d4a66', '#a9aeb5', '#f3f3f1', '#d9b98c'];
const MAT_OPTS: Opt[] = MATERIALS.map(m => [m.id, m.name]);
const FIELDS: Record<string, F> = Object.fromEntries(([
  { key: 'width', label: 'Width', type: 'num', unit: 'mm' },
  { key: 'depth', label: 'Depth', type: 'num', unit: 'mm' },
  { key: 'tableHeight', label: 'Table height', type: 'num', unit: 'mm' },
  { key: 'boxHeight', label: 'Box height', type: 'num', unit: 'mm' },
  { key: 'load', label: 'Load on the worktop', type: 'num', unit: 'kg' },
  { key: 'shelfLoad', label: 'Load on the shelf', type: 'num', unit: 'kg', show: p => p.shelf },
  { key: 'shelf', label: 'Storage shelf', type: 'bool' },
  { key: 'lowerRing', label: 'Lower rails', type: 'seg', options: [['full', 'All sides'], ['sides-back', 'Open front'], ['none', 'None']], show: p => !p.shelf },
  { key: 'lowerHeight', label: 'Shelf height', type: 'num', unit: 'mm', show: p => p.lowerRing !== 'none' },
  { key: 'supports', label: 'Worktop supports', type: 'seg', options: [[-1, 'Auto'], [0, '0'], [1, '1'], [2, '2'], [3, '3'], [4, '4']] },
  { key: 'overheadBar', label: 'Overhead camera bar', type: 'bool' },
  { key: 'overheadBarY', label: 'Bar position', type: 'num', unit: 'mm', show: p => p.overheadBar },
  { key: 'base', label: 'Base', type: 'seg', options: [['feet', 'Feet'], ['casters', 'Casters']] },
  { key: 'casterWheel', label: 'Wheel', type: 'seg', options: Object.keys(CASTERS).map(k => [Number(k), `Ø${k}`]), show: p => p.base === 'casters' },
  { key: 'panelMaterial', label: 'Wall material', type: 'select', options: MAT_OPTS },
  { key: 'panelThk', label: 'Wall thickness', type: 'num', unit: 'mm' },
  { key: 'worktop', label: 'Worktop board', type: 'bool' },
  { key: 'worktopMaterial', label: 'Worktop material', type: 'select', options: MAT_OPTS, show: p => p.worktop },
  { key: 'worktopThk', label: 'Worktop thickness', type: 'num', unit: 'mm', show: p => p.worktop },
  { key: 'shelfMaterial', label: 'Shelf material', type: 'select', options: MAT_OPTS, show: p => p.shelf },
  { key: 'shelfThk', label: 'Shelf thickness', type: 'num', unit: 'mm', show: p => p.shelf },
  { key: 'frameColor', label: 'Extrusion', type: 'color', swatches: FRAME_SW },
  { key: 'panelColor', label: 'Walls', type: 'color', swatches: PANEL_SW },
  { key: 'worktopColor', label: 'Worktop', type: 'color', swatches: BOARD_SW },
  { key: 'shelfColor', label: 'Shelf', type: 'color', swatches: BOARD_SW },
  { key: 'panelOpacity', label: 'Wall opacity', type: 'range' },
  { key: 'stockLength', label: 'Buy extrusion as', type: 'select', options: [[0, 'Cut to length'], [500, '500 mm bars'], [1000, '1000 mm bars'], [1500, '1500 mm bars'], [2000, '2000 mm bars'], [3000, '3000 mm bars']] },
  { key: 'kerf', label: 'Saw kerf', type: 'num', unit: 'mm', show: p => p.stockLength > 0 },
] as F[]).map(f => [f.key, f]));
const LIM: Record<string, { min: number; max: number; step: number }> = LIMITS as any;
const pct = (k: string, v: number) => { const l = LIM[k]; return l ? `${((v - l.min) / (l.max - l.min)) * 100}%` : '50%'; };

function field(key: keyof Params, label?: string): string {
  const f = FIELDS[key], v = P[key] as unknown, lab = esc(label ?? f.label), row = (inner: string) => `<div class="row" data-row="${key}">${inner}</div>`;
  if (f.type === 'bool') return row(`<label class="switch"><span>${lab}</span><input type="checkbox" data-k="${key}" ${v ? 'checked' : ''}></label>`);
  if (f.type === 'seg') return row(`<div class="row-h"><span class="l">${lab}</span></div><div class="seg" role="group" aria-label="${lab}">${f.options!.map(([o, l]) => `<button type="button" data-k="${key}" data-v="${o}" aria-pressed="${String(o) === String(v)}">${esc(l)}</button>`).join('')}</div>`);
  if (f.type === 'select') return row(`<div class="row-h"><span class="l">${lab}</span></div><select class="sel" data-k="${key}" aria-label="${lab}">${f.options!.map(([o, l]) => `<option value="${o}" ${String(o) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>`);
  if (f.type === 'color') return row(`<div class="row-h"><span class="l">${lab}</span></div><div class="swatches">${f.swatches!.map(c => `<button type="button" class="sw" style="background:${c}" data-k="${key}" data-v="${c}" aria-pressed="${c === v}" aria-label="${c}"></button>`).join('')}<label class="sw custom" title="Custom colour"><input type="color" data-k="${key}" value="${esc(v)}" aria-label="Custom ${lab} colour"></label></div>`);
  const l = LIM[key]!;
  if (f.type === 'range') return row(`<div class="row-h"><span class="l">${lab}</span><span class="num"><i data-out="${key}">${Math.round(Number(v) * 100)}%</i></span></div><input type="range" data-k="${key}" min="${l.min}" max="${l.max}" step="${l.step}" value="${v}" style="--p:${pct(key, Number(v))}" aria-label="${lab}">`);
  return row(`<div class="row-h"><label class="l" for="n-${key}">${lab}</label><span class="num"><input id="n-${key}" type="number" inputmode="decimal" data-k="${key}" value="${v}" min="${l.min}" max="${l.max}" step="${l.step}"><i>${esc(f.unit || '')}</i></span></div><input type="range" data-k="${key}" min="${l.min}" max="${l.max}" step="${l.step}" value="${v}" style="--p:${pct(key, Number(v))}" aria-label="${lab}" tabindex="-1">`);
}
const walls = () => `<div class="row"><div class="row-h"><span class="l">Walls</span></div><div class="pills">${(['back', 'left', 'right', 'front', 'roof'] as PanelFace[]).map(k => `<label><input type="checkbox" data-panel="${k}" ${P.panels[k] ? 'checked' : ''}><span>${k[0].toUpperCase() + k.slice(1)}</span></label>`).join('')}</div></div>`;

// ------------------------------------------------------------------ sidebar
function renderSide() {
  const open = store.get<Record<string, boolean>>('tg:open2', { size: true });
  const sec = (id: string, name: string, body: string) => `<details class="sec" data-sec="${id}" ${open[id] ? 'open' : ''}><summary>${name}</summary><div>${body}</div></details>`;
  const k = (...keys: (keyof Params)[]) => keys.map(x => field(x)).join('');
  $('#form').innerHTML = [
    sec('checks', 'Checks', `<div class="checks" id="checks"></div>`),
    sec('size', 'Size and load', k('width', 'depth', 'tableHeight', 'boxHeight', 'load') + `<p class="note" id="sizing"></p>`),
    sec('structure', 'Structure', k('shelf', 'shelfLoad', 'lowerRing', 'lowerHeight', 'supports', 'overheadBar', 'overheadBarY', 'base', 'casterWheel')),
    sec('walls', 'Walls and boards', walls() + k('panelMaterial', 'panelThk', 'worktop', 'worktopMaterial', 'worktopThk', 'shelfMaterial', 'shelfThk')),
    sec('colours', 'Colours', k('frameColor', 'panelColor', 'worktopColor', 'shelfColor', 'panelOpacity')),
    sec('cameras', 'Cameras', `<div id="cam-list" class="list"></div><button type="button" class="add" id="cam-add">Add a camera</button>`),
    sec('assembly', 'Assembly', `<div class="timeline" id="timeline"></div>`),
    sec('parts', 'Parts list', `<div id="parts"></div>${k('stockLength', 'kerf')}`),
    sec('view', 'View', `<div class="seg" role="group" aria-label="View">${[['iso', '3/4'], ['front', 'Front'], ['side', 'Side'], ['top', 'Top']].map(([v, l]) => `<button type="button" data-view="${v}">${l}</button>`).join('')}</div>
      <label class="switch"><span>Realistic materials</span><input type="checkbox" id="v-real" ${store.get('tg:real', true) ? 'checked' : ''}></label>
      <label class="switch"><span>See through walls</span><input type="checkbox" id="v-xray"></label>
      <label class="switch"><span>Exploded</span><input type="checkbox" id="v-explode"></label>
      <label class="switch"><span>Camera preview</span><input type="checkbox" id="v-pip" ${pipOn ? 'checked' : ''}></label>`),
  ].join('');
  $$<HTMLDetailsElement>('details.sec').forEach(d => d.addEventListener('toggle', () => {
    open[d.dataset.sec!] = d.open; store.set('tg:open2', open);
    if (d.dataset.sec === 'assembly' && !d.open) { stopPlay(); setStep(-1); }
  }));
  $('#v-xray').addEventListener('change', e => world.setXray((e.target as HTMLInputElement).checked));
  $('#v-real').addEventListener('change', e => { const on = (e.target as HTMLInputElement).checked; store.set('tg:real', on); world.setRealistic(on); });
  $('#v-explode').addEventListener('change', e => world.setExplode((e.target as HTMLInputElement).checked));
  $('#v-pip').addEventListener('change', e => { pipOn = (e.target as HTMLInputElement).checked; syncPip(); });
  renderDynamic();
  syncAll();
}

// the parts of the sidebar that are lists, redrawn on every change
function renderDynamic() {
  $('#cam-list').innerHTML = M.cameras.map(c => `<button type="button" class="cam-item" data-pick="cam_${c.spec.id}"><b>${esc(c.spec.name)}</b><small>${c.spec.width}×${c.spec.height} · ${c.hfov.toFixed(0)}°</small></button>`).join('');
  renderTimeline();
  const cuts = cutList(M), metres = cuts.reduce((a, c) => a + c.length * c.qty, 0) / 1000, lines = bom(M);
  const stock = P.stockLength ? nest(M) : null;
  $('#parts').innerHTML = `<div class="stats"><div class="stat"><b>${round(metres)} m</b><span>extrusion</span></div><div class="stat"><b>${round(M.mass)} kg</b><span>total</span></div><div class="stat"><b>${'$' + Math.round(cost(M))}</b><span>frame, rough</span></div></div>
    <p class="sub">Cut list</p><div class="list">${cuts.map(c => `<div class="li"><span class="mark">${c.mark}</span><span class="t">${c.length} mm<small>${esc([...new Set(c.names.map(n => n.split(',')[0]))].join(', '))}${c.taps ? ` · ${esc(c.taps)}` : ''}</small></span><span class="q">×${c.qty}</span></div>`).join('')}</div>
    ${stock ? `<p class="sub">${stock.bars.length} bars of ${P.stockLength} mm${stock.tooLong.length ? `, ${stock.tooLong.join(', ')} too long` : ''}</p>` : ''}
    <p class="sub">How it goes together</p><div class="steps-txt">${joins(M).map(j => `<p>${esc(j)}</p>`).join('')}</div>
    <p class="sub">Hardware and boards</p><div class="list">${lines.filter(l => l.group !== 'Extrusion').map(l => `<div class="li"><span class="t">${esc(l.item)}<small>${esc(l.spec)}</small></span><span class="q">×${l.qty}</span></div>`).join('')}</div>`;
  const z = M.sizing;
  $('#sizing').textContent = `Legs ${z.legs}, worktop rails ${z.rails}${z.supports ? ` with ${z.supports} support${z.supports > 1 ? 's' : ''}` : ''}${P.lowerRing !== 'none' ? `, ${P.shelf ? 'shelf' : 'lower'} rails ${z.lower}` : ''}, box ${z.box}. `
    + `Under ${P.load} kg the rails sag ${z.sag.toFixed(1)} mm and the worktop moves ${z.sway.toFixed(1)} mm when an arm pushes.`;
  // checks only show up when something needs attention
  const bad = checks(M).filter(c => !c.ok && c.level !== 'info');
  $('#checks').innerHTML = bad.map(c => `<div class="ck ${c.level}">${esc(c.text)}</div>`).join('');
  $<HTMLElement>('[data-sec=checks]').hidden = !bad.length;
  $<HTMLElement>('[data-sec=checks] summary').textContent = bad.length === 1 ? 'One thing to check' : `${bad.length} things to check`;
}

// push P into every bound control that is not being typed in
function syncAll() {
  for (const el of $$<HTMLInputElement | HTMLSelectElement | HTMLButtonElement>('[data-k]')) {
    const k = el.dataset.k as keyof Params, v = P[k] as unknown;
    if (el instanceof HTMLButtonElement) { el.setAttribute('aria-pressed', String(String(el.dataset.v) === String(v))); continue; }
    if (el === document.activeElement && (el as HTMLInputElement).type === 'number') continue;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v;
    else el.value = String(v);
    if ((el as HTMLInputElement).type === 'range') el.style.setProperty('--p', pct(k, Number(v)));
  }
  $$<HTMLElement>('[data-out]').forEach(o => (o.textContent = `${Math.round(Number(P[o.dataset.out as keyof Params]) * 100)}%`));
  $$<HTMLInputElement>('[data-panel]').forEach(c => (c.checked = P.panels[c.dataset.panel as PanelFace]));
  $$<HTMLElement>('[data-row]').forEach(r => { const f = FIELDS[r.dataset.row!]; r.hidden = !!f?.show && !f.show(P); });
}

function setParam(k: keyof Params, raw: unknown) {
  const def = DEFAULTS[k];
  const v = typeof def === 'number' ? Number(raw) : typeof def === 'boolean' ? !!raw : raw;
  if (typeof v === 'number' && !Number.isFinite(v)) return;
  (P as any)[k] = v;
  // a new material brings its usual thickness and colour
  if (k === 'panelMaterial') { const m = material(String(v)); P.panelThk = Math.min(m.thk, M.profs.box.slot - 0.5); P.panelColor = m.color; P.panelOpacity = m.opacity ?? 1; }
  if (k === 'worktopMaterial') { const m = material(String(v)); P.worktopThk = m.thk; P.worktopColor = m.color; }
  if (k === 'shelfMaterial') { const m = material(String(v)); P.shelfThk = m.thk; P.shelfColor = m.color; }
  update();
}

document.addEventListener('input', e => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.panel) { P.panels[el.dataset.panel as PanelFace] = el.checked; return update(); }
  if (el.dataset.cam) return camInput(el);
  if (el.id === 'tl') { stopPlay(); return setStep(Number(el.value) >= M.steps.length ? -1 : Number(el.value)); }
  if (el.dataset.k) setParam(el.dataset.k as keyof Params, el.type === 'checkbox' ? el.checked : el.value);
});
document.addEventListener('change', e => { if ((e.target as HTMLInputElement).type === 'number') syncAll(); });
document.addEventListener('click', e => {
  const t = e.target as HTMLElement;
  const kv = t.closest<HTMLButtonElement>('button[data-k]');
  if (kv) return setParam(kv.dataset.k as keyof Params, kv.dataset.v);
  const pick = t.closest<HTMLElement>('[data-pick]');
  if (pick) return selectPart(pick.dataset.pick!, null, true);
  const view = t.closest<HTMLElement>('[data-view]');
  if (view) return world.view(view.dataset.view!);
  const act = t.closest<HTMLElement>('[data-act]');
  if (act) return action(act.dataset.act!, act.dataset.arg);
  const face = t.closest<HTMLElement>('[data-cam-face]');
  if (face) return camSet(c => (c.face = face.dataset.camFace as Face));
  if (t.closest('#cam-add')) return addCamera();
  if (!t.closest('details.more')) $<HTMLDetailsElement>('details.more').open = false;
});

// ------------------------------------------------------------------ world
const tip = $('#tip');
const world = createWorld($('#world'), {
  onHover(h: Hit | null) {
    if (!h) { tip.hidden = true; return; }
    tip.hidden = false;
    tip.style.left = `${h.screen[0]}px`; tip.style.top = `${h.screen[1]}px`;
    tip.innerHTML = placing && h.place ? `Mount here<span>${esc(h.part.name)} · ${Math.round(h.place.along * 100)}%</span>` : `${esc(h.part.name)}<span>${esc(h.part.spec)}</span>`;
  },
  onSelect(h: Hit | null) { selectPart(h ? h.part.id : null, h?.place ?? null); },
});
let placing: ((h: PlaceHit) => void) | null = null;

// ------------------------------------------------------------------ the selected part
const ROLE_COLOR: Record<string, keyof Params> = { frame: 'frameColor', panel: 'panelColor', worktop: 'worktopColor', shelf: 'shelfColor' };
const colorOf = (p: Part) => { const k = ROLE_COLOR[p.role]; return k ? String(P[k]) : p.role === 'cam' ? '#1c2230' : p.role === 'hw' ? '#9a9ea5' : '#2a2b2f'; };
function selectPart(id: string | null, place: PlaceHit | null = null, focus = false) {
  sel = id ? { id, place } : null;
  world.select(id);
  if (id && focus) world.focus(id);
  if (id?.startsWith('cam_')) { pipCam = id.slice(4); syncPip(); }
  if (id) showSide(true);
  renderSelected();
  if (id) $('#side-b').scrollTo({ top: 0, behavior: 'smooth' });
}
function renderSelected() {
  const box = $('#selected'), part = sel && M.parts.find(p => p.id === sel!.id);
  if (!part) { box.innerHTML = ''; return; }
  const kind = part.kind === 'member' ? 'Extrusion' : part.role === 'panel' ? 'Wall' : part.kind === 'panel' ? 'Board' : part.kind === 'camera' ? 'Camera' : 'Hardware';
  let body = '';
  if (part.member) {
    body = field('frameColor', 'Colour, all extrusion') + `<div class="actions">${sel!.place ? `<button type="button" class="btn solid" data-act="mount-here">Mount a camera here</button>` : ''}<button type="button" class="btn" data-act="focus">Focus</button></div>`;
  } else if (part.role === 'panel') {
    const face = part.id.replace('panel_', '');
    body = field('panelColor', 'Colour, all walls') + field('panelOpacity') + `<div class="actions"><button type="button" class="btn quiet" data-act="remove-wall" data-arg="${face}">Remove this ${face === 'roof' ? 'roof' : 'wall'}</button></div>`;
  } else if (part.role === 'worktop' || part.role === 'shelf') {
    const w = part.role === 'worktop';
    body = field(w ? 'worktopColor' : 'shelfColor', 'Colour') + field(w ? 'worktopMaterial' : 'shelfMaterial', 'Material') + `<div class="actions"><button type="button" class="btn quiet" data-act="remove-board" data-arg="${part.role}">Remove the ${part.role}</button></div>`;
  } else if (part.kind === 'camera') body = cameraEditor(part.id.slice(4));
  else if (part.id.startsWith('foot') || part.id.startsWith('caster')) body = field('base') + field('casterWheel');
  const mark = markOf[part.id] || '', light = /^#(f|e|d|c)/i.test(colorOf(part));
  box.innerHTML = `<div class="selcard"><div class="selcard-h"><span class="chip" style="background:${colorOf(part)};color:${light ? '#1a47c9' : '#fff'}" title="${kind}">${mark}</span><div><b>${esc(part.name)}</b><span class="spec">${esc(part.spec)}</span></div><button type="button" class="icon-btn" data-act="deselect" aria-label="Deselect"><svg viewBox="0 0 16 16"><path d="M4 4l8 8M12 4l-8 8"/></svg></button></div>${body}</div>`;
  syncAll();
}

// ------------------------------------------------------------------ cameras
const FACE_NAME: Record<Face, string> = { '-z': 'Under', '+z': 'Top', '-y': 'Front', '+y': 'Back', '-x': 'Left', '+x': 'Right' };
function cameraEditor(id: string): string {
  const c = P.cameras.find(x => x.id === id);
  if (!c) return '';
  const num = (k: string, label: string, unit: string, v: number, step = 1) => `<div class="row-h"><label class="l">${label}</label><span class="num"><input type="number" data-cam="${id}" data-ck="${k}" value="${v}" step="${step}"><i>${unit}</i></span></div>`;
  return `<div class="row"><input class="txt" type="text" data-cam="${id}" data-ck="name" value="${esc(c.name)}" aria-label="Name" spellcheck="false"></div>
    <div class="row"><select class="sel" data-cam="${id}" data-ck="preset" aria-label="Camera model">${CAMERA_PRESETS.map(p => `<option value="${p.id}" ${p.id === c.preset ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></div>
    <div class="row">${num('width', 'Width', 'px', c.width)}${num('height', 'Height', 'px', c.height)}${num('hfov', 'Horizontal FOV', '°', c.hfov, 0.1)}</div>
    <div class="row"><div class="row-h"><span class="l">Along the ${esc((M.parts.find(p => p.id === c.mount)?.name || c.mount).split(',')[0].toLowerCase())}</span><span class="num"><i>${Math.round(c.along * 100)}%</i></span></div><input type="range" data-cam="${id}" data-ck="along" min="0" max="1" step="0.005" value="${c.along}" style="--p:${c.along * 100}%"></div>
    <div class="row"><div class="row-h"><span class="l">On its face</span></div><div class="seg">${(['-z', '+z', '-y', '+y', '-x', '+x'] as Face[]).map(f => `<button type="button" data-cam-face="${f}" aria-pressed="${f === c.face}">${FACE_NAME[f]}</button>`).join('')}</div></div>
    <div class="row"><div class="row-h"><span class="l">Looks at</span><span class="num" style="gap:4px">${[0, 1, 2].map(i => `<input type="number" data-cam="${id}" data-ck="target.${i}" value="${c.target[i]}" step="10" aria-label="${'xyz'[i]}" style="width:46px">`).join('')}<i>mm</i></span></div><small style="color:var(--fg3);font-size:11px">x, y, z from the centre of the worktop</small></div>
    <div class="actions"><button type="button" class="btn solid" data-act="move-cam">Move it</button><button type="button" class="btn" data-act="view-cam">Preview</button><button type="button" class="btn quiet" data-act="remove-cam">Remove</button></div>`;
}
function camSet(fn: (c: Params['cameras'][number]) => void) {
  const c = sel && P.cameras.find(x => `cam_${x.id}` === sel!.id);
  if (!c) return;
  fn(c);
  update(); renderSelected();
}
function camInput(el: HTMLInputElement) {
  const c = P.cameras.find(x => x.id === el.dataset.cam);
  if (!c) return;
  const k = el.dataset.ck!;
  if (k.startsWith('target.')) { c.target[Number(k.split('.')[1])] = parseFloat(el.value) || 0; c.aim = 'target'; }
  else if (k === 'name') c.name = el.value.trim() || c.id;
  else if (k === 'preset') { c.preset = el.value; if (el.value !== 'custom') { const p = cameraPreset(el.value); c.width = p.width; c.height = p.height; c.hfov = p.hfov; } }
  else { const v = parseFloat(el.value); if (!Number.isFinite(v)) return; (c as any)[k] = v; }
  if (k === 'along') { el.style.setProperty('--p', `${c.along * 100}%`); const i = el.parentElement!.querySelector('.num i'); if (i) i.textContent = `${Math.round(c.along * 100)}%`; }
  update();
  if (k === 'preset') renderSelected();
}
function startPlacing(id: string) {
  const c = P.cameras.find(x => x.id === id);
  $('#placing-name').textContent = c ? `“${c.name}”` : '';
  $('#placing').hidden = false;
  placing = h => {
    const cam = P.cameras.find(x => x.id === id);
    if (cam) Object.assign(cam, { mount: h.member, along: h.along, face: h.face });
    stopPlacing();
    update();
    selectPart(`cam_${id}`);
  };
  world.placeMode(placing);
}
function stopPlacing() { placing = null; world.placeMode(null); $('#placing').hidden = true; }
$('#placing-cancel').addEventListener('click', stopPlacing);
function newCamera(place: PlaceHit | null): string {
  let n = P.cameras.length + 1;
  while (P.cameras.some(c => c.id === `cam${n}`)) n++;
  const pre = CAMERA_PRESETS[0], id = `cam${n}`;
  P.cameras.push({ ...clone(DEFAULTS.cameras[0]), id, name: id, preset: pre.id, width: pre.width, height: pre.height, hfov: pre.hfov,
    mount: place?.member ?? 'post_FR', along: place?.along ?? 0.85, face: place?.face ?? '-y', standoff: 25, aim: 'target', target: [0, 0, 0] });
  pipCam = id;
  update();
  return id;
}
function addCamera() { startPlacing(newCamera(null)); }

function action(a: string, arg?: string) {
  const c = sel && P.cameras.find(x => `cam_${x.id}` === sel!.id);
  if (a === 'deselect') selectPart(null);
  if (a === 'focus' && sel) world.focus(sel.id);
  if (a === 'mount-here' && sel?.place) selectPart(`cam_${newCamera(sel.place)}`);
  if (a === 'remove-wall') { P.panels[arg as PanelFace] = false; selectPart(null); update(); }
  if (a === 'remove-board') { if (arg === 'worktop') P.worktop = false; else P.shelf = false; selectPart(null); update(); }
  if (a === 'move-cam' && c) startPlacing(c.id);
  if (a === 'view-cam' && c) { pipCam = c.id; pipOn = true; syncPip(); }
  if (a === 'remove-cam' && c) { P.cameras = P.cameras.filter(x => x !== c); selectPart(null); update(); }
}

// ------------------------------------------------------------------ assembly timeline
let playT = 0;
function setStep(i: number) {
  stepIdx = i;
  world.setStep(i < 0 ? null : M.steps[i].n);
  renderTimeline();
}
function renderTimeline() {
  const el = document.getElementById('timeline');
  if (!el) return;
  const n = M.steps.length, v = stepIdx < 0 ? n : stepIdx, s = stepIdx < 0 ? null : M.steps[stepIdx];
  const tl = document.getElementById('tl') as HTMLInputElement | null;
  if (tl && document.activeElement === tl) {   // dragging: only relabel
    el.querySelector('.tl-n')!.textContent = s ? `${stepIdx + 1} of ${n}` : 'Done';
    el.querySelector('.tl-t')!.textContent = s ? s.title : 'The finished table';
    tl.style.setProperty('--p', `${(v / n) * 100}%`);
    return;
  }
  el.innerHTML = `<div class="tl-h"><span class="tl-n">${s ? `${stepIdx + 1} of ${n}` : 'Done'}</span><span class="tl-t">${s ? esc(s.title) : 'The finished table'}</span><button type="button" class="icon-btn" id="tl-play" aria-label="${playT ? 'Pause' : 'Play the assembly'}">${playT ? '<svg viewBox="0 0 16 16"><path d="M5.5 3.5v9M10.5 3.5v9"/></svg>' : '<svg viewBox="0 0 16 16"><path d="M5 3.5l7 4.5-7 4.5z" fill="currentColor"/></svg>'}</button></div>
    <input type="range" id="tl" min="0" max="${n}" step="1" value="${v}" style="--p:${(v / n) * 100}%" aria-label="Assembly step">`;
  document.getElementById('tl-play')!.addEventListener('click', () => (playT ? stopPlay() : play()));
}
function play() {
  stopPlay();
  playT = window.setInterval(() => { if (stepIdx < 0 || stepIdx >= M.steps.length - 1) { stopPlay(); setStep(-1); } else setStep(stepIdx + 1); }, 1300);
  setStep(0);
}
function stopPlay() { if (!playT) return; clearInterval(playT); playT = 0; renderTimeline(); }

// ------------------------------------------------------------------ preview, sidebar
const pipSel = $<HTMLSelectElement>('#pip-select');
function syncPip() {
  if (!P.cameras.some(c => c.id === pipCam)) pipCam = P.cameras[0]?.id ?? null;
  const on = pipOn && !!pipCam;
  $('#pip').hidden = !on;
  const cb = document.getElementById('v-pip') as HTMLInputElement | null;
  if (cb) cb.checked = pipOn;
  pipSel.innerHTML = P.cameras.map(c => `<option value="${c.id}" ${c.id === pipCam ? 'selected' : ''}>${esc(c.name)}</option>`).join('');
  const pose = M.cameras.find(c => c.spec.id === pipCam);
  if (pose) $('#pip-view').style.aspectRatio = `${pose.spec.width} / ${pose.spec.height}`;
  world.showCamera(on ? pipCam : null, $('#pip-view'));
}
pipSel.addEventListener('change', () => { pipCam = pipSel.value; syncPip(); });
$('#pip-close').addEventListener('click', () => { pipOn = false; syncPip(); });
function showSide(on: boolean) {
  const was = !$('#side').hidden;
  $('#side').hidden = !on;
  $('#open-side').hidden = on;
  if (was !== on || !inited) world.setInsets(on && window.innerWidth > 700 ? 344 : 0, 0, 0, on && window.innerWidth <= 700 ? window.innerHeight * 0.56 : 0);
}
let inited = false;
$('#collapse').addEventListener('click', () => showSide(false));
$('#open-side').addEventListener('click', () => showSide(true));
document.addEventListener('keydown', e => {
  if (e.key !== 'Escape') return;
  if (placing) stopPlacing(); else if (sel) selectPart(null);
});

// ------------------------------------------------------------------ update
function update() {
  P = normalize(P);
  M = buildModel(P);
  P.profile = M.p.profile;
  markOf = Object.fromEntries(cutList(M).flatMap(c => c.ids.map(id => [id, c.mark])));
  const h = toHash(P);
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  world.setModel(M);
  if (stepIdx >= M.steps.length) stepIdx = -1;
  world.setStep(stepIdx < 0 ? null : M.steps[stepIdx].n);
  syncAll();
  renderDynamic();
  syncPip();
  if (sel && !M.parts.some(p => p.id === sel!.id)) selectPart(null);
  else if (sel) { const pt = M.parts.find(p => p.id === sel!.id)!; const sp = $('#selected .spec'); if (sp) sp.textContent = pt.spec; const ch = $<HTMLElement>('#selected .chip'); if (ch) ch.style.background = colorOf(pt); }
}

// ------------------------------------------------------------------ downloads
const baseName = () => `table_${Math.round(P.width)}x${Math.round(P.depth)}x${Math.round(M.topZ)}`;
function save(data: BlobPart, name: string, type = 'application/octet-stream') {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([data], { type }));
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 2000);
}
async function zip(files: Files, name: string) {
  const z = new JSZip(), root = z.folder(baseName())!;
  for (const [p, d] of Object.entries(files)) root.file(p, d);
  save(await z.generateAsync({ type: 'blob', compression: 'DEFLATE' }), name, 'application/zip');
}
const subset = (files: Files, pre: string) => Object.fromEntries(Object.entries(files).filter(([k]) => k.startsWith(pre)));
$$('[data-dl]').forEach(b => b.addEventListener('click', async () => {
  const k = b.dataset.dl!, n = baseName();
  $<HTMLDetailsElement>('details.more').open = false;
  if (k === 'zip') {
    toast('Preparing the download');
    const files = bundle(M, location.href);
    files['frame.glb'] = await glb(M);
    files['preview.png'] = await (await fetch(world.picture())).arrayBuffer();
    return zip(files, `${n}.zip`);
  }
  if (k === 'urdf') return zip(subset(bundle(M), 'urdf/'), `${n}_urdf.zip`);
  if (k === 'mjcf') return zip(subset(bundle(M), 'mjcf/'), `${n}_mjcf.zip`);
  if (k === 'usd') return save(bundle(M)['usd/frame.usda'] as string, `${n}.usda`, 'text/plain');
  if (k === 'glb') return save(await glb(M), `${n}.glb`, 'model/gltf-binary');
  if (k === 'bom') return save(bomCsv(M), `${n}_parts.csv`, 'text/csv');
  if (k === 'cams') return save(JSON.stringify(cameraJson(M), null, 2), `${n}_cameras.json`, 'application/json');
  if (k === 'png') return save(await (await fetch(world.picture())).blob(), `${n}.png`, 'image/png');
}));
$('#share').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Copy the address bar to share'); } });
$('#reset').addEventListener('click', () => { P = normalize({}); selectPart(null); stopPlay(); setStep(-1); renderSide(); update(); world.view('iso'); });
$<HTMLInputElement>('#load').addEventListener('change', async e => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try { P = normalize(JSON.parse(await file.text())); selectPart(null); renderSide(); update(); toast(`Loaded ${file.name}`); } catch { toast('That file is not a params.json'); }
});
let toastT = 0;
function toast(t: string) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = window.setTimeout(() => (el.hidden = true), 2200); }
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== toHash(P)) { P = fromHash(h); renderSide(); update(); } });

// ------------------------------------------------------------------ go
markOf = Object.fromEntries(cutList(M).flatMap(c => c.ids.map(id => [id, c.mark])));
renderSide();
world.setRealistic(store.get('tg:real', true));
update();
showSide(window.innerWidth > 700);
inited = true;
world.view('iso');
