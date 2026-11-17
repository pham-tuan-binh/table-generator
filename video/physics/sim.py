"""
Two i2rt YAM arms doing ToyBlocks' stack-three task in MuJoCo, recorded for playback.

  python video/physics/sim.py <menagerie i2rt_yam dir> public/bench [--seeds 1 2 3] [--seconds 60]

Each seed is one bench: a scattered scene of wooden alphabet blocks; the arms stack three of
them in the middle, letters turned to the front camera, then put them back, episode after
episode. Nothing is scripted onto the blocks: they rest, get squeezed, carried, stacked and
knocked by contact alone. The arms follow smooth paths (one curve per move: straight up, over,
straight down, timed with minimum jerk) solved by IK at every step. The fingers are actuated
and stop on the block where their visible meshes touch it, so nothing in the recording
clips. Output, per seed: <seed>.json (layout, glyphs) and <seed>.bin (int16 frames).

Frame: the bench rig of src/bench.ts. Metres, z up, the worktop surface at z = 0, arm bases
at x = +-0.305 facing -y, the tower at (0, -0.25).
"""
import json, math, sys, argparse, re
from pathlib import Path
import numpy as np
import mujoco

ap = argparse.ArgumentParser()
ap.add_argument('menagerie'); ap.add_argument('out')
ap.add_argument('--seeds', type=int, nargs='+', default=[1, 2, 3, 4, 5, 6, 7])
ap.add_argument('--seconds', type=float, default=60)
ap.add_argument('--fps', type=int, default=30)
ap.add_argument('--preview', help='also write an MP4 from MuJoCo, to check the run (MUJOCO_GL=egl)')
ap.add_argument('--blocks', default=str(Path(__file__).resolve().parents[2] / 'public/toyblocks/blocks.json'))
args = ap.parse_args()

SIZE = json.load(open(args.blocks))['extent'][0] * 0.9          # src/bench.ts SCALE
SPACING = 0.610
BASES = [(-SPACING / 2, 0.0), (SPACING / 2, 0.0)]
YAW = -math.pi / 2
TOWER = np.array([0.0, -0.25])
# the gripping pads, measured from the finger meshes in link_6 (gripper shut on a 37.8 mm block):
# flat inner faces at x = +-finger opening, 25 mm wide in y, 19 mm tall in z (z points out of the hand)
PAD_Y, PAD_Z, PAD_T = (-0.0507, -0.0253), (0.128, 0.147), 0.004
TOOL = np.array([0.0, sum(PAD_Y) / 2, sum(PAD_Z) / 2])   # the middle of the pads: where a block's centre goes
HOVER = 0.09                               # how high a block is lifted before it travels
OPEN, SQUEEZE = 0.034, 0.0                 # finger targets; the block stops them at ~0.0187
LETTERS = list('CDEFGHJKLMNPQSUVWXYZ'); DIGITS = ['1', '3', '5']
DT = 0.002

# ------------------------------------------------------------------ the model
def arm_xml() -> str:
    s = (Path(args.menagerie) / 'yam.xml').read_text()
    s = s.replace('meshdir="assets"', f'meshdir="{Path(args.menagerie).resolve() / "assets"}"')
    s = re.sub(r'<keyframe>.*?</keyframe>', '', s, flags=re.S)
    # Menagerie's capsules are a rough stand-in and touch nothing here; the fingers get exact
    # pads (build). Not the finger meshes: MuJoCo collides with convex hulls, and the hull of
    # this curved finger has a slanted inner face that wedges a block out of the grip.
    s = s.replace('<geom group="3" type="capsule"/>', '<geom group="3" type="capsule" contype="0" conaffinity="0"/>')
    # the arm joints are driven along their path (below); only the gripper is a motor
    s = re.sub(r'<position name="joint\d"[^>]*/>', '', s)
    s = s.replace('<position class="finger" name="gripper" joint="left_finger"/>',
                  '<position class="finger" name="gripper" joint="left_finger" kp="1500" kv="40" forcerange="-25 25"/>')
    return s

def world_xml(n_blocks: int) -> str:
    blocks = ''.join(f'''
    <body name="b{i}" pos="0 0 1"><freejoint/>
      <geom type="box" size="{SIZE/2} {SIZE/2} {SIZE/2}" mass="0.032" contype="1" conaffinity="3" friction="0.9 0.01 0.001" condim="4"/>
    </body>''' for i in range(n_blocks))
    return f'''<mujoco><visual><global offwidth="1280" offheight="720"/><headlight ambient="0.45 0.45 0.45" diffuse="0.6 0.6 0.6"/></visual><option timestep="{DT}" integrator="implicitfast" cone="elliptic" impratio="10" noslip_iterations="3"><flag multiccd="enable"/></option>
  <worldbody>
    <geom name="worktop" type="plane" size="2 2 0.01" contype="1" conaffinity="1" friction="0.7 0.01 0.001"/>{blocks}
  </worldbody></mujoco>'''

