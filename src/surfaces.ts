// What every part looks like. Two looks share one interface:
//   realistic  physically based surfaces: brushed anodised aluminium, laminate, phenolic,
//              foam board and acrylic generated here; real plywood photographed by
//              Poly Haven (CC0), downloaded on demand. Grain is mapped in real millimetres.
//   simple     flat colours, as before
// The user's colours still apply: they tint the surface.
import * as THREE from 'three';
import { Params, material } from './params.ts';
import { Role, Part } from './model.ts';

// ------------------------------------------------------------------ procedural maps
let seed = 1;
const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
function canvas(w: number, h: number, draw: (img: ImageData) => void, srgb = false): THREE.CanvasTexture {
  const c = document.createElement('canvas'); c.width = w; c.height = h;
  const g = c.getContext('2d')!, img = g.createImageData(w, h);
  draw(img); g.putImageData(img, 0, 0);
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  t.anisotropy = 8;
  t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
  return t;
}
// a tileable height field, turned into a roughness map and a normal map
function heightMaps(w: number, h: number, height: Float32Array, roughBase: number, roughVar: number, bump: number) {
  const at = (x: number, y: number) => height[((y + h) % h) * w + ((x + w) % w)];
  const rough = canvas(w, h, img => { for (let i = 0; i < w * h; i++) { const v = Math.max(0, Math.min(255, (roughBase + (height[i] - 0.5) * roughVar) * 255)); img.data.set([v, v, v, 255], i * 4); } });
  const normal = canvas(w, h, img => {
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      const dx = (at(x + 1, y) - at(x - 1, y)) * bump, dy = (at(x, y + 1) - at(x, y - 1)) * bump, l = Math.hypot(dx, dy, 1);
      img.data.set([(-dx / l * 0.5 + 0.5) * 255, (-dy / l * 0.5 + 0.5) * 255, (1 / l * 0.5 + 0.5) * 255, 255], (y * w + x) * 4);
    }
  });
  return { rough, normal };
}
// brushed: fine streaks along u
function brushed() {
  const w = 1024, h = 256, H = new Float32Array(w * h);
  seed = 7;
  const rows = Array.from({ length: h }, () => rnd());
  for (let k = 0; k < 900; k++) {   // scratches: thin, long, along u
    const y = Math.floor(rnd() * h), x0 = Math.floor(rnd() * w), len = 80 + rnd() * 600, a = (rnd() - 0.5) * 0.5;
    for (let i = 0; i < len; i++) H[y * w + ((x0 + i) % w)] += a * Math.sin((i / len) * Math.PI);
  }
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) H[y * w + x] = 0.5 + (rows[y] - 0.5) * 0.35 + H[y * w + x] * 0.5;
  return heightMaps(w, h, H, 0.34, 0.25, 1.4);
}
// grain: smooth fractal noise, for laminate, phenolic, foam
function grain(s: number, octaves: number, scale: number) {
  const n = 256, H = new Float32Array(n * n);
  seed = s;
  for (let o = 0; o < octaves; o++) {
    const cells = Math.max(2, Math.round(scale * 2 ** o)), lat = Array.from({ length: cells * cells }, () => rnd()), amp = 0.5 ** o;
    const L = (i: number, j: number) => lat[((j + cells) % cells) * cells + ((i + cells) % cells)];
    for (let y = 0; y < n; y++) for (let x = 0; x < n; x++) {
      const fx = (x / n) * cells, fy = (y / n) * cells, i = Math.floor(fx), j = Math.floor(fy), u = fx - i, v = fy - j;
      const su = u * u * (3 - 2 * u), sv = v * v * (3 - 2 * v);
      H[y * n + x] += amp * (L(i, j) * (1 - su) * (1 - sv) + L(i + 1, j) * su * (1 - sv) + L(i, j + 1) * (1 - su) * sv + L(i + 1, j + 1) * su * sv);
    }
  }
  let lo = Infinity, hi = -Infinity;
  for (const v of H) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
  for (let i = 0; i < H.length; i++) H[i] = (H[i] - lo) / (hi - lo || 1);
  return { n, H };
}

