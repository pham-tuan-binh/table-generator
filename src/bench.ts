// Two i2rt YAM arms on the worktop, building a tower of cubes together and taking it
// down again, forever. Scripted, not simulated: joint angles come from IK at a handful of
// waypoints and are eased between, so it looks right and costs nothing.
//
// Layout follows i2rt's YAM station: two arms side by side, 610 mm apart, both facing
// into the workspace. Here they sit at the open front of the worktop, facing the back.
// Everything is placed in a "rig" frame (mm, z up) whose origin is midway between the arm
// bases, so the plan never depends on the table's size.
import * as THREE from 'three';
import { Arm, ArmDef, YAM, parseUrdf, loadMeshes, Q } from './arm.ts';

export const ARM_SPACING = 610;                     // mm, centre to centre (i2rt station)
export const BENCH_MIN_WIDTH = ARM_SPACING + 180;   // clear width the pair needs
const CUBE = 40, HOVER = 95, SLOT = 1.6, MOVE = 3.2, GRASP = 1.1, RELEASE = 2.55, N = 3;
const BASES: [number, number][] = [[-ARM_SPACING / 2, 0], [ARM_SPACING / 2, 0]];
const PILES = [new THREE.Vector3(-330, -230, 0), new THREE.Vector3(330, -230, 0)];
const TOWER = new THREE.Vector3(0, -250, 0);
const YAW = -Math.PI / 2;   // arm forward (+x) turned to face the front (-y)

export interface Kit { def: ArmDef; meshes: Record<string, THREE.BufferGeometry> }
export async function loadKit(base: string, lod: 'hero' | 'crowd'): Promise<Kit> {
  const def = parseUrdf(await (await fetch(base + 'yam.urdf')).text());
  return { def, meshes: await loadMeshes(`${base}${lod}/`, def.visuals.map(v => v.mesh)) };
}

// ------------------------------------------------------------------ the script
// one cycle: left, right, left, right, left, right onto the tower; a beat; then back off
// the tower in reverse; a beat. Even slots belong to the left arm, odd to the right, so an
// arm never starts a move before its last one ends.
interface Move { slot: number; arm: number; cube: number; from: Stack; to: Stack }
interface Stack { kind: 'pile' | 'tower'; arm: number; level: number }
const CYCLE = 14;
const SCRIPT: Move[] = (() => {
  const piles = [[0, 1, 2], [3, 4, 5]], tower: number[] = [], out: Move[] = [];
  for (let s = 0; s < 6; s++) { const arm = s % 2, cube = piles[arm].pop()!; out.push({ slot: s, arm, cube, from: { kind: 'pile', arm, level: piles[arm].length }, to: { kind: 'tower', arm, level: tower.length } }); tower.push(cube); }
  for (let s = 7; s < 13; s++) { const arm = s % 2, cube = tower.pop()!; out.push({ slot: s, arm, cube, from: { kind: 'tower', arm, level: tower.length }, to: { kind: 'pile', arm, level: piles[arm].length } }); piles[arm].push(cube); }
  return out;
})();
const owner = (cube: number) => (cube < N ? 0 : 1);
const stackPoint = (s: Stack) => (s.kind === 'pile' ? PILES[s.arm] : TOWER).clone().setZ(CUBE / 2 + s.level * CUBE);

// ------------------------------------------------------------------ the plan: IK once
interface Plan { q: Record<string, Q>[]; rel: THREE.Matrix4[] }
let plan: Plan | null = null;
const rigFromArm = (arm: number) => new THREE.Matrix4().makeTranslation(BASES[arm][0], BASES[arm][1], 0).multiply(new THREE.Matrix4().makeRotationZ(YAW)).multiply(new THREE.Matrix4().makeScale(1000, 1000, 1000));
function makePlan(kit: Kit): Plan {
  const arm = new Arm(kit.def, kit.meshes, { body: new THREE.MeshBasicMaterial(), dark: new THREE.MeshBasicMaterial() }, YAM, false);
  const q: Record<string, Q>[] = [], rel: THREE.Matrix4[] = [];
  for (let a = 0; a < 2; a++) {
    const toArm = rigFromArm(a).invert(), local = (p: THREE.Vector3) => p.clone().applyMatrix4(toArm);
    const w: Record<string, Q> = {};
    let seed: Q = { ...YAM.rest };
    const solve = (key: string, p: THREE.Vector3) => { seed = arm.ik(local(p), seed); w[key] = seed; };
    solve('home', PILES[a].clone().setZ(N * CUBE + HOVER + 40));
    for (let h = 0; h < N; h++) { const p = stackPoint({ kind: 'pile', arm: a, level: h }); solve(`pg${h}`, p); solve(`ph${h}`, p.clone().setZ(p.z + HOVER)); }
    seed = w.home;
    for (let h = 0; h < 2 * N; h++) { const p = stackPoint({ kind: 'tower', arm: a, level: h }); solve(`tg${h}`, p); solve(`th${h}`, p.clone().setZ(p.z + HOVER)); }
    q.push(w);
    // where a gripped cube sits in the tool frame
    const T = rigFromArm(a).multiply(arm.toolMatrix(w.pg0)), C = new THREE.Matrix4().makeTranslation(PILES[a].x, PILES[a].y, CUBE / 2);
    rel.push(T.invert().multiply(C));
  }
  return { q, rel };
}

