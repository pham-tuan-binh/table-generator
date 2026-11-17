// Decimates an arm's STLs into two levels of detail for the launch video:
//   hero/   ~30 % of the triangles, for the close-up arms
//   crowd/  ~3 %, for the field of tables
// usage: node video/decimate.mjs <stl dir> <name>   (writes video/assets/<name>/{hero,crowd})
import { readFileSync, writeFileSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { MeshoptSimplifier } from 'meshoptimizer';

const src = process.argv[2], name = process.argv[3] || 'arm';
const out = new URL(`./assets/${name}/`, import.meta.url).pathname;
await MeshoptSimplifier.ready;

function readStl(buf) {
  const n = buf.readUInt32LE(80), pos = new Float32Array(n * 9);
  for (let t = 0; t < n; t++) for (let k = 0; k < 9; k++) pos[t * 9 + k] = buf.readFloatLE(84 + t * 50 + 12 + k * 4);
  return pos;
}
// weld identical vertices so the simplifier sees a connected mesh
function weld(pos) {
  const map = new Map(), verts = [], idx = new Uint32Array(pos.length / 3);
  for (let i = 0; i < pos.length / 3; i++) {
    const key = `${pos[i * 3].toFixed(6)},${pos[i * 3 + 1].toFixed(6)},${pos[i * 3 + 2].toFixed(6)}`;
    let v = map.get(key);
    if (v === undefined) { v = verts.length / 3; map.set(key, v); verts.push(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]); }
    idx[i] = v;
  }
  return { verts: new Float32Array(verts), idx };
}
function writeStl(verts, idx) {
  const n = idx.length / 3, buf = Buffer.alloc(84 + n * 50);
  buf.writeUInt32LE(n, 80);
  for (let t = 0; t < n; t++) {
    const o = 84 + t * 50;
    for (let k = 0; k < 3; k++) for (let c = 0; c < 3; c++) buf.writeFloatLE(verts[idx[t * 3 + k] * 3 + c], o + 12 + k * 12 + c * 4);
  }
  return buf;
}
for (const [dir, ratio] of [['hero', 0.3], ['crowd', 0.03]]) {
  mkdirSync(join(out, dir), { recursive: true });
  for (const f of readdirSync(src).filter(f => f.endsWith('.stl'))) {
    const { verts, idx } = weld(readStl(readFileSync(join(src, f))));
    const target = Math.max(60, Math.floor((idx.length * ratio) / 3) * 3);
    const [simp] = MeshoptSimplifier.simplify(idx, verts, 3, target, 0.05, ['LockBorder']);
    writeFileSync(join(out, dir, f), writeStl(verts, simp));
    console.log(dir, f, idx.length / 3, '->', simp.length / 3);
  }
}
