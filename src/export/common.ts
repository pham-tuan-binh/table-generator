// Shared bits for the sim exporters: units, colours, rotations, camera frames.
import { Model, Part, V3, vec, matrixToRpy, matToQuat, colsToMat, CameraPose } from '../model.ts';

export const f = (v: number, d = 6) => { const r = Number(v.toFixed(d)); return Object.is(r, -0) ? '0' : String(r); };
export const m3 = (v: V3) => v.map(x => f(x / 1000)).join(' ');          // mm -> "x y z" in metres
export const fl = (v: number[], d = 6) => v.map(x => f(x, d)).join(' ');

export function hexRgba(hex: string, a = 1): [number, number, number, number] {
  const n = parseInt(hex.replace('#', ''), 16);
  return [((n >> 16) & 255) / 255, ((n >> 8) & 255) / 255, (n & 255) / 255, a];
}

export interface Look { name: string; rgba: [number, number, number, number]; metallic: number; roughness: number }
export function looks(m: Model): Record<Part['role'], Look> {
  const p = m.p;
  return {
    frame: { name: 'aluminium_frame', rgba: hexRgba(p.frameColor), metallic: 0.8, roughness: 0.35 },
    panel: { name: 'wall_panel', rgba: hexRgba(p.panelColor, p.panelOpacity), metallic: 0, roughness: 0.9 },
    worktop: { name: 'worktop', rgba: hexRgba(p.worktopColor), metallic: 0, roughness: 0.8 },
    shelf: { name: 'shelf', rgba: hexRgba(p.shelfColor), metallic: 0, roughness: 0.8 },
    hw: { name: 'steel', rgba: hexRgba('#8d9096'), metallic: 0.9, roughness: 0.4 },
    dark: { name: 'black_plastic', rgba: hexRgba('#2a2a2d'), metallic: 0, roughness: 0.7 },
    cam: { name: 'camera_body', rgba: hexRgba('#1d232c'), metallic: 0.2, roughness: 0.5 },
  };
}

// a rotation taking local +z onto d, as URDF rpy and as a quaternion
export function zTo(d: V3): { rpy: V3; quat: [number, number, number, number]; cols: [V3, V3, V3] } {
  const z = vec.norm(d);
  const helper: V3 = Math.abs(z[2]) < 0.9 ? [0, 0, 1] : [1, 0, 0];
  const x = vec.norm(vec.cross(helper, z)), y = vec.cross(z, x);
  return { rpy: matrixToRpy(x, y, z), quat: matToQuat(colsToMat(x, y, z)), cols: [x, y, z] };
}
// member visual: unit-length profile mesh along +z, rotated onto the member axis
export const MEMBER_ROT: Record<'x' | 'y' | 'z', { rpy: V3; quat: [number, number, number, number] }> = {
  x: { rpy: [0, Math.PI / 2, 0], quat: [Math.SQRT1_2, 0, Math.SQRT1_2, 0] },
  y: { rpy: [-Math.PI / 2, 0, 0], quat: [Math.SQRT1_2, -Math.SQRT1_2, 0, 0] },
  z: { rpy: [0, 0, 0], quat: [1, 0, 0, 0] },
};

// the frames a camera is described in
export function cameraFrames(c: CameraPose) {
  const right = vec.mul(c.l, -1), down = vec.mul(c.u, -1), back = vec.mul(c.f, -1);
  return {
    // ROS body: x forward, y left, z up
    body: { cols: [c.f, c.l, c.u] as [V3, V3, V3], rpy: matrixToRpy(c.f, c.l, c.u), quat: matToQuat(colsToMat(c.f, c.l, c.u)) },
    // OpenCV / ROS optical: x right, y down, z forward
    optical: { cols: [right, down, c.f] as [V3, V3, V3], quat: matToQuat(colsToMat(right, down, c.f)) },
    // OpenGL / MuJoCo / USD / glTF: x right, y up, looks down -z
    gl: { cols: [right, c.u, back] as [V3, V3, V3], quat: matToQuat(colsToMat(right, c.u, back)) },
  };
}

export const safe = (s: string) => s.replace(/[^A-Za-z0-9_]/g, '_').replace(/^(\d)/, '_$1') || 'cam';
// every profile and length used, for one scaled mesh asset each
export const lengthsOf = (m: Model) => [...new Set(m.parts.filter(p => p.member).map(p => `${p.member!.prof}|${Math.round(p.member!.length * 10) / 10}`))].map(k => { const [prof, L] = k.split('|'); return { prof, L: Number(L) }; });
export const meshName = (prof: string, L: number) => `profile_${prof}_${String(L).replace('.', 'p')}`;
export const profilesUsed = (m: Model) => [...new Set(m.parts.filter(p => p.member).map(p => p.member!.prof))];
// the profile meshes are 1 m long and centred on the origin, so they sit at the member's middle
export const memberMid = (pt: Part): V3 => { const mb = pt.member!, ax: V3 = [mb.axis === 'x' ? 1 : 0, mb.axis === 'y' ? 1 : 0, mb.axis === 'z' ? 1 : 0]; return vec.add(mb.a, vec.mul(ax, mb.length / 2)); };
