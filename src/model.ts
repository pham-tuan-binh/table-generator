// Params -> the physical design: every extrusion, panel, bracket, foot and camera with its
// pose, mass and the build step it is fitted in. Pure data, no DOM, so the page, the
// exporters and the command-line generator all read the same model.
import { Params, PROFILES, ProfileSpec, material, CASTERS, FOOT_HEIGHT, cameraPreset, CameraSpec, Face } from './params.ts';
import { sizeFrame, Sizing } from './structure.ts';

export type V3 = [number, number, number];
export type Axis = 'x' | 'y' | 'z';
export type Role = 'frame' | 'panel' | 'worktop' | 'shelf' | 'hw' | 'cam' | 'dark';

export interface Box { c: V3; s: V3 }
export interface Cyl { a: V3; b: V3; r: number }
export interface Member { axis: Axis; a: V3; length: number }   // centre line from a, along +axis

export interface Part {
  id: string;
  name: string;
  kind: 'member' | 'panel' | 'hardware' | 'camera';
  role: Role;
  step: number;
  boxes: Box[];          // simple solids: collision for everything, visual for panels/hardware
  cyls: Cyl[];
  member?: Member;
  outline?: [number, number][];  // panels: the cut outline (mm, in the panel's own plane)
  plane?: 'xy' | 'xz' | 'yz';
  thk?: number;
  materialId?: string;
  mass: number;          // kg
  spec: string;
  collide: boolean;
}

export interface CameraPose {
  spec: CameraSpec;
  pos: V3;               // optical centre, mm
  f: V3; l: V3; u: V3;   // forward, left, up (ROS body axes) in the design frame
  hfov: number; vfov: number;
  fx: number; fy: number; cx: number; cy: number;
  valid: boolean;
  note?: string;
}

export interface Step { n: number; title: string; tasks: string[]; check?: string; warn?: string }

export interface Model {
  p: Params;
  prof: ProfileSpec;
  s: number;
  baseH: number;
  topZ: number;          // top of the box rails
  worktopZ: number;      // top of the worktop surface (or of the table rails without one)
  parts: Part[];
  cameras: CameraPose[];
  steps: Step[];
  bbox: [V3, V3];
  mass: number;
  com: V3;
  inertia: [number, number, number, number, number, number]; // ixx iyy izz ixy ixz iyz, kg·m² about the COM
  supportCount: number;
  sizing: Sizing;
}

const add = (a: V3, b: V3): V3 => [a[0] + b[0], a[1] + b[1], a[2] + b[2]];
const sub = (a: V3, b: V3): V3 => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const mul = (a: V3, k: number): V3 => [a[0] * k, a[1] * k, a[2] * k];
const dot = (a: V3, b: V3) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const cross = (a: V3, b: V3): V3 => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
const norm = (a: V3): V3 => { const l = Math.hypot(...a) || 1; return [a[0] / l, a[1] / l, a[2] / l]; };
export const vec = { add, sub, mul, dot, cross, norm };
const AX: Record<Axis, V3> = { x: [1, 0, 0], y: [0, 1, 0], z: [0, 0, 1] };
const FACE: Record<Face, V3> = { '+x': [1, 0, 0], '-x': [-1, 0, 0], '+y': [0, 1, 0], '-y': [0, -1, 0], '+z': [0, 0, 1], '-z': [0, 0, -1] };
const D2R = Math.PI / 180;

export function memberBox(m: Member, s: number): Box {
  const ax = AX[m.axis], c = add(m.a, mul(ax, m.length / 2));
  return { c, s: [m.axis === 'x' ? m.length : s, m.axis === 'y' ? m.length : s, m.axis === 'z' ? m.length : s] };
}

