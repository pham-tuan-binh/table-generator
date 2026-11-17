// Renders the launch video frame by frame in headless Chromium, then encodes it.
//   npx vite --port 5174 &            (serves video/index.html)
//   node video/render.mjs [out.mp4] [--workers 4] [--from 0] [--to N] [--step 1]
// Frames are written to video/frames/ and kept, so a run can be resumed or partly redone.
import { chromium } from 'playwright';
import { mkdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const out = args.find(a => a.endsWith('.mp4')) || 'video/table-generator.mp4';
const url = opt('url', 'http://localhost:5174/video/');
const workers = Number(opt('workers', 4)), step = Number(opt('step', 1));
const dir = new URL('./frames/', import.meta.url).pathname;
mkdirSync(dir, { recursive: true });
// GL=gpu uses the machine's GPU through ANGLE (EGL); otherwise software WebGL (SwiftShader)
const GL = process.env.GL === 'gpu'
  ? ['--use-gl=angle', '--use-angle=gl-egl', '--ignore-gpu-blocklist', '--enable-gpu', '--enable-gpu-rasterization']
  : ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'];
const launch = { args: GL, headless: true };
// load the page and wait until it is ready; Vite may reload it once while it optimises dependencies
async function open(b) {
  for (let k = 0; ; k++) {
    const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
    try { await p.goto(url); await p.evaluate(() => window.ready); return p; }
    catch (e) { await p.close(); if (k >= 3) throw e; }
  }
}
if (process.env.CHROME) launch.executablePath = process.env.CHROME;

const probe = await chromium.launch(launch);
const pp = await open(probe);
const { FPS, DURATION, gpu } = await pp.evaluate(() => {
  const gl = document.createElement('canvas').getContext('webgl2'), ext = gl.getExtension('WEBGL_debug_renderer_info');
  return { FPS: window.FPS, DURATION: window.DURATION, gpu: ext ? gl.getParameter(ext.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER) };
});
console.log('renderer:', gpu);
if (process.env.GL === 'gpu' && /swiftshader|llvmpipe/i.test(gpu)) { console.error('asked for the GPU but got software rendering; stopping'); process.exit(2); }
await probe.close();
const total = Math.round(FPS * DURATION), from = Number(opt('from', 0)), to = Number(opt('to', total));
const todo = [];
for (let i = from; i < to; i += step) if (!existsSync(`${dir}${String(i).padStart(5, '0')}.png`)) todo.push(i);
console.log(`${todo.length} frames to render of ${total}, ${workers} workers`);

const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  const b = await chromium.launch(launch);
  const p = await open(b);
  p.on('pageerror', e => console.error('page error', e.message));
  for (let k = w; k < todo.length; k += workers) {
    const i = todo[k];
    await p.evaluate(t => window.frame(t), i / FPS);
    await p.screenshot({ path: `${dir}${String(i).padStart(5, '0')}.png`, timeout: 0 });
    if (++done % 30 === 0) { const s = (Date.now() - t0) / 1000; console.log(`${done}/${todo.length}  ${(s / done).toFixed(2)} s/frame  eta ${Math.round((s / done) * (todo.length - done) / 60)} min`); }
  }
  await b.close();
}));

if (step === 1 && from === 0 && to === total) {
  execFileSync('ffmpeg', ['-y', '-framerate', String(FPS), '-i', `${dir}%05d.png`, '-c:v', 'libx264', '-preset', 'slow', '-crf', '17', '-pix_fmt', 'yuv420p', '-movflags', '+faststart', out], { stdio: 'inherit' });
  console.log(`wrote ${out}`);
}