def armZ(m: mujoco.MjModel) -> float:
    """lift so the base plate sits on the worktop (src/bench.ts does the same, plus 0.4 mm)"""
    lo = 0.0
    for g in range(m.ngeom):
        if m.geom_bodyid[g] == 0 or m.geom_type[g] != mujoco.mjtGeom.mjGEOM_MESH: continue
        if m.body(m.geom_bodyid[g]).name != 'arm': continue
        mid = m.geom_dataid[g]; v = m.mesh_vert[m.mesh_vertadr[mid]:m.mesh_vertadr[mid] + m.mesh_vertnum[mid]]
        R = np.zeros(9); mujoco.mju_quat2Mat(R, m.geom_quat[g]); lo = min(lo, (v @ R.reshape(3, 3).T + m.geom_pos[g])[:, 2].min())
    return -lo + 0.0004

def build(n_blocks: int):
    probe = mujoco.MjModel.from_xml_string(arm_xml())
    z = armZ(probe)
    spec = mujoco.MjSpec.from_string(world_xml(n_blocks))
    for k, (x, y) in enumerate(BASES):
        f = spec.worldbody.add_frame(pos=[x, y, z], quat=[math.cos(YAW / 2), 0, 0, math.sin(YAW / 2)])
        spec.attach(mujoco.MjSpec.from_string(arm_xml()), prefix=f'a{k}_', frame=f)
    for k in range(2):
        spec.body(f'a{k}_link_6').add_site(name=f'a{k}_tool', pos=TOOL.tolist())
    # each pad as a box on its finger: placed in link_6 with the finger at a known opening, then
    # expressed in the finger's own frame (it slides along link_6 x, so the offset holds)
    m0 = spec.compile(); d0 = mujoco.MjData(m0); w = 0.02
    for k in range(2):
        for name, sgn in (('left', 1), ('right', -1)):
            d0.qpos[m0.joint(f'a{k}_{name}_finger').qposadr[0]] = sgn * w
        mujoco.mj_kinematics(m0, d0)
        b6 = m0.body(f'a{k}_link_6').id; R6 = d0.xmat[b6].reshape(3, 3); p6 = d0.xpos[b6]
        for name, sgn in (('left', 1), ('right', -1)):
            bf = m0.body(f'a{k}_link_{name}_finger').id; Rf = d0.xmat[bf].reshape(3, 3); pf = d0.xpos[bf]
            c6 = np.array([sgn * (w - 0.0004 + PAD_T / 2), TOOL[1], TOOL[2]])        # pad centre in link_6; the 0.4 mm is the contact's give, so the visible pad just meets the block
            cf = Rf.T @ (p6 + R6 @ c6 - pf)                                          # ... in the finger frame
            Rfb = Rf.T @ R6; q = np.zeros(4); mujoco.mju_mat2Quat(q, Rfb.flatten())  # link_6 axes in the finger frame
            spec.body(f'a{k}_link_{name}_finger').add_geom(
                type=mujoco.mjtGeom.mjGEOM_BOX, size=[PAD_T / 2, (PAD_Y[1] - PAD_Y[0]) / 2, (PAD_Z[1] - PAD_Z[0]) / 2],
                pos=cf.tolist(), quat=q.tolist(), contype=2, conaffinity=0, group=3, density=0,
                friction=[1.2, 0.02, 0.002], condim=4, solref=[0.004, 1], solimp=[0.995, 0.9995, 0.0002, 0.5, 2], rgba=[1, 0.3, 0.3, 1])
    return spec.compile()

# ------------------------------------------------------------------ the scene (src/bench.ts makeScene)
def rng(seed):
    s = [(seed * 2654435761) % 2**32 or 1]
    def r():
        s[0] = (s[0] * 1664525 + 1013904223) % 2**32
        return s[0] / 4294967296
    return r