export function buildModel(input: Params): Model {
  // the extrusion follows from the rated load, never from a picker
  const sizing = sizeFrame(input), p: Params = { ...input, profile: sizing.profile };
  const prof = PROFILES[p.profile], s = prof.s, e = prof.engage;
  const W = p.width, D = p.depth, Ht = p.tableHeight, Htot = p.tableHeight + p.boxHeight;
  const baseH = p.base === 'casters' ? CASTERS[p.casterWheel] : FOOT_HEIGHT;
  const hx = W / 2 - s / 2, hy = D / 2 - s / 2;
  const parts: Part[] = [];
  const memberPart = (id: string, name: string, m: Member, step: number, extra: Partial<Part> = {}): Part => {
    const part: Part = {
      id, name, kind: 'member', role: 'frame', step, member: m, boxes: [memberBox(m, s)], cyls: [],
      mass: (prof.kgPerM * m.length) / 1000, spec: `${prof.id} × ${round(m.length)} mm`, collide: true, ...extra,
    };
    parts.push(part);
    return part;
  };

  // ---- posts: one piece from the base to the top of the box
  const corners: Record<string, [number, number]> = { FL: [-1, -1], FR: [1, -1], BL: [-1, 1], BR: [1, 1] };
  const cornerName: Record<string, string> = { FL: 'front left', FR: 'front right', BL: 'back left', BR: 'back right' };
  for (const [k, [sx, sy]] of Object.entries(corners))
    memberPart(`post_${k}`, `Post, ${cornerName[k]}`, { axis: 'z', a: [sx * hx, sy * hy, baseH], length: Htot - baseH }, 2);

  // ---- rings of rails between the posts; top of each ring at z
  const ring = (level: string, label: string, z: number, sides: ('front' | 'back' | 'left' | 'right')[], stepY: number, stepX: number) => {
    for (const side of sides) {
      const isX = side === 'front' || side === 'back';
      const sgn = side === 'front' || side === 'left' ? -1 : 1;
      const m: Member = isX
        ? { axis: 'x', a: [-W / 2 + s, sgn * hy, z - s / 2], length: W - 2 * s }
        : { axis: 'y', a: [sgn * hx, -D / 2 + s, z - s / 2], length: D - 2 * s };
      memberPart(`rail_${level}_${side}`, `${label} rail, ${side}`, m, isX ? stepX : stepY);
    }
  };
  const lowerSides: ('front' | 'back' | 'left' | 'right')[] = p.lowerRing === 'full' ? ['left', 'right', 'front', 'back'] : p.lowerRing === 'sides-back' ? ['left', 'right', 'back'] : [];
  ring('lower', p.shelf ? 'Shelf' : 'Lower', p.lowerHeight, lowerSides, 3, 4);
  ring('table', 'Worktop', Ht, ['left', 'right', 'front', 'back'], 3, 4);
  ring('top', 'Top', Htot, ['left', 'right', 'front', 'back'], 7, 7);

  // ---- bars under the worktop, flush with the worktop rails, front to back
  const autoSupports = Math.max(0, Math.ceil((W - 2 * s) / 450) - 1);
  const nSup = p.supports < 0 ? autoSupports : p.supports;
  for (let i = 0; i < nSup; i++) {
    const x = -W / 2 + s + ((W - 2 * s) * (i + 1)) / (nSup + 1);
    memberPart(`support_${i + 1}`, `Worktop support ${i + 1}`, { axis: 'y', a: [x, -D / 2 + s, Ht - s / 2], length: D - 2 * s }, 4);
  }
  if (p.overheadBar)
    memberPart('bar_overhead', 'Overhead camera bar', { axis: 'x', a: [-W / 2 + s, p.overheadBarY, Htot - s / 2], length: W - 2 * s }, 7);

  // ---- boards resting on a ring, notched round the posts
  const board = (id: string, name: string, role: Role, z: number, matId: string, t: number, step: number) => {
    const mat = material(matId);
    const outline: [number, number][] = [[s, 0], [W - s, 0], [W - s, s], [W, s], [W, D - s], [W - s, D - s], [W - s, D], [s, D], [s, D - s], [0, D - s], [0, s], [s, s]];
    const boxes: Box[] = [
      { c: [0, 0, z + t / 2], s: [W, D - 2 * s, t] },
      { c: [0, -D / 2 + s / 2, z + t / 2], s: [W - 2 * s, s, t] },
      { c: [0, D / 2 - s / 2, z + t / 2], s: [W - 2 * s, s, t] },
    ];
    const area = (W * D - 4 * s * s) / 1e6;
    parts.push({ id, name, kind: 'panel', role, step, boxes, cyls: [], outline, plane: 'xy', thk: t, materialId: matId,
      mass: area * (t / 1000) * mat.density, spec: `${mat.name}, ${t} mm, ${round(W)} × ${round(D)} notched ${round(s)} × ${round(s)}`, collide: true });
  };
  if (p.shelf) board('shelf', 'Shelf board', 'shelf', p.lowerHeight, p.shelfMaterial, p.shelfThk, 5);
  const wt = p.worktop ? p.worktopThk : 0;
  if (p.worktop) board('worktop', 'Worktop', 'worktop', Ht, p.worktopMaterial, p.worktopThk, 5);

  // ---- box walls: sheets held in the post slots and the top rails' slots
  const pm = material(p.panelMaterial), t = p.panelThk;
  const zb = p.worktop ? Ht + wt : Ht - e, zt = Htot - s + e;
  const wall = (face: 'back' | 'front' | 'left' | 'right') => {
    const isX = face === 'back' || face === 'front', sgn = face === 'front' || face === 'left' ? -1 : 1;
    const span = (isX ? W : D) - 2 * s + 2 * e, h = zt - zb;
    const c: V3 = isX ? [0, sgn * hy, (zb + zt) / 2] : [sgn * hx, 0, (zb + zt) / 2];
    const sz: V3 = isX ? [span, t, h] : [t, span, h];
    parts.push({ id: `panel_${face}`, name: `${cap(face)} wall`, kind: 'panel', role: 'panel', step: 6, boxes: [{ c, s: sz }], cyls: [],
      outline: [[0, 0], [span, 0], [span, h], [0, h]], plane: isX ? 'xz' : 'yz', thk: t, materialId: pm.id,
      mass: (span * h / 1e6) * (t / 1000) * pm.density, spec: `${pm.name}, ${t} mm, ${round(span)} × ${round(h)}`, collide: true });
  };
  for (const f of ['back', 'left', 'right', 'front'] as const) if (p.panels[f]) wall(f);
  if (p.panels.roof)
    parts.push({ id: 'panel_roof', name: 'Roof', kind: 'panel', role: 'panel', step: 7, boxes: [{ c: [0, 0, Htot + t / 2], s: [W, D, t] }], cyls: [],
      outline: [[0, 0], [W, 0], [W, D], [0, D]], plane: 'xy', thk: t, materialId: pm.id,
      mass: (W * D / 1e6) * (t / 1000) * pm.density, spec: `${pm.name}, ${t} mm, ${round(W)} × ${round(D)}`, collide: true });

  // ---- feet or casters under each post
  for (const [k, [sx, sy]] of Object.entries(corners)) {
    const x = sx * hx, y = sy * hy;
    if (p.base === 'feet') {
      parts.push({ id: `foot_${k}`, name: `Levelling foot, ${cornerName[k]}`, kind: 'hardware', role: 'dark', step: 2, boxes: [],
        cyls: [{ a: [x, y, 0], b: [x, y, 8], r: 20 }, { a: [x, y, 8], b: [x, y, baseH], r: 4 }], mass: 0.08,
        spec: `Levelling foot, ${prof.endTap} stud, Ø40 base`, collide: true });
    } else {
      const wr = p.casterWheel / 2, plate = 6;
      parts.push({ id: `caster_${k}`, name: `Caster, ${cornerName[k]}`, kind: 'hardware', role: 'dark', step: 2,
        boxes: [{ c: [x, y, baseH - plate / 2], s: [Math.max(s, 40), Math.max(s, 40), plate] }, { c: [x, y, (wr + baseH - plate) / 2], s: [p.casterWheel * 0.35, 6 + p.casterWheel * 0.32, baseH - plate - wr] }],
        cyls: [{ a: [x - p.casterWheel * 0.14, y, wr], b: [x + p.casterWheel * 0.14, y, wr], r: wr }], mass: 0.1 + p.casterWheel * 0.003,
        spec: `Swivel caster with brake, Ø${p.casterWheel} mm wheel, ${prof.endTap} threaded stem`, collide: true });
    }
  }

  // ---- an L bracket at each rail end: under the rail where it meets a post, on its side
  // where it meets another rail at the same level (supports, the overhead bar)
  const bl = s * 0.9, bt = Math.max(2.5, s * 0.12), bw = s * 0.8;
  const sized = (axis: Axis, along: number, across: number, up: number): V3 => axis === 'x' ? [along, across, up] : [across, along, up];
  for (const part of [...parts]) {
    if (part.kind !== 'member' || part.id.startsWith('post') || part.id.startsWith('rail_top')) continue;
    const m = part.member!, ax = AX[m.axis], toPost = part.id.startsWith('rail_');
    const q: V3 = m.axis === 'x' ? [0, 1, 0] : [1, 0, 0];
    for (const end of [0, 1]) {
      const pt = add(m.a, mul(ax, end * m.length)), dir = mul(ax, end ? -1 : 1);   // dir points into the rail
      const zBot = m.a[2] - s / 2;
      const boxes: Box[] = toPost
        ? [{ c: add([pt[0], pt[1], zBot - bt / 2], mul(dir, bl / 2)), s: sized(m.axis, bl, bw, bt) },
           { c: add([pt[0], pt[1], zBot - bl / 2], mul(dir, bt / 2)), s: sized(m.axis, bt, bw, bl) }]
        : [{ c: add(add(pt, mul(dir, bl / 2)), mul(q, s / 2 + bt / 2)), s: sized(m.axis, bl, bt, bw) },
           { c: add(add(pt, mul(dir, bt / 2)), mul(q, s / 2 + bl / 2)), s: sized(m.axis, bt, bl, bw) }];
      parts.push({ id: `bracket_${part.id}_${end}`, name: `L bracket, ${part.name.toLowerCase()} ${end ? 'end' : 'start'}`, kind: 'hardware', role: 'hw', step: part.step,
        boxes, cyls: [], mass: 0.02, spec: `${prof.id} L bracket, 2 hole`, collide: false });
    }
  }

  // ---- cameras: resolve each onto its member
  const worktopZ = Ht + wt;
  const cameras: CameraPose[] = p.cameras.map(c => resolveCamera(c, parts, s, worktopZ));
  for (const cam of cameras) {
    const pre = cameraPreset(cam.spec.preset), [bd, bw, bh] = pre.body;
    const back = add(cam.pos, mul(cam.f, -bd / 2 - 6));
    const surf = sub(cam.pos, mul(FACE[cam.spec.face], cam.spec.standoff));
    parts.push({ id: `cam_${cam.spec.id}`, name: `Camera "${cam.spec.name}"`, kind: 'camera', role: 'cam', step: 8,
      boxes: [orientedBox(back, cam.f, cam.l, cam.u, [bd, bw, bh])],
      cyls: [{ a: add(cam.pos, mul(cam.f, -6)), b: cam.pos, r: Math.min(bw, bh) * 0.28 }, { a: surf, b: add(back, mul(cam.f, 0)), r: 4 }],
      mass: 0.15, spec: `${pre.name}, ${cam.spec.width}×${cam.spec.height}, ${cam.hfov.toFixed(1)}° × ${cam.vfov.toFixed(1)}°`, collide: false });
  }

  // ---- totals
  const all = parts.flatMap(pt => pt.boxes.map(b => b.c).concat(pt.cyls.flatMap(c => [c.a, c.b])));
  const bbox: [V3, V3] = [[-W / 2, -D / 2, 0], [W / 2, D / 2, Htot + (p.panels.roof ? t : 0)]];
  for (const q of all) for (let i = 0; i < 3; i++) { bbox[0][i] = Math.min(bbox[0][i], q[i]); bbox[1][i] = Math.max(bbox[1][i], q[i]); }
  const { mass, com, inertia } = massProps(parts.filter(pt => pt.kind !== 'camera'));
  const model: Model = { p, prof, s, baseH, topZ: Htot, worktopZ, parts, cameras, steps: [], bbox, mass, com, inertia, supportCount: nSup, sizing };
  model.steps = buildSteps(model);
  return model;
}

