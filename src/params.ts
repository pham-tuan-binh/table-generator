// Every input of the design, its limits, and how it travels in a URL hash.
// Units: millimetres, degrees, kg. Design frame: z up, x along the width (left to right),
// y along the depth (front is -y, back is +y), origin on the floor under the table centre.

export type ProfileId = '2020' | '3030' | '4040' | '1010';
export type BaseType = 'feet' | 'casters';
export type LowerRing = 'full' | 'sides-back' | 'none';
export type PanelFace = 'back' | 'left' | 'right' | 'front' | 'roof';
export type Face = '+x' | '-x' | '+y' | '-y' | '+z' | '-z';

export interface CameraSpec {
  id: string;
  name: string;
  preset: string;
  width: number;
  height: number;
  hfov: number;           // horizontal field of view, degrees
  near: number;           // mm
  far: number;            // mm
  rate: number;           // Hz
  mount: string;          // member id it is clamped to
  along: number;          // 0..1 along the member
  face: Face;             // which face of the member it sits on
  standoff: number;       // mm from that face to the camera's optical centre
  aim: 'target' | 'angles';
  target: [number, number, number];   // aim point, relative to the centre of the worktop surface
  yaw: number; pitch: number; roll: number;  // pitch > 0 looks down
}

export interface Params {
  width: number;          // X, outside
  depth: number;          // Y, outside
  tableHeight: number;    // floor to the top of the worktop rails
  boxHeight: number;      // top of the worktop rails to the top of the box
  profile: ProfileId;
  base: BaseType;
  casterWheel: number;    // mm wheel diameter
  lowerRing: LowerRing;
  lowerHeight: number;    // top of the lower ring above the floor
  shelf: boolean;
  supports: number;       // bars under the worktop, -1 = auto
  overheadBar: boolean;
  overheadBarY: number;   // y of the overhead camera bar
  panels: Record<PanelFace, boolean>;
  panelMaterial: string;
  panelThk: number;
  worktop: boolean;
  worktopMaterial: string;
  worktopThk: number;
  shelfMaterial: string;
  shelfThk: number;
  stockLength: number;    // 0 = cut to length
  kerf: number;
  frameColor: string;
  panelColor: string;
  worktopColor: string;
  panelOpacity: number;
  cameras: CameraSpec[];
}

export interface ProfileSpec {
  id: ProfileId; name: string; s: number; slot: number; slotDepth: number; engage: number;
  screw: string; endTap: string; kgPerM: number; tnut: string;
}

export const PROFILES: Record<ProfileId, ProfileSpec> = {
  '2020': { id: '2020', name: '2020 T-slot (20×20 mm, 6 mm slot)', s: 20, slot: 6.2, slotDepth: 6, engage: 5, screw: 'M5', endTap: 'M5', kgPerM: 0.5, tnut: 'M5 drop-in T-nut (6 mm slot)' },
  '3030': { id: '3030', name: '3030 T-slot (30×30 mm, 8 mm slot)', s: 30, slot: 8.2, slotDepth: 9, engage: 7, screw: 'M6', endTap: 'M8', kgPerM: 0.9, tnut: 'M6 drop-in T-nut (8 mm slot)' },
  '4040': { id: '4040', name: '4040 T-slot (40×40 mm, 8 mm slot)', s: 40, slot: 8.2, slotDepth: 12, engage: 8, screw: 'M8', endTap: 'M8', kgPerM: 1.5, tnut: 'M8 drop-in T-nut (8 mm slot)' },
  '1010': { id: '1010', name: '1010 T-slot (1×1 in, 1/4-20)', s: 25.4, slot: 6.6, slotDepth: 7, engage: 5, screw: '1/4-20', endTap: '1/4-20', kgPerM: 0.75, tnut: '1/4-20 drop-in T-nut (10 series)' },
};

export interface MaterialSpec { id: string; name: string; density: number; thk: number; color: string; opacity?: number; cnc: boolean }
// density in kg/m³
export const MATERIALS: MaterialSpec[] = [
  { id: 'hpl', name: 'HPL / mica laminate', density: 1400, thk: 3, color: '#f4f4f1', cnc: true },
  { id: 'acm', name: 'Aluminium composite (ACM)', density: 1270, thk: 3, color: '#eeeeee', cnc: true },
  { id: 'acrylic', name: 'Clear acrylic', density: 1190, thk: 3, color: '#cfe3ee', opacity: 0.35, cnc: true },
  { id: 'polycarb', name: 'Polycarbonate', density: 1200, thk: 3, color: '#dde8ee', opacity: 0.45, cnc: true },
  { id: 'abs-black', name: 'Matte black ABS', density: 1050, thk: 3, color: '#2b2b2e', cnc: true },
  { id: 'plywood', name: 'Birch plywood', density: 650, thk: 18, color: '#d9b98c', cnc: true },
  { id: 'mdf', name: 'MDF', density: 750, thk: 18, color: '#bfa27c', cnc: true },
  { id: 'hdpe', name: 'HDPE sheet', density: 950, thk: 12, color: '#f2f2ee', cnc: true },
  { id: 'alu', name: 'Aluminium plate', density: 2700, thk: 6, color: '#c9ccd0', cnc: true },
];
export const material = (id: string) => MATERIALS.find(m => m.id === id) || MATERIALS[0];

export const CASTERS: Record<number, number> = { 50: 72, 63: 88, 75: 104, 100: 128 };  // wheel Ø -> mount height
export const FOOT_HEIGHT = 30;

