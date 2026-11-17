// The launch video, rendered one frame at a time: window.frame(t) poses everything for
// time t (seconds) and renders. A field of tables, each with two YAM arms working
// ToyBlocks; the camera settles on one; parameters change one at a time in the app's own
// card and every table follows; then back out over the field, and download.
// Deterministic in t, so frames render in any order, in parallel.
import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { normalize, Params } from '../src/params.ts';
import { buildModel, Model } from '../src/model.ts';
import { partGeometries } from '../src/geometry.ts';
import { createStudio } from '../src/studio.ts';
import { createMaterials, worldUV } from '../src/surfaces.ts';
import { Bench, loadKit, Kit } from '../src/bench.ts';

export const FPS = 30, DURATION = 48;
const W = 1920, H = 1080;

const clamp = (x: number, a = 0, b = 1) => Math.min(b, Math.max(a, x));
const smooth = (x: number) => { x = clamp(x); return x * x * x * (x * (x * 6 - 15) + 10); };
const ramp = (t: number, t0: number, t1: number) => smooth((t - t0) / (t1 - t0));
const lerp = (a: number, b: number, k: number) => a + (b - a) * k;

// ------------------------------------------------------------------ the story
interface Beat { t0: number; t1: number; kind: 'slider' | 'seg'; sec: string; label: string; unit?: string; from?: number; to?: number; min?: number; max?: number; opts?: string[]; pick?: number }
const BEATS: Beat[] = [
  { t0: 10, t1: 15, kind: 'slider', sec: 'Size and load', label: 'Width', unit: 'mm', from: 1400, to: 1800, min: 300, max: 3000 },
  { t0: 15, t1: 20, kind: 'slider', sec: 'Size and load', label: 'Table height', unit: 'mm', from: 750, to: 900, min: 200, max: 1200 },
  { t0: 20, t1: 25, kind: 'slider', sec: 'Size and load', label: 'Box height', unit: 'mm', from: 750, to: 900, min: 150, max: 1500 },
  { t0: 25, t1: 30, kind: 'slider', sec: 'Size and load', label: 'Load on the worktop', unit: 'kg', from: 30, to: 120, min: 0, max: 300 },
  { t0: 30, t1: 34.5, kind: 'seg', sec: 'Structure', label: 'Base', opts: ['Feet', 'Casters'], pick: 1 },
];
const ACT0 = 1.2, ACT1 = 3.6;   // when, in each beat, the cursor works the control
const actK = (b: Beat, t: number) => ramp(t, b.t0 + ACT0, b.t0 + ACT1);
const clicked = (b: Beat, t: number) => t >= b.t0 + ACT0 + 0.5;

function paramsAt(t: number): Params {
  const v = (i: number) => { const b = BEATS[i]; return lerp(b.from!, b.to!, actK(b, t)); };
  return normalize({
    width: Math.round(v(0) / 10) * 10, depth: 800, tableHeight: Math.round(v(1) / 5) * 5, boxHeight: Math.round(v(2) / 5) * 5,
    load: Math.round(v(3) / 5) * 5, base: clicked(BEATS[4], t) ? 'casters' : 'feet', casterWheel: 75,
  });
}

// ------------------------------------------------------------------ scene
const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true });
renderer.setPixelRatio(1);
renderer.setSize(W, H);
document.body.prepend(renderer.domElement);
const scene = new THREE.Scene();
const studio = createStudio(renderer, scene);
const camera = new THREE.PerspectiveCamera(28, W / H, 0.05, 300);
const composer = new EffectComposer(renderer, new THREE.WebGLRenderTarget(W, H, { samples: 4, type: THREE.HalfFloatType }));
composer.addPass(new RenderPass(scene, camera));
const gtao = new GTAOPass(scene, camera, W, H);
gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.5, thickness: 1, scale: 1.2, samples: 12 });
gtao.blendIntensity = 0.85;
composer.addPass(gtao);
composer.addPass(new OutputPass());
const root = new THREE.Group();   // design space: mm, z up
root.rotation.x = -Math.PI / 2;
root.scale.setScalar(0.001);
scene.add(root);

const armMats = {
  body: new THREE.MeshPhysicalMaterial({ color: 0xf2f1ee, metalness: 0.05, roughness: 0.45, clearcoat: 0.2 }),
  dark: new THREE.MeshPhysicalMaterial({ color: 0x17181b, metalness: 0.35, roughness: 0.45 }),
};