// a box with arbitrary axes, approximated by its axis-aligned size when the axes are not
// axis-aligned (only cameras use it; they are visual only)
function orientedBox(c: V3, f: V3, l: V3, u: V3, size: V3): Box & { axes?: [V3, V3, V3] } {
  return Object.assign({ c, s: size }, { axes: [f, l, u] as [V3, V3, V3] });
}

export function resolveCamera(c: CameraSpec, parts: Part[], s: number, worktopZ: number): CameraPose {
  const part = parts.find(pt => pt.id === c.mount && pt.member);
  let pos: V3, valid = true, note: string | undefined;
  const n = FACE[c.face];
  if (part) {
    const m = part.member!, ax = AX[m.axis];
    const along = Math.min(1, Math.max(0, c.along));
    if (Math.abs(dot(ax, n)) > 0.5) {
      // an end face of the member: the camera sits off that end
      const end = dot(ax, n) > 0 ? add(m.a, mul(ax, m.length)) : m.a;
      pos = add(end, mul(n, c.standoff));
    } else pos = add(add(m.a, mul(ax, along * m.length)), mul(n, s / 2 + c.standoff));
  } else {
    pos = [0, 0, worktopZ + 500];
    valid = false;
    note = `mount "${c.mount}" is not part of this frame`;
  }
  let yaw = c.yaw * D2R, pitch = c.pitch * D2R;
  if (c.aim === 'target') {
    const tgt: V3 = [c.target[0], c.target[1], worktopZ + c.target[2]];
    const d = norm(sub(tgt, pos));
    pitch = Math.asin(Math.max(-1, Math.min(1, -d[2])));
    yaw = Math.abs(d[2]) > 0.9999 ? c.yaw * D2R : Math.atan2(d[1], d[0]);
  }
  const roll = c.roll * D2R;
  // R = Rz(yaw) Ry(pitch) Rx(roll); columns are forward, left, up. Positive pitch looks down.
  const R = rpyToMatrix(roll, pitch, yaw);
  const f: V3 = [R[0][0], R[1][0], R[2][0]], l: V3 = [R[0][1], R[1][1], R[2][1]], u: V3 = [R[0][2], R[1][2], R[2][2]];
  const hfov = Math.min(170, Math.max(5, c.hfov));
  const vfov = (2 * Math.atan(Math.tan((hfov * D2R) / 2) * (c.height / c.width))) / D2R;
  const fx = c.width / 2 / Math.tan((hfov * D2R) / 2);
  return { spec: c, pos, f, l, u, hfov, vfov, fx, fy: fx, cx: c.width / 2, cy: c.height / 2, valid, note };
}

