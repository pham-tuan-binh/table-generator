// Two i2rt YAM arms working ToyBlocks' stack-three task on the worktop.
//
// ToyBlocks (AllenAI, Apache-2.0) is a simulation framework of an arm arranging toy blocks;
// its blocks are wooden alphabet blocks (AlphabetBlockLarge), and its
// stack-three task asks for three named blocks stacked with every letter left readable.
// Here a seeded generator in the same spirit draws a scene from ToyBlocks' training split,
// picks three blocks, and the two arms build the tower in the middle (each moving the blocks
// on its side, turning letters to face the front camera with the wrist), then put every
// block back where it was. Then the next episode, with three other blocks.
//
// Scripted, not simulated: IK at every waypoint, solved once up front, eased between.
// Layout follows i2rt's YAM station: two arms 610 mm apart, both facing the workspace;
// here they are clamped at the worktop's open front edge, facing the back.
import * as THREE from 'three';
import { Arm, ArmDef, YAM, parseUrdf, loadMeshes, Q } from './arm.ts';

export const ARM_SPACING = 610;                     // mm, centre to centre (i2rt station)
export const BENCH_MIN_WIDTH = ARM_SPACING + 180;   // clear width the pair needs
const LIFT = 0.4;   // mm: what sits on the worktop sits just above it, never in its plane
const SCALE = 0.9, HOVER = 90, SLOT = 1.6, MOVE = 3.2, GRASP = 1.1, RELEASE = 2.55;
const BASES: [number, number][] = [[-ARM_SPACING / 2, 0], [ARM_SPACING / 2, 0]];
const TOWER = new THREE.Vector2(0, -250);
const YAW = -Math.PI / 2;   // arm forward (+x) turned to face -y in the rig frame

// ToyBlocks' training split of glyphs (scripts/task_gen/stack_three.py)
const LETTERS = 'CDEFGHJKLMNPQSUVWXYZ'.split('');
const DIGITS = ['1', '3', '5'];

// ------------------------------------------------------------------ assets
interface Blocks { size: number; body: THREE.BufferGeometry; decal: Record<string, THREE.BufferGeometry>; readable: Record<string, THREE.Quaternion>; mats: { body: THREE.Material; decal: THREE.Material } }
export interface Kit { def: ArmDef; meshes: Record<string, THREE.BufferGeometry>; blocks: Blocks }

export async function loadKit(robots: string, toyblocks: string, lod: 'hero' | 'crowd'): Promise<Kit> {
  const def = parseUrdf(await (await fetch(robots + 'yam.urdf')).text());
  const [meshes, blocks] = await Promise.all([loadMeshes(`${robots}${lod}/`, def.visuals.map(v => v.mesh)), loadBlocks(toyblocks)]);
  return { def, meshes, blocks };
}

let blocksCache: Promise<Blocks> | null = null;
function loadBlocks(base: string): Promise<Blocks> {
  return (blocksCache ??= (async () => {
    const d = await (await fetch(base + 'blocks.json')).json();
    const c = new THREE.Vector3(...(d.centre as [number, number, number]));
    const geo = (pos: number[][], uv?: number[][]) => {
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(pos.flatMap(p => [(p[0] - c.x) * 1000 * SCALE, (p[1] - c.y) * 1000 * SCALE, (p[2] - c.z) * 1000 * SCALE]), 3));
      if (uv) g.setAttribute('uv', new THREE.Float32BufferAttribute(uv.flat(), 2));
      g.computeVertexNormals();
      return g;
    };
    const body = geo(d.body.position, d.body.uv);
    const decal: Record<string, THREE.BufferGeometry> = {}, readable: Record<string, THREE.Quaternion> = {};
    for (const [g, uv] of Object.entries(d.glyphUV as Record<string, number[][]>)) {
      decal[g] = geo(d.decal.position, uv);
      readable[g] = readableTurn(decal[g]);
    }
    const L = new THREE.TextureLoader();
    const tex = (f: string, srgb: boolean) => { const t = L.load(base + f); t.colorSpace = srgb ? THREE.SRGBColorSpace : THREE.NoColorSpace; t.anisotropy = 8; return t; };
    return {
      size: d.extent[0] * 1000 * SCALE, body, decal, readable,
      mats: {
        body: new THREE.MeshPhysicalMaterial({ map: tex('body.jpg', true), normalMap: tex('body_normal.png', false), roughness: 0.55, clearcoat: 0.35, clearcoatRoughness: 0.4 }),
        decal: new THREE.MeshStandardMaterial({ map: tex('decals.webp', true), transparent: true, alphaTest: 0.5, roughness: 0.6, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2 }),
      },
    };
  })());
}