// ------------------------------------------------------------------ one bench
const ease = (x: number) => { x = Math.min(1, Math.max(0, x)); return x * x * x * (x * (x * 6 - 15) + 10); };
const mix = (a: Q, b: Q, k: number) => { const e = ease(k), o: Q = {}; for (const n in a) o[n] = a[n] + ((b[n] ?? a[n]) - a[n]) * e; return o; };
const CUBE_GEO = new THREE.BoxGeometry(CUBE, CUBE, CUBE);

export class Bench {
  group = new THREE.Group();   // origin: the worktop surface centre
  rig = new THREE.Group();     // origin: midway between the arm bases
  arms: Arm[] = [];
  cubes: THREE.Mesh[] = [];

  constructor(kit: Kit, mats: { body: THREE.Material; dark: THREE.Material; cubes: [THREE.Material, THREE.Material] }, shadows = true) {
    plan ??= makePlan(kit);
    this.group.add(this.rig);
    for (let a = 0; a < 2; a++) {
      const arm = new Arm(kit.def, kit.meshes, mats, YAM, shadows);
      arm.root.position.set(BASES[a][0], BASES[a][1], 0);
      arm.root.rotation.z = YAW;
      arm.root.scale.setScalar(1000);
      this.rig.add(arm.root);
      this.arms.push(arm);
    }
    for (let c = 0; c < 2 * N; c++) {
      const m = new THREE.Mesh(CUBE_GEO, mats.cubes[owner(c)]);
      m.castShadow = shadows; m.receiveShadow = shadows;
      this.rig.add(m);
      this.cubes.push(m);
    }
  }

  // clamp the arm bases at the open front edge of a worktop this deep, facing the back:
  // the back of each base plate sits on the edge
  layout(depth: number) { this.rig.position.set(0, -depth / 2 - this.arms[0].footprint().min.x * 1000, 0); this.rig.rotation.z = Math.PI; }

  update(t: number) {
    const P = plan!, len = CYCLE * SLOT, c0 = Math.floor(t / len) * len;
    // the moves in play: this cycle's, and the tail of the last one
    const moves = [...SCRIPT.map(m => ({ ...m, start: c0 + m.slot * SLOT })), ...SCRIPT.map(m => ({ ...m, start: c0 - len + m.slot * SLOT }))];
    const qs: Q[] = [];
    for (let a = 0; a < 2; a++) {
      const w = P.q[a], m = moves.find(x => x.arm === a && t >= x.start && t < x.start + MOVE);
      let q = w.home;
      if (m) {
        const g = (s: Stack) => `${s.kind === 'pile' ? 'p' : 't'}g${s.level}`, h = (s: Stack) => `${s.kind === 'pile' ? 'p' : 't'}h${s.level}`;
        const open = (x: Q) => this.arms[a].grip(x, true), shut = (x: Q) => this.arms[a].grip(x, false);
        const keys: [number, Q][] = [[0, open(w.home)], [0.6, open(w[h(m.from)])], [0.9, open(w[g(m.from)])], [GRASP, shut(w[g(m.from)])], [1.4, shut(w[h(m.from)])],
          [2.1, shut(w[h(m.to)])], [2.4, shut(w[g(m.to)])], [RELEASE, open(w[g(m.to)])], [2.85, open(w[h(m.to)])], [MOVE, open(w.home)]];
        const u = t - m.start;
        for (let i = 0; i < keys.length - 1; i++) if (u >= keys[i][0] && u <= keys[i + 1][0]) { q = mix(keys[i][1], keys[i + 1][1], (u - keys[i][0]) / (keys[i + 1][0] - keys[i][0])); break; }
      } else q = this.arms[a].grip(w.home, true);
      this.arms[a].set(q);
      qs[a] = q;
    }
    // each cube: where its latest grasp left it, or in a gripper
    for (let c = 0; c < 2 * N; c++) {
      const mine = moves.filter(x => x.cube === c && t >= x.start + GRASP).sort((x, y) => y.start - x.start)[0];
      const cube = this.cubes[c];
      if (mine && t < mine.start + RELEASE) {
        const M = rigFromArm(mine.arm).multiply(this.arms[mine.arm].toolMatrix(qs[mine.arm])).multiply(P.rel[mine.arm]);
        M.decompose(cube.position, cube.quaternion, cube.scale);
      } else {
        const s = mine ? mine.to : { kind: 'pile' as const, arm: owner(c), level: c % N };
        cube.position.copy(stackPoint(s));
        cube.quaternion.identity(); cube.scale.setScalar(1);
      }
    }
  }
}

