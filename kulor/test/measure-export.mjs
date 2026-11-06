// Times each stage of the export pipeline in the running app, to find the real bottleneck.
// Run after e2e.mjs: node test/measure-export.mjs <workdir>

import { spawn } from 'node:child_process';
import path from 'node:path';
import electronPath from 'electron';

const PORT = 9334;
const work = path.resolve(process.argv[2]);
const source = path.join(work, 'alfa.mp4').replaceAll('\\', '/');
const output = path.join(work, 'measure.mp4').replaceAll('\\', '/');

const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'profile2')}`], { stdio: 'ignore' });

let target;
for (let i = 0; i < 100 && !target; i++) {
  try {
    target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page');
  } catch { /* starting */ }
  await new Promise((r) => setTimeout(r, 200));
}
const socket = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((r) => { socket.onopen = r; });
let id = 1;
const waiting = new Map();
socket.onmessage = (m) => {
  const d = JSON.parse(m.data);
  waiting.get(d.id)?.(d);
};
const ev = (expression) => new Promise((resolve) => {
  const n = id++;
  waiting.set(n, (d) => resolve(d.result?.result?.value ?? JSON.stringify(d).slice(0, 900)));
  socket.send(JSON.stringify({ id: n, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
});
for (let i = 0; i < 100; i++) {
  await new Promise((r) => setTimeout(r, 200));
  if ((await ev(`typeof __kulor`)) === 'object') break;
}

const result = await ev(`(async () => {
  const api = window.kulor, FRAMES = 90, W = 1920, H = 1080, ms = {};
  const time = async (name, fn) => { const t = performance.now(); for (let i = 0; i < FRAMES; i++) await fn(i); ms[name] = +((performance.now() - t) / FRAMES).toFixed(1); };

  const d1 = await api.decoderOpen({ path: ${JSON.stringify(source)}, still: false, seekSec: 0, width: W, height: H, fps: 30, colorMatrix: 'bt709' });
  let frame = null;
  await time('decode+ipc', async () => { frame = (await api.decoderRead(d1)) ?? frame; });
  await api.decoderClose(d1);

  const c = __kulor.player().compositor;
  const pixels = new Uint8Array(W * H * 1.5);
  await time('upload', () => c.uploadYuv420('m', frame, W, H));
  await time('draw', () => { c.begin(); c.drawImage('m', W, H, { grade: null, x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 }, 'bt709'); });
  await time('readNv12', () => c.readNv12(pixels));

  const p = __kulor.store.getState().project;
  await api.exportBegin(p, { outputPath: ${JSON.stringify(output)}, format: 'h264', width: W, height: H, quality: 1, from: 0, to: FRAMES });
  await time('encode+ipc', () => api.exportFrame(pixels));
  await api.exportFinish();
  return ms;
})()`);
console.log(result);
socket.close();
app.kill();
process.exit(0);
