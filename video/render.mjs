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
const launch = { args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--ignore-gpu-blocklist'] };
if (process.env.CHROME) launch.executablePath = process.env.CHROME;

const probe = await chromium.launch(launch);
const pp = await probe.newPage({ viewport: { width: 1920, height: 1080 } });
await pp.goto(url);
const { FPS, DURATION } = await pp.evaluate(async () => { await window.ready; return { FPS: window.FPS, DURATION: window.DURATION }; });
await probe.close();
const total = Math.round(FPS * DURATION), from = Number(opt('from', 0)), to = Number(opt('to', total));
const todo = [];
for (let i = from; i < to; i += step) if (!existsSync(`${dir}${String(i).padStart(5, '0')}.png`)) todo.push(i);
console.log(`${todo.length} frames to render of ${total}, ${workers} workers`);

const t0 = Date.now();
let done = 0;
await Promise.all(Array.from({ length: workers }, async (_, w) => {
  const b = await chromium.launch(launch);
  const p = await b.newPage({ viewport: { width: 1920, height: 1080 } });
  p.on('pageerror', e => console.error('page error', e.message));
  await p.goto(url);
  await p.evaluate(() => window.ready);
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
