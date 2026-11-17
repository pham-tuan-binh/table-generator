// The 3D view, drawn as a technical illustration: orthographic camera, each face flat-filled
// with one of four tones of its material's colour by the way it faces, thin ink outlines found
// from depth and normal jumps, paper background. Colour codes on top of that: yellow for the
// parts new in the step being read, red for the part clicked, blue for camera frustums.
// An inset renders what the selected robot camera sees.
import * as THREE from 'three';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Model, Part, Role, V3 } from './model.ts';
import { partGeometries } from './geometry.ts';
import { Face } from './params.ts';

export interface PickInfo { id: string; name: string; spec: string; kind: Part['kind'] }
export interface PlaceHit { member: string; along: number; face: Face }
export interface Colors { frame: string; panel: string; worktop: string; panelOpacity: number }

const PAPER = 0xfbfbfa, INK = 0x232326;
const CODE = { lit: '#e5484d', new: '#ffd100', ghost: '#e4e4e0' };

function tones(hex: string): THREE.Color[] {
  // four tones from dark (facing down) to light (facing up), all from the one colour
  const base = new THREE.Color(hex), hsl = { h: 0, s: 0, l: 0 };
  base.getHSL(hsl);
  const L = hsl.l;
  return [0.62, 0.76, 0.88, 1.0].map(k => new THREE.Color().setHSL(hsl.h, hsl.s, Math.min(0.97, L < 0.2 ? L * k + 0.05 * k : L * (0.55 + 0.45 * k) + (k === 1 ? 0.04 : 0))));
}

function toneMat(hex: string, opacity = 1): THREE.ShaderMaterial {
  return new THREE.ShaderMaterial({
    uniforms: { tones: { value: tones(hex) }, opacity: { value: opacity } },
    transparent: opacity < 1, depthWrite: opacity >= 1, side: THREE.DoubleSide,
    vertexShader: `varying vec3 wp; void main() { vec4 w = modelMatrix * vec4(position, 1.0); wp = w.xyz; gl_Position = projectionMatrix * viewMatrix * w; }`,
    fragmentShader: `uniform vec3 tones[4]; uniform float opacity; varying vec3 wp;
      void main() {
        vec3 n = normalize(cross(dFdx(wp), dFdy(wp)));
        int k;
        if (n.y > 0.6) k = 3; else if (n.y < -0.6) k = 0;
        else k = dot(normalize(n.xz + 1e-5), normalize(vec2(0.62, 0.78))) > 0.0 ? 2 : 1;
        gl_FragColor = vec4(tones[k], opacity);
      }`,
  });
}

interface Entry { mesh: THREE.Mesh; part: Part; role: Role }

