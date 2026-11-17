// Sizes each part of the frame for what it actually carries, for the lowest cost.
//
//   legs           carry everything; sized for sway and buckling
//   worktop rails  carry the worktop load; sized for sag, together with how many support
//                  bars go under the worktop (more short bars can beat thicker rails)
//   shelf rails    carry the shelf load; sized for sag, else the lightest bracing
//   box            posts, top rails, camera bar: only walls and cameras, so the lightest
//                  profile whose slot holds the walls
//
// Rules of thumb (design aids, not certification):
//   sag    rails under the rated load times 1.5 for a moving arm, plus the board,
//          spread over every rail under the board: deflection <= span / 300
//   sway   a moving arm pushes back with 15 % of the worktop load, sideways at the worktop,
//          against four legs whose bracket joints are a third as stiff as welds: <= 1 mm
//   legs   Euler buckling of the longest unbraced leg segment: safety factor >= 3
import { Params, PROFILES, ProfileId, CASTERS, FOOT_HEIGHT, material } from './params.ts';

export const SECTION: Record<ProfileId, { I: number; A: number }> = {   // mm⁴, mm²
  '2020': { I: 6900, A: 160 },
  '3030': { I: 27000, A: 335 },
  '4040': { I: 99000, A: 555 },
  '1010': { I: 18400, A: 282 },
};
const E = 69000, G = 9.81, DYNAMIC = 1.5, SWAY_SHARE = 0.15, JOINT = 0.3;
export const RULES = { sagRatio: 300, swayMm: 1, bucklingSf: 3 };
export const BRACKET_PRICE = 1.2;        // USD, rough, an L bracket with its screws and T-nuts
const SIZES: ProfileId[] = ['2020', '3030', '4040'];
// the longest free span a worktop board of this thickness should bridge between bars
export const boardSpan = (t: number) => (t >= 18 ? 900 : t >= 12 ? 650 : 450);

export interface Sizing {
  legs: ProfileId; rails: ProfileId; lower: ProfileId; box: ProfileId;
  supports: number; shelfSupports: number;
  sag: number; sagLimit: number; shelfSag: number; shelfSagLimit: number; sway: number; buckling: number;
  ok: boolean;
  why: { legs: string; rails: string; lower: string };   // what set each size
}

const board = (p: Params, m: string, t: number) => ((p.width * p.depth) / 1e6) * (t / 1000) * material(m).density;
const baseHeight = (p: Params) => (p.base === 'casters' ? CASTERS[p.casterWheel] : FOOT_HEIGHT);

// deflection of the longest rail of a ring of rails carrying a board
function ringSag(totalN: number, Lx: number, Ly: number, extraLy: number, I: number) {
  const w = totalN / (2 * Lx + (2 + extraLy) * Ly);
  return (5 * w * Lx ** 4) / (384 * E * I);
}

