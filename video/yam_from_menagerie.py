"""Turns MuJoCo Menagerie's i2rt YAM (MIT, i2rt robotics) into the web arm format.

Loads the MJCF with MuJoCo so every pose is exactly what the simulator compiles, then
writes a URDF whose joints are the bodies' frames and whose visuals are the compiled
meshes baked into their body frames, one STL per part, named for its material
('white' shells, 'black' everything else). Also reports the fingertip gap against the
finger joint, to close the gripper on a block of known width.

  usage: python video/yam_from_menagerie.py <menagerie i2rt_yam dir> <out dir>
"""
import struct
import sys
from pathlib import Path

import mujoco
import numpy as np

src, out = Path(sys.argv[1]), Path(sys.argv[2])
(out / 'full').mkdir(parents=True, exist_ok=True)
m = mujoco.MjModel.from_xml_path(str(src / 'yam.xml'))
d = mujoco.MjData(m)
name = lambda t, i: mujoco.mj_id2name(m, t, i)


def quat_to_rpy(q):
    w, x, y, z = q
    R = np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                  [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                  [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]])
    pitch = np.arcsin(-np.clip(R[2, 0], -1, 1))
    if abs(R[2, 0]) > 1 - 1e-9:   # pitch of +-90 degrees: roll and yaw share an axis; fold it all into yaw
        return 0.0, pitch, np.arctan2(-R[0, 1], R[1, 1])
    return np.arctan2(R[2, 1], R[2, 2]), pitch, np.arctan2(R[1, 0], R[0, 0])


def write_stl(path, tris):
    with open(path, 'wb') as f:
        f.write(b'\0' * 80 + struct.pack('<I', len(tris)))
        for a, b, c in tris:
            n = np.cross(b - a, c - a); n = n / (np.linalg.norm(n) or 1)
            f.write(struct.pack('<12fH', *n, *a, *b, *c, 0))


white = mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_MATERIAL, 'white')
links, joints = [], []
for b in range(1, m.nbody):
    bname = name(mujoco.mjtObj.mjOBJ_BODY, b)
    visuals = []
    for g in range(m.ngeom):
        if m.geom_bodyid[g] != b or m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH or m.geom_group[g] != 2:
            continue
        mid = m.geom_dataid[g]
        v0, nv, f0, nf = m.mesh_vertadr[mid], m.mesh_vertnum[mid], m.mesh_faceadr[mid], m.mesh_facenum[mid]
        V = m.mesh_vert[v0:v0 + nv].astype(float)
        R = np.zeros(9); mujoco.mju_quat2Mat(R, m.geom_quat[g]); R = R.reshape(3, 3)
        V = V @ R.T + m.geom_pos[g]
        F = m.mesh_face[f0:f0 + nf]
        tone = 'white' if m.geom_matid[g] == white else 'black'
        fname = f'{bname}_{len(visuals)}_{tone}.stl'
        write_stl(out / 'full' / fname, [(V[a], V[bb], V[c]) for a, bb, c in F])
        visuals.append(fname)
    links.append((bname, visuals))
    parent = name(mujoco.mjtObj.mjOBJ_BODY, m.body_parentid[b])
    if parent == 'world':
        continue
    jid = [j for j in range(m.njnt) if m.jnt_bodyid[j] == b]
    pos, quat = m.body_pos[b], m.body_quat[b]
    rpy = quat_to_rpy(quat)
    if jid:
        j = jid[0]
        kind = 'prismatic' if m.jnt_type[j] == mujoco.mjtJoint.mjJNT_SLIDE else 'revolute'
        joints.append(f'  <joint name="{name(mujoco.mjtObj.mjOBJ_JOINT, j)}" type="{kind}"><parent link="{parent}"/><child link="{bname}"/>'
                      f'<origin xyz="{pos[0]:.7g} {pos[1]:.7g} {pos[2]:.7g}" rpy="{rpy[0]:.7g} {rpy[1]:.7g} {rpy[2]:.7g}"/>'
                      f'<axis xyz="{m.jnt_axis[j][0]:.4g} {m.jnt_axis[j][1]:.4g} {m.jnt_axis[j][2]:.4g}"/>'
                      f'<limit lower="{m.jnt_range[j][0]:.7g}" upper="{m.jnt_range[j][1]:.7g}" effort="1" velocity="1"/></joint>')
    else:
        joints.append(f'  <joint name="{bname}_fixed" type="fixed"><parent link="{parent}"/><child link="{bname}"/>'
                      f'<origin xyz="{pos[0]:.7g} {pos[1]:.7g} {pos[2]:.7g}" rpy="{rpy[0]:.7g} {rpy[1]:.7g} {rpy[2]:.7g}"/></joint>')

urdf = ['<?xml version="1.0"?>', '<!-- i2rt YAM, converted from MuJoCo Menagerie i2rt_yam (MIT, i2rt robotics). Meshes are baked into their link frames. -->', '<robot name="yam">']
for bname, visuals in links:
    urdf.append(f'  <link name="{bname}">' + ''.join(f'<visual><geometry><mesh filename="assets/{v}"/></geometry></visual>' for v in visuals) + '</link>')
urdf += joints + ['</robot>', '']
(out / 'yam.urdf').write_text('\n'.join(urdf))

# the fingertip gap against the finger joint: distance between the two fingers' inner faces
lf, rf = (mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_BODY, n) for n in ('lf_down', 'rf_down'))
for q in (0.0, 0.01, 0.02, 0.03, 0.037):
    d.qpos[:] = 0
    d.qpos[m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'left_finger')]] = q
    d.qpos[m.jnt_qposadr[mujoco.mj_name2id(m, mujoco.mjtObj.mjOBJ_JOINT, 'right_finger')]] = -q
    mujoco.mj_kinematics(m, d)
    print(f'finger {q:.3f}: tips {np.linalg.norm(d.xpos[lf] - d.xpos[rf]) * 1000:.1f} mm apart (body origins)')
print('links', [l for l, _ in links])