def scene(seed):
    r = rng(seed); pick = lambda a: a[int(r() * len(a))]
    n = 7 + int(r() * 2); pieces = []; used = set()
    for i in range(n):
        tries = 0
        while True:
            spot = np.array([(r() * 2 - 1) * 0.4, -0.13 - r() * 0.23]); tries += 1
            if tries >= 300 or not (np.linalg.norm(spot - TOWER) < SIZE * 2.6 or any(np.linalg.norm(p['spot'] - spot) < SIZE * 2.2 for p in pieces) or abs(spot[0]) < SIZE * 1.5): break
        while True:
            g = pick(LETTERS) if i < 5 else pick(DIGITS)
            if g not in used or len(used) >= 22: break
        used.add(g)
        pieces.append({'glyph': g, 'spot': spot, 'yaw': int(r() * 4) * math.pi / 2})
    return pieces

# ------------------------------------------------------------------ kinematics
wrap = lambda a: math.atan2(math.sin(a), math.cos(a))

class Kin:
    """IK for one arm on a private MjData: the tool point to a position, gripper straight down,
    fingers closing along a given direction in the plane"""
    def __init__(self, m, k):
        self.m, self.d, self.k = m, mujoco.MjData(m), k
        self.q = np.array([m.jnt_qposadr[m.joint(f'a{k}_joint{j}').id] for j in range(1, 7)])
        self.v = np.array([m.jnt_dofadr[m.joint(f'a{k}_joint{j}').id] for j in range(1, 7)])
        self.lo = np.array([m.jnt_range[m.joint(f'a{k}_joint{j}').id][0] for j in range(1, 7)])
        self.hi = np.array([m.jnt_range[m.joint(f'a{k}_joint{j}').id][1] for j in range(1, 7)])
        self.site = m.site(f'a{k}_tool').id
        self.jp = np.zeros((3, m.nv)); self.jr = np.zeros((3, m.nv))
    def target(self, yaw):
        z = np.array([0, 0, -1.0]); x = np.array([math.cos(yaw), math.sin(yaw), 0]); return np.stack([x, np.cross(z, x), z], 1)
    def fk(self, q):
        self.d.qpos[self.q] = q; mujoco.mj_kinematics(self.m, self.d); mujoco.mj_comPos(self.m, self.d)
        return self.d.site_xpos[self.site].copy(), self.d.site_xmat[self.site].reshape(3, 3).copy()
    def solve(self, q, pos, yaw, iters=60, tol=1e-5):
        q = q.copy(); Rd = self.target(yaw)
        for _ in range(iters):
            p, R = self.fk(q)
            ep = pos - p
            er = 0.5 * sum(np.cross(R[:, i], Rd[:, i]) for i in range(3))
            if np.linalg.norm(ep) < tol and np.linalg.norm(er) < 1e-4: break
            mujoco.mj_jacSite(self.m, self.d, self.jp, self.jr, self.site)
            J = np.vstack([self.jp[:, self.v], self.jr[:, self.v]]); e = np.concatenate([ep, er])
            q += J.T @ np.linalg.solve(J @ J.T + 1e-4 * np.eye(6), e)
            q = np.clip(q, self.lo, self.hi)
        return q
    def reach(self, q, pos, yaw):
        """solve, and if the solver stalls against a limit, start again with the wrist already
        rolled to the yaw (the roll maps one to one onto the yaw once the gripper points down)"""
        best = None
        seeds = [q]
        q0 = self.solve(q, pos, self.tool_x(q), iters=80)
        for sg in (1, -1):
            s = q0.copy(); s[5] = wrap(q0[5] + sg * wrap(yaw - self.tool_x(q0))); seeds.append(s)
        for s in seeds:
            r = self.solve(s, pos, yaw, iters=120)
            p, R = self.fk(r); e = np.linalg.norm(p - pos) + 0.05 * np.linalg.norm(R[:, 0] - self.target(yaw)[:, 0])
            if best is None or e < best[0]: best = (e, r)
        return best[1], best[0]
    def tool_x(self, q):
        _, R = self.fk(q); return math.atan2(R[1, 0], R[0, 0])

def minjerk(s): s = min(1.0, max(0.0, s)); return s ** 3 * (10 - 15 * s + 6 * s * s)

def bezier(p0, p3, up0, up3):
    """leave p0 straight up and arrive at p3 straight down"""
    p1 = p0 + np.array([0, 0, up0]); p2 = p3 + np.array([0, 0, up3])
    return lambda s: (1 - s) ** 3 * p0 + 3 * (1 - s) ** 2 * s * p1 + 3 * (1 - s) * s * s * p2 + s ** 3 * p3

def block_yaw(quat):
    R = np.zeros(9); mujoco.mju_quat2Mat(R, quat); R = R.reshape(3, 3); return math.atan2(R[1, 0], R[0, 0])