// ------------------------------------------------------------------ surfaces
interface Surface {
  maps: () => { map?: THREE.Texture; rough?: THREE.Texture; normal?: THREE.Texture };
  tile: number;            // metres of surface one repeat of the maps covers
  roughness: number; metalness: number; normalScale: number;
  clearcoat?: number; anisotropy?: number; photo?: boolean; sheen?: number;
}
const memo = <T>(f: () => T) => { let v: T | undefined; return () => (v ??= f()); };
const BRUSHED = memo(brushed);
const FINE = memo(() => { const g = grain(11, 5, 6); return heightMaps(g.n, g.n, g.H, 0.5, 0.2, 2.2); });
const FOAM = memo(() => { const g = grain(23, 3, 40); return heightMaps(g.n, g.n, g.H, 0.9, 0.08, 1.5); });
const SPECKLE = memo(() => { const g = grain(31, 3, 64); return heightMaps(g.n, g.n, g.H, 0.55, 0.12, 0.6); });
const polyhaven = (name: string) => memo(() => {
  const base = `https://dl.polyhaven.org/file/ph-assets/Textures/jpg/1k/${name}/${name}`, L = new THREE.TextureLoader();
  L.setCrossOrigin('anonymous');
  const load = (suffix: string, srgb: boolean) => {
    const t = L.load(`${base}_${suffix}_1k.jpg`, () => onTexture());
    t.wrapS = t.wrapT = THREE.RepeatWrapping; t.anisotropy = 8;
    t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace;
    return t;
  };
  return { map: load('diff', true), rough: load('rough', false), normal: load('nor_gl', false) };
});
let onTexture = () => {};
/** called whenever a downloaded texture arrives, so the view can redraw */
export function onTextureLoad(cb: () => void) { onTexture = cb; }

const SURFACES: Record<string, Surface> = {
  aluminium: { maps: BRUSHED, tile: 0.25, roughness: 0.42, metalness: 0.85, normalScale: 0.15, clearcoat: 0.2, anisotropy: 0.45 },
  steel: { maps: BRUSHED, tile: 0.08, roughness: 0.3, metalness: 0.95, normalScale: 0.15 },
  rubber: { maps: FOAM, tile: 0.05, roughness: 0.92, metalness: 0, normalScale: 0.3 },
  plastic: { maps: FINE, tile: 0.08, roughness: 0.45, metalness: 0, normalScale: 0.2 },
  hpl: { maps: FINE, tile: 0.4, roughness: 0.42, metalness: 0, normalScale: 0.04, clearcoat: 0.15 },
  melamine: { maps: FINE, tile: 0.5, roughness: 0.38, metalness: 0, normalScale: 0.03, clearcoat: 0.2 },
  phenolic: { maps: SPECKLE, tile: 0.25, roughness: 0.5, metalness: 0, normalScale: 0.04, clearcoat: 0.18 },
  // PVC foam board: smooth, satin, a soft sheen at grazing angles, no visible texture
  foam: { maps: FINE, tile: 0.6, roughness: 0.72, metalness: 0, normalScale: 0.012, sheen: 0.35 },
  acm: { maps: FINE, tile: 0.6, roughness: 0.3, metalness: 0.1, normalScale: 0.06, clearcoat: 0.5 },
  'abs-black': { maps: FINE, tile: 0.2, roughness: 0.6, metalness: 0, normalScale: 0.3 },
  acrylic: { maps: FINE, tile: 1, roughness: 0.04, metalness: 0, normalScale: 0.02, clearcoat: 1 },
  polycarb: { maps: FINE, tile: 1, roughness: 0.08, metalness: 0, normalScale: 0.03, clearcoat: 1 },
  plywood: { maps: polyhaven('plywood'), tile: 1, roughness: 1, metalness: 0, normalScale: 0.6, photo: true },
  mdf: { maps: SPECKLE, tile: 0.2, roughness: 0.75, metalness: 0, normalScale: 0.08 },
  hdpe: { maps: FINE, tile: 0.15, roughness: 0.6, metalness: 0, normalScale: 0.06 },
  alu: { maps: BRUSHED, tile: 0.4, roughness: 0.3, metalness: 0.9, normalScale: 0.15, anisotropy: 0.5 },
};