export function rpyToMatrix(r: number, p: number, y: number): number[][] {
  const cr = Math.cos(r), sr = Math.sin(r), cp = Math.cos(p), sp = Math.sin(p), cy = Math.cos(y), sy = Math.sin(y);
  return [
    [cy * cp, cy * sp * sr - sy * cr, cy * sp * cr + sy * sr],
    [sy * cp, sy * sp * sr + cy * cr, sy * sp * cr - cy * sr],
    [-sp, cp * sr, cp * cr],
  ];
}
// fixed-axis roll/pitch/yaw (URDF convention) of a rotation whose columns are f, l, u
export function matrixToRpy(f: V3, l: V3, u: V3): V3 {
  const r20 = f[2], r21 = l[2], r22 = u[2], r10 = f[1], r00 = f[0];
  const pitch = Math.asin(Math.max(-1, Math.min(1, -r20)));
  if (Math.abs(r20) < 0.99999) return [Math.atan2(r21, r22), pitch, Math.atan2(r10, r00)];
  // gimbal lock: fold the roll into the yaw
  return [0, pitch, Math.atan2(-l[0], l[1])];
}
// rotation matrix (rows) to quaternion w,x,y,z
export function matToQuat(m: number[][]): [number, number, number, number] {
  const tr = m[0][0] + m[1][1] + m[2][2];
  let w, x, y, z;
  if (tr > 0) { const S = Math.sqrt(tr + 1) * 2; w = 0.25 * S; x = (m[2][1] - m[1][2]) / S; y = (m[0][2] - m[2][0]) / S; z = (m[1][0] - m[0][1]) / S; }
  else if (m[0][0] > m[1][1] && m[0][0] > m[2][2]) { const S = Math.sqrt(1 + m[0][0] - m[1][1] - m[2][2]) * 2; w = (m[2][1] - m[1][2]) / S; x = 0.25 * S; y = (m[0][1] + m[1][0]) / S; z = (m[0][2] + m[2][0]) / S; }
  else if (m[1][1] > m[2][2]) { const S = Math.sqrt(1 + m[1][1] - m[0][0] - m[2][2]) * 2; w = (m[0][2] - m[2][0]) / S; x = (m[0][1] + m[1][0]) / S; y = 0.25 * S; z = (m[1][2] + m[2][1]) / S; }
  else { const S = Math.sqrt(1 + m[2][2] - m[0][0] - m[1][1]) * 2; w = (m[1][0] - m[0][1]) / S; x = (m[0][2] + m[2][0]) / S; y = (m[1][2] + m[2][1]) / S; z = 0.25 * S; }
  return [w, x, y, z];
}
export const colsToMat = (a: V3, b: V3, c: V3) => [[a[0], b[0], c[0]], [a[1], b[1], c[1]], [a[2], b[2], c[2]]];