# ------------------------------------------------------------------ one bench
# a move, in phases: swing over the block (joints), straight down, close, carry (one curve: up,
# over, down), open, straight up, swing home (joints). Each phase eases in and out (minimum jerk).
PHASES = [('to', 1.2), ('down', 0.55), ('close', 0.45), ('carry', 2.0), ('open', 0.4), ('up', 0.55), ('home', 1.1)]
MOVE = sum(t for _, t in PHASES)
REACH, CLOSE, CARRY = 0.9 + 0.45, 0.4, 1.6    # for the report
SLOT = 1.6         # the next move may start this long after one starts (the tower is clear by then)

N_PATH = 150
DEBUG = False
def trace(K, q0, pos, yaw):
    """a Cartesian path as joint samples, each solved from the last; None if it cannot be followed
    smoothly (the IK misses, or the arm would have to flip between two samples)"""
    out = [q0]; q = q0
    for k in range(1, N_PATH + 1):
        t = k / N_PATH; q = K.solve(q, pos(t), yaw(t), iters=40, tol=1e-6)
        p, R = K.fk(q)
        if np.linalg.norm(p - pos(t)) > 1e-3 or np.abs(q - out[-1]).max() > 0.3:
            if DEBUG: print(f'    trace fails at t={t:.2f}: miss {np.linalg.norm(p - pos(t))*1000:.1f} mm, step {np.abs(q - out[-1]).round(2)}, q {q.round(2)}')
            return None
        out.append(q)
    return np.array(out)
def sample(path, t):
    x = min(1.0, max(0.0, t)) * (len(path) - 1); i = min(int(x), len(path) - 2); f = x - i
    return path[i] * (1 - f) + path[i + 1] * f
# the carry: up, over and down on one curve, eased; the wrist turns only while the block is in
# the air, never dragging it on the worktop or the tower
def carry_pos(a, b):
    c = bezier(a, b, HOVER, HOVER); return lambda t: c(minjerk(t))
def carry_yaw(y0, y1): return lambda t: y0 + (y1 - y0) * minjerk((t - 0.12) / 0.76)
def lift_pos(K, q):
    p, _ = K.fk(q); p = p.copy(); return lambda t: p + np.array([0, 0, 0.10 * minjerk(t)])