function physical(s: Surface, color: string, extra: THREE.MeshPhysicalMaterialParameters = {}, tintFrom?: string): THREE.MeshPhysicalMaterial {
  const m = s.maps(), rep = (t?: THREE.Texture) => { if (!t) return undefined; const c = t.clone(); c.repeat.set(1 / s.tile, 1 / s.tile); c.needsUpdate = true; return c; };
  // a photographed surface keeps its own colour; the user's colour tints it relative to the default
  let col = new THREE.Color(color);
  if (s.photo && tintFrom) { const a = new THREE.Color(color), b = new THREE.Color(tintFrom); col = new THREE.Color(Math.min(2, a.r / Math.max(b.r, 0.05)), Math.min(2, a.g / Math.max(b.g, 0.05)), Math.min(2, a.b / Math.max(b.b, 0.05))); }
  return new THREE.MeshPhysicalMaterial({
    color: col, map: rep(m.map), roughnessMap: rep(m.rough), normalMap: rep(m.normal), normalScale: new THREE.Vector2(s.normalScale, s.normalScale),
    roughness: s.roughness, metalness: s.metalness, clearcoat: s.clearcoat ?? 0, clearcoatRoughness: 0.35,
    anisotropy: s.anisotropy ?? 0, sheen: s.sheen ?? 0, sheenRoughness: 0.8, sheenColor: new THREE.Color(0xffffff), ...extra,
  });
}

/** the material for every role of the table */
export function createMaterials(p: Params, realistic: boolean): Record<Role, THREE.Material> {
  const see = p.panelOpacity < 1, wallMat = material(p.panelMaterial);
  const glassy = { transparent: see, opacity: p.panelOpacity, depthWrite: !see, side: THREE.DoubleSide };
  if (!realistic) return {
    frame: new THREE.MeshStandardMaterial({ color: p.frameColor, metalness: 0.62, roughness: 0.34 }),
    panel: new THREE.MeshPhysicalMaterial({ color: p.panelColor, metalness: 0, roughness: wallMat.opacity ? 0.08 : 0.55, clearcoat: wallMat.opacity ? 0.6 : 0.15, ...glassy }),
    worktop: new THREE.MeshPhysicalMaterial({ color: p.worktopColor, roughness: 0.5, clearcoat: 0.25, clearcoatRoughness: 0.4 }),
    shelf: new THREE.MeshPhysicalMaterial({ color: p.shelfColor, roughness: 0.55, clearcoat: 0.15 }),
    hw: new THREE.MeshStandardMaterial({ color: 0x9a9ea5, metalness: 0.85, roughness: 0.3 }),
    dark: new THREE.MeshStandardMaterial({ color: 0x2a2b2f, metalness: 0.1, roughness: 0.75 }),
    cam: new THREE.MeshStandardMaterial({ color: 0x1c2230, metalness: 0.3, roughness: 0.45 }),
  };
  const board = (id: string, color: string) => physical(SURFACES[id] || SURFACES.hpl, color, {}, material(id).color);
  return {
    frame: physical(SURFACES.aluminium, p.frameColor),
    panel: physical(SURFACES[p.panelMaterial] || SURFACES.hpl, p.panelColor, glassy, wallMat.color),
    worktop: board(p.worktopMaterial, p.worktopColor),
    shelf: board(p.shelfMaterial, p.shelfColor),
    hw: physical(SURFACES.steel, '#a3a7ad'),
    dark: physical(SURFACES.rubber, '#26272b'),
    cam: physical(SURFACES.plastic, '#1c2230'),
  };
}

/**
 * UVs in metres of real surface, so grain is the same size on every part whatever its
 * length. Faces are mapped onto the plane they face; on an extrusion u runs along its
 * length, so brushing follows the profile like a real extrusion.
 */
export function worldUV(g: THREE.BufferGeometry, part?: Part) {
  const pos = g.attributes.position, nor = g.attributes.normal;
  if (!nor) g.computeVertexNormals();
  const n = g.attributes.normal, uv = new Float32Array(pos.count * 2);
  const along = part?.member ? { x: 0, y: 1, z: 2 }[part.member.axis] : -1;
  for (let i = 0; i < pos.count; i++) {
    const p = [pos.getX(i), pos.getY(i), pos.getZ(i)], a = [Math.abs(n.getX(i)), Math.abs(n.getY(i)), Math.abs(n.getZ(i))];
    const k = a[0] > a[1] && a[0] > a[2] ? 0 : a[1] > a[2] ? 1 : 2;
    let u: number, v: number;
    if (along >= 0 && along !== k) { u = along; v = 3 - k - along; } else { u = k === 0 ? 1 : 0; v = k === 2 ? 1 : 2; }
    uv[i * 2] = p[u] / 1000; uv[i * 2 + 1] = p[v] / 1000;
  }
  g.setAttribute('uv', new THREE.BufferAttribute(uv, 2));
  return g;
}
