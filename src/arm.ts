// A minimal URDF arm for the video: the link tree as three.js groups (revolute and
// prismatic joints), forward kinematics, and a damped-least-squares IK that puts the tool
// point on a target while the gripper points straight down. Metres, z up, as in the URDF.
import * as THREE from 'three';
import { STLLoader } from 'three/examples/jsm/loaders/STLLoader.js';

export type Q = Record<string, number>;
interface JointDef { name: string; parent: string; child: string; xyz: number[]; rpy: number[]; axis: number[]; lower: number; upper: number; type: string }
interface VisualDef { link: string; mesh: string; xyz: number[]; rpy: number[] }
export interface ArmDef { joints: JointDef[]; visuals: VisualDef[]; root: string }

// what the video needs to know about an arm beyond its URDF
export interface ArmConfig {
  ik: string[];                             // joints the IK moves
  toolLink: string;                         // the link the gripper is on
  toolOffset: [number, number, number];     // tool point (between the fingertips), in that link
  approach: [number, number, number];       // the gripper's approach axis, in that link
  fingers: { joint: string; open: number; shut: number }[];
  rest: Q;                                  // a comfortable pose to start from
  shells: string[];                         // meshes with a light shell between dark ends (the rest are dark)
}

export const YAM: ArmConfig = {
  ik: ['joint1', 'joint2', 'joint3', 'joint4', 'joint5'],
  toolLink: 'gripper',
  toolOffset: [0, 0, 0.14465],   // i2rt: TCP 144.65 mm out along the flange's +Z
  approach: [0, 0, 1],
  fingers: [{ joint: 'joint7', open: -0.038, shut: -0.012 }, { joint: 'joint8', open: -0.038, shut: -0.012 }],
  rest: { joint1: 0, joint2: 0.9, joint3: 1.4, joint4: 0.5, joint5: 0, joint6: 0 },
  // as on the real arm: white shells on the upper arm and forearm, black everything else
  shells: ['link2.stl', 'link3.stl'],
};

const nums = (s: string | null, d = '0 0 0') => (s ?? d).trim().split(/\s+/).map(Number);
const frame = (xyz: number[], rpy: number[]) => new THREE.Matrix4().compose(new THREE.Vector3(...xyz), new THREE.Quaternion().setFromEuler(new THREE.Euler(rpy[0], rpy[1], rpy[2], 'ZYX')), new THREE.Vector3(1, 1, 1));

export function parseUrdf(xml: string): ArmDef {
  const doc = new DOMParser().parseFromString(xml, 'application/xml');
  const joints: JointDef[] = [...doc.querySelectorAll('robot > joint')].map(j => {
    const o = j.querySelector('origin'), lim = j.querySelector('limit');
    return {
      name: j.getAttribute('name')!, parent: j.querySelector('parent')!.getAttribute('link')!, child: j.querySelector('child')!.getAttribute('link')!,
      xyz: nums(o?.getAttribute('xyz') ?? null), rpy: nums(o?.getAttribute('rpy') ?? null), axis: nums(j.querySelector('axis')?.getAttribute('xyz') ?? null, '0 0 1'),
      lower: Number(lim?.getAttribute('lower') ?? -Math.PI), upper: Number(lim?.getAttribute('upper') ?? Math.PI), type: j.getAttribute('type') || 'fixed',
    };
  });
  const visuals: VisualDef[] = [];
  for (const l of doc.querySelectorAll('robot > link')) for (const v of l.querySelectorAll('visual')) {
    const o = v.querySelector('origin'), m = v.querySelector('mesh');
    if (m) visuals.push({ link: l.getAttribute('name')!, mesh: m.getAttribute('filename')!.split('/').pop()!, xyz: nums(o?.getAttribute('xyz') ?? null), rpy: nums(o?.getAttribute('rpy') ?? null) });
  }
  const children = new Set(joints.map(j => j.child));
  const root = joints.map(j => j.parent).find(p => !children.has(p))!;
  return { joints, visuals, root };
}

