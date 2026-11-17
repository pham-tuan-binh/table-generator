// three.js geometry for the model, in design coordinates (mm, z up): the T-slot profile
// extruded per member, boxes, cylinders. Shared by the viewer and the mesh exporters
// (STL / GLB / USD), so what you see is what the simulator gets.
import * as THREE from 'three';
import { ProfileSpec } from './params.ts';
import { Model, Part, Box, Cyl, Member, V3, memberBox } from './model.ts';

export function profileShape(prof: ProfileSpec): THREE.Shape {
  const h = prof.s / 2, w = prof.slot / 2, lip = Math.max(1.5, prof.s * 0.09), dep = prof.slotDepth;
  const cw = Math.min(h * 0.62, w * 1.9);
  // one side (the -y face), slot in the middle, then the same rotated for the other three
  const side: [number, number][] = [
    [-h + 0.8, -h], [-w, -h], [-w, -h + lip], [-cw, -h + lip], [-cw * 0.55, -h + dep], [cw * 0.55, -h + dep], [cw, -h + lip], [w, -h + lip], [w, -h], [h - 0.8, -h],
  ];
  const pts: THREE.Vector2[] = [];
  for (let k = 0; k < 4; k++) {
    const a = (k * Math.PI) / 2, c = Math.cos(a), s = Math.sin(a);
    for (const [x, y] of side) pts.push(new THREE.Vector2(x * c - y * s, x * s + y * c));
  }
  const shape = new THREE.Shape(pts);
  const r = prof.s * 0.105, hole = new THREE.Path();
  hole.absarc(0, 0, r, 0, Math.PI * 2, true);
  shape.holes.push(hole);
  return shape;
}

const profCache = new Map<string, THREE.BufferGeometry>();
// a unit-length (1 mm) profile along +z, scaled per member
function unitProfile(prof: ProfileSpec): THREE.BufferGeometry {
  let g = profCache.get(prof.id);
  if (!g) {
    g = new THREE.ExtrudeGeometry(profileShape(prof), { depth: 1, bevelEnabled: false, curveSegments: 10 });
    profCache.set(prof.id, g);
  }
  return g;
}

export function memberGeometry(m: Member, prof: ProfileSpec): THREE.BufferGeometry {
  const g = unitProfile(prof).clone();
  g.scale(1, 1, m.length);
  if (m.axis === 'x') g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 1, 0), new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0)));
  if (m.axis === 'y') g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(0, 0, 1), new THREE.Vector3(1, 0, 0), new THREE.Vector3(0, 1, 0)));
  g.translate(...m.a);
  return g;
}

export function boxGeometry(b: Box & { axes?: [V3, V3, V3] }): THREE.BufferGeometry {
  const g = new THREE.BoxGeometry(...b.s);
  if (b.axes) g.applyMatrix4(new THREE.Matrix4().makeBasis(new THREE.Vector3(...b.axes[0]), new THREE.Vector3(...b.axes[1]), new THREE.Vector3(...b.axes[2])));
  g.translate(...b.c);
  return g;
}

export function cylGeometry(c: Cyl, seg = 28): THREE.BufferGeometry {
  const a = new THREE.Vector3(...c.a), b = new THREE.Vector3(...c.b), d = b.clone().sub(a);
  const g = new THREE.CylinderGeometry(c.r, c.r, d.length(), seg);
  g.applyQuaternion(new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), d.normalize()));
  g.translate(...a.add(b).multiplyScalar(0.5).toArray());
  return g;
}

// every solid of a part as geometry, design coordinates
// detailed = the real T-slot profile; plain = a square bar (the viewer's illustration style,
// where slot edges would ink the whole bar)
export function partGeometries(part: Part, model: Model, detailed = true): THREE.BufferGeometry[] {
  if (part.member) return [detailed ? memberGeometry(part.member, model.prof) : boxGeometry(memberBox(part.member, model.s))];
  return [...part.boxes.map(b => boxGeometry(b)), ...part.cyls.map(c => cylGeometry(c))];
}

// merged non-indexed triangles of a set of geometries
export function mergeTriangles(geos: THREE.BufferGeometry[]): Float32Array {
  const arrs = geos.map(g => (g.index ? g.toNonIndexed() : g).attributes.position.array as Float32Array);
  const out = new Float32Array(arrs.reduce((a, b) => a + b.length, 0));
  let o = 0;
  for (const a of arrs) { out.set(a, o); o += a.length; }
  return out;
}
