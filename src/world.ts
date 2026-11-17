// The world: a full-screen, physically lit studio with the table in it. Real T-slot
// geometry, soft shadows, environment reflections, hover and selection outlines, build-step
// animation, an exploded view, camera frustums and a live inset from any robot camera.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js';
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js';
import { OutlinePass } from 'three/examples/jsm/postprocessing/OutlinePass.js';
import { OutputPass } from 'three/examples/jsm/postprocessing/OutputPass.js';
import { GTAOPass } from 'three/examples/jsm/postprocessing/GTAOPass.js';
import { createStudio } from './studio.ts';
import { Bench, loadKit, BENCH_MIN_WIDTH } from './bench.ts';
import { Model, Part, V3 } from './model.ts';
import { partGeometries } from './geometry.ts';
import { Face } from './params.ts';
import { createMaterials, worldUV, onTextureLoad } from './surfaces.ts';

export interface PlaceHit { member: string; along: number; face: Face }
export interface Hit { part: Part; place: PlaceHit | null; screen: [number, number] }

const ACCENT = 0xffffff;

export { backdrop } from './studio.ts';

export function createWorld(el: HTMLElement, opts: { onHover?: (h: Hit | null) => void; onSelect?: (h: Hit | null) => void } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: false, preserveDrawingBuffer: true, powerPreference: 'high-performance' });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const studio = createStudio(renderer, scene, () => { dirty = true; });

  const camera = new THREE.PerspectiveCamera(32, 1, 0.02, 60);
  camera.position.set(-3.2, 2.2, 3.6);
  camera.layers.enable(2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.minDistance = 0.4;
  controls.maxDistance = 12;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.target.set(0, 0.6, 0);

  // design (mm, z up) inside a group turned into three's metres, y up
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(0.001);
  scene.add(root);
  const frusta = new THREE.Group();
  root.add(frusta);

  // post: render, outlines for hover and selection, tone mapping
  const target = new THREE.WebGLRenderTarget(1, 1, { samples: 4, type: THREE.HalfFloatType });
  const composer = new EffectComposer(renderer, target);
  composer.addPass(new RenderPass(scene, camera));
  // ambient occlusion: where parts meet and corners close in, light can't reach
  const gtao = new GTAOPass(scene, camera, 1, 1);
  gtao.updateGtaoMaterial({ radius: 0.12, distanceExponent: 1.5, thickness: 1, scale: 1.2, samples: 12 });
  gtao.blendIntensity = 0.85;
  composer.addPass(gtao);
  const selPass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
  Object.assign(selPass, { edgeStrength: 4, edgeGlow: 0, edgeThickness: 1, pulsePeriod: 0 });
  selPass.visibleEdgeColor.set(ACCENT); selPass.hiddenEdgeColor.set(0xffffff);
  const hovPass = new OutlinePass(new THREE.Vector2(1, 1), scene, camera);
  Object.assign(hovPass, { edgeStrength: 1.6, edgeGlow: 0, edgeThickness: 1 });
  hovPass.visibleEdgeColor.set(0xffffff); hovPass.hiddenEdgeColor.set(0xffffff);
  composer.addPass(hovPass);
  composer.addPass(selPass);
  composer.addPass(new OutputPass());

  interface Entry { mesh: THREE.Mesh; part: Part; home: THREE.Vector3; centre: THREE.Vector3 }
  let entries: Entry[] = [], model: Model | null = null;
  let mats: Record<string, THREE.Material> = {}, buildMats: Record<string, THREE.Material> = {};
  let xray = false, realistic = true;
  // a pair of YAM arms working ToyBlocks' stack-three task, loaded once in the background
  let bench: Bench | null = null, armsOn = true;
  const armMats = {
    body: new THREE.MeshPhysicalMaterial({ color: 0xf2f1ee, metalness: 0.05, roughness: 0.45, clearcoat: 0.2 }),   // white shells
    dark: new THREE.MeshPhysicalMaterial({ color: 0x17181b, metalness: 0.35, roughness: 0.45 }),     // anodised black: base, joints, wrist, gripper
  };
  loadKit(new URL('robots/yam/', document.baseURI).href, new URL('toyblocks/', document.baseURI).href, 'hero').then(kit => { bench = new Bench(kit, armMats); root.add(bench.group); placeBench(); }).catch(e => console.warn('arms:', e));
  function placeBench() {
    if (!bench || !model) return;
    const legs = model.profs.legs.s;
    const fits = model.p.width - 2 * legs >= BENCH_MIN_WIDTH && model.p.depth >= 380 && model.p.boxHeight >= 350;
    bench.group.visible = armsOn && fits && step == null && explodeTo === 0;
    bench.group.position.set(0, 0, model.worktopZ);
    bench.layout(model.p.depth);
    dirty = true;
  }
  onTextureLoad(() => { dirty = true; });
  const ghost = new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.07, depthWrite: false, side: THREE.DoubleSide });
  let step: number | null = null, explode = 0, explodeTo = 0, selected: string | null = null, hovered: string | null = null, pipCam: string | null = null;
  let placing: ((h: PlaceHit) => void) | null = null;
  const dropping = new Map<THREE.Mesh, number>();   // mesh -> start time of its drop-in
  let dirty = true;

  function makeMaterials(m: Model) {
    Object.values(mats).concat(Object.values(buildMats)).forEach(x => x.dispose());
    mats = createMaterials(m.p, realistic);
    // during assembly the earlier steps fade back; the current step stays solid
    buildMats = Object.fromEntries(Object.entries(mats).map(([k, mt]) => {
      const c = mt.clone() as THREE.MeshStandardMaterial;
      c.transparent = true; c.opacity = 0.22; c.depthWrite = false;
      return [k, c];
    }));
  }

  function setModel(m: Model) {
    const first = !model;
    model = m;
    makeMaterials(m);
    for (const e of entries) { root.remove(e.mesh); e.mesh.geometry.dispose(); }
    entries = [];
    for (const part of m.parts) for (const g of partGeometries(part, m, true)) {
      g.computeVertexNormals();
      worldUV(g, part);
      g.computeBoundingBox();
      const mesh = new THREE.Mesh(g, mats[part.role]);
      mesh.castShadow = part.role !== 'panel' || m.p.panelOpacity > 0.6;
      mesh.receiveShadow = true;
      mesh.userData.part = part.id;
      root.add(mesh);
      entries.push({ mesh, part, home: new THREE.Vector3(), centre: g.boundingBox!.getCenter(new THREE.Vector3()) });
    }
    buildFrusta(m);
    // shadow camera hugs the table
    const [lo, hi] = m.bbox, r = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 1000;
    studio.fit(r * 1.1, new THREE.Vector3((lo[0] + hi[0]) / 2000, 0, -(lo[1] + hi[1]) / 2000));
    studio.rig(m.p.width / 1000, m.p.depth / 1000, m.topZ / 1000);
    if (first) intro();
    placeBench();
    apply();
  }

  // each camera's view as a pyramid of faint ink-blue edges: reads against the white
  // walls and the blue backdrop alike without taking over
  const frustumEdge = (on: boolean) => new THREE.LineBasicMaterial({ color: 0x0b2a8f, transparent: true, opacity: on ? 0.5 : 0.22, depthTest: true });
  function buildFrusta(m: Model) {
    frusta.traverse(o => { const x = o as THREE.Mesh; x.geometry?.dispose(); (x.material as THREE.Material)?.dispose?.(); });
    frusta.clear();
    for (const c of m.cameras) {
      const d = 220, tx = Math.tan((c.hfov * Math.PI) / 360) * d, ty = Math.tan((c.vfov * Math.PI) / 360) * d;
      const o = new THREE.Vector3(...c.pos);
      const P = (a: number, b: number) => o.clone().add(new THREE.Vector3(...c.f).multiplyScalar(d)).add(new THREE.Vector3(...c.l).multiplyScalar(a)).add(new THREE.Vector3(...c.u).multiplyScalar(b));
      const k = [P(tx, ty), P(-tx, ty), P(-tx, -ty), P(tx, -ty)];
      const g = new THREE.Group();
      g.userData.cam = c.spec.id;
      const on = c.spec.id === pipCam;
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints([o, k[0], o, k[1], o, k[2], o, k[3], k[0], k[1], k[1], k[2], k[2], k[3], k[3], k[0]]), frustumEdge(on));
      line.layers.set(2); g.add(line);
      frusta.add(g);
    }
  }

  // visibility, materials and outlines for the current step / selection / explode
  function apply() {
    if (!model) return;
    const [lo, hi] = model.bbox, mid = new THREE.Vector3((lo[0] + hi[0]) / 2, (lo[1] + hi[1]) / 2, model.worktopZ);
    for (const e of entries) {
      const vis = step == null || e.part.step <= step;
      if (vis && !e.mesh.visible && step != null) dropping.set(e.mesh, performance.now());
      e.mesh.visible = vis;
      e.mesh.material = step != null && e.part.step < step ? buildMats[e.part.role] : xray && e.part.role === 'panel' ? ghost : mats[e.part.role];
      e.mesh.castShadow = !(xray && e.part.role === 'panel') && (e.part.role !== 'panel' || model.p.panelOpacity > 0.6);
      // exploded: every part pushed out from the middle, by kind
      const dir = e.centre.clone().sub(mid);
      e.home.set(dir.x * 0.45, dir.y * 0.6, dir.z * 0.35 + (e.part.kind === 'panel' ? 60 : 0));
    }
    frusta.visible = step == null || step >= 8;
    frusta.children.forEach(g => { const on = g.userData.cam === pipCam; const l = g.children[0] as THREE.LineSegments; (l.material as THREE.Material).opacity = on ? 0.5 : 0.22; });
    const meshesOf = (id: string | null) => (id ? entries.filter(e => e.part.id === id && e.mesh.visible).map(e => e.mesh) : []);
    selPass.selectedObjects = meshesOf(selected);
    hovPass.selectedObjects = hovered && hovered !== selected ? meshesOf(hovered) : [];
    dirty = true;
  }

  // camera moves
  let anim: ((now: number) => boolean) | null = null;
  const presets: Record<string, [number, number, number]> = { iso: [-38, 24, 1], front: [0, 6, 1], side: [90, 6, 1], top: [0, 88, 1.05], back: [180, 20, 1] };
  function fit(): { centre: THREE.Vector3; dist: number } {
    const [lo, hi] = model!.bbox;
    const centre = new THREE.Vector3((lo[0] + hi[0]) / 2000, (lo[2] + hi[2]) / 2000, -(lo[1] + hi[1]) / 2000);
    const rad = Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 2000;
    // fit the bounding sphere into the part of the screen the panels leave free
    const w = el.clientWidth || 1, h = el.clientHeight || 1;
    const fw = Math.max(0.3, (w - inset.l - inset.r) / w), fh = Math.max(0.3, (h - inset.t - inset.b) / h);
    const vfov = (camera.fov * Math.PI) / 180, hfov = 2 * Math.atan(Math.tan(vfov / 2) * camera.aspect);
    const d = Math.max(rad / Math.sin((vfov * fh) / 2), rad / Math.sin((hfov * fw) / 2));
    return { centre, dist: d * 1.04 };
  }
  function flyTo(pos: THREE.Vector3, tgt: THREE.Vector3, dur = 900) {
    const p0 = camera.position.clone(), t0 = controls.target.clone(), s = performance.now();
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) dur = 0;
    anim = now => {
      const k = dur ? Math.min(1, (now - s) / dur) : 1, e = k < 0.5 ? 4 * k * k * k : 1 - Math.pow(-2 * k + 2, 3) / 2;
      camera.position.lerpVectors(p0, pos, e);
      controls.target.lerpVectors(t0, tgt, e);
      return k < 1;
    };
  }
  function view(name: string) {
    if (!model) return;
    const [az, elv, k] = presets[name], { centre, dist } = fit();
    const a = (az * Math.PI) / 180, e = (elv * Math.PI) / 180;
    flyTo(centre.clone().add(new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e)).multiplyScalar(dist * k)), centre);
  }
  function intro() {
    const { centre, dist } = fit();
    camera.position.copy(centre.clone().add(new THREE.Vector3(-0.9, 0.9, 1.4).normalize().multiplyScalar(dist * 1.9)));
    controls.target.copy(centre);
    view('iso');
  }

  // pointer: hover, select, place
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  function hitAt(cx: number, cy: number, membersOnly = false): Hit | null {
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const pool = entries.filter(e => e.mesh.visible && (!membersOnly || e.part.member));
    const hit = ray.intersectObjects(pool.map(e => e.mesh), false)[0];
    const e = hit && entries.find(x => x.mesh === hit.object);
    if (!e) return null;
    let place: PlaceHit | null = null;
    if (e.part.member) {
      const m = e.part.member, p = root.worldToLocal(hit.point.clone()).sub(e.mesh.position);
      const ax = new THREE.Vector3(m.axis === 'x' ? 1 : 0, m.axis === 'y' ? 1 : 0, m.axis === 'z' ? 1 : 0);
      const along = Math.min(1, Math.max(0, p.clone().sub(new THREE.Vector3(...m.a)).dot(ax) / m.length));
      const c = new THREE.Vector3(...m.a).add(ax.clone().multiplyScalar(along * m.length));
      const d = p.clone().sub(c); d.addScaledVector(ax, -d.dot(ax));
      const comps: [number, Face, Face][] = [[d.x, '+x', '-x'], [d.y, '+y', '-y'], [d.z, '+z', '-z']];
      const best = comps.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0];
      place = { member: e.part.id, along: Math.round(along * 1000) / 1000, face: best[0] >= 0 ? best[1] : best[2] };
    }
    return { part: e.part, place, screen: [cx, cy] };
  }
  let down: [number, number] | null = null, moveQueued: PointerEvent | null = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointermove', e => { moveQueued = e; });
  renderer.domElement.addEventListener('pointerleave', () => { if (hovered) { hovered = null; apply(); opts.onHover?.(null); } });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const h = hitAt(e.clientX, e.clientY, !!placing);
    if (placing) { if (h?.place) placing(h.place); return; }
    selected = h ? h.part.id : null;
    apply();
    opts.onSelect?.(h);
  });
  function processHover() {
    if (!moveQueued) return;
    const e = moveQueued; moveQueued = null;
    if (e.buttons) return;
    const h = hitAt(e.clientX, e.clientY, !!placing), id = h ? h.part.id : null;
    renderer.domElement.style.cursor = h ? (placing ? 'crosshair' : 'pointer') : placing ? 'crosshair' : '';
    if (id !== hovered) { hovered = id; apply(); }
    opts.onHover?.(h);
  }

  // the robot camera inset, drawn into the rectangle of a DOM element
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 50);
  persp.layers.set(0);
  let pipEl: HTMLElement | null = null;
  // the robot camera's view: rendered into a corner of the main canvas, copied into a small
  // canvas inside the preview card (so CSS can round and clip it), then the main view is
  // drawn over that corner again
  let pipCanvas: HTMLCanvasElement | null = null;
  function drawPip() {
    const c = model?.cameras.find(x => x.spec.id === pipCam);
    if (!c || !pipEl || pipEl.offsetParent === null) return;
    const r = pipEl.getBoundingClientRect(), cr = renderer.domElement.getBoundingClientRect(), dpr = renderer.getPixelRatio();
    const w = Math.round(r.width), h = Math.round(r.height), x = 0, y = 0;   // bottom-left corner in GL terms
    if (w < 4 || h < 4) return;
    if (!pipCanvas || pipCanvas.parentElement !== pipEl) {
      pipCanvas = document.createElement('canvas');
      pipCanvas.className = 'pip-canvas';
      pipEl.prepend(pipCanvas);
    }
    const T = (v: V3) => new THREE.Vector3(v[0], v[2], -v[1]);
    persp.position.copy(T(c.pos).multiplyScalar(0.001));
    persp.up.copy(T(c.u));
    persp.lookAt(persp.position.clone().add(T(c.f)));
    persp.fov = c.vfov; persp.aspect = w / h;
    persp.near = Math.max(0.005, c.spec.near / 1000); persp.far = c.spec.far / 1000;
    persp.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x, y, w, h); renderer.setViewport(x, y, w, h);
    renderer.render(scene, persp);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, cr.width, cr.height);
    if (pipCanvas.width !== w * dpr || pipCanvas.height !== h * dpr) { pipCanvas.width = w * dpr; pipCanvas.height = h * dpr; }
    pipCanvas.getContext('2d')!.drawImage(renderer.domElement, 0, (cr.height - h) * dpr, w * dpr, h * dpr, 0, 0, w * dpr, h * dpr);
  }

  const inset = { l: 0, r: 0, t: 0, b: 0 };
  function applyInsets() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    camera.setViewOffset(w, h, -(inset.l - inset.r) / 2, -(inset.t - inset.b) / 2, w, h);
    camera.updateProjectionMatrix();
    dirty = true;
  }
  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    composer.setSize(w, h);
    composer.setPixelRatio(renderer.getPixelRatio());
    camera.aspect = w / h;
    applyInsets();
  }
  new ResizeObserver(resize).observe(el);
  resize();

  const DROP = 650;
  renderer.setAnimationLoop(now => {
    processHover();
    let moving = false;
    if (anim && !anim(now)) anim = null;
    if (anim) moving = true;
    if (controls.update()) moving = true;
    // explode easing, and parts dropping in during a build step
    if (Math.abs(explode - explodeTo) > 1e-3) { explode += (explodeTo - explode) * 0.12; moving = true; } else explode = explodeTo;
    for (const e of entries) {
      let dz = 0;
      const t0 = dropping.get(e.mesh);
      if (t0 != null) {
        const k = Math.min(1, (now - t0) / DROP), ease = 1 - Math.pow(1 - k, 3);
        dz = (1 - ease) * 320;
        if (k >= 1) dropping.delete(e.mesh); else moving = true;
      }
      e.mesh.position.set(e.home.x * explode, e.home.y * explode, e.home.z * explode + dz);
    }
    if (bench?.group.visible) { bench.update(now / 1000); moving = true; }
    if (!moving && !dirty && !pipCam) return;
    dirty = false;
    drawPip();
    composer.render();
  });

  return {
    setModel, view, resize,
    setStep(n: number | null) { step = n; placeBench(); apply(); },
    setExplode(on: boolean) { explodeTo = on ? 1 : 0; placeBench(); },
    select(id: string | null) { selected = id; apply(); },
    showCamera(id: string | null, elOut: HTMLElement | null) { pipCam = id; pipEl = elOut; apply(); },
    placeMode(cb: ((h: PlaceHit) => void) | null) { placing = cb; renderer.domElement.style.cursor = cb ? 'crosshair' : ''; },
    focus(id: string) {
      const es = entries.filter(e => e.part.id === id);
      if (!es.length) return;
      const box = new THREE.Box3();
      es.forEach(e => box.expandByObject(e.mesh));
      const c = box.getCenter(new THREE.Vector3()), dir = camera.position.clone().sub(controls.target).normalize();
      flyTo(c.clone().add(dir.multiplyScalar(Math.max(0.9, box.getSize(new THREE.Vector3()).length() * 1.6))), c);
    },
    picture(): string { composer.render(); return renderer.domElement.toDataURL('image/png'); },
    setXray(on: boolean) { xray = on; apply(); },
    setArms(on: boolean) { armsOn = on; placeBench(); },
    setRealistic(on: boolean) { realistic = on; if (model) setModel(model); },
    setInsets(l: number, r: number, t = 0, b = 0) {
      if (inset.l === l && inset.r === r && inset.t === t && inset.b === b) return;
      Object.assign(inset, { l, r, t, b });
      applyInsets();
      // re-fit along the current view direction so the table stays whole in the free space
      if (!model) return;
      const { centre, dist } = fit(), dir = camera.position.clone().sub(controls.target).normalize();
      flyTo(centre.clone().add(dir.multiplyScalar(dist)), centre, 600);
    },
  };
}
export type World = ReturnType<typeof createWorld>;
