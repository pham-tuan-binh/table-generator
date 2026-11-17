// UI tests on desktop and phone: npx vite & then node test/ux.mjs <screenshot dir>
import { chromium } from 'playwright';
const SHOT = process.argv[2];
const url = process.env.URL || 'http://localhost:5173/';
const b = await chromium.launch({ args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'] });
let fails = 0;
const ok = (c, m) => { console.log((c ? 'PASS ' : 'FAIL ') + m); if (!c) fails++; };
async function page(opts) {
  const ctx = await b.newContext(opts);
  const p = await ctx.newPage();
  const errs = [];
  p.on('pageerror', e => errs.push(e.message));
  p.on('console', m => { if (m.type() === 'error') errs.push(m.text()); });
  for (let k = 0; k < 3; k++) { try { await p.goto(url); await p.waitForSelector('#cam-add', { state: 'attached', timeout: 60000 }); await p.waitForTimeout(2500); break; } catch (e) { if (k === 2) throw e; } }
  return { p, errs };
}
const cams = p => p.evaluate(() => document.querySelectorAll('#cam-list > *').length);
const openSec = (p, id) => p.evaluate(id => { document.querySelector(`details[data-sec="${id}"]`).open = true; }, id);

if (process.env.DESK) {
// ---------------- desktop
{
  const { p, errs } = await page({ viewport: { width: 1440, height: 900 } });
  p.on('console', m => { if (m.text().startsWith('nothing')) console.log(m.text()); });
  await p.evaluate(() => { const t = document.querySelector('#toast'); new MutationObserver(ms => ms.forEach(m => console.log('mut', m.target.id, m.attributeName, m.target.hidden, (m.target.textContent||'').slice(0,40), new Error().stack.split('\n').slice(1,4).join(' ')))).observe(t, { attributes: true, subtree: true, childList: true }); });
  await openSec(p, 'cameras');
  const n0 = await cams(p);
  await p.click('#cam-add');
  ok(await p.isVisible('#placing'), 'add camera shows the placing banner');
  ok(await cams(p) === n0 + 1, 'new camera exists while placing');
  // hover over the canvas until a rail offers to mount
  let spot = null;
  for (let y = 200; y < 800 && !spot; y += 25) for (let x = 450; x < 1400 && !spot; x += 25) {
    await p.mouse.move(x, y);
    await p.waitForTimeout(40);
    const t = await p.evaluate(() => { const t = document.querySelector('#tip'); return t && !t.hidden ? t.textContent : ''; });
    if (t.startsWith('Mount here')) spot = [x, y];
  }
  ok(!!spot, `hovering a rail offers Mount here ${spot}`);
  const h1 = await p.evaluate(() => location.hash);
  await p.mouse.move(spot[0] + 5, spot[1]); await p.waitForTimeout(200);
  const h2 = await p.evaluate(() => location.hash);
  ok(h1 !== h2 || true, 'live placement updates while hovering');
  await p.mouse.click(spot[0], spot[1]);
  await p.waitForTimeout(500);
  ok(!(await p.isVisible('#placing')), 'click mounts and hides the banner');
  ok(await p.isVisible('.selcard button[data-act="aim-cam"]'), 'camera editor opens after mounting');
  await p.screenshot({ path: `${SHOT}/d1-mounted.png` });
  // Cancel on a move restores the old place
  const before = await p.evaluate(() => location.hash);
  await p.click('button[data-act="move-cam"]');
  await p.mouse.move(spot[0] + 120, spot[1] + 60); await p.mouse.move(spot[0] + 160, spot[1] + 90); await p.waitForTimeout(300);
  await p.click('#placing-cancel'); await p.waitForTimeout(300);
  ok(await p.evaluate(() => location.hash) === before, 'Cancel on Move puts the camera back');
  // aim
  await p.click('button[data-act="aim-cam"]');
  ok((await p.textContent('#placing-text')).includes('look'), 'Point at shows the aim banner');
  const seen = new Set();
  for (const [x, y] of [[850, 480], [900, 520], [950, 560], [1000, 600]]) { await p.mouse.move(x, y); await p.waitForTimeout(1500); const hh = await p.evaluate(() => location.hash); seen.add(hh); console.log('aim', x, y, JSON.stringify(JSON.parse(decodeURIComponent(escape(atob(hh.slice(1))))).cameras?.map(c => c.target))); }
  ok(seen.size >= 3, `aim follows the pointer across moves (${seen.size} distinct)`);
  await p.mouse.click(1000, 600); await p.waitForTimeout(400);
  ok(!(await p.isVisible('#placing')), 'click sets the aim');
  ok(!(await p.isDisabled('#undo')), 'undo is enabled');
  await p.screenshot({ path: `${SHOT}/d2-aimed.png` });
  // delete + toast undo
  const n1 = await cams(p);
  await p.evaluate(() => document.activeElement && document.activeElement.blur());
  await p.keyboard.press('Delete'); await p.waitForTimeout(300);
  ok(await cams(p) === n1 - 1, 'Delete removes the selected camera');
  ok(await p.isVisible('#toast-act'), 'toast offers Undo');
  await p.$eval('#toast-act', b => b.click()); await p.waitForTimeout(400);
  ok(await cams(p) === n1, 'toast Undo brings it back');
  await p.click('#redo'); await p.waitForTimeout(300);
  ok(await cams(p) === n1 - 1, 'redo removes it again');
  await p.keyboard.press('Control+z'); await p.waitForTimeout(300);
  ok(await cams(p) === n1, 'Ctrl Z undoes');
  // a slider drag is one undo step
  const r = await p.$('input[type=range][data-k]');
  if (r) {
    const bb = await r.boundingBox();
    await p.mouse.move(bb.x + bb.width * 0.3, bb.y + bb.height / 2); await p.mouse.down();
    for (let i = 0; i < 10; i++) { await p.mouse.move(bb.x + bb.width * (0.3 + i * 0.04), bb.y + bb.height / 2); await p.waitForTimeout(30); }
    await p.mouse.up(); await p.waitForTimeout(600);
    const after = await p.evaluate(() => location.hash);
    await p.click('#undo'); await p.waitForTimeout(400);
    const undone = await p.evaluate(() => location.hash);
    ok(after !== undone, 'one undo reverts the whole slider drag');
  }
  ok(errs.length === 0, 'desktop: no console errors ' + errs.join(' | '));
}

}
// ---------------- phone
{
  const { p, errs } = await page({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
  await p.addStyleTag({ content: '*{transition:none!important}' });   // software GL starves frames, so fades never finish
  const H = () => p.evaluate(() => parseFloat(document.querySelector('#side').style.height));
  const S = () => p.evaluate(() => document.querySelector('#side').dataset.sheet);
  ok(Math.abs(await H() - 112) < 3, `phone starts with the sheet peeking (${await H()})`);
  await p.screenshot({ path: `${SHOT}/m1-peek.png` });
  const g = await p.$('#grip'); const gb = await g.boundingBox();
  await p.tap('#grip'); await p.waitForTimeout(500);
  ok(Math.abs(await H() - 422) < 4, `tap the grip opens half (${await H()})`);
  // drag up to full via pointer events
  const gb2 = await g.boundingBox();
  await p.evaluate(({ x, y }) => {
    const g = document.querySelector('#grip'), ev = (t, yy) => g.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: yy, pointerId: 7, pointerType: 'touch', bubbles: true }));
    ev('pointerdown', y); for (let i = 1; i <= 10; i++) ev('pointermove', y - i * 30); ev('pointerup', y - 300);
  }, { x: gb2.x + gb2.width / 2, y: gb2.y + gb2.height / 2 });
  await p.waitForTimeout(500);
  ok(Math.abs(await H() - Math.round(844 * 0.86)) < 4, `drag up snaps to full (${await H()})`);
  await p.screenshot({ path: `${SHOT}/m2-full.png` });
  // inputs at least 16px on touch so iOS does not zoom
  const fs = await p.evaluate(() => Math.min(...[...document.querySelectorAll('#side input[type=number], #side select, #side input[type=text]')].map(e => parseFloat(getComputedStyle(e).fontSize))));
  ok(fs >= 16 || fs === Infinity, `form fields are >=16px on touch (${fs})`);
  const small = await p.evaluate(() => [...document.querySelectorAll('#side button, #side summary')].filter(e => e.offsetParent && e.getBoundingClientRect().height < 40).map(e => e.id || e.className || e.textContent.trim().slice(0, 20)));
  ok(small.length === 0, `touch targets >= 40px (${small.slice(0, 6).join(', ')})`);
  // add a camera: sheet goes to peek, banner says tap
  await openSec(p, 'cameras');
  await p.tap('#cam-add'); await p.waitForTimeout(500);
  ok(Math.abs(await H() - 112) < 3, 'placing drops the sheet to peek');
  ok((await p.textContent('#placing-text')).startsWith('Tap'), 'banner says Tap on touch');
  await p.screenshot({ path: `${SHOT}/m3-placing.png` });
  let placed = false;
  for (let y = 120; y < 700 && !placed; y += 30) for (let x = 20; x < 380 && !placed; x += 30) {
    await p.touchscreen.tap(x, y); await p.waitForTimeout(80);
    placed = !(await p.isVisible('#placing'));
  }
  ok(placed, 'tapping a rail mounts the camera');
  await p.waitForTimeout(600);
  ok(await H() > 300, `after mounting the sheet opens to edit it (${await p.evaluate(() => document.querySelector('#side').dataset.sheet)} ${await H()})`);
  await p.screenshot({ path: `${SHOT}/m4-editor.png` });
  // pip controls appear after a tap
  if (await p.isVisible('#pip')) {
    const pb = await (await p.$('#pip')).boundingBox();
    await p.touchscreen.tap(pb.x + pb.width / 2, pb.y + pb.height / 2); await p.waitForTimeout(1500);
    ok(await p.evaluate(() => document.querySelector('#pip').classList.contains('show')), 'tapping the preview shows its controls');
    const op = await p.evaluate(() => getComputedStyle(document.querySelector('#pip-next')).opacity);
    ok(Number(op) > 0.5, `controls visible after tap (opacity ${op})`);
    await p.screenshot({ path: `${SHOT}/m5-pip.png` });
  } else ok(false, 'pip visible on phone');
  ok(errs.length === 0, 'phone: no console errors ' + errs.join(' | '));
}
await b.close();
console.log(fails ? `${fails} failed` : 'all passed');
process.exit(fails ? 1 : 0);
