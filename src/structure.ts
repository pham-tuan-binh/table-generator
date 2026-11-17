// Picks the extrusion from the load the table is rated for. Each candidate profile is
// checked, smallest first, against three rules of thumb; the first that passes all three is
// used for the whole frame (one profile keeps brackets, T-nuts and stock to one kind).
//
//   sag    worktop and shelf rails under their rated load, spread over the rails that carry
//          the board, plus the board itself: deflection <= span / 300
//   sway   a robot arm pushes back on the table when it moves: 15 % of the worktop load
//          applied sideways at the worktop, resisted by the four posts as columns whose
//          bracket joints are only partly rigid: deflection <= 1 mm
//   posts  Euler buckling of the longest unbraced post segment under a quarter of
//          everything: safety factor >= 3
//
// These are design aids, not certification. Section data is typical for each series.
import { Params, PROFILES, ProfileId, CASTERS, FOOT_HEIGHT, material } from './params.ts';

export const SECTION: Record<ProfileId, { I: number; A: number }> = {   // mm⁴, mm²
  '2020': { I: 6900, A: 160 },
  '3030': { I: 27000, A: 335 },
  '4040': { I: 99000, A: 555 },
  '1010': { I: 18400, A: 282 },
};
const E = 69000;            // MPa, 6063-T5
const G = 9.81;
const DYNAMIC = 1.5;        // a moving arm loads the table more than its weight
const SWAY_SHARE = 0.15;    // sideways reaction, as a share of the worktop load
const JOINT = 0.3;          // bracket joints carry about a third of a welded joint's moment
export const LIMITS = { sagRatio: 300, swayMm: 1, bucklingSf: 3 };

export interface Sizing {
  profile: ProfileId;
  sag: number; sagLimit: number;     // mm
  sway: number;                      // mm
  buckling: number;                  // safety factor
  ok: boolean;                       // false when even the largest profile fails
  governs: string;                   // which rule pushed the size up, if any
}

function evaluate(p: Params, id: ProfileId): Omit<Sizing, 'governs'> {
  const s = PROFILES[id].s, { I } = SECTION[id];
  const W = p.width, D = p.depth, Ht = p.tableHeight, Htot = Ht + p.boxHeight;
  const baseH = p.base === 'casters' ? CASTERS[p.casterWheel] : FOOT_HEIGHT;
  const Lx = W - 2 * s, Ly = D - 2 * s;
  const nSup = p.supports < 0 ? Math.max(0, Math.ceil(Lx / 450) - 1) : p.supports;
  const board = (m: string, t: number) => ((W * D) / 1e6) * (t / 1000) * material(m).density;

  // sag: worktop load spread along every rail under the board, check the long rail
  const wtN = (p.load * DYNAMIC + (p.worktop ? board(p.worktopMaterial, p.worktopThk) : 0)) * G;
  const wRail = wtN / (2 * Lx + (2 + nSup) * Ly);                      // N/mm
  let sag = (5 * wRail * Lx ** 4) / (384 * E * I);
  if (p.shelf) {
    const shN = (p.shelfLoad * DYNAMIC + board(p.shelfMaterial, p.shelfThk)) * G;
    sag = Math.max(sag, (5 * (shN / (2 * Lx + 2 * Ly)) * Lx ** 4) / (384 * E * I));
  }
  const sagLimit = Lx / LIMITS.sagRatio;

  // sway: posts between the worktop ring and the ring below it (or the floor)
  const braced = p.lowerRing !== 'none';
  const Ls = braced ? Ht - p.lowerHeight : Ht - baseH;
  const kPost = braced ? (12 * E * I) / Ls ** 3 : (3 * E * I) / Ls ** 3;
  const sway = (SWAY_SHARE * p.load * G) / (4 * kPost * JOINT);

  // posts: everything on four posts, longest unbraced segment, partly fixed ends
  const frameKg = ((4 * (Htot - baseH) + 4 * (Lx + Ly)) / 1000) * PROFILES[id].kgPerM;
  const N = ((p.load + (p.shelf ? p.shelfLoad : 0)) * DYNAMIC + frameKg + (p.worktop ? board(p.worktopMaterial, p.worktopThk) : 0)) * G / 4;
  const levels = [baseH, ...(braced ? [p.lowerHeight] : []), Ht, Htot].sort((a, b) => a - b);
  const Lu = Math.max(...levels.slice(1).map((z, i) => z - levels[i]));
  const buckling = (Math.PI ** 2 * E * I) / (1.5 * Lu) ** 2 / Math.max(N, 1);

  return { profile: id, sag, sagLimit, sway, buckling, ok: sag <= sagLimit && sway <= LIMITS.swayMm && buckling >= LIMITS.bucklingSf };
}

export function sizeFrame(p: Params): Sizing {
  const order: ProfileId[] = ['2020', '3030', '4040'];
  let prev: ReturnType<typeof evaluate> | null = null;
  for (const id of order) {
    const r = evaluate(p, id);
    if (r.ok || id === order[order.length - 1]) {
      // the rule the next smaller size failed is the one that set this size
      const governs = !prev ? '' : prev.sway > LIMITS.swayMm ? 'sway' : prev.sag > prev.sagLimit ? 'sag' : 'buckling';
      return { ...r, governs };
    }
    prev = r;
  }
  throw new Error('no profile');
}