function massProps(parts: Part[]) {
  // every part as its boxes and cylinders, each a uniform solid sharing the part's mass by volume
  const solids: { m: number; c: V3; I: [number, number, number] }[] = [];
  for (const pt of parts) {
    const vols = [...pt.boxes.map(b => b.s[0] * b.s[1] * b.s[2]), ...pt.cyls.map(c => Math.PI * c.r * c.r * Math.hypot(...sub(c.b, c.a)))];
    const vt = vols.reduce((a, b) => a + b, 0) || 1;
    pt.boxes.forEach((b, i) => {
      const m = (pt.mass * vols[i]) / vt, [x, y, z] = b.s.map(v => v / 1000);
      solids.push({ m, c: b.c, I: [(m * (y * y + z * z)) / 12, (m * (x * x + z * z)) / 12, (m * (x * x + y * y)) / 12] });
    });
    pt.cyls.forEach((c, i) => {
      const m = (pt.mass * vols[pt.boxes.length + i]) / vt, r = c.r / 1000, h = Math.hypot(...sub(c.b, c.a)) / 1000;
      const ia = (m * r * r) / 2, it = (m * (3 * r * r + h * h)) / 12;
      const d = norm(sub(c.b, c.a)), k = Math.abs(d[0]) > 0.9 ? 0 : Math.abs(d[1]) > 0.9 ? 1 : 2;
      solids.push({ m, c: mul(add(c.a, c.b), 0.5), I: [k === 0 ? ia : it, k === 1 ? ia : it, k === 2 ? ia : it] });
    });
  }
  const mass = solids.reduce((a, b) => a + b.m, 0);
  const com = mul(solids.reduce<V3>((a, b) => add(a, mul(b.c, b.m)), [0, 0, 0]), 1 / (mass || 1));
  const I = [0, 0, 0, 0, 0, 0] as [number, number, number, number, number, number];
  for (const sd of solids) {
    const [dx, dy, dz] = sub(sd.c, com).map(v => v / 1000);
    I[0] += sd.I[0] + sd.m * (dy * dy + dz * dz);
    I[1] += sd.I[1] + sd.m * (dx * dx + dz * dz);
    I[2] += sd.I[2] + sd.m * (dx * dx + dy * dy);
    I[3] -= sd.m * dx * dy; I[4] -= sd.m * dx * dz; I[5] -= sd.m * dy * dz;
  }
  return { mass, com, inertia: I };
}