def run(seed):
    pieces = scene(seed); n = len(pieces)
    m = build(n); d = mujoco.MjData(m)
    kin = [Kin(m, k) for k in range(2)]
    bq = [m.jnt_qposadr[m.body(f'b{i}').jntadr[0]] for i in range(n)]
    grip_q = [m.jnt_qposadr[m.joint(f'a{k}_left_finger').id] for k in range(2)]
    grip_q2 = [m.jnt_qposadr[m.joint(f'a{k}_right_finger').id] for k in range(2)]
    act = [m.actuator(f'a{k}_gripper').id for k in range(2)]
    for i, p in enumerate(pieces):
        d.qpos[bq[i]:bq[i] + 3] = [*p['spot'], SIZE / 2 + 0.0002]
        d.qpos[bq[i] + 3:bq[i] + 7] = [math.cos(p['yaw'] / 2), 0, 0, math.sin(p['yaw'] / 2)]
    # a relaxed pose above the worktop, each arm on its own side
    home_pos = [np.array([BASES[k][0] * 0.75, -0.2, 0.17]) for k in range(2)]
    rest = np.array([0, 0.8, 1.2, 0.4, 0, 0])
    home = [kin[k].reach(rest, home_pos[k], math.pi / 2)[0] for k in range(2)]
    for k in range(2): d.qpos[kin[k].q] = home[k]; d.ctrl[act[k]] = OPEN
    d.qpos[grip_q[0]] = d.qpos[grip_q[1]] = OPEN; d.qpos[grip_q2[0]] = d.qpos[grip_q2[1]] = -OPEN

    # the schedule: episodes of three blocks up and three back, as in src/bench.ts
    # The tower is shared: each move books the stretch of time its hand is over it, and the next
    # move starts so that its hand arrives only after the last one has gone.
    at = {}; c = 0.0
    for name, T in PHASES: at[name] = c; c += T
    window = {'up': (at['carry'] + 0.15 * PHASES[3][1], at['home'] + 0.6), 'down': (0.0, at['carry'] + 0.75 * PHASES[3][1])}
    moves, free, tower_free = [], [0.6, 0.6], 0.6
    ep_r = rng(seed * 101)
    while min(free) < args.seconds:
        order = sorted(range(n), key=lambda _: ep_r())[:3]
        side = lambda i: 0 if pieces[i]['spot'][0] < 0 else 1
        plan = [(i, 'up', h) for h, i in enumerate(order)] + [(i, 'down', 2 - h) for h, i in enumerate(reversed(order))]
        for i, kind, h in plan:
            a = side(i); w0, w1 = window[kind]
            start = max(free[a], tower_free - w0 + 0.3)
            moves.append({'arm': a, 'piece': i, 'kind': kind, 'level': h, 'start': start})
            free[a] = start + MOVE; tower_free = start + w1
        tower_free += 0.4
    # an arm never waits around: in any gap long enough, it turns one of the blocks on its side
    # that this stretch of the task does not need
    fill_r = rng(seed * 7 + 3); extra = []
    for a in range(2):
        mine = sorted([x for x in moves if x['arm'] == a], key=lambda x: x['start'])
        t0 = 0.6
        for nxt in mine + [{'start': args.seconds + MOVE}]:
            busy = {x['piece'] for x in moves if x['start'] < nxt['start'] + MOVE and x['start'] + MOVE > t0}
            while nxt['start'] - t0 >= MOVE + 0.3:
                spare = [i for i in range(n) if (pieces[i]['spot'][0] < 0) == (a == 0) and i not in busy]
                if not spare: break
                i = spare[int(fill_r() * len(spare))]
                extra.append({'arm': a, 'piece': i, 'kind': 'turn', 'level': 0, 'start': t0 + 0.15, 'dir': 1 if fill_r() < 0.5 else -1})
                busy.add(i); t0 += MOVE + 0.15
            t0 = max(t0, nxt['start'] + MOVE)
    moves += extra

    # each arm's current move, planned when it starts, from where things really are
    cur = [None, None]; q_cmd = [home[0].copy(), home[1].copy()]
    def plan_move(mv):
        a, i = mv['arm'], mv['piece']; K = kin[a]
        bp = d.qpos[bq[i]:bq[i] + 3].copy(); byaw = block_yaw(d.qpos[bq[i] + 3:bq[i] + 7])
        grasp = bp + np.array([0, 0, 0.003])
        if mv['kind'] == 'up':
            place = np.array([*TOWER, SIZE / 2 + mv['level'] * SIZE + 0.0015 + 0.003]); want = 0.0
        elif mv['kind'] == 'turn':
            # pick it up, give it a quarter turn, set it down where it was
            mv['xy'] = bp[:2].copy(); mv['want'] = byaw + mv['dir'] * math.pi / 2
            place = np.array([*bp[:2], SIZE / 2 + 0.0015 + 0.003]); want = mv['want']
        else:
            p = pieces[i]; place = np.array([*p['spot'], SIZE / 2 + 0.0015 + 0.003]); want = p['yaw']
        turn = wrap(want - byaw)
        # four square grasps; each one's whole path is solved now, and one that would make the arm
        # flip (a jump between neighbouring samples) is never used
        best = None; why = []
        for k4, tw in [(k, t) for k in range(4) for t in (turn, turn - 2 * math.pi, turn + 2 * math.pi) if abs(t) < 1.6 * math.pi]:
            yg = byaw + k4 * math.pi / 2; yp = yg + tw
            for hov in (HOVER * 0.75, 0.04, 0.025):   # a block high on a tower gets a shorter approach
                above = grasp + np.array([0, 0, hov])
                qh, eh = K.reach(home[a], above, yg)
                if eh <= 1e-3: break
            if eh > 1e-3: why.append(f'{k4}: hover ik {eh*1000:.1f}mm j6 {qh[5]:.2f}'); continue
            down = trace(K, qh, lambda t: above + (grasp - above) * minjerk(t), lambda t: yg)
            if down is None: why.append(f'{k4}: down'); continue
            carry = trace(K, down[-1], carry_pos(grasp, place), carry_yaw(yg, yp))
            if carry is None: why.append(f'{k4}: carry'); continue
            # the wrist must stay well inside its limits, and the swing over should be short
            cost = max(abs(down[-1][5]), abs(carry[-1][5])) + 0.8 * np.abs(np.diff(carry[:, 5])).sum() + 0.2 * np.abs(qh - q_cmd[a]).sum() + 0.8 * abs(qh[5] - q_cmd[a][5])
            if best is None or cost < best[0]: best = (cost, yg, yp, qh, down, carry)
        if best is None: print(f'  ! no grasp for block {pieces[i]["glyph"]} at {(bp*1000).round()} mm; skipped ({"; ".join(why)})'); mv['skip'] = True; return
        _, yg, yp, qh, down, carry = best
        mv.update(yg=yg, yp=yp, q0=q_cmd[a].copy(), qh=qh, block=i, down=down, carry=carry)
        mv['up'] = trace(K, carry[-1], lift_pos(K, carry[-1]), lambda t, y=yp: y)

    def aim(a, mv):
        """once the block is held: where it really sits in the hand decides where the hand goes,
        so the block (not the hand) lands on its spot, square, on whatever is really below it"""
        K = kin[a]; i = mv['block']; q = mv['down'][-1]; p, R = K.fk(q); P, Rr = K.fk(d.qpos[K.q])
        b = d.qpos[bq[i]:bq[i] + 3]; o = Rr.T @ (b - P); slip = wrap(block_yaw(d.qpos[bq[i] + 3:bq[i] + 7]) - K.tool_x(d.qpos[K.q]))
        if mv['kind'] == 'up':
            want = 0.0; below = None
            if mv['level'] > 0:
                cand = [j for j in range(n) if j != i and np.linalg.norm(d.qpos[bq[j]:bq[j] + 2] - TOWER) < 0.03 and abs(d.qpos[bq[j] + 2] - (SIZE / 2 + (mv['level'] - 1) * SIZE)) < 0.01]
                below = d.qpos[bq[cand[0]]:bq[cand[0]] + 3] if cand else None
            xy = below[:2] if below is not None else TOWER
            z = (below[2] + SIZE if below is not None else SIZE / 2 + mv['level'] * SIZE) + 0.0015
        elif mv['kind'] == 'turn':
            want = mv['want']; xy = mv['xy']; z = SIZE / 2 + 0.0015
        else:
            want = pieces[i]['yaw']; xy = pieces[i]['spot']; z = SIZE / 2 + 0.0015
        yp = mv['yp'] + wrap((want - slip) - mv['yp'])
        place = np.array([*xy, z]) - K.target(yp) @ o
        carry = trace(K, q, carry_pos(p, place), carry_yaw(mv['yg'], yp))
        mv['aim'] = True; mv['target'] = np.array([*xy, z - 0.0015])
        if carry is None: print(f'  ! corrected carry for {pieces[i]["glyph"]} would flip; kept the planned one'); return
        mv.update(carry=carry, yp=yp, up=trace(K, carry[-1], lift_pos(K, carry[-1]), lambda t, y=yp: y))

    def reaim(a, mv, now, rest):
        """above the spot, on the way down: look again at where the block sits in the hand, and
        bend the rest of the descent so the block arrives exactly"""
        mv['aim2'] = True
        K = kin[a]; i = mv['block']; q = q_cmd[a].copy(); P, R = K.fk(q)
        b = d.qpos[bq[i]:bq[i] + 3]; o = R.T @ (b - P); slip = wrap(block_yaw(d.qpos[bq[i] + 3:bq[i] + 7]) - K.tool_x(q))
        want = 0.0 if mv['kind'] == 'up' else mv['want'] if mv['kind'] == 'turn' else pieces[i]['yaw']; y0 = K.tool_x(q)
        y1 = y0 + wrap((want - slip) - y0)
        place = mv['target'] + np.array([0, 0, 0.0015]) - K.target(y1) @ o
        # the end of the planned carry, seen from here: keep its remaining shape, shifted onto the new end
        tail0 = sample(mv['carry'], 0.7); end_old = mv['carry'][-1]
        p_tail, _ = K.fk(tail0); p_end, _ = K.fk(end_old); shift = place - p_end
        path = trace(K, q, lambda t: P + (p_end - p_tail) * minjerk(t) + shift * minjerk(t) + (p_tail - P), lambda t: y0 + (y1 - y0) * minjerk(t))
        if path is None: print(f'  ! final correction for {pieces[i]["glyph"]} would flip; skipped'); return
        mv['final'] = (now, rest, path); mv['yp'] = y1
        mv['up'] = trace(K, path[-1], lift_pos(K, path[-1]), lambda t, y=y1: y)

    def ref(a, now):
        """joint targets and finger target for arm a at time now"""
        mv = cur[a]
        if mv is None: return None
        u = now - mv['start']
        for name, T in PHASES:
            if u < T or name == 'home': break
            u -= T
        s = minjerk(u / T); tau = min(1.0, u / T)
        if name == 'to': return mv['q0'] + (mv['qh'] - mv['q0']) * s, OPEN
        if name == 'down': return sample(mv['down'], tau), OPEN
        if name == 'close': return mv['down'][-1], OPEN + (SQUEEZE - OPEN) * s
        if name == 'carry':
            if 'aim' not in mv: aim(a, mv)
            if tau >= 0.7 and 'aim2' not in mv: reaim(a, mv, now, T * 0.3)
            if 'final' in mv and now >= mv['final'][0]: return sample(mv['final'][2], (now - mv['final'][0]) / mv['final'][1]), SQUEEZE
            return sample(mv['carry'], tau), SQUEEZE
        if name in ('open', 'up') and 'final' in mv and 'patched' not in mv:
            mv['carry'] = mv['final'][2]; mv['patched'] = True
        if name == 'open': return mv['carry'][-1], SQUEEZE + (OPEN - SQUEEZE) * s
        if name == 'up': return (sample(mv['up'], tau) if mv['up'] is not None else mv['carry'][-1]), OPEN
        # home along a curve that only rises then falls back to the rest pose: it cannot dip into the tower
        if 'back' not in mv:
            K = kin[a]; q = q_cmd[a].copy(); p, _ = K.fk(q); y0 = K.tool_x(q); yh = K.tool_x(home[a])
            yh = y0 + wrap(yh - y0); top = max(p[2], home_pos[a][2]) + 0.03
            c = bezier(p.copy(), home_pos[a], top - p[2], top - home_pos[a][2])
            mv['back'] = trace(K, q, lambda t: c(minjerk(t)), lambda t: y0 + (yh - y0) * minjerk(t))
            if mv['back'] is None: print(f'  ! way home for arm {a} would flip; going in joint space')
            mv['qu'] = q
        if mv['back'] is not None: return sample(mv['back'], tau), OPEN
        return mv['qu'] + (home[a] - mv['qu']) * s, OPEN

    # settle the blocks, then run and record
    for _ in range(200): mujoco.mj_step(m, d)
    if args.preview:
        import subprocess
        W, H = 1280, 720
        rend = mujoco.Renderer(m, H, W // 2); opt = mujoco.MjvOption()
        cams = []
        for az, el, dist, look in [(90, -28, 1.0, [0, -0.22, 0.05]), (90, -10, 0.32, [0, -0.25, 0.05])]:
            c = mujoco.MjvCamera(); c.azimuth, c.elevation, c.distance = az, el, dist; c.lookat[:] = look; cams.append(c)
        ff = subprocess.Popen(['ffmpeg', '-v', 'error', '-y', '-f', 'rawvideo', '-pix_fmt', 'rgb24', '-s', f'{W}x{H}', '-r', str(args.fps), '-i', '-',
                               '-c:v', 'libx264', '-pix_fmt', 'yuv420p', '-crf', '22', args.preview.replace('.mp4', f'_{seed}.mp4')], stdin=subprocess.PIPE)
    lvl = {}
    frames = []; every = round(1 / (args.fps * DT)); steps = int(args.seconds / DT)
    pending = sorted(moves, key=lambda x: x['start'])
    for step in range(steps + 1):
        now = step * DT
        for a in range(2):
            if cur[a] is not None and now >= cur[a]['start'] + MOVE: cur[a] = None
            if cur[a] is None:
                nxt = next((x for x in pending if x['arm'] == a and x['start'] <= now), None)
                if nxt:
                    pending.remove(nxt); plan_move(nxt)
                    if not nxt.get('skip'): cur[a] = nxt
            r = ref(a, now)
            q, g = r if r is not None else (home[a], OPEN)
            # drive the joints by velocity onto the path; overwriting positions would hide the
            # hand's motion from the contact solver and blocks would slip out of the grip
            if np.abs(q - q_cmd[a]).max() > 0.05: print(f'  ! arm {a} path jumps {np.abs(q - q_cmd[a]).max():.2f} rad at {now:.2f} s')
            q_cmd[a] = q
            d.qvel[kin[a].v] = np.clip((q - d.qpos[kin[a].q]) / DT, -6, 6)
            d.ctrl[act[a]] = g
        if step % 50 == 0:
            for i in range(n):
                z = d.qpos[bq[i] + 2]; hgt = round((z - SIZE / 2) / SIZE)
                held = any(c_ is not None and c_.get('block') == i for c_ in cur)
                if held: lvl[i] = 0
                elif hgt >= 1 and abs(z - (SIZE / 2 + hgt * SIZE)) < 0.004: lvl[i] = hgt
                elif lvl.get(i, 0) >= 1 and z < SIZE / 2 + 0.004:
                    print(f'  ! {pieces[i]["glyph"]} fell from level {lvl[i]} at {now:.2f} s'); lvl[i] = 0
        if step % every == 0:
            row = []
            for a in range(2): row += list(d.qpos[kin[a].q]) + [d.qpos[grip_q[a]], d.qpos[grip_q2[a]]]
            for i in range(n): row += list(d.qpos[bq[i]:bq[i] + 7])
            frames.append(row)
            if args.preview:
                img = []
                act_arm = 0 if cur[0] is not None else 1 if cur[1] is not None else 0
                cams[1].lookat[:] = d.site_xpos[kin[act_arm].site]; cams[1].azimuth = 90 + (25 if act_arm == 0 else -25)
                for c in cams: rend.update_scene(d, c, opt); img.append(rend.render())
                ff.stdin.write(np.concatenate(img, 1).tobytes())
        mujoco.mj_step(m, d)

    if args.preview: ff.stdin.close(); ff.wait()
    # how well it went: every tower should have stood, every block should be home again
    F = np.array(frames)
    out = Path(args.out); out.mkdir(parents=True, exist_ok=True)
    # int16: joint angles in 1e-4 rad, positions in 0.05 mm, quaternions in 1/32767
    cols = []
    for a in range(2): cols += ['ang'] * 6 + ['pos'] * 2
    for i in range(n): cols += ['pos'] * 3 + ['quat'] * 4
    scale = np.array([{'ang': 1e4, 'pos': 2e4, 'quat': 32767}[c] for c in cols])
    Q = np.clip(np.round(F * scale), -32768, 32767).astype('<i2')
    (out / f'{seed}.bin').write_bytes(Q.tobytes())
    goals = []
    for i in range(0, len(moves), 6): goals.append([pieces[mv['piece']]['glyph'] for mv in moves[i:i + 3]])
    json.dump({'fps': args.fps, 'frames': len(frames), 'size': SIZE, 'glyphs': [p['glyph'] for p in pieces],
               'columns': {'arm': 8, 'block': 7}, 'scale': {'ang': 1e4, 'pos': 2e4, 'quat': 32767},
               'goals': goals, 'episodeStarts': [moves[i]['start'] for i in range(0, len(moves), 6)]},
              open(out / f'{seed}.json', 'w'))
    # per move: did the block come up with the gripper, and land where it was meant to?
    fps = args.fps
    for mv in moves:
        if 'target' not in mv: continue
        i = mv['block']; c = 16 + 7 * i
        f0 = int((mv['start'] + REACH + CLOSE) * fps); f1 = int((mv['start'] + REACH + CLOSE + CARRY) * fps); f2 = min(len(F) - 1, int((mv['start'] + MOVE) * fps))
        if f2 >= len(F) - 1: continue
        lift = F[f0:f1, c + 2].max() - F[f0, c + 2]
        if 'target' not in mv: continue
        fo = int((mv['start'] + at['open'] - 0.03) * fps); pre = np.linalg.norm(F[fo, c:c + 2] - mv['target'][:2])
        mid = np.linalg.norm(F[int((mv['start'] + at['carry'] + 0.05) * fps), c:c + 2] - F[int((mv['start'] + at['carry']) * fps), c:c + 2])
        land = F[f2, c:c + 3]; err = np.linalg.norm(land[:2] - mv['target'][:2]); dz = land[2] - mv['target'][2]
        yaw = block_yaw(F[f2, c + 3:c + 7]); want = 0.0 if mv['kind'] == 'up' else mv['want'] if mv['kind'] == 'turn' else pieces[i]['yaw']
        print(f"  t {mv['start']:5.1f} {mv['kind']:4} {pieces[i]['glyph']} arm {mv['arm']}  lifted {lift*1000:5.1f} mm  off before release {pre*1000:4.1f} mm, landed off {err*1000:4.1f} mm, dz {dz*1000:+5.1f} mm, yaw off {math.degrees(wrap(yaw-want)):+5.1f} deg")
    # report: blocks that ended far from home, and towers that fell
    end = F[-1]; off = 2 * 8
    worst = max(np.linalg.norm(end[off + 7 * i: off + 7 * i + 2] - pieces[i]['spot']) for i in range(n))
    heights = F[:, off + 2::7][:, :n]
    print(f'seed {seed}: {n} blocks, {len(moves)} moves, {len(frames)} frames; tallest block {heights.max()*1000:.1f} mm; '
          f'worst drift from home {worst*1000:.1f} mm')
    return F, pieces, moves

if __name__ == "__main__":
    for s in args.seeds: run(s)