// the turn that puts a glyph block's upper-case face toward the front, upright. In the atlas each
// glyph owns a 3 x 2 block of cells; its upper case is the first cell of the lower row.
function readableTurn(g: THREE.BufferGeometry): THREE.Quaternion {
  const pos = g.attributes.position as THREE.BufferAttribute, uv = g.attributes.uv as THREE.BufferAttribute, faces: { n: THREE.Vector3; up: THREE.Vector3; u: number; v: number }[] = [];
  for (let i = 0; i + 5 < pos.count; i += 6) {   // two triangles per face
    const P = [0, 1, 2].map(k => new THREE.Vector3().fromBufferAttribute(pos, i + k)), T = [0, 1, 2].map(k => new THREE.Vector2().fromBufferAttribute(uv, i + k));
    const n = P[1].clone().sub(P[0]).cross(P[2].clone().sub(P[0])).normalize();
    // the 3D direction of +v on this face, from the triangle's UV gradient
    const e1 = P[1].clone().sub(P[0]), e2 = P[2].clone().sub(P[0]), d1 = T[1].clone().sub(T[0]), d2 = T[2].clone().sub(T[0]);
    const r = 1 / (d1.x * d2.y - d2.x * d1.y || 1e-9);
    const up = e2.clone().multiplyScalar(d1.x).sub(e1.clone().multiplyScalar(d2.x)).multiplyScalar(r).normalize();
    faces.push({ n, up, u: (T[0].x + T[1].x + T[2].x) / 3, v: (T[0].y + T[1].y + T[2].y) / 3 });
  }
  const vMin = Math.min(...faces.map(f => f.v));
  const face = faces.filter(f => f.v < vMin + 0.03).sort((a, b) => a.u - b.u)[0] ?? faces[0];
  const from = new THREE.Matrix4().makeBasis(face.up.clone().cross(face.n).normalize(), face.up, face.n);
  // the rig is turned 180 degrees on the table, so its +y faces the open front and the front camera
  const to = new THREE.Matrix4().makeBasis(new THREE.Vector3(-1, 0, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(0, 1, 0));
  return new THREE.Quaternion().setFromRotationMatrix(to.multiply(from.invert()));
}

// ------------------------------------------------------------------ recorded physics
// A bench simulated in MuJoCo (video/physics/sim.py) and stored frame by frame: both arms'
// joints and fingers, and every block's pose, in this rig's frame. Played back, nothing is
// scripted: blocks only move because the fingers squeezed and carried them.
export interface Recording { fps: number; frames: number; size: number; glyphs: string[]; data: Int16Array; stride: number }
export async function loadRecording(url: string, gz = false): Promise<Recording> {
  const bin = gz
    // a server may already have unpacked it (Content-Encoding): only unzip what still starts with the gzip magic
    ? fetch(url + '.bin.gz').then(r => r.arrayBuffer()).then(b => {
        const u = new Uint8Array(b);
        return u[0] === 0x1f && u[1] === 0x8b ? new Response(new Blob([b]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer() : b;
      })
    : fetch(url + '.bin').then(r => r.arrayBuffer());
  const [h, buf] = await Promise.all([fetch(url + '.json').then(r => r.json()), bin]);
  return { ...h, data: new Int16Array(buf), stride: 16 + 7 * h.glyphs.length };
}
const ARM_JOINTS = ['joint1', 'joint2', 'joint3', 'joint4', 'joint5', 'joint6'];

// ------------------------------------------------------------------ episodes
interface Piece { id: number; glyph: string; spot: THREE.Vector2; yaw: number }
interface Plan { home: Q; hf: Q; gf: Q; ht: Q; gt: Q; rel: THREE.Matrix4 }
interface Move { arm: number; piece: number; from: THREE.Vector3; to: THREE.Vector3; fromYaw: number; toYaw: number; start: number; q?: Plan }
interface Episode { goal: number[]; moves: Move[]; end: number }

function rng(seed: number) { let s = (seed * 2654435761) >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }

// a ToyBlocks-style scene of wooden alphabet blocks, letters and digits, scattered at random turns
function makeScene(seed: number, size: number): Piece[] {
  const r = rng(seed), pick = <T,>(a: T[]) => a[Math.floor(r() * a.length)];
  const n = 7 + Math.floor(r() * 2), pieces: Piece[] = [], used = new Set<string>();
  for (let i = 0; i < n; i++) {
    let spot = new THREE.Vector2(), tries = 0;
    do spot = new THREE.Vector2((r() * 2 - 1) * 400, -130 - r() * 230);
    while (++tries < 300 && (spot.distanceTo(TOWER) < size * 2.6 || pieces.some(p => p.spot.distanceTo(spot) < size * 2.2) || Math.abs(spot.x) < size * 1.5));
    let glyph: string;
    do glyph = i < 5 ? pick(LETTERS) : pick(DIGITS);
    while (used.has(glyph) && used.size < 22);
    used.add(glyph);
    pieces.push({ id: i, glyph, spot, yaw: Math.floor(r() * 4) * (Math.PI / 2) });
  }
  return pieces;
}

// one episode: three blocks onto the tower in order, turned readable; then each back home
function episode(pieces: Piece[], seed: number, size: number, t0: number): Episode {
  const r = rng(seed), order = [...pieces].sort(() => r() - 0.5).slice(0, 3).map(p => p.id);
  const side = (p: Piece) => (p.spot.x < 0 ? 0 : 1), free = [t0, t0], moves: Move[] = [];
  let t = t0;
  const add = (arm: number, piece: number, from: THREE.Vector3, to: THREE.Vector3, fromYaw: number, toYaw: number) => {
    const start = Math.max(free[arm], t);
    moves.push({ arm, piece, from, to, fromYaw, toYaw, start });
    free[arm] = start + MOVE;
    t = start + SLOT;   // the next move may start once this one has let go of the tower area
  };
  const home = (p: Piece) => new THREE.Vector3(p.spot.x, p.spot.y, size / 2 + LIFT), level = (h: number) => new THREE.Vector3(TOWER.x, TOWER.y, size / 2 + LIFT + h * size);
  order.forEach((id, h) => add(side(pieces[id]), id, home(pieces[id]), level(h), pieces[id].yaw, 0));
  t += SLOT;
  [...order].reverse().forEach((id, k) => add(side(pieces[id]), id, level(2 - k), home(pieces[id]), 0, pieces[id].yaw));
  return { goal: order, moves, end: Math.max(...free) + SLOT };
}

// ------------------------------------------------------------------ one bench
const ease = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
const mix = (a: Q, b: Q, k: number) => { const e = ease(k), o: Q = {}; for (const n in a) o[n] = a[n] + ((b[n] ?? a[n]) - a[n]) * e; return o; };
const PLANS = new Map<string, { pieces: Piece[]; episodes: Episode[]; moves: Move[]; loop: number }>();
let armZ = 0;   // the arms' bases are lifted so their plates sit on the worktop
const rigFromArm = (arm: number) => new THREE.Matrix4().makeTranslation(BASES[arm][0], BASES[arm][1], armZ).multiply(new THREE.Matrix4().makeRotationZ(YAW)).multiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));
const wrap = (a: number) => Math.atan2(Math.sin(a), Math.cos(a));
// a soft contact shadow: the rig's light is a big diffuse panel, so what a block leaves on
// the worktop is a dark, blurred patch right under it, fading as it is lifted
let blobTex: THREE.Texture | null = null;
function blob(size: number): THREE.Mesh {
  blobTex ??= (() => {
    const c = document.createElement('canvas'); c.width = c.height = 128;
    const g = c.getContext('2d')!, r = g.createRadialGradient(64, 64, 8, 64, 64, 64);
    r.addColorStop(0, 'rgba(0,0,0,0.85)'); r.addColorStop(0.45, 'rgba(0,0,0,0.45)'); r.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = r; g.fillRect(0, 0, 128, 128);
    return new THREE.CanvasTexture(c);
  })();
  const m = new THREE.Mesh(new THREE.PlaneGeometry(size, size), new THREE.MeshBasicMaterial({ map: blobTex, transparent: true, depthWrite: false, opacity: 0.55, toneMapped: false }));
  m.renderOrder = -1;
  return m;
}
const yawOf = (M: THREE.Matrix4) => { const x = new THREE.Vector3(1, 0, 0).applyMatrix4(new THREE.Matrix4().extractRotation(M)); return Math.atan2(x.y, x.x); };

export class Bench {
  group = new THREE.Group();   // origin: the worktop surface centre
  rig = new THREE.Group();     // origin: midway between the arm bases
  arms: Arm[] = [];
  private pieces: Piece[] = [];
  private blocks: THREE.Group[] = [];
  private shadows: THREE.Mesh[] = [];
  private moves: Move[] = [];
  private episodes: Episode[] = [];
  private loop = 0;

  private rec: Recording | null = null;
  /** play a recording round and round (the web), rather than hold its last frame (the video) */
  looping = false;
  private qa = new THREE.Quaternion(); private qb = new THREE.Quaternion();

  constructor(private kit: Kit, mats: { body: THREE.Material; dark: THREE.Material }, seed = 1, shadows = true, count = 4, rec: Recording | null = null) {
    this.rec = rec;
    this.group.add(this.rig);
    for (let a = 0; a < 2; a++) {
      const arm = new Arm(kit.def, kit.meshes, mats, YAM, shadows);
      arm.root.position.set(BASES[a][0], BASES[a][1], 0);
      arm.root.rotation.z = YAW;
      arm.root.scale.setScalar(1000);
      armZ = -arm.footprint().min.z * 1000 + LIFT;
      arm.root.position.z = armZ;
      this.rig.add(arm.root);
      this.arms.push(arm);
    }
    // one scene, episodes back to back; each leaves the scene as it found it. Plans depend
    // only on the seed, so benches with the same seed share them
    const size = kit.blocks.size, key = `${seed}/${count}`, cached = PLANS.get(key);
    if (rec) { this.pieces = rec.glyphs.map((glyph, id) => ({ id, glyph, spot: new THREE.Vector2(), yaw: 0 })); this.loop = rec.frames / rec.fps; }
    else if (cached) Object.assign(this, { pieces: cached.pieces, episodes: cached.episodes, moves: cached.moves, loop: cached.loop });
    else {
      this.pieces = makeScene(seed, size);
      let t = 0;
      for (let e = 0; e < count; e++) { const ep = episode(this.pieces, seed * 101 + e, size, t); this.episodes.push(ep); t = ep.end; }
      this.loop = t;
      this.moves = this.episodes.flatMap(e => e.moves);
    }
    for (const p of this.pieces) {
      const g = new THREE.Group();
      const body = new THREE.Mesh(kit.blocks.body, kit.blocks.mats.body);
      body.castShadow = shadows; body.receiveShadow = shadows;
      g.add(body);
      g.add(new THREE.Mesh(kit.blocks.decal[p.glyph], kit.blocks.mats.decal));
      this.rig.add(g);
      this.blocks.push(g);
      const sh = blob(kit.blocks.size * 1.9);
      this.rig.add(sh);
      this.shadows.push(sh);
    }
    for (const a of this.arms) { const sh = blob(190); sh.position.set(a.root.position.x, a.root.position.y - 30, 0.4); (sh.material as THREE.MeshBasicMaterial).opacity = 0.45; this.rig.add(sh); }
    if (!cached && !rec) { for (const m of this.moves) this.planMove(m); PLANS.set(key, { pieces: this.pieces, episodes: this.episodes, moves: this.moves, loop: this.loop }); }
  }

  // IK at the five waypoints of a move. The wrist roll is chosen twice: at the grasp, so the
  // fingers close square on two faces of the block (never across a corner); and on the way,
  // so the block lands turned as the goal wants. Of the four square grasps, the one that keeps
  // the wrist furthest inside its limits wins.
  private planMove(m: Move) {
    const arm = this.arms[m.arm], toArm = rigFromArm(m.arm).invert(), local = (p: THREE.Vector3) => p.clone().applyMatrix4(toArm);
    const home = arm.ik(local(new THREE.Vector3(BASES[m.arm][0] * 0.7, -190, 250)), { ...YAM.rest });
    const hf0 = arm.ik(local(m.from.clone().setZ(m.from.z + HOVER)), home), gf0 = arm.ik(local(m.from), hf0);
    const ht0 = arm.ik(local(m.to.clone().setZ(m.to.z + HOVER)), gf0), gt0 = arm.ik(local(m.to), ht0);
    const blockAt = (q: Q) => rigFromArm(m.arm).multiply(arm.toolMatrix(q));
    const C = new THREE.Matrix4().compose(m.from, this.turn(m.piece, m.fromYaw), new THREE.Vector3(1, 1, 1));
    const faceYaw = yawOf(C), want = yawOf(new THREE.Matrix4().makeRotationFromQuaternion(this.turn(m.piece, m.toYaw)));
    // which way the block turns when the wrist rolls (the gripper points down, so it is mirrored): measured, not assumed
    const sgn = Math.sign(wrap(yawOf(blockAt({ ...gf0, joint6: (gf0.joint6 ?? 0) + 0.1 })) - yawOf(blockAt(gf0)))) || 1;
    const roll = (q: Q, r: number) => ({ ...q, joint6: (q.joint6 ?? 0) + sgn * r });
    const inside = (q: Q) => Math.abs(q.joint6 ?? 0) <= 2.05;
    let best: Plan | null = null, bestCost = Infinity;
    for (let k = 0; k < 4; k++) {
      // the fingers close along the tool's x axis: line it up with one of the block's faces
      const rg = wrap(faceYaw - yawOf(blockAt(gf0)) + (k * Math.PI) / 2);
      const hf = roll(hf0, rg), gf = roll(gf0, rg);
      if (!inside(gf)) continue;
      const rel = blockAt(gf).invert().multiply(C);
      const rp = wrap(yawOf(blockAt(roll(gt0, rg)).multiply(rel)) - want);
      const ht = roll(ht0, rg - rp), gt = roll(gt0, rg - rp);
      if (!inside(gt)) continue;
      const cost = Math.abs(gf.joint6 ?? 0) + Math.abs(gt.joint6 ?? 0);
      if (cost < bestCost) { bestCost = cost; best = { home, hf, gf, ht, gt, rel }; }
    }
    m.q = best ?? { home, hf: hf0, gf: gf0, ht: ht0, gt: gt0, rel: blockAt(gf0).invert().multiply(C) };
  }
  private turn(piece: number, yaw: number): THREE.Quaternion {
    const p = this.pieces[piece], q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 0, 1), yaw);
    return q.multiply(this.kit.blocks.readable[p.glyph]);
  }

  // clamp the arm bases at the open front edge of a worktop this deep, facing the back
  layout(depth: number) { this.rig.position.set(0, -depth / 2 - this.arms[0].footprint().min.x * 1000, 0); this.rig.rotation.z = Math.PI; }

  // a recorded frame, interpolated between the two nearest samples; past the end it holds still
  private play(time: number) {
    const r = this.rec!;
    if (this.looping) time = ((time % this.loop) + this.loop) % this.loop;
    const x = Math.min(r.frames - 1, Math.max(0, time * r.fps)), i0 = Math.floor(x), i1 = Math.min(r.frames - 1, i0 + 1), k = x - i0;
    const at = (c: number) => r.data[i0 * r.stride + c] * (1 - k) + r.data[i1 * r.stride + c] * k;
    for (let a = 0; a < 2; a++) {
      const q: Q = {}, o = a * 8;
      ARM_JOINTS.forEach((j, n) => (q[j] = at(o + n) / 1e4));
      q.left_finger = at(o + 6) / 2e4; q.right_finger = at(o + 7) / 2e4;
      this.arms[a].set(q);
    }
    this.blocks.forEach((g, id) => {
      const o = 16 + 7 * id, row = (f: number, c: number) => r.data[f * r.stride + o + c] / 32767;
      g.position.set(at(o) / 20, at(o + 1) / 20, at(o + 2) / 20);   // 0.05 mm units to mm
      this.qa.set(row(i0, 4), row(i0, 5), row(i0, 6), row(i0, 3)).normalize();
      this.qb.set(row(i1, 4), row(i1, 5), row(i1, 6), row(i1, 3)).normalize();
      g.quaternion.slerpQuaternions(this.qa, this.qb, k).multiply(this.kit.blocks.readable[this.pieces[id].glyph]);
      g.scale.setScalar(1);
      const sh = this.shadows[id], lift = g.position.z - this.kit.blocks.size / 2;
      sh.position.set(g.position.x, g.position.y, 0.3);
      (sh.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.max(0, 1 - lift / 90);
      sh.visible = lift < 90;
    });
  }

  /** the goal of the episode playing at time t, bottom to top, in ToyBlocks' words */
  goalAt(time: number): string[] {
    const t = ((time % this.loop) + this.loop) % this.loop, ep = this.episodes.find(e => t < e.end) ?? this.episodes[0];
    return ep.goal.map(id => `block ${this.pieces[id].glyph}`);
  }

  update(time: number) {
    if (this.rec) return this.play(time);
    const t = ((time % this.loop) + this.loop) % this.loop, qs: Q[] = [];
    for (let a = 0; a < 2; a++) {
      const arm = this.arms[a], m = this.moves.find(x => x.arm === a && t >= x.start && t < x.start + MOVE);
      let q = arm.grip(this.moves.find(x => x.arm === a)?.q?.home ?? YAM.rest, true);
      if (m?.q) {
        const w = m.q, open = (x: Q) => arm.grip(x, true), shut = (x: Q) => arm.grip(x, false);
        const keys: [number, Q][] = [[0, open(w.home)], [0.6, open(w.hf)], [0.9, open(w.gf)], [GRASP, shut(w.gf)], [1.4, shut(w.hf)],
          [2.1, shut(w.ht)], [2.4, shut(w.gt)], [RELEASE, open(w.gt)], [2.85, open(w.ht)], [MOVE, open(w.home)]];
        const u = t - m.start;
        for (let i = 0; i < keys.length - 1; i++) if (u >= keys[i][0] && u <= keys[i + 1][0]) { q = mix(keys[i][1], keys[i + 1][1], (u - keys[i][0]) / (keys[i + 1][0] - keys[i][0])); break; }
      }
      arm.set(q);
      qs[a] = q;
    }
    // each block: carried, or where its last move left it, or at home
    this.blocks.forEach((g, id) => {
      const last = this.moves.filter(x => x.piece === id && t >= x.start + GRASP).sort((a, b) => b.start - a.start)[0], p = this.pieces[id];
      if (last?.q && t < last.start + RELEASE) rigFromArm(last.arm).multiply(this.arms[last.arm].toolMatrix(qs[last.arm])).multiply(last.q.rel).decompose(g.position, g.quaternion, g.scale);
      else if (last) { g.position.copy(last.to); g.quaternion.copy(this.turn(id, last.toYaw)); g.scale.setScalar(1); }
      else { g.position.set(p.spot.x, p.spot.y, this.kit.blocks.size / 2 + LIFT); g.quaternion.copy(this.turn(id, p.yaw)); g.scale.setScalar(1); }
      // its contact shadow on the worktop, only while it is low; a block on the tower casts onto the one below
      const sh = this.shadows[id], lift = g.position.z - this.kit.blocks.size / 2;
      sh.position.set(g.position.x, g.position.y, 0.3);
      (sh.material as THREE.MeshBasicMaterial).opacity = 0.55 * Math.max(0, 1 - lift / 90);
      sh.visible = lift < 90;
    });
  }
}
