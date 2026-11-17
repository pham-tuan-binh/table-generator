// glTF binary (browser only): y up, metres, PBR colours, and each robot camera as a glTF
// perspective camera (looks down -z, +y up, like OpenGL).
import * as THREE from 'three';
import { GLTFExporter } from 'three/examples/jsm/exporters/GLTFExporter.js';
import { Model } from '../model.ts';
import { partGeometries } from '../geometry.ts';
import { looks, cameraFrames, safe } from './common.ts';

export async function glb(m: Model): Promise<ArrayBuffer> {
  const L = looks(m), scene = new THREE.Scene();
  const toYUp = new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(new THREE.Matrix4().makeScale(0.001, 0.001, 0.001));
  const mats: Record<string, THREE.MeshStandardMaterial> = {};
  for (const [role, l] of Object.entries(L)) mats[role] = new THREE.MeshStandardMaterial({
    name: l.name, color: new THREE.Color(l.rgba[0], l.rgba[1], l.rgba[2]), metalness: l.metallic, roughness: l.roughness,
    transparent: l.rgba[3] < 1, opacity: l.rgba[3], side: THREE.DoubleSide,
  });
  const frame = new THREE.Group();
  frame.name = 'frame';
  scene.add(frame);
  for (const pt of m.parts) {
    const geos = partGeometries(pt, m).map(g => { g.applyMatrix4(toYUp); g.computeVertexNormals(); return g; });
    const grp = geos.length === 1 ? new THREE.Mesh(geos[0], mats[pt.role]) : new THREE.Group();
    if (geos.length > 1) geos.forEach(g => grp.add(new THREE.Mesh(g, mats[pt.role])));
    grp.name = pt.id;
    grp.userData = { name: pt.name, spec: pt.spec, mass_kg: pt.mass };
    frame.add(grp);
  }
  for (const c of m.cameras) {
    const gl = cameraFrames(c).gl.cols, cam = new THREE.PerspectiveCamera(c.vfov, c.spec.width / c.spec.height, c.spec.near / 1000, c.spec.far / 1000);
    const M = new THREE.Matrix4().makeBasis(new THREE.Vector3(...gl[0]), new THREE.Vector3(...gl[1]), new THREE.Vector3(...gl[2])).setPosition(c.pos[0] / 1000, c.pos[1] / 1000, c.pos[2] / 1000);
    new THREE.Matrix4().makeRotationX(-Math.PI / 2).multiply(M).decompose(cam.position, cam.quaternion, cam.scale);
    cam.name = `${safe(c.spec.name)}_camera`;
    cam.userData = { width: c.spec.width, height: c.spec.height, hfov_deg: c.hfov };
    scene.add(cam);
  }
  const worktop = new THREE.Object3D();
  worktop.name = 'worktop_frame';
  worktop.position.set(0, m.worktopZ / 1000, 0);
  scene.add(worktop);
  return (await new GLTFExporter().parseAsync(scene, { binary: true })) as ArrayBuffer;
}
