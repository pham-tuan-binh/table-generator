// The page: the form, the two 3D views, every section, and the downloads. State lives in
// the URL hash so a design is a link.
import JSZip from 'jszip';
import { Params, DEFAULTS, PROFILES, MATERIALS, CAMERA_PRESETS, CASTERS, LIMITS, normalize, toHash, fromHash, clone, material, cameraPreset, CameraSpec, Face } from './params.ts';
import { buildModel, Model, round } from './model.ts';
import { createViewer, Viewer, PickInfo } from './viewer.ts';
import { bom, cutList, nest, checks, bomCsv } from './bom.ts';
import { drawingsSvg } from './drawings.ts';
import { bundle, cameraJson, readme, Files } from './export/bundle.ts';
import { glb } from './export/glb.ts';

const $ = <T extends HTMLElement = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) => String(s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
const store = {
  get<T>(k: string, d: T): T { try { const v = localStorage.getItem(k); return v == null ? d : JSON.parse(v); } catch { return d; } },
  set(k: string, v: unknown) { try { localStorage.setItem(k, JSON.stringify(v)); } catch { /* private mode */ } },
};

let P: Params = fromHash(location.hash.slice(1));
let M: Model = buildModel(P);
let pipCam: string | null = P.cameras[0]?.id ?? null;
let openCam: string | null = null;

// ------------------------------------------------------------------ form
type Field = {
  key: keyof Params; label: string; type: 'num' | 'select' | 'bool' | 'color' | 'range';
  unit?: string; options?: [string | number, string][]; hint?: string; show?: (p: Params) => boolean;
};
const opt = (o: Record<string, string>) => Object.entries(o) as [string, string][];
const GROUPS: [string, Field[]][] = [
  ['Size', [
    { key: 'width', label: 'Width', type: 'num', unit: 'mm', hint: 'outside, left to right' },
    { key: 'depth', label: 'Depth', type: 'num', unit: 'mm', hint: 'outside, front to back' },
    { key: 'tableHeight', label: 'Table height', type: 'num', unit: 'mm', hint: 'floor to the top of the worktop rails' },
    { key: 'boxHeight', label: 'Box height', type: 'num', unit: 'mm', hint: 'worktop rails to the top of the box' },
    { key: 'profile', label: 'Extrusion', type: 'select', options: Object.values(PROFILES).map(p => [p.id, p.name]) },
  ]],
  ['Below the worktop', [
    { key: 'shelf', label: 'Storage shelf', type: 'bool' },
    { key: 'lowerRing', label: 'Lower rails', type: 'select', options: opt({ full: 'All four sides', 'sides-back': 'Sides and back (open front)', none: 'None' }), show: p => !p.shelf, hint: 'reinforcement ring near the floor' },
    { key: 'lowerHeight', label: 'Shelf / lower rail height', type: 'num', unit: 'mm', show: p => p.lowerRing !== 'none' },
    { key: 'supports', label: 'Worktop supports', type: 'select', options: [[-1, 'Auto'], [0, 'None'], [1, '1'], [2, '2'], [3, '3'], [4, '4'], [5, '5'], [6, '6']], hint: 'bars front to back under the worktop' },
  ]],
  ['Base', [
    { key: 'base', label: 'Base', type: 'select', options: opt({ feet: 'Levelling feet', casters: 'Casters with brakes' }) },
    { key: 'casterWheel', label: 'Caster wheel', type: 'select', options: Object.keys(CASTERS).map(k => [Number(k), `Ø${k} mm`]), show: p => p.base === 'casters' },
  ]],
  ['Box', [
    { key: 'overheadBar', label: 'Overhead camera bar', type: 'bool' },
    { key: 'overheadBarY', label: 'Bar position', type: 'num', unit: 'mm', hint: 'from the centre, + toward the back', show: p => p.overheadBar },
  ]],
  ['Panels', [
    { key: 'panelMaterial', label: 'Wall material', type: 'select', options: MATERIALS.map(m => [m.id, m.name]) },
    { key: 'panelThk', label: 'Wall thickness', type: 'num', unit: 'mm', hint: 'held in the slots' },
    { key: 'worktop', label: 'Worktop board', type: 'bool' },
    { key: 'worktopMaterial', label: 'Worktop material', type: 'select', options: MATERIALS.map(m => [m.id, m.name]), show: p => p.worktop },
    { key: 'worktopThk', label: 'Worktop thickness', type: 'num', unit: 'mm', show: p => p.worktop },
    { key: 'shelfMaterial', label: 'Shelf material', type: 'select', options: MATERIALS.map(m => [m.id, m.name]), show: p => p.shelf },
    { key: 'shelfThk', label: 'Shelf thickness', type: 'num', unit: 'mm', show: p => p.shelf },
  ]],
  ['Colours', [
    { key: 'frameColor', label: 'Extrusion', type: 'color' },
    { key: 'panelColor', label: 'Walls', type: 'color' },
    { key: 'worktopColor', label: 'Worktop and shelf', type: 'color' },
    { key: 'panelOpacity', label: 'Wall opacity', type: 'range' },
  ]],
  ['Stock', [
    { key: 'stockLength', label: 'Buy extrusion as', type: 'select', options: [[0, 'Cut to length'], [500, '500 mm bars'], [1000, '1000 mm bars'], [1500, '1500 mm bars'], [2000, '2000 mm bars'], [3000, '3000 mm bars']] },
    { key: 'kerf', label: 'Saw kerf', type: 'num', unit: 'mm', show: p => p.stockLength > 0 },
  ]],
];
const FRAME_COLORS: [string, string][] = [['#c4c7cb', 'Silver'], ['#26272a', 'Black'], ['#d8a028', 'Gold'], ['#3d6fb6', 'Blue']];

function fieldHtml(f: Field): string {
  const v = P[f.key] as unknown, id = `f-${f.key}`, lim = LIMITS[f.key];
  const hint = f.hint || (lim && f.type === 'num' ? `${lim.min}–${lim.max}` : '');
  const small = hint ? `<small>${esc(hint)}</small>` : '';
  const wrap = (inner: string, cls = 'field') => `<label class="${cls}" for="${id}" data-row="${f.key}">${inner}</label>`;
  if (f.type === 'bool') return wrap(`<input type="checkbox" id="${id}" data-k="${f.key}" ${v ? 'checked' : ''}><span>${esc(f.label)}</span>`, 'field check');
  if (f.type === 'select') return wrap(`<span>${esc(f.label)}</span><select id="${id}" data-k="${f.key}">${f.options!.map(([o, l]) => `<option value="${esc(o)}" ${String(o) === String(v) ? 'selected' : ''}>${esc(l)}</option>`).join('')}</select>${small}`);
  if (f.type === 'color') {
    const sw = f.key === 'frameColor' ? `<span class="dls">${FRAME_COLORS.map(([c, n]) => `<button type="button" class="btn sm" data-swatch="${c}" title="${n}" style="padding:3px 6px"><span style="display:inline-block;width:12px;height:12px;background:${c};border:1px solid #0003"></span></button>`).join('')}</span>` : '';
    return wrap(`<span>${esc(f.label)}</span><span style="display:inline-flex;gap:6px;align-items:center">${sw}<input type="color" id="${id}" data-k="${f.key}" value="${esc(v)}"></span>`);
  }
  if (f.type === 'range') return wrap(`<span>${esc(f.label)}</span><input type="range" id="${id}" data-k="${f.key}" min="${lim!.min}" max="${lim!.max}" step="${lim!.step}" value="${v}">`);
  return wrap(`<span>${esc(f.label)}</span><span class="inp"><input type="number" inputmode="decimal" id="${id}" data-k="${f.key}" value="${v}" min="${lim?.min ?? ''}" max="${lim?.max ?? ''}" step="${lim?.step ?? 1}"><i>${esc(f.unit || '')}</i></span>${small}`);
}

function renderForm() {
  const walls = (['back', 'left', 'right', 'front', 'roof'] as const).map(k => `<label><input type="checkbox" data-panel="${k}" ${P.panels[k] ? 'checked' : ''}>${k[0].toUpperCase() + k.slice(1)}</label>`).join('');
  $('#form').innerHTML = GROUPS.map(([g, fs]) => `<fieldset><legend>${esc(g)}</legend>${g === 'Panels' ? `<div class="checks-row" role="group" aria-label="Box walls">${walls}</div>` : ''}${fs.map(fieldHtml).join('')}</fieldset>`).join('')
    + `<fieldset><legend>Cameras</legend><div id="cam-list"></div><div class="cam-act"><button type="button" class="btn" id="cam-add">+ Add camera</button></div></fieldset>`;
  renderCams();
  syncVisibility();
}
function syncVisibility() {
  for (const [, fs] of GROUPS) for (const f of fs) {
    const row = document.querySelector<HTMLElement>(`[data-row="${f.key}"]`);
    if (row) row.hidden = !!f.show && !f.show(P);
  }
}
// put normalized values back into the inputs that are not being typed in
function syncForm() {
  for (const el of document.querySelectorAll<HTMLInputElement | HTMLSelectElement>('#form [data-k]')) {
    if (el === document.activeElement && el.type === 'number') continue;
    const v = P[el.dataset.k as keyof Params] as unknown;
    if (el instanceof HTMLInputElement && el.type === 'checkbox') el.checked = !!v; else el.value = String(v);
  }
  syncVisibility();
}

$('#form').addEventListener('input', e => {
  const el = e.target as HTMLInputElement;
  if (el.dataset.panel) { P.panels[el.dataset.panel as keyof Params['panels']] = el.checked; return update(); }
  if (el.dataset.cam) return camInput(el);
  const k = el.dataset.k as keyof Params;
  if (!k) return;
  const def = DEFAULTS[k];
  let v: unknown = el.type === 'checkbox' ? el.checked : typeof def === 'number' ? parseFloat(el.value) : el.value;
  if (typeof v === 'number' && !Number.isFinite(v)) return;
  (P as any)[k] = v;
  // a new material brings its usual thickness and colour
  if (k === 'panelMaterial') { const m = material(String(v)); P.panelThk = Math.min(m.thk, PROFILES[P.profile].slot - 0.5); P.panelColor = m.color; P.panelOpacity = m.opacity ?? 1; }
  if (k === 'worktopMaterial') { const m = material(String(v)); P.worktopThk = m.thk; P.worktopColor = m.color; }
  if (k === 'shelfMaterial') P.shelfThk = material(String(v)).thk;
  update(el.type !== 'number');
});
$('#form').addEventListener('change', e => { if ((e.target as HTMLInputElement).type === 'number') syncForm(); });
$('#form').addEventListener('click', e => {
  const t = e.target as HTMLElement, sw = t.closest<HTMLElement>('[data-swatch]');
  if (sw) { P.frameColor = sw.dataset.swatch!; update(true); }
  if (t.id === 'cam-add') addCamera();
  const act = t.closest<HTMLElement>('[data-act]');
  if (act) camAction(act.dataset.act!, act.dataset.id!);
});

// ------------------------------------------------------------------ cameras
const FACES: Face[] = ['-z', '+z', '-y', '+y', '-x', '+x'];
const FACE_NAME: Record<Face, string> = { '-z': 'underside (−z)', '+z': 'top (+z)', '-y': 'front (−y)', '+y': 'back (+y)', '-x': 'left (−x)', '+x': 'right (+x)' };
function memberOptions(sel: string) {
  const members = M.parts.filter(p => p.member);
  const has = members.some(m => m.id === sel);
  return (has ? '' : `<option value="${esc(sel)}" selected>(missing) ${esc(sel)}</option>`) + members.map(m => `<option value="${m.id}" ${m.id === sel ? 'selected' : ''}>${esc(m.name)}</option>`).join('');
}
function camNum(c: CameraSpec, key: string, label: string, unit: string, v: number, step = 1, extra = '') {
  return `<label class="field"><span>${label}</span><span class="inp"><input type="number" data-cam="${c.id}" data-ck="${key}" value="${v}" step="${step}" ${extra}><i>${unit}</i></span></label>`;
}
function renderCams() {
  const list = $('#cam-list');
  if (!list) return;
  list.innerHTML = P.cameras.map(c => {
    const pose = M.cameras.find(x => x.spec.id === c.id);
    return `<details class="cam-card" data-card="${c.id}" ${openCam === c.id ? 'open' : ''}>
      <summary><span class="dot" style="${pipCam === c.id ? '' : 'opacity:.35'}"></span>${esc(c.name)}<small>${c.width}×${c.height} · ${pose ? pose.hfov.toFixed(0) : c.hfov}°</small></summary>
      <div class="cam-body">
        <label class="field"><span>Name</span><input type="text" data-cam="${c.id}" data-ck="name" value="${esc(c.name)}" spellcheck="false"></label>
        <label class="field"><span>Camera</span><select data-cam="${c.id}" data-ck="preset">${CAMERA_PRESETS.map(p => `<option value="${p.id}" ${p.id === c.preset ? 'selected' : ''}>${esc(p.name)}</option>`).join('')}</select></label>
        ${camNum(c, 'width', 'Width', 'px', c.width)}${camNum(c, 'height', 'Height', 'px', c.height)}${camNum(c, 'hfov', 'Horizontal FOV', '°', c.hfov, 0.1)}
        ${camNum(c, 'rate', 'Frame rate', 'Hz', c.rate)}
        <label class="field"><span>Mounted on</span><select data-cam="${c.id}" data-ck="mount">${memberOptions(c.mount)}</select></label>
        <label class="field"><span>Along it</span><input type="range" data-cam="${c.id}" data-ck="along" min="0" max="1" step="0.005" value="${c.along}"><small>${Math.round(c.along * 100)}% from its start</small></label>
        <label class="field"><span>On its face</span><select data-cam="${c.id}" data-ck="face">${FACES.map(f => `<option value="${f}" ${f === c.face ? 'selected' : ''}>${FACE_NAME[f]}</option>`).join('')}</select></label>
        ${camNum(c, 'standoff', 'Stand-off', 'mm', c.standoff)}
        <label class="field"><span>Aim</span><select data-cam="${c.id}" data-ck="aim"><option value="target" ${c.aim === 'target' ? 'selected' : ''}>Look at a point</option><option value="angles" ${c.aim === 'angles' ? 'selected' : ''}>Yaw / pitch / roll</option></select></label>
        ${c.aim === 'target'
          ? `<div class="field"><span>Look at</span><span class="xyz">${['x', 'y', 'z'].map((a, i) => `<span class="inp"><input type="number" data-cam="${c.id}" data-ck="target.${i}" value="${c.target[i]}" step="10" aria-label="${a}"><i>${a}</i></span>`).join('')}</span><small>mm from the centre of the worktop surface</small></div>`
          : `${camNum(c, 'yaw', 'Yaw', '°', c.yaw)}${camNum(c, 'pitch', 'Pitch (down +)', '°', c.pitch)}`}
        ${camNum(c, 'roll', 'Roll', '°', c.roll)}
        <div class="cam-act">
          <button type="button" class="btn sm" data-act="place" data-id="${c.id}">Place on frame</button>
          <button type="button" class="btn sm" data-act="view" data-id="${c.id}" aria-pressed="${pipCam === c.id}">Show view</button>
          <button type="button" class="btn sm" data-act="remove" data-id="${c.id}">Remove</button>
        </div>
      </div></details>`;
  }).join('');
  list.querySelectorAll<HTMLDetailsElement>('details').forEach(d => d.addEventListener('toggle', () => {
    if (d.open) { openCam = d.dataset.card!; if (pipCam !== openCam) { pipCam = openCam; viewers.forEach(v => v.showCamera(pipCam)); list.querySelectorAll('[data-act=view]').forEach(b => b.setAttribute('aria-pressed', String((b as HTMLElement).dataset.id === pipCam))); } }
    else if (openCam === d.dataset.card) openCam = null;
  }));
}
function camInput(el: HTMLInputElement) {
  const c = P.cameras.find(x => x.id === el.dataset.cam)!, k = el.dataset.ck!;
  if (k.startsWith('target.')) c.target[Number(k.split('.')[1])] = parseFloat(el.value) || 0;
  else if (['name', 'mount', 'face', 'aim', 'preset'].includes(k)) (c as any)[k] = el.value;
  else { const v = parseFloat(el.value); if (!Number.isFinite(v)) return; (c as any)[k] = v; }
  if (k === 'preset' && el.value !== 'custom') { const p = cameraPreset(el.value); c.width = p.width; c.height = p.height; c.hfov = p.hfov; }
  if (k === 'aim' && el.value === 'angles') { const pose = M.cameras.find(x => x.spec.id === c.id); if (pose) { c.yaw = Math.round(Math.atan2(pose.f[1], pose.f[0]) * 180 / Math.PI); c.pitch = Math.round(Math.asin(-pose.f[2]) * 180 / Math.PI); } }
  if (k === 'name') c.name = el.value.trim() || c.id;
  if (k === 'along') { const sm = el.parentElement!.querySelector('small'); if (sm) sm.textContent = `${Math.round(c.along * 100)}% from its start`; }
  update(false, ['preset', 'aim', 'mount'].includes(k));
}
function addCamera() {
  let n = P.cameras.length + 1;
  while (P.cameras.some(c => c.id === `cam${n}`)) n++;
  const pre = CAMERA_PRESETS[0];
  P.cameras.push({ ...clone(DEFAULTS.cameras[0]), id: `cam${n}`, name: `cam${n}`, preset: pre.id, width: pre.width, height: pre.height, hfov: pre.hfov,
    mount: 'post_FR', along: 0.85, face: '-y', standoff: 25, aim: 'target', target: [0, 0, 0] });
  openCam = pipCam = `cam${n}`;
  update(true, true);
  camAction('place', `cam${n}`);
}
function camAction(act: string, id: string) {
  const c = P.cameras.find(x => x.id === id);
  if (!c) return;
  if (act === 'remove') { P.cameras = P.cameras.filter(x => x.id !== id); if (pipCam === id) pipCam = P.cameras[0]?.id ?? null; update(true, true); }
  if (act === 'view') { pipCam = pipCam === id ? null : id; viewers.forEach(v => v.showCamera(pipCam)); renderCams(); }
  if (act === 'place') {
    $('#placing-name').textContent = `"${c.name}"`;
    $('#placing').hidden = false;
    $('#viewer').scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    main.placeMode(hit => {
      c.mount = hit.member; c.along = hit.along; c.face = hit.face;
      main.placeMode(null); $('#placing').hidden = true;
      pipCam = id; openCam = id;
      update(true, true);
    });
  }
}
$('#placing-cancel').addEventListener('click', () => { main.placeMode(null); $('#placing').hidden = true; });

// ------------------------------------------------------------------ viewers
const pick = $('#pick');
const onPick = (p: PickInfo | null) => {
  pick.hidden = !p;
  if (p) pick.innerHTML = `${esc(p.name)}${markOf[p.id] ? ` · <b>${markOf[p.id]}</b>` : ''}<small>${esc(p.spec)}</small>`;
};
const main: Viewer = createViewer($('#viewer'), { onPick, pip: true });
const stepsView: Viewer = createViewer($('#viewer-steps'));
const viewers = [main, stepsView];
document.querySelectorAll<HTMLElement>('.cams [data-cam]').forEach(b => b.addEventListener('click', () => main.view(b.dataset.cam!)));
const colors = () => ({ frame: P.frameColor, panel: P.panelColor, worktop: P.worktopColor, panelOpacity: P.panelOpacity });
let markOf: Record<string, string> = {};

// ------------------------------------------------------------------ update
let sectionTimer = 0, lastColors = '';
function update(syncInputs = false, rebuildCams = false) {
  P = normalize(P);
  M = buildModel(P);
  markOf = Object.fromEntries(cutList(M).flatMap(c => c.ids.map(id => [id, c.mark])));
  const h = toHash(P);
  history.replaceState(null, '', h ? `#${h}` : location.pathname + location.search);
  const cs = JSON.stringify(colors());
  if (cs !== lastColors) { viewers.forEach(v => v.setColors(colors())); lastColors = cs; }
  viewers.forEach(v => { v.showCamera(v === main ? pipCam : null); v.setModel(M, colors()); });
  if (syncInputs) syncForm(); else syncVisibility();
  if (rebuildCams) renderCams();
  else for (const c of P.cameras) {   // refresh the summary line and mount list without losing focus
    const card = document.querySelector(`[data-card="${c.id}"] summary small`), pose = M.cameras.find(x => x.spec.id === c.id);
    if (card && pose) card.textContent = `${c.width}×${c.height} · ${pose.hfov.toFixed(0)}°`;
    const sel = document.querySelector<HTMLSelectElement>(`[data-cam="${c.id}"][data-ck="mount"]`);
    if (sel && sel !== document.activeElement && sel.options.length !== M.parts.filter(p => p.member).length) sel.innerHTML = memberOptions(c.mount);
  }
  $('#title').textContent = `Robot test table, ${round(P.width)} × ${round(P.depth)} × ${round(M.topZ)} mm`;
  clearTimeout(sectionTimer);
  sectionTimer = window.setTimeout(renderSections, 120);
}

// ------------------------------------------------------------------ sections
function renderSections() {
  const cks = checks(M), bad = cks.filter(c => !c.ok);
  const icon = (c: { ok: boolean; level: string }) => c.ok ? '✓' : c.level === 'error' ? '✗' : c.level === 'info' ? 'i' : '!';
  $('#checks-body').innerHTML = `<ul class="checks">${cks.map(c => `<li class="${c.ok ? 'ok' : c.level}"><span class="ic" aria-hidden="true">${icon(c)}</span><span>${esc(c.text)}</span></li>`).join('')}</ul>`;
  $('#toc-checks').textContent = bad.length ? `${bad.length} to look at` : 'all pass';

  const lines = bom(M);
  const groups = [...new Set(lines.map(l => l.group))];
  $('#bom-body').innerHTML = `<table class="doc"><thead><tr><th>Item</th><th>Spec</th><th class="n">Qty</th><th>Note</th></tr></thead><tbody>${groups.map(g => `<tr class="grp"><td colspan="4">${esc(g)}</td></tr>` + lines.filter(l => l.group === g).map(l => `<tr><td>${esc(l.item)}</td><td>${esc(l.spec)}</td><td class="n">${l.qty} ${esc(l.unit)}</td><td>${esc(l.note || '')}</td></tr>`).join('')).join('')}</tbody></table>`;
  const cuts = cutList(M), metres = cuts.reduce((a, c) => a + c.length * c.qty, 0) / 1000;
  $('#totals').textContent = `${round(metres)} m of ${M.prof.id} · ${cuts.reduce((a, c) => a + c.qty, 0)} pieces · about ${round(M.mass)} kg`;
  $('#toc-bom').textContent = `${lines.length} lines`;

  let cut = `<table class="doc"><thead><tr><th>Mark</th><th class="n">Length</th><th class="n">Qty</th><th>Parts</th><th>Machining</th></tr></thead><tbody>${cuts.map(c => `<tr><td class="mark">${c.mark}</td><td class="n">${c.length} mm</td><td class="n">${c.qty}</td><td>${esc([...new Set(c.names.map(n => n.split(',')[0]))].join(', '))}</td><td>${esc(c.taps)}</td></tr>`).join('')}</tbody></table>`;
  if (P.stockLength) {
    const { bars, tooLong } = nest(M);
    cut += `<h3>From ${P.stockLength} mm bars</h3><p class="totals">${bars.length} bars, kerf ${P.kerf} mm${tooLong.length ? ` · ${tooLong.join(', ')} too long for the stock` : ''}</p><div class="bars">${bars.map(b => `<div class="bar">${b.cuts.map(c => `<span style="width:${(c.length / P.stockLength) * 100}%">${c.mark} ${c.length}</span>`).join('')}<span class="waste" style="flex:1">${b.waste > 40 ? b.waste : ''}</span></div>`).join('')}</div>`;
  }
  $('#cut-body').innerHTML = cut;
  $('#toc-cut').textContent = `${cuts.length} lengths`;

  const d = drawingsSvg(M);
  $('#drawings-body').innerHTML = `<figure class="v-top">${d.top}</figure><figure>${d.front}</figure><figure>${d.side}</figure>`;

  $('#cams-body').innerHTML = M.cameras.length ? `<table class="doc"><thead><tr><th>Camera</th><th>Image</th><th>Intrinsics</th><th>Position (mm)</th><th>Looking</th><th>Mount</th></tr></thead><tbody>${M.cameras.map(c => `<tr>
    <td><b>${esc(c.spec.name)}</b><small>${esc(cameraPreset(c.spec.preset).name)}</small></td>
    <td>${c.spec.width}×${c.spec.height}<small>${c.hfov.toFixed(1)}° × ${c.vfov.toFixed(1)}° @ ${c.spec.rate} Hz</small></td>
    <td>fx = fy = ${c.fx.toFixed(1)}<small>cx ${c.cx}, cy ${c.cy}</small></td>
    <td>${c.pos.map(v => Math.round(v)).join(', ')}<small>worktop at z ${round(M.worktopZ)}</small></td>
    <td>${c.f.map(v => v.toFixed(2)).join(', ')}<small>forward unit vector</small></td>
    <td>${esc(M.parts.find(p => p.id === c.spec.mount)?.name || c.spec.mount)}<small>${Math.round(c.spec.along * 100)}% along, ${FACE_NAME[c.spec.face]}, ${c.spec.standoff} mm off</small></td></tr>`).join('')}</tbody></table>
    <p>Every export carries these cameras: URDF links <code>&lt;name&gt;_camera_link</code> (x forward) and <code>&lt;name&gt;_camera_optical_frame</code> (z forward) with a Gazebo sensor, MuJoCo <code>&lt;camera&gt;</code> with <code>fovy</code> and <code>resolution</code>, USD <code>Camera</code> prims, glTF cameras, and <code>cameras.json</code> with K and the pose in ROS, OpenCV and OpenGL conventions.</p>`
    : '<p>No cameras. Add one in the form.</p>';
  $('#toc-cams').textContent = `${M.cameras.length} camera${M.cameras.length === 1 ? '' : 's'}`;

  const z = (M.worktopZ / 1000).toFixed(3);
  $('#sim-body').innerHTML = `<p>The table is one static body. Its origin is on the floor under the table centre, z up, x across the width, y toward the back. Mount your robot at <code>worktop_frame</code>, the centre of the worktop surface, z = ${z} m. Colliders are boxes (one per extrusion, board and foot); visuals are the real T-slot profile.</p>
  <div class="sim-grid">
    <div class="sim-card"><h3>MuJoCo</h3><p>Load <code>mjcf/scene.xml</code>. Cameras render at their resolution.</p><pre class="code">python -m mujoco.viewer --mjcf=mjcf/scene.xml</pre><pre class="code">&lt;!-- your robot on the worktop --&gt;
&lt;body name="robot_base" pos="0 0 ${z}"&gt;...&lt;/body&gt;</pre></div>
    <div class="sim-card"><h3>URDF (ROS, Isaac, PyBullet, Gazebo)</h3><p><code>urdf/frame.urdf</code> with its <code>meshes/</code>. Fix your arm to the worktop:</p><pre class="code">&lt;joint name="table_to_robot" type="fixed"&gt;
  &lt;parent link="worktop_frame"/&gt;
  &lt;child link="robot_base_link"/&gt;
&lt;/joint&gt;</pre></div>
    <div class="sim-card"><h3>OpenUSD (Isaac Sim, Omniverse)</h3><p><code>usd/frame.usda</code>: z up, metres, PBR materials, static colliders with <code>PhysicsCollisionAPI</code>, cameras. Self-contained.</p><pre class="code">usdview usd/frame.usda</pre></div>
    <div class="sim-card"><h3>glTF (Blender, web)</h3><p><code>frame.glb</code>: y up, metres, colours, cameras as glTF cameras. Good for renders and three.js.</p></div>
  </div>`;

  renderSteps();
}

function renderSteps() {
  const key = `table-generator:ticks`, ticks = store.get<Record<string, boolean>>(key, {});
  $('#steps-body').innerHTML = M.steps.map(s => {
    const parts = M.parts.filter(p => p.step === s.n && p.kind !== 'hardware');
    const hw = M.parts.filter(p => p.step === s.n && p.kind === 'hardware').length;
    const byMark: Record<string, number> = {};
    for (const p of parts) { const k = markOf[p.id] ? `${markOf[p.id]} · ${p.name.split(',')[0]}` : p.name; byMark[k] = (byMark[k] || 0) + 1; }
    const list = Object.entries(byMark).map(([k, n]) => `<b>${esc(k)}</b>${n > 1 ? ` ×${n}` : ''}`).join(', ');
    return `<article class="step" data-step="${s.n}" id="step-${s.n}">
      <div class="step-h"><div class="sn">${s.n}</div><div><h3>${esc(s.title)}</h3><p>Step ${s.n} of ${M.steps.length}</p></div></div>
      <ol class="tasks">${s.tasks.map((t, i) => { const id = `t-${s.n}-${i}`; return `<li><input type="checkbox" id="${id}" data-tick="${id}" ${ticks[id] ? 'checked' : ''}><label for="${id}">${esc(t)}</label></li>`; }).join('')}</ol>
      ${s.warn ? `<p class="note"><span class="ic" aria-hidden="true">!</span><span>${esc(s.warn)}</span></p>` : ''}
      ${s.check ? `<p class="gate"><span class="ic" aria-hidden="true">✓</span><span>${esc(s.check)}</span></p>` : ''}
      ${list ? `<p class="parts">New in this step: ${list}${hw ? `, ${hw} brackets/hardware` : ''}</p>` : ''}
    </article>`;
  }).join('');
  $('#steps-body').querySelectorAll<HTMLInputElement>('[data-tick]').forEach(cb => cb.addEventListener('change', () => { ticks[cb.dataset.tick!] = cb.checked; store.set(key, ticks); }));
  $('#toc-steps').textContent = `${M.steps.length} steps`;
  watchSteps();
}

let stepObs: IntersectionObserver | null = null;
const seen = new Map<number, number>();
function watchSteps() {
  stepObs?.disconnect();
  seen.clear();
  stepObs = new IntersectionObserver(es => {
    for (const e of es) seen.set(Number((e.target as HTMLElement).dataset.step), e.intersectionRatio);
    const best = [...seen.entries()].sort((a, b) => b[1] - a[1])[0];
    if (best && best[1] > 0) showStep(best[0]);
  }, { threshold: [0, 0.25, 0.5, 0.75, 1], rootMargin: '-15% 0px -35% 0px' });
  document.querySelectorAll('.step').forEach(s => stepObs!.observe(s));
  showStep(curStep && M.steps.some(s => s.n === curStep) ? curStep : M.steps[0].n);
}
let curStep = 0;
function showStep(n: number) {
  curStep = n;
  const s = M.steps.find(x => x.n === n)!;
  const last = Math.max(...M.steps.map(x => x.n));
  stepsView.setStep(n === last ? null : n, M.parts.some(p => p.step === n) ? n : null);
  $('#step-3d-cap').textContent = `Step ${n}: ${s.title}`;
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
$('#dl-zip').addEventListener('click', async () => {
  toast('Building the zip…');
  const files = bundle(M, location.href);
  files['frame.glb'] = await glb(M);
  files['preview.png'] = await (await fetch(main.picture())).arrayBuffer();
  await zip(files, `${baseName()}.zip`);
  toast('Downloaded');
});
document.querySelectorAll<HTMLElement>('[data-dl]').forEach(b => b.addEventListener('click', async () => {
  const k = b.dataset.dl!, n = baseName();
  if (k === 'urdf') return zip(subset(bundle(M), 'urdf/'), `${n}_urdf.zip`);
  if (k === 'mjcf') return zip(subset(bundle(M), 'mjcf/'), `${n}_mjcf.zip`);
  if (k === 'usd') return save(bundle(M)['usd/frame.usda'] as string, `${n}.usda`, 'text/plain');
  if (k === 'glb') return save(await glb(M), `${n}.glb`, 'model/gltf-binary');
  if (k === 'bom') return save(bomCsv(M), `${n}_bom.csv`, 'text/csv');
  if (k === 'cams') return save(JSON.stringify(cameraJson(M), null, 2), `${n}_cameras.json`, 'application/json');
  if (k === 'md') return save(readme(M, location.href), `${n}_build_plan.md`, 'text/markdown');
}));
$('#copy-link').addEventListener('click', async () => { try { await navigator.clipboard.writeText(location.href); toast('Link copied'); } catch { toast('Copy the address bar to share'); } });
$('#reset').addEventListener('click', () => { P = normalize({}); pipCam = P.cameras[0]?.id ?? null; renderForm(); update(true, true); });
$<HTMLInputElement>('#load').addEventListener('change', async e => {
  const file = (e.target as HTMLInputElement).files?.[0];
  if (!file) return;
  try { P = normalize(JSON.parse(await file.text())); pipCam = P.cameras[0]?.id ?? null; renderForm(); update(true, true); toast(`Loaded ${file.name}`); }
  catch { toast('That file is not a params.json'); }
});
let toastT = 0;
function toast(t: string) { const el = $('#toast'); el.textContent = t; el.hidden = false; clearTimeout(toastT); toastT = window.setTimeout(() => (el.hidden = true), 2200); }
window.addEventListener('hashchange', () => { const h = location.hash.slice(1); if (h !== toHash(P)) { P = fromHash(h); renderForm(); update(true, true); } });

// ------------------------------------------------------------------ go
renderForm();
update(true, true);
renderSections();