export async function loadMeshes(base: string, files: string[]): Promise<Record<string, THREE.BufferGeometry>> {
  const loader = new STLLoader(), out: Record<string, THREE.BufferGeometry> = {};
  await Promise.all([...new Set(files)].map(async f => { const g = loader.parse(await (await fetch(base + f)).arrayBuffer()); g.computeVertexNormals(); out[f] = g; }));
  return out;
}

export class Arm {
  root = new THREE.Group();
  private joints: Record<string, { pivot: THREE.Object3D; def: JointDef }> = {};
  private links: Record<string, THREE.Object3D> = {};
  tool = new THREE.Object3D();

  constructor(def: ArmDef, meshes: Record<string, THREE.BufferGeometry>, mats: { body: THREE.Material; dark: THREE.Material }, readonly cfg: ArmConfig, shadows = true) {
    this.links[def.root] = this.root;
    const pending = [...def.joints];
    while (pending.length) {
      const i = pending.findIndex(j => this.links[j.parent]);
      if (i < 0) break;
      const j = pending.splice(i, 1)[0];
      const origin = new THREE.Object3D();
      origin.applyMatrix4(frame(j.xyz, j.rpy));
      const pivot = new THREE.Object3D();
      origin.add(pivot);
      this.links[j.parent].add(origin);
      this.links[j.child] = pivot;
      if (j.type !== 'fixed') this.joints[j.name] = { pivot, def: j };
    }
    for (const v of def.visuals) {
      const g = meshes[v.mesh];
      if (!g || !this.links[v.link]) continue;
      const mesh = new THREE.Mesh(cfg.shells.includes(v.mesh) ? shell(g) : g, cfg.shells.includes(v.mesh) ? mats.body : mats.dark);
      mesh.applyMatrix4(frame(v.xyz, v.rpy));
      mesh.castShadow = shadows; mesh.receiveShadow = shadows;
      this.links[v.link].add(mesh);
    }
    this.tool.position.set(...cfg.toolOffset);
    this.links[cfg.toolLink].add(this.tool);
  }

  // the base plate's extent in the arm's own frame (metres), to clamp it at a table edge
  footprint(): THREE.Box3 {
    this.root.updateMatrixWorld(true);
    const inv = this.root.matrixWorld.clone().invert(), box = new THREE.Box3();
    for (const c of this.root.children) if ((c as THREE.Mesh).isMesh) { const g = (c as THREE.Mesh).geometry; g.computeBoundingBox(); box.union(g.boundingBox!.clone().applyMatrix4(inv.clone().multiply(c.matrixWorld))); }
    return box;
  }

  set(q: Q) {
    for (const [n, v] of Object.entries(q)) {
      const j = this.joints[n];
      if (!j) continue;
      const ax = new THREE.Vector3(...j.def.axis).normalize();
      if (j.def.type === 'prismatic') j.pivot.position.copy(ax.multiplyScalar(v));
      else j.pivot.quaternion.setFromAxisAngle(ax, v);
    }
  }
  grip(q: Q, open: boolean): Q { const o = { ...q }; for (const f of this.cfg.fingers) o[f.joint] = open ? f.open : f.shut; return o; }

  // tool position and approach direction in the arm's root frame
  fk(q: Q): { p: THREE.Vector3; a: THREE.Vector3 } {
    this.set(q);
    this.root.updateMatrixWorld(true);
    const M = this.root.matrixWorld.clone().invert().multiply(this.tool.matrixWorld);
    return { p: new THREE.Vector3().setFromMatrixPosition(M), a: new THREE.Vector3(...this.cfg.approach).transformDirection(M) };
  }
  // the tool's pose in the arm's root frame
  toolMatrix(q: Q): THREE.Matrix4 {
    this.set(q);
    this.root.updateMatrixWorld(true);
    return this.root.matrixWorld.clone().invert().multiply(this.tool.matrixWorld);
  }