export interface CameraPreset { id: string; name: string; width: number; height: number; hfov: number; body: [number, number, number] }
export const CAMERA_PRESETS: CameraPreset[] = [
  { id: 'usb-1080', name: 'USB webcam 1080p (~70° HFOV)', width: 1920, height: 1080, hfov: 70.4, body: [30, 90, 30] },
  { id: 'realsense-d435', name: 'RealSense D435 colour (69° HFOV)', width: 1920, height: 1080, hfov: 69, body: [25, 90, 25] },
  { id: 'rpi-cam3', name: 'Pi Camera Module 3 (66° HFOV)', width: 1536, height: 864, hfov: 66, body: [12, 25, 24] },
  { id: 'rpi-cam3-wide', name: 'Pi Camera Module 3 Wide (102° HFOV)', width: 1536, height: 864, hfov: 102, body: [12, 25, 24] },
  { id: 'wide-usb', name: 'Wide-angle USB 720p (~120° HFOV)', width: 1280, height: 720, hfov: 120, body: [20, 32, 32] },
  { id: 'custom', name: 'Custom', width: 640, height: 480, hfov: 60, body: [25, 32, 32] },
];
export const cameraPreset = (id: string) => CAMERA_PRESETS.find(p => p.id === id) || CAMERA_PRESETS[CAMERA_PRESETS.length - 1];

export const DEFAULTS: Params = {
  width: 1000, depth: 500, tableHeight: 750, boxHeight: 500,
  profile: '2020', base: 'feet', casterWheel: 75,
  lowerRing: 'full', lowerHeight: 180, shelf: true, supports: -1,
  overheadBar: true, overheadBarY: 0,
  panels: { back: true, left: true, right: true, front: false, roof: false },
  panelMaterial: 'hpl', panelThk: 3,
  worktop: true, worktopMaterial: 'plywood', worktopThk: 18,
  shelfMaterial: 'plywood', shelfThk: 12,
  stockLength: 0, kerf: 3,
  frameColor: '#c4c7cb', panelColor: '#f4f4f1', worktopColor: '#d9b98c', panelOpacity: 1,
  cameras: [
    { id: 'overhead', name: 'overhead', preset: 'usb-1080', width: 1920, height: 1080, hfov: 70.4, near: 20, far: 5000, rate: 30,
      mount: 'bar_overhead', along: 0.5, face: '-z', standoff: 20, aim: 'target', target: [0, 0, 0], yaw: 0, pitch: 90, roll: 0 },
    { id: 'front', name: 'front', preset: 'usb-1080', width: 1920, height: 1080, hfov: 70.4, near: 20, far: 5000, rate: 30,
      mount: 'rail_top_front', along: 0.5, face: '-z', standoff: 20, aim: 'target', target: [0, 60, 0], yaw: 90, pitch: 40, roll: 0 },
  ],
};

export interface Limit { min: number; max: number; step: number }
export const LIMITS: Partial<Record<keyof Params, Limit>> = {
  width: { min: 300, max: 3000, step: 10 },
  depth: { min: 250, max: 1500, step: 10 },
  tableHeight: { min: 200, max: 1200, step: 10 },
  boxHeight: { min: 150, max: 1500, step: 10 },
  lowerHeight: { min: 60, max: 900, step: 10 },
  overheadBarY: { min: -700, max: 700, step: 5 },
  panelThk: { min: 1, max: 12, step: 0.5 },
  worktopThk: { min: 3, max: 40, step: 1 },
  shelfThk: { min: 3, max: 40, step: 1 },
  kerf: { min: 0, max: 6, step: 0.5 },
  panelOpacity: { min: 0.1, max: 1, step: 0.05 },
};

export const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

// keep every number inside its limits and the dependent ones consistent
export function normalize(input: Partial<Params>): Params {
  const p: Params = { ...clone(DEFAULTS), ...clone(input) };
  p.panels = { ...DEFAULTS.panels, ...(input.panels || {}) };
  if (!PROFILES[p.profile]) p.profile = DEFAULTS.profile;
  for (const [k, lim] of Object.entries(LIMITS) as [keyof Params, Limit][]) {
    const v = Number(p[k]);
    (p as any)[k] = Number.isFinite(v) ? Math.min(lim.max, Math.max(lim.min, v)) : DEFAULTS[k];
  }
  const s = PROFILES[p.profile].s;
  p.lowerHeight = Math.min(p.lowerHeight, p.tableHeight - 3 * s);
  p.overheadBarY = Math.max(-(p.depth / 2 - 2 * s), Math.min(p.depth / 2 - 2 * s, p.overheadBarY));
  if (p.shelf && p.lowerRing !== 'full') p.lowerRing = 'full';
  if (!CASTERS[p.casterWheel]) p.casterWheel = 75;
  p.supports = Math.round(Math.max(-1, Math.min(6, Number(p.supports))));
  p.cameras = (p.cameras || []).map(c => ({ ...clone(DEFAULTS.cameras[0]), ...c }));
  return p;
}

// a URL hash: base64 of the JSON of what differs from the defaults
export function toHash(p: Params): string {
  const diff: Record<string, unknown> = {};
  for (const k of Object.keys(p) as (keyof Params)[]) if (JSON.stringify(p[k]) !== JSON.stringify(DEFAULTS[k])) diff[k] = p[k];
  if (!Object.keys(diff).length) return '';
  return btoa(unescape(encodeURIComponent(JSON.stringify(diff)))).replace(/=+$/, '');
}
export function fromHash(h: string): Params {
  try { if (h) return normalize(JSON.parse(decodeURIComponent(escape(atob(h))))); } catch { /* bad link: defaults */ }
  return normalize({});
}