// a table as one merged mesh per material: few draw calls, shared by every copy
const matCache = new Map<string, Record<string, THREE.Material>>();
function tableMeshes(m: Model): THREE.Group {
  const k = JSON.stringify([m.p.frameColor, m.p.panelColor, m.p.panelOpacity, m.p.panelMaterial, m.p.worktopMaterial, m.p.worktopColor, m.p.shelfColor]);
  let mats = matCache.get(k);
  if (!mats) { mats = createMaterials(m.p, true); matCache.set(k, mats); }
  const g = new THREE.Group(), byRole = new Map<string, THREE.BufferGeometry[]>();
  for (const part of m.parts) for (const geo of partGeometries(part, m, true)) {
    const flat = geo.index ? geo.toNonIndexed() : geo;
    flat.computeVertexNormals();
    worldUV(flat, part);
    byRole.set(part.role, [...(byRole.get(part.role) || []), flat]);
  }
  for (const [role, geos] of byRole) {
    const mesh = new THREE.Mesh(mergeGeometries(geos), mats[role]);
    mesh.castShadow = role !== 'panel' || m.p.panelOpacity > 0.6;
    mesh.receiveShadow = true;
    g.add(mesh);
  }
  return g;
}

// ------------------------------------------------------------------ the field
// The hero and the tables right around it are real: their own meshes, arms and blocks.
// Everything further out is instanced: one draw call per table material for the whole
// field, and the arms and blocks drawn from six animated template rigs, each repeated
// across the tables that use it. Detail is spent only where the camera can see it.
interface Station { group: THREE.Group; table: THREE.Group | null; bench: Bench; phase: number; ring: number }
interface Far { x: number; y: number; ring: number; tpl: number }
let hero: Station;
const near: Station[] = [], far: Far[] = [];
const TEMPLATES = 6;
const templates: { bench: Bench; holder: THREE.Group; phase: number; meshes: THREE.Mesh[]; inst: THREE.InstancedMesh[]; tables: Far[] }[] = [];
let farTables: THREE.InstancedMesh[] = [];
let tableKey = '';
const SX = 3100, SY = 2200;

async function setup() {
  const base = new URL('../', location.href).href;
  const [heroKit, crowdKit]: Kit[] = await Promise.all([loadKit(base + 'robots/yam/', base + 'toyblocks/', 'hero'), loadKit(base + 'robots/yam/', base + 'toyblocks/', 'crowd')]);
  const station = (kit: Kit, seed: number, x: number, y: number, phase: number, shadows: boolean, ring: number): Station => {
    const group = new THREE.Group(), bench = new Bench(kit, armMats, seed, shadows, 2);
    group.position.set(x, y, 0);
    group.add(bench.group);
    root.add(group);
    return { group, table: null, bench, phase, ring };
  };
  hero = station(heroKit, 1, 0, 0, 0, true, 0);
  // far wider and deeper than the frame, so the field has no edge
  for (let i = -13; i <= 13; i++) for (let j = -3; j <= 20; j++) {
    if (i === 0 && j === 0) continue;
    const ring = Math.max(Math.abs(i), Math.abs(j)), k = ((i + 13) * 7 + j + 3) % TEMPLATES;
    if (ring <= 1) near.push(station(crowdKit, 2 + k, i * SX, j * SY, k * 0.9, false, ring));
    else far.push({ x: i * SX, y: j * SY, ring, tpl: k });
  }
  // six template rigs, never drawn themselves; their poses are copied onto the far tables
  for (let k = 0; k < TEMPLATES; k++) {
    const holder = new THREE.Group(), bench = new Bench(crowdKit, armMats, 2 + k, false, 2);
    holder.add(bench.group);
    const meshes: THREE.Mesh[] = [];
    bench.group.traverse(o => { if ((o as THREE.Mesh).isMesh) meshes.push(o as THREE.Mesh); });
    const tables = far.filter(f => f.tpl === k);
    const inst = meshes.map(m => {
      const im = new THREE.InstancedMesh(m.geometry, m.material, tables.length);
      im.frustumCulled = false;
      im.castShadow = false; im.receiveShadow = true;
      root.add(im);
      return im;
    });
    templates.push({ bench, holder, phase: k * 0.9, meshes, inst, tables });
  }
  // distance haze in the backdrop's blue: the field dissolves instead of ending
  scene.fog = new THREE.Fog(0x2563e8, 36, 80);
  await studio.ready;
  await document.fonts.ready;
}

function placeTables(m: Model) {
  const key = JSON.stringify(m.p);
  if (key === tableKey) return;
  tableKey = key;
  const proto = tableMeshes(m);
  for (const s of [hero, ...near]) {
    if (s.table) { s.group.remove(s.table); if (s === hero) s.table.traverse(o => (o as THREE.Mesh).geometry?.dispose()); }
    s.table = s === hero ? proto : proto.clone();
    s.group.add(s.table);
    s.bench.group.position.z = m.worktopZ; s.bench.layout(m.p.depth);
  }
  for (const t of templates) { t.bench.group.position.z = m.worktopZ; t.bench.layout(m.p.depth); }
  // one instanced mesh per table material for every far table
  for (const im of farTables) root.remove(im);
  farTables = (proto.children as THREE.Mesh[]).map(mesh => {
    const im = new THREE.InstancedMesh(mesh.geometry, mesh.material, far.length);
    im.frustumCulled = false; im.castShadow = true; im.receiveShadow = true;
    root.add(im);
    return im;
  });
}