  // the IK joints so the tool sits on target (root frame, metres), pointing down
  ik(target: THREE.Vector3, seed: Q, iters = 150): Q {
    const names = this.cfg.ik, down = new THREE.Vector3(0, 0, -1), W = 0.08;
    const lim = names.map(n => [this.joints[n].def.lower, this.joints[n].def.upper]);
    const err = (q: Q) => { const { p, a } = this.fk(q); return [target.x - p.x, target.y - p.y, target.z - p.z, (down.x - a.x) * W, (down.y - a.y) * W, (down.z - a.z) * W]; };
    const solve = (s0: Q) => {
      const q = { ...s0 };
      for (let it = 0; it < iters; it++) {
        const e = err(q);
        if (Math.hypot(...e) < 1e-4) break;
        const J = names.map(n => { const e2 = err({ ...q, [n]: q[n] + 1e-4 }); return e.map((v, r) => (e2[r] - v) / -1e-4); });
        const k = names.length;
        const A = [...Array(k).keys()].map(i => [...Array(k).keys()].map(j => J[i].reduce((s, v, r) => s + v * J[j][r], 0) + (i === j ? 2e-4 : 0)));
        const b = [...Array(k).keys()].map(i => J[i].reduce((s, v, r) => s + v * e[r], 0));
        const dq = solveN(A, b);
        names.forEach((n, i) => { q[n] = Math.min(lim[i][1], Math.max(lim[i][0], q[n] + Math.max(-0.25, Math.min(0.25, dq[i])))); });
      }
      return { q, e: Math.hypot(...err(q)) };
    };
    let best = solve(seed);
    if (best.e > 2e-3) for (const s of [this.cfg.rest, { ...this.cfg.rest, joint1: Math.atan2(target.y, target.x) }]) { const r = solve({ ...seed, ...s }); if (r.e < best.e) best = r; }
    return best.q;
  }
}

// a link with a light shell along its middle and dark ends: vertex colours along its long axis
const shellCache = new Map<THREE.BufferGeometry, THREE.BufferGeometry>();
function shell(g: THREE.BufferGeometry): THREE.BufferGeometry {
  let out = shellCache.get(g);
  if (out) return out;
  out = g.clone();
  out.computeBoundingBox();
  const b = out.boundingBox!, size = b.getSize(new THREE.Vector3()), ax = size.x > size.y ? (size.x > size.z ? 0 : 2) : size.y > size.z ? 1 : 2;
  // one colour per triangle, from its centre, so the shell's edge is crisp instead of a grey blend
  const pos = out.attributes.position, col = new Float32Array(pos.count * 3), lo = b.min.getComponent(ax), len = size.getComponent(ax);
  for (let i = 0; i + 2 < pos.count; i += 3) {
    const t = ((pos.getComponent(i, ax) + pos.getComponent(i + 1, ax) + pos.getComponent(i + 2, ax)) / 3 - lo) / len;
    const c = t > 0.17 && t < 0.83 ? [1, 1, 1] : [0.07, 0.075, 0.085];
    for (let k = 0; k < 3; k++) col.set(c, (i + k) * 3);
  }
  out.setAttribute('color', new THREE.BufferAttribute(col, 3));
  shellCache.set(g, out);
  return out;
}

function solveN(A: number[][], b: number[]): number[] {
  const n = b.length, M = A.map((r, i) => [...r, b[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(M[r][c]) > Math.abs(M[p][c])) p = r;
    [M[c], M[p]] = [M[p], M[c]];
    for (let r = 0; r < n; r++) if (r !== c) { const f = M[r][c] / M[c][c]; for (let k = c; k <= n; k++) M[r][k] -= f * M[c][k]; }
  }
  return M.map((r, i) => r[n] / r[i]);
}