function buildSteps(m: Model): Step[] {
  const p = m.p, prof = m.prof;
  const steps: Step[] = [];
  const push = (n: number, title: string, tasks: string[], check?: string, warn?: string) => {
    if (n === 1 || n === 9 || m.parts.some(pt => pt.step === n)) steps.push({ n, title, tasks, check, warn });
  };
  push(1, 'Cut and prepare the extrusions', [
    `Cut every piece on the cut list, square to ±0.5 mm. Mark each with its letter.`,
    `Deburr the cut ends so they sit flat against the post faces.`,
    `Tap the bottom end of each post ${prof.endTap} for the ${p.base === 'feet' ? 'levelling feet' : 'caster stems'}.`,
  ], 'Pieces of the same letter are the same length within 0.5 mm.');
  push(2, p.base === 'feet' ? 'Fit the feet to the posts' : 'Fit the casters to the posts', [
    p.base === 'feet' ? `Screw a levelling foot into each post end, wound in to leave about 10 mm of adjustment.` : `Screw a caster into each post end and tighten against the post with its lock nut.`,
    `Lay the four posts side by side with the feet at one end.`,
  ]);
  const lower = p.lowerRing !== 'none';
  push(3, 'Build the two end frames', [
    `Lay two posts on the floor, slots facing each other, ${round(p.depth - 2 * m.s)} mm apart between inside faces.`,
    `Fit the worktop side rail with its top flush ${round(p.tableHeight)} mm from the floor${lower ? `, and the ${p.shelf ? 'shelf' : 'lower'} side rail with its top ${round(p.lowerHeight)} mm from the floor` : ''}.`,
    `Put an L bracket under each rail end: one screw into the rail, one into the post, both into drop-in T-nuts.`,
    `Do the same for the other end frame.`,
  ], 'Each end frame is square: its diagonals match within 2 mm.', 'Leave the top rails off for now: the box walls drop in from above.');
  push(4, 'Join the end frames', [
    `Stand both end frames up. Fit the front and back worktop rails between them, tops flush with the side rails.`,
    lower ? `Fit the ${p.lowerRing === 'full' ? 'front and back' : 'back'} ${p.shelf ? 'shelf' : 'lower'} rail${p.lowerRing === 'full' ? 's' : ''} the same way.` : '',
    m.supportCount ? `Fit ${m.supportCount} worktop support${m.supportCount > 1 ? 's' : ''} front to back, evenly spaced, flush with the worktop rails.` : '',
    `Tighten every bracket, then check the diagonals of the worktop rectangle.`,
  ].filter(Boolean), 'Worktop diagonals match within 2 mm. The table stands on all four without rocking.');
  push(5, p.worktop ? 'Lay the worktop' + (p.shelf ? ' and the shelf' : '') : 'Lay the shelf', [
    p.shelf ? `Slide the shelf board in diagonally and drop it onto the ${p.shelf ? 'shelf' : 'lower'} rails, notches round the posts.` : '',
    p.worktop ? `Drop the worktop onto the worktop rails, notches round the posts.` : '',
    `Fix each board down with countersunk ${prof.screw} screws into T-nuts in the rails' top slots, about every 300 mm.`,
  ].filter(Boolean), 'Boards sit flat, no rocking, no screw heads proud of the surface.');
  push(6, 'Drop in the box walls', [
    `Slide each wall down into the post slots from above until it rests on ${p.worktop ? 'the worktop' : 'the worktop rail slot'}.`,
    `Peel any protective film from the inside face now; it is hard to reach later.`,
  ], undefined, 'The top rails hold the walls in. Fit the walls before the top rails.');
  push(7, 'Close the top of the box', [
    `Fit the four top rails between the posts, pressing each down over the wall edges, with a 3-way corner bracket at each corner.`,
    p.overheadBar ? `Fit the overhead camera bar ${p.overheadBarY === 0 ? 'across the middle' : `${round(Math.abs(p.overheadBarY))} mm ${p.overheadBarY > 0 ? 'behind' : 'in front of'} the centre`}, flush with the top rails, with an L bracket at each end.` : '',
    p.panels.roof ? `Lay the roof on top and fix it at the corners with ${prof.screw} screws into T-nuts.` : '',
  ].filter(Boolean), 'Top diagonals match within 2 mm. The walls do not rattle.');
  push(8, 'Mount the cameras', m.cameras.map(c => {
    const pt = m.parts.find(q => q.id === c.spec.mount);
    return `"${c.spec.name}": clamp to ${pt ? pt.name.toLowerCase() : c.spec.mount} at ${round(c.spec.along * 100)}% along, on its ${c.spec.face} face; optical centre ${round(c.spec.standoff)} mm off the face.`;
  }).concat(m.cameras.length ? ['Aim each camera to match its preview in the 3D view, then lock the mount.'] : []),
  'Each camera image matches the simulated view from the same camera.');
  push(9, 'Level and check', [
    p.base === 'feet' ? 'Put a level on the worktop and adjust the feet until it reads level both ways.' : 'Roll the table into place and lock all four caster brakes.',
    'Push the top corner sideways: it should not rack. If it does, recheck the bracket screws.',
    'Measure the worktop height and the camera positions; update the parameters if anything was built differently.',
  ], 'Worktop level within 1 mm/m. Frame does not rack.');
  return steps;
}

export const round = (v: number) => Math.round(v * 10) / 10;
const cap = (s: string) => s[0].toUpperCase() + s.slice(1);