export function createViewer(el: HTMLElement, opts: { onPick?: (p: PickInfo | null) => void; pip?: boolean } = {}) {
  const renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
  renderer.setClearColor(PAPER, 1);
  el.appendChild(renderer.domElement);
  const scene = new THREE.Scene();
  const camera = new THREE.OrthographicCamera(-1, 1, 1, -1, -50, 100);
  camera.layers.enable(1); camera.layers.enable(2);
  const controls = new OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.12;
  controls.minZoom = 0.4;
  controls.maxZoom = 12;

  // outlines: view-space normal + depth to a float target, then ink where either jumps
  const ndMat = new THREE.ShaderMaterial({
    side: THREE.DoubleSide,
    vertexShader: `varying vec3 vp; void main() { vec4 v = modelViewMatrix * vec4(position, 1.0); vp = v.xyz; gl_Position = projectionMatrix * v; }`,
    fragmentShader: `varying vec3 vp; void main() { vec3 n = normalize(cross(dFdx(vp), dFdy(vp))); gl_FragColor = vec4(n * 0.5 + 0.5, -vp.z / 100.0); }`,
  });
  const ndTarget = new THREE.WebGLRenderTarget(1, 1, { type: THREE.FloatType });
  const edgeMat = new THREE.ShaderMaterial({
    uniforms: { nd: { value: ndTarget.texture }, px: { value: new THREE.Vector2() }, ink: { value: new THREE.Color(INK) }, dzK: { value: 0.012 } },
    transparent: true, depthTest: false, depthWrite: false,
    vertexShader: `varying vec2 uv0; void main() { uv0 = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }`,
    fragmentShader: `uniform sampler2D nd; uniform vec2 px; uniform vec3 ink; uniform float dzK; varying vec2 uv0;
      void main() {
        vec4 c = texture2D(nd, uv0);
        vec4 l = texture2D(nd, uv0 - vec2(px.x, 0.0)), r = texture2D(nd, uv0 + vec2(px.x, 0.0));
        vec4 d = texture2D(nd, uv0 - vec2(0.0, px.y)), t = texture2D(nd, uv0 + vec2(0.0, px.y));
        float e = 0.0;
        vec4 s4[4]; s4[0] = l; s4[1] = r; s4[2] = d; s4[3] = t;
        for (int i = 0; i < 4; i++) {
          vec4 s = s4[i];
          float bg = step(c.a, 0.0) + step(s.a, 0.0);
          float dn = 1.0 - dot(c.rgb * 2.0 - 1.0, s.rgb * 2.0 - 1.0);
          e = max(e, max(bg > 0.5 && bg < 1.5 ? 1.0 : 0.0, step(0.25, dn)));
        }
        if (l.a > 0.0 && r.a > 0.0 && d.a > 0.0 && t.a > 0.0) {
          float lap = max(abs(l.a + r.a - 2.0 * c.a), abs(d.a + t.a - 2.0 * c.a)) * 100.0;
          e = max(e, step(dzK, lap));
        }
        gl_FragColor = vec4(ink, e * 0.85);
      }`,
  });
  const edgeScene = new THREE.Scene();
  edgeScene.add(new THREE.Mesh(new THREE.PlaneGeometry(2, 2), edgeMat));
  const edgeCam = new THREE.Camera();

  // design (mm, z up) inside a group turned into three's metres, y up
  const root = new THREE.Group();
  root.rotation.x = -Math.PI / 2;
  root.scale.setScalar(0.001);
  scene.add(root);
  let grid: THREE.GridHelper | null = null;
  const frusta = new THREE.Group();
  root.add(frusta);

  let mats: Record<string, THREE.ShaderMaterial> = {};
  let entries: Entry[] = [];
  let model: Model | null = null;
  let size = 1, camDist = 4;
  const center = new THREE.Vector3();
  let stepLimit: number | null = null, stepHi: number | null = null, selected: string | null = null, dirty = true, framed = false;
  let pipCam: string | null = null, placing: ((h: PlaceHit) => void) | null = null;

  function setColors(c: Colors) {
    Object.values(mats).forEach(m => m.dispose());
    mats = {
      frame: toneMat(c.frame), panel: toneMat(c.panel, c.panelOpacity), worktop: toneMat(c.worktop), shelf: toneMat(c.worktop),
      hw: toneMat('#8d9096'), dark: toneMat('#3b3c40'), cam: toneMat('#2e3a4a'),
      lit: toneMat(CODE.lit), new: toneMat(CODE.new), ghost: toneMat(CODE.ghost, 0.35),
    };
    refresh();
  }

  function setModel(m: Model, colors: Colors) {
    model = m;
    for (const e of entries) { root.remove(e.mesh); e.mesh.geometry.dispose(); }
    entries = [];
    if (!mats.frame) setColors(colors);
    for (const part of m.parts) for (const g of partGeometries(part, m, false)) {
      const mesh = new THREE.Mesh(g, mats[part.role]);
      mesh.userData.id = part.id;
      root.add(mesh);
      entries.push({ mesh, part, role: part.role });
    }
    // camera frustums, 250 mm deep, on their own layer (no outline, not in the inset)
    frusta.clear();
    for (const c of m.cameras) {
      const d = 260, tx = Math.tan((c.hfov * Math.PI) / 360) * d, ty = Math.tan((c.vfov * Math.PI) / 360) * d;
      const P = (a: number, b: number) => new THREE.Vector3(...c.pos).add(new THREE.Vector3(...c.f).multiplyScalar(d)).add(new THREE.Vector3(...c.l).multiplyScalar(a)).add(new THREE.Vector3(...c.u).multiplyScalar(b));
      const o = new THREE.Vector3(...c.pos), k = [P(tx, ty), P(-tx, ty), P(-tx, -ty), P(tx, -ty)];
      const pts = [o, k[0], o, k[1], o, k[2], o, k[3], k[0], k[1], k[1], k[2], k[2], k[3], k[3], k[0]];
      // a tick on the top edge so "up" in the image is obvious
      const top = k[0].clone().add(k[1]).multiplyScalar(0.5);
      pts.push(top, top.clone().add(new THREE.Vector3(...c.u).multiplyScalar(ty * 0.25)));
      const line = new THREE.LineSegments(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: c.spec.id === pipCam ? 0x0a6cff : 0x5b8fd9 }));
      line.layers.set(2);
      line.userData.cam = c.spec.id;
      frusta.add(line);
    }
    const [lo, hi] = m.bbox;
    const span = Math.max(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]);
    size = (Math.hypot(hi[0] - lo[0], hi[1] - lo[1], hi[2] - lo[2]) / 1000) * 0.55;
    camDist = Math.max(2, (span / 1000) * 2);
    camera.near = -camDist * 2; camera.far = camDist * 4;
    center.set((lo[0] + hi[0]) / 2000, (lo[2] + hi[2]) / 2000, -(lo[1] + hi[1]) / 2000);
    if (grid) scene.remove(grid);
    const gs = Math.ceil((span * 2.4) / 1000);
    grid = new THREE.GridHelper(gs, gs * 10, 0xd6d6d2, 0xe9e9e5);
    grid.position.set(center.x, -0.0005, center.z);
    grid.layers.set(1);
    scene.add(grid);
    edgeMat.uniforms.dzK.value = Math.max(0.008, (span / 1000) * 0.006);
    if (!framed) { view('iso', true); framed = true; }
    resize();
    refresh();
  }

  function refresh() {
    for (const e of entries) {
      e.mesh.visible = stepLimit == null || e.part.step <= stepLimit;
      let mat = mats[e.role];
      if (stepHi != null) mat = e.part.step === stepHi ? mats.new : mats[e.role];
      if (selected && e.part.id === selected) mat = mats.lit;
      e.mesh.material = mat;
    }
    frusta.visible = stepLimit == null || stepLimit >= 8;
    frusta.children.forEach(l => ((l as THREE.LineSegments).material as THREE.LineBasicMaterial).color.set(l.userData.cam === pipCam ? 0x0a6cff : 0x7fa6de));
    dirty = true;
  }

  const dirOf = (az: number, elv: number) => {
    const a = (az * Math.PI) / 180, e = (elv * Math.PI) / 180;
    return new THREE.Vector3(Math.sin(a) * Math.cos(e), Math.sin(e), Math.cos(a) * Math.cos(e));
  };
  const presets: Record<string, [number, number]> = { iso: [-35, 26], front: [0, 0], side: [90, 0], top: [0, 89.9] };
  let anim: ((now: number) => void) | null = null;
  function view(name: string, instant = false) {
    const [az, elv] = presets[name];
    const from = { p: camera.position.clone(), t: controls.target.clone(), z: camera.zoom };
    const to = { p: center.clone().add(dirOf(az, elv).multiplyScalar(camDist)), t: center.clone(), z: 1 };
    const reduce = instant || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const start = performance.now(), dur = reduce ? 0 : 600;
    anim = now => {
      const k = dur ? Math.min(1, (now - start) / dur) : 1, e = 1 - Math.pow(1 - k, 3);
      camera.position.lerpVectors(from.p, to.p, e);
      controls.target.lerpVectors(from.t, to.t, e);
      camera.zoom = from.z + (to.z - from.z) * e;
      camera.updateProjectionMatrix();
      dirty = true;
      if (k >= 1) anim = null;
    };
    if (reduce) anim(performance.now());
  }

  // picking, and placing a camera on a member
  const ray = new THREE.Raycaster(), ndc = new THREE.Vector2();
  let down: [number, number] | null = null;
  renderer.domElement.addEventListener('pointerdown', e => { down = [e.clientX, e.clientY]; });
  renderer.domElement.addEventListener('pointerup', e => {
    if (!down || Math.hypot(e.clientX - down[0], e.clientY - down[1]) > 5) return;
    const r = renderer.domElement.getBoundingClientRect();
    ndc.set(((e.clientX - r.left) / r.width) * 2 - 1, -((e.clientY - r.top) / r.height) * 2 + 1);
    ray.setFromCamera(ndc, camera);
    const pool = entries.filter(x => x.mesh.visible && (!placing || x.part.kind === 'member'));
    const hit = ray.intersectObjects(pool.map(x => x.mesh), false)[0];
    const entry = hit && entries.find(x => x.mesh === hit.object);
    if (placing) {
      if (entry && hit.face && model) {
        const m = entry.part.member!, p = root.worldToLocal(hit.point.clone());
        const ax = new THREE.Vector3(m.axis === 'x' ? 1 : 0, m.axis === 'y' ? 1 : 0, m.axis === 'z' ? 1 : 0);
        const along = Math.min(1, Math.max(0, p.clone().sub(new THREE.Vector3(...m.a)).dot(ax) / m.length));
        // the face: the dominant direction from the member's centre line to the hit, across the axis
        const c = new THREE.Vector3(...m.a).add(ax.clone().multiplyScalar(along * m.length));
        const d = p.clone().sub(c); d.addScaledVector(ax, -d.dot(ax));
        const comps: [number, Face, Face][] = [[d.x, '+x', '-x'], [d.y, '+y', '-y'], [d.z, '+z', '-z']];
        const best = comps.sort((a, b) => Math.abs(b[0]) - Math.abs(a[0]))[0];
        placing({ member: entry.part.id, along: Math.round(along * 1000) / 1000, face: best[0] >= 0 ? best[1] : best[2] });
      }
      return;
    }
    selected = entry ? entry.part.id : null;
    refresh();
    opts.onPick?.(entry ? { id: entry.part.id, name: entry.part.name, spec: entry.part.spec, kind: entry.part.kind } : null);
  });

  function resize() {
    const w = el.clientWidth, h = el.clientHeight;
    if (!w || !h) return;
    renderer.setSize(w, h, false);
    renderer.domElement.style.width = w + 'px';
    renderer.domElement.style.height = h + 'px';
    const a = w / h;
    Object.assign(camera, a >= 1 ? { left: -size * a, right: size * a, top: size, bottom: -size } : { left: -size, right: size, top: size / a, bottom: -size / a });
    camera.updateProjectionMatrix();
    const dpr = renderer.getPixelRatio();
    ndTarget.setSize(Math.round(w * dpr), Math.round(h * dpr));
    edgeMat.uniforms.px.value.set(1 / (w * dpr), 1 / (h * dpr));
    dirty = true;
  }
  new ResizeObserver(resize).observe(el);
  let visible = true;
  new IntersectionObserver(es => { visible = es[0].isIntersecting; }).observe(el);

  // the robot camera's view, as an inset in the bottom right corner
  const persp = new THREE.PerspectiveCamera(60, 16 / 9, 0.01, 50);
  persp.layers.set(0);
  function drawPip() {
    const c = model?.cameras.find(x => x.spec.id === pipCam);
    if (!opts.pip || !c) return;
    const w = el.clientWidth, h = el.clientHeight, aspect = c.spec.width / c.spec.height;
    const pw = Math.min(w * 0.42, 340), ph = pw / aspect, x = w - pw - 12, y = 12;
    // design -> three: (x, y, z) -> (x, z, -y), metres
    const T = (v: V3) => new THREE.Vector3(v[0], v[2], -v[1]);
    persp.position.copy(T(c.pos).multiplyScalar(0.001));
    persp.up.copy(T(c.u));
    persp.lookAt(persp.position.clone().add(T(c.f)));
    persp.fov = c.vfov; persp.aspect = aspect;
    persp.near = Math.max(0.005, c.spec.near / 1000); persp.far = c.spec.far / 1000;
    persp.updateProjectionMatrix();
    renderer.setScissorTest(true);
    renderer.setScissor(x - 2, y - 2, pw + 4, ph + 4); renderer.setViewport(x - 2, y - 2, pw + 4, ph + 4);
    renderer.setClearColor(INK, 1); renderer.clear();
    renderer.setScissor(x, y, pw, ph); renderer.setViewport(x, y, pw, ph);
    renderer.setClearColor(0xf1f1ee, 1); renderer.clear();
    renderer.render(scene, persp);
    renderer.setScissorTest(false);
    renderer.setViewport(0, 0, w, h);
    renderer.setClearColor(PAPER, 1);
    pipLabel(c.spec.name, x, h - y - ph, pw);
  }
  const label = document.createElement('div');
  label.className = 'pip-label';
  el.appendChild(label);
  function pipLabel(text: string, x: number, top: number, pw: number) {
    label.hidden = false;
    label.textContent = `${text} camera`;
    label.style.left = `${x}px`; label.style.top = `${top - 22}px`; label.style.width = `${pw}px`;
  }

  function draw(paper = 1) {
    renderer.setClearColor(PAPER, paper);
    renderer.render(scene, camera);
    // normals/depth without the see-through panels, the grid or the frustums
    const hidden = entries.filter(e => e.mesh.visible && (e.mesh.material as THREE.ShaderMaterial).transparent);
    hidden.forEach(e => (e.mesh.visible = false));
    camera.layers.set(0);
    scene.overrideMaterial = ndMat;
    renderer.setRenderTarget(ndTarget);
    renderer.setClearColor(0x000000, 0);
    renderer.clear();
    renderer.render(scene, camera);
    renderer.setRenderTarget(null);
    renderer.setClearColor(PAPER, 1);
    scene.overrideMaterial = null;
    camera.layers.enable(1); camera.layers.enable(2);
    hidden.forEach(e => (e.mesh.visible = true));
    renderer.autoClear = false;
    renderer.render(edgeScene, edgeCam);
    if (paper) drawPip(); else label.hidden = true;
    renderer.autoClear = true;
    if (!pipCam || !opts.pip) label.hidden = true;
  }
  renderer.setAnimationLoop(now => {
    if (anim) anim(now);
    if (controls.update()) dirty = true;
    if (!dirty || !visible) return;
    dirty = false;
    draw();
  });

  function picture(): string {
    view('iso', true);
    if (grid) grid.visible = false;
    frusta.visible = false;
    draw(0);
    const url = renderer.domElement.toDataURL('image/png');
    if (grid) grid.visible = true;
    refresh();
    return url;
  }

  return {
    setModel, setColors, view, resize, picture,
    setStep(limit: number | null, hi: number | null) { stepLimit = limit; stepHi = hi; refresh(); },
    select(id: string | null) { selected = id; refresh(); },
    showCamera(id: string | null) { pipCam = id; refresh(); },
    placeMode(cb: ((h: PlaceHit) => void) | null) { placing = cb; renderer.domElement.style.cursor = cb ? 'crosshair' : ''; },
  };
}
export type Viewer = ReturnType<typeof createViewer>;