// sink-away factor of a table in its ring: 1 standing, 0 gone
function standing(ring: number, away: number) {
  const k = clamp(away * 1.6 - (6 - Math.min(6, ring)) * 0.1);
  return 1 - k * k * (3 - 2 * k);
}
const M4 = new THREE.Matrix4(), T4 = new THREE.Matrix4(), S4 = new THREE.Matrix4();
function placeField(t: number, away: number) {
  for (const s of near) {
    s.bench.update(t + s.phase);
    const e = standing(s.ring, away);
    s.group.visible = e > 0.002; s.group.scale.setScalar(Math.max(0.001, e));
  }
  const base = far.map(f => { const e = Math.max(0.001, standing(f.ring, away)); return T4.makeTranslation(f.x, f.y, 0).multiply(S4.makeScale(e, e, e)).clone(); });
  farTables.forEach(im => { far.forEach((_, i) => im.setMatrixAt(i, base[i])); im.instanceMatrix.needsUpdate = true; });
  for (const tp of templates) {
    tp.bench.update(t + tp.phase);
    tp.holder.updateMatrixWorld(true);
    tp.meshes.forEach((m, mi) => {
      const im = tp.inst[mi];
      im.visible = m.visible;
      tp.tables.forEach((f, i) => im.setMatrixAt(i, M4.copy(base[far.indexOf(f)]).multiply(m.matrixWorld)));
      im.instanceMatrix.needsUpdate = true;
    });
  }
}

// ------------------------------------------------------------------ the card and the cursor
const card = document.getElementById('card')!, cursor = document.getElementById('cursor-g')!;
let cardHtml = '';
function setCard(html: string) { if (html !== cardHtml) { card.innerHTML = html; cardHtml = html; } }
function ui(t: number, p: Params, m: Model) {
  let cur: [number, number] | null = null, press = false, show = 0;
  const b = BEATS.find(x => t >= x.t0 && t < x.t1);
  if (b) {
    show = Math.min(ramp(t, b.t0, b.t0 + 0.45), 1 - ramp(t, b.t1 - 0.45, b.t1));
    if (b.kind === 'slider') {
      const val = lerp(b.from!, b.to!, actK(b, t)), shown = b.unit === 'kg' ? p.load : Math.round(val / 10) * 10;
      const f = (val - b.min!) / (b.max! - b.min!);
      const extra = b.unit === 'kg' ? `<div class="row" style="margin-top:30px"><span>Legs</span><b>${m.sizing.legs}</b></div>` : '';
      setCard(`<div class="row"><span>${b.label}</span><span><b>${shown}</b><i>${b.unit}</i></span></div><div class="track"><div class="fill" style="width:${f * 100}%"></div><div class="thumb" style="left:${f * 100}%"></div></div>${extra}`);
      const th = card.querySelector('.thumb')!.getBoundingClientRect(), x = th.left + th.width / 2, y = th.top + th.height / 2;
      cur = t < b.t0 + ACT0 ? [lerp(x + 140, x, ramp(t, b.t0 + 0.2, b.t0 + ACT0 - 0.1)), lerp(y + 120, y, ramp(t, b.t0 + 0.2, b.t0 + ACT0 - 0.1))] : [x, y];
      press = t > b.t0 + ACT0 - 0.15 && t < b.t0 + ACT1 + 0.1;
    } else {
      const on = clicked(b, t) ? b.pick! : 1 - b.pick!;
      setCard(`<div class="row"><span>${b.label}</span></div><div class="seg">${b.opts!.map((o, i) => `<span class="${i === on ? 'on' : ''}">${o}</span>`).join('')}</div>`);
      const opt = card.querySelectorAll('.seg span')[b.pick!].getBoundingClientRect(), x = opt.left + opt.width / 2, y = opt.top + opt.height / 2;
      cur = [lerp(x + 120, x, ramp(t, b.t0 + 0.2, b.t0 + ACT0 + 0.3)), lerp(y + 140, y, ramp(t, b.t0 + 0.2, b.t0 + ACT0 + 0.3))];
      press = Math.abs(t - (b.t0 + ACT0 + 0.5)) < 0.12;
    }
  }
  // the download, as the camera pulls back
  const dl = Math.min(ramp(t, 34.8, 35.3), 1 - ramp(t, 38.4, 38.9));
  if (!b && dl > 0) {
    show = dl;
    const open = t > 36.2, sel = open ? Math.floor((t - 36.6) / 0.38) : -1;
    const rows = [['MuJoCo', '.zip'], ['URDF', '.zip'], ['OpenUSD', '.usda'], ['glTF', '.glb'], ['Parts list', '.csv']];
    setCard(`<div class="dl"><svg width="26" height="26" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8 2v8M4.5 6.5L8 10l3.5-3.5M2.5 13.5h11"/></svg>Download everything</div>${open ? `<div class="menu">${rows.map(([a, e], i) => `<div class="${i === sel ? 'on' : ''}"><b>${a}</b><span>${e}</span></div>`).join('')}</div>` : ''}`);
    const btn = card.querySelector('.dl')!.getBoundingClientRect(), x = btn.left + btn.width / 2, y = btn.top + btn.height / 2;
    const items = card.querySelectorAll('.menu div'), it = items[Math.max(0, Math.min(items.length - 1, sel))]?.getBoundingClientRect();
    cur = open && it ? [it.left + it.width * 0.4, it.top + it.height / 2] : [lerp(x + 160, x, ramp(t, 35.0, 35.9)), lerp(y + 160, y, ramp(t, 35.0, 35.9))];
    press = Math.abs(t - 36.1) < 0.12;
  }
  card.style.opacity = String(show);
  card.style.transform = `translate(${(1 - show) * -40}px, -50%)`;
  cursor.setAttribute('visibility', cur && show > 0.6 ? 'visible' : 'hidden');
  if (cur) cursor.setAttribute('transform', `translate(${cur[0]} ${cur[1]}) scale(${press ? 0.88 : 1})`);
}

