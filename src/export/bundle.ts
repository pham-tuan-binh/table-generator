// Everything for one design as a file tree: sim assets, BOM, cut list, panel DXFs, camera
// calibration, the build plan as Markdown, and the params to regenerate it.
import * as THREE from 'three';
import { Model, round } from '../model.ts';
import { profileShape, partGeometries, mergeTriangles } from '../geometry.ts';
import { urdf } from './urdf.ts';
import { mjcf, mjcfScene } from './mjcf.ts';
import { usda, stl } from './usd.ts';
import { cameraFrames, f } from './common.ts';
import { bom, bomCsv, cutCsv, cutList, checks, nest } from '../bom.ts';
import { material, PROFILES } from '../params.ts';

export type Files = Record<string, string | ArrayBuffer | Uint8Array>;

export function profileStl(m: Model): ArrayBuffer {
  const g = new THREE.ExtrudeGeometry(profileShape(m.prof), { depth: 1000, bevelEnabled: false, curveSegments: 10 });
  g.translate(0, 0, -500);
  return stl(mergeTriangles([g]));
}

export function cameraJson(m: Model) {
  return {
    frame: 'base_link (floor under the table centre, z up, x across the width, y toward the back), metres',
    worktop_frame_z: m.worktopZ / 1000,
    cameras: m.cameras.map(c => {
      const fr = cameraFrames(c), opt = fr.optical.cols;
      const T = [0, 1, 2].map(r => [opt[0][r], opt[1][r], opt[2][r], c.pos[r] / 1000].map(v => Number(f(v))));
      T.push([0, 0, 0, 1]);
      return {
        name: c.spec.name, mount: { member: c.spec.mount, along: c.spec.along, face: c.spec.face, standoff_m: c.spec.standoff / 1000 },
        resolution: [c.spec.width, c.spec.height], hfov_deg: Number(f(c.hfov, 4)), vfov_deg: Number(f(c.vfov, 4)), rate_hz: c.spec.rate,
        K: [[Number(f(c.fx, 3)), 0, c.cx], [0, Number(f(c.fy, 3)), c.cy], [0, 0, 1]], distortion: [0, 0, 0, 0, 0],
        position_m: c.pos.map(v => Number(f(v / 1000))),
        quat_wxyz: { ros_body_x_forward: fr.body.quat.map(v => Number(f(v))), opencv_optical_z_forward: fr.optical.quat.map(v => Number(f(v))), opengl_minus_z_forward: fr.gl.quat.map(v => Number(f(v))) },
        T_base_optical: T,
        urdf_rpy_body: fr.body.rpy.map(v => Number(f(v))),
      };
    }),
  };
}

// a panel outline as an R12 DXF of LINEs, in mm
export function dxf(outline: [number, number][]): string {
  const o = ['0', 'SECTION', '2', 'HEADER', '9', '$INSUNITS', '70', '4', '0', 'ENDSEC', '0', 'SECTION', '2', 'ENTITIES'];
  outline.forEach((p, i) => {
    const q = outline[(i + 1) % outline.length];
    o.push('0', 'LINE', '8', 'CUT', '10', f(p[0], 3), '20', f(p[1], 3), '30', '0', '11', f(q[0], 3), '21', f(q[1], 3), '31', '0');
  });
  o.push('0', 'ENDSEC', '0', 'EOF');
  return o.join('\n') + '\n';
}