export function sizeFrame(p: Params): Sizing {
  const W = p.width, D = p.depth, Ht = p.tableHeight, baseH = baseHeight(p);
  const braced = p.lowerRing !== 'none';
  const shelfKg = p.shelf ? p.shelfLoad * DYNAMIC + board(p, p.shelfMaterial, p.shelfThk) : 0;
  const topKg = p.load * DYNAMIC + (p.worktop ? board(p, p.worktopMaterial, p.worktopThk) : 0);

  // legs: sway and buckling
  const legCheck = (id: ProfileId) => {
    const I = SECTION[id].I, Ls = braced ? Ht - p.lowerHeight : Ht - baseH;
    const k = braced ? (12 * E * I) / Ls ** 3 : (3 * E * I) / Ls ** 3;
    const sway = (SWAY_SHARE * p.load * G) / (4 * k * JOINT);
    const boxKg = ((4 * p.boxHeight + 2 * (W + D)) / 1000) * PROFILES['2020'].kgPerM + 5;   // box frame, walls, cameras
    const N = ((topKg + shelfKg + boxKg + ((4 * Ht) / 1000) * PROFILES[id].kgPerM) * G) / 4;
    const levels = [baseH, ...(braced ? [p.lowerHeight] : []), Ht].sort((a, b) => a - b);
    const Lu = Math.max(...levels.slice(1).map((z, i) => z - levels[i]));
    const buckling = (Math.PI ** 2 * E * I) / (1.5 * Lu) ** 2 / N;
    return { sway, buckling, ok: sway <= RULES.swayMm && buckling >= RULES.bucklingSf };
  };
  let legs: ProfileId = SIZES[SIZES.length - 1], legWhy = 'the largest size; it still falls short';
  for (const id of SIZES) {
    const r = legCheck(id);
    if (r.ok) { legs = id; break; }
    legWhy = r.sway > RULES.swayMm ? `a smaller leg would sway ${r.sway.toFixed(1)} mm` : 'a smaller leg would be too slender';
  }
  if (legs === SIZES[0]) legWhy = '';
  // a ring of rails carrying a board: the cheapest profile and number of support bars
  const ringFit = (sl: number, loadKg: number, counts: number[]) => {
    const Lx = W - 2 * sl, Ly = D - 2 * sl, limit = Lx / RULES.sagRatio;
    let best: { id: ProfileId; n: number; cost: number; sag: number } | null = null;
    for (const id of SIZES) for (const n of counts) {
      const sag = ringSag(loadKg * G, Lx, Ly, n, SECTION[id].I);
      if (sag > limit) continue;
      const cost = ((2 * Lx + (2 + n) * Ly) / 1000) * PROFILES[id].price + 2 * n * BRACKET_PRICE;
      if (!best || cost < best.cost - 1e-9) best = { id, n, cost, sag };
    }
    const n = counts[counts.length - 1];
    return { ok: !!best, limit, ...(best || { id: '4040' as ProfileId, n, cost: 0, sag: ringSag(loadKg * G, Lx, Ly, n, SECTION['4040'].I) }) };
  };
  const sizeOf = (id: ProfileId) => PROFILES[id].s;
  const auto = [0, 1, 2, 3, 4, 5, 6];
  const minN = (sl: number) => (p.worktop ? Math.max(0, Math.ceil((W - 2 * sl) / boardSpan(p.worktopThk)) - 1) : 0);
  const topCounts = (sl: number) => (p.supports < 0 ? auto.filter(n => n >= minN(sl)) : [p.supports]);
  let rails = ringFit(sizeOf(legs), topKg, topCounts(sizeOf(legs)));
  // legs are never thinner than the rails that butt into them
  if (sizeOf(rails.id) > sizeOf(legs)) {
    legs = rails.id;
    legWhy = `matches the ${rails.id} worktop rails`;
    rails = ringFit(sizeOf(legs), topKg, topCounts(sizeOf(legs)));
  }
  const railWhy = rails.id === '2020' ? '' : `2020 rails would sag more than ${rails.limit.toFixed(1)} mm`;
  const shelf = p.shelf ? ringFit(sizeOf(legs), shelfKg, [0, 1, 2, 3, 4]) : null;
  const lower: ProfileId = shelf ? shelf.id : '2020';
  const lowerWhy = shelf && shelf.id !== '2020' ? `2020 shelf rails would sag more than ${shelf.limit.toFixed(1)} mm` : '';

  const lc = legCheck(legs);
  return {
    legs, rails: rails.id, lower, box: '2020', supports: rails.n, shelfSupports: shelf ? shelf.n : 0,
    sag: rails.sag, sagLimit: rails.limit, shelfSag: shelf ? shelf.sag : 0, shelfSagLimit: shelf ? shelf.limit : 0, sway: lc.sway, buckling: lc.buckling,
    ok: lc.ok && rails.ok && (!shelf || shelf.ok),
    why: { legs: legWhy, rails: railWhy, lower: lowerWhy },
  };
}