// ------------------------------------------------------------------ one frame
function setHtml(id: string, s: string) { const el = document.getElementById(id)!; if (el.innerHTML !== s) el.innerHTML = s; }
function frame(t: number) {
  const p = paramsAt(t), m = buildModel(p);
  placeTables(m);
  hero.bench.update(t);
  // when the camera settles on one table the rest sink away, ring by ring, and rise again on the way out
  const away = ramp(t, 8.6, 10) * (1 - ramp(t, 38.8, 40.8));
  placeField(t, away);

  // camera: wide over the field, in to the hero (on the right, the card on the left),
  // and back out at the end
  const size = Math.max(p.width, p.depth * 1.6, m.topZ * 1.2) / 1000;
  const k = t < 25 ? ramp(t, 3.5, 9.5) : 1 - ramp(t, 38.6, 45);
    // wide: the field fills the lower part of the frame, the words get the open blue above it
  const wide = { az: t < 25 ? lerp(-30, -20, t / 10) : lerp(-14, -6, (t - 38.6) / 9.4), el: 13, dist: 19, tgt: new THREE.Vector3(0.4, 2.9, -5.5) };
  const close = { az: lerp(-36, 10, clamp((t - 9.5) / 25)), el: lerp(16, 12, clamp((t - 9.5) / 25)), dist: size * 1.95, tgt: new THREE.Vector3(0, (m.worktopZ / 1000) * 0.92, 0) };
  const az = lerp(wide.az, close.az, k), el = lerp(wide.el, close.el, k), dist = Math.exp(lerp(Math.log(wide.dist), Math.log(close.dist), k));
  const tgt = wide.tgt.clone().lerp(close.tgt, k);
  const ar = THREE.MathUtils.degToRad(az), er = THREE.MathUtils.degToRad(el);
  camera.position.copy(tgt).add(new THREE.Vector3(Math.sin(ar) * Math.cos(er), Math.sin(er), Math.cos(ar) * Math.cos(er)).multiplyScalar(dist));
  camera.lookAt(tgt);
  camera.setViewOffset(W, H, lerp(0, -W * 0.15, k), 0, W, H);
  gtao.enabled = k > 0.35;   // contact shading only matters close up
  studio.fit(lerp(9, size * 1.25, k), tgt.clone().setY(0));
  studio.rig(p.width / 1000, p.depth / 1000, m.topZ / 1000);

  // words: one large line in the open blue, at the start and at the end
  const title = document.getElementById('title')!;
  const opening = Math.min(ramp(t, 0.6, 1.4), 1 - ramp(t, 4.0, 4.8)), ending = ramp(t, 44.4, 45.4);
  if (opening > 0) { setHtml('title-h', 'Generate sim-ready assets for<br>aluminium-extrusion eval tables'); title.style.opacity = String(opening); }
  else if (ending > 0) { setHtml('title-h', 'URDF, MJCF, USD and a bill of materials,<br>from one design'); title.style.opacity = String(ending); }
  else title.style.opacity = '0';
  ui(t, p, m);
  composer.render();
}

declare global { interface Window { frame: (t: number) => void; ready: Promise<void>; DURATION: number; FPS: number } }
window.FPS = FPS; window.DURATION = DURATION;
window.frame = frame;
window.ready = setup().then(() => frame(0));