export function readme(m: Model, link = ''): string {
  const p = m.p, L: string[] = [];
  const fmt = (v: number) => `${round(v)} mm`;
  L.push(`# Robot test table: ${round(p.width)} × ${round(p.depth)} × ${round(m.topZ)} mm`, '');
  if (link) L.push(`Edit this design: ${link}`, '');
  L.push(`${PROFILES[p.profile].name} table, worktop at ${fmt(m.worktopZ)}, box ${fmt(p.boxHeight)} tall on top, on ${p.base === 'feet' ? 'levelling feet' : `Ø${p.casterWheel} mm casters`}. Total mass about ${round(m.mass)} kg.`, '');
  L.push(`## Files`, '',
    '| File | What |', '|---|---|',
    '| `urdf/frame.urdf` | URDF: base_link, worktop_frame, camera links + optical frames, Gazebo camera sensors |',
    '| `mjcf/scene.xml` | MuJoCo: load this (includes `frame.xml`, adds floor and lights). Cameras render at their resolution |',
    '| `usd/frame.usda` | OpenUSD (z up, metres): meshes, materials, static colliders, cameras |',
    '| `frame.glb` | glTF binary (y up) with colours and cameras, for Blender / web (from the web app) |',
    '| `meshes/` | `profile_*.stl` unit-length extrusion (1 m, centred), `frame.stl` everything in one mesh |',
    '| `cameras.json` | intrinsics (K) and extrinsics of each camera in ROS, OpenCV and OpenGL conventions |',
    '| `bom.csv`, `cutlist.csv` | bill of materials and cut list |',
    '| `panels/*.dxf` | panel outlines for CNC / laser, mm |',
    '| `params.json` | the inputs; drop it on the web app or run `npm run generate -- params.json` |', '');
  L.push(`Frames: origin on the floor under the table centre, z up, x across the width (left to right), y toward the back. The worktop surface centre is \`worktop_frame\` at z = ${f(m.worktopZ / 1000)} m.`, '');
  L.push(`## Checks`, '', ...checks(m).map(c => `- ${c.ok ? '✓' : c.level === 'error' ? '✗' : '!'} ${c.text}`), '');
  L.push(`## Bill of materials`, '', '| Group | Item | Spec | Qty | Note |', '|---|---|---|---:|---|', ...bom(m).map(b => `| ${b.group} | ${b.item} | ${b.spec} | ${b.qty} | ${b.note || ''} |`), '');
  L.push(`## Cut list`, '', '| Mark | Length | Qty | Parts | Taps |', '|---|---:|---:|---|---|', ...cutList(m).map(c => `| ${c.mark} | ${c.length} mm | ${c.qty} | ${[...new Set(c.names.map(n => n.split(',')[0]))].join(', ')} | ${c.taps} |`), '');
  if (p.stockLength) {
    const { bars } = nest(m);
    L.push(`### Cutting from ${p.stockLength} mm stock (kerf ${p.kerf} mm)`, '', ...bars.map((b, i) => `${i + 1}. ${b.cuts.map(c => `${c.mark} ${c.length}`).join(' + ')}  (offcut ${b.waste} mm)`), '');
  }
  L.push(`## Cameras`, '', '| Name | Resolution | HFOV × VFOV | Position (mm) | Mount |', '|---|---|---|---|---|',
    ...m.cameras.map(c => `| ${c.spec.name} | ${c.spec.width}×${c.spec.height} | ${c.hfov.toFixed(1)}° × ${c.vfov.toFixed(1)}° | ${c.pos.map(v => Math.round(v)).join(', ')} | ${c.spec.mount}, ${Math.round(c.spec.along * 100)}%, ${c.spec.face} face |`), '');
  L.push(`## Build steps`, '');
  for (const s of m.steps) {
    L.push(`### ${s.n}. ${s.title}`, '', ...s.tasks.map((t, i) => `${i + 1}. ${t}`), '');
    if (s.warn) L.push(`> **Note:** ${s.warn}`, '');
    if (s.check) L.push(`**Check:** ${s.check}`, '');
  }
  return L.join('\n');
}

export function bundle(m: Model, link = ''): Files {
  const files: Files = {};
  files['urdf/frame.urdf'] = urdf(m);
  files['urdf/meshes/profile_' + m.prof.id + '.stl'] = profileStl(m);
  files['mjcf/frame.xml'] = mjcf(m);
  files['mjcf/scene.xml'] = mjcfScene();
  files['mjcf/meshes/profile_' + m.prof.id + '.stl'] = profileStl(m);
  files['usd/frame.usda'] = usda(m);
  files['meshes/profile_' + m.prof.id + '.stl'] = profileStl(m);
  files['meshes/frame.stl'] = stl(mergeTriangles(m.parts.flatMap(pt => partGeometries(pt, m))));
  files['cameras.json'] = JSON.stringify(cameraJson(m), null, 2) + '\n';
  files['bom.csv'] = bomCsv(m);
  files['cutlist.csv'] = cutCsv(m);
  for (const pt of m.parts) if (pt.outline && material(pt.materialId!).cnc) files[`panels/${pt.id}_${pt.thk}mm.dxf`] = dxf(pt.outline);
  files['params.json'] = JSON.stringify(m.p, null, 2) + '\n';
  files['README.md'] = readme(m, link);
  return files;
}

