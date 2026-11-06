// End-to-end test: drives the built app in real Electron over the DevTools protocol, with real mouse
// and keyboard events where it matters. Run with: npm run build && node test/e2e.mjs [workdir]
//
// It generates its own media, so it needs nothing but ffmpeg on PATH.

import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import electronPath from 'electron';

const PORT = 9333;
const work = path.resolve(process.argv[2] ?? fs.mkdtempSync(path.join(os.tmpdir(), 'kulor-e2e-')));
fs.mkdirSync(work, { recursive: true });

let failures = 0;
function check(name, ok, detail = '') {
  console.log(`${ok ? '  ok  ' : ' FAIL '} ${name}${detail ? `  (${detail})` : ''}`);
  if (!ok) failures++;
}

function ffmpeg(...args) {
  const r = spawnSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-y', ...args], { encoding: 'utf8' });
  if (r.status !== 0) throw new Error(r.stderr);
}

function probe(file, entries) {
  const r = spawnSync('ffprobe', ['-v', 'error', '-count_frames', '-show_entries', entries, '-of', 'json', file], { encoding: 'utf8' });
  return JSON.parse(r.stdout);
}

function makeMedia() {
  const a = path.join(work, 'alfa.mp4');
  const b = path.join(work, 'beta.mkv');
  const still = path.join(work, 'bild.png');
  const music = path.join(work, 'musik.mp3');
  if (!fs.existsSync(a)) {
    ffmpeg('-f', 'lavfi', '-i', 'testsrc2=s=1920x1080:r=30:d=6', '-f', 'lavfi', '-i', 'sine=f=440:r=48000:d=6',
      '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p', '-g', '30', '-colorspace', 'bt709', '-color_primaries', 'bt709',
      '-color_trc', 'bt709', '-c:a', 'aac', a);
    ffmpeg('-f', 'lavfi', '-i', 'smptebars=s=1280x720:r=30:d=4', '-f', 'lavfi', '-i', 'sine=f=880:r=48000:d=4',
      '-c:v', 'libx265', '-preset', 'ultrafast', '-pix_fmt', 'yuv420p', '-x265-params', 'log-level=error', '-c:a', 'aac', b);
    ffmpeg('-f', 'lavfi', '-i', 'gradients=s=800x600:d=1', '-frames:v', '1', still);
    ffmpeg('-f', 'lavfi', '-i', 'sine=f=220:r=44100:d=8', '-c:a', 'libmp3lame', music);
  }
  return { a, b, still, music };
}

async function cdpConnect() {
  let target;
  for (let i = 0; i < 100 && !target; i++) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
      target = list.find((t) => t.type === 'page' && t.url.includes('index.html'));
    } catch {
      /* not up yet */
    }
    if (!target) await new Promise((r) => setTimeout(r, 200));
  }
  if (!target) throw new Error('Appen svarade aldrig på DevTools-porten.');

  const socket = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    socket.onopen = resolve;
    socket.onerror = reject;
  });
  let nextId = 1;
  const waiting = new Map();
  const logs = [];
  socket.onmessage = (m) => {
    const data = JSON.parse(m.data);
    if (data.id) {
      waiting.get(data.id)?.(data);
      waiting.delete(data.id);
    } else if (data.method === 'Runtime.exceptionThrown') {
      logs.push(data.params.exceptionDetails.exception?.description ?? data.params.exceptionDetails.text);
    } else if (data.method === 'Runtime.consoleAPICalled' && data.params.type === 'error') {
      logs.push(data.params.args.map((a) => a.value ?? a.description).join(' '));
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = nextId++;
      waiting.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });
  await send('Runtime.enable');
  await send('Page.enable');
  return { send, logs, close: () => socket.close() };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const media = makeMedia();
  const app = spawn(electronPath, ['.', `--remote-debugging-port=${PORT}`, `--user-data-dir=${path.join(work, 'profile')}`], {
    cwd: process.cwd(),
    stdio: 'ignore',
  });

  const { send, logs, close } = await cdpConnect();

  const ev = async (expression) => {
    const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.result?.exceptionDetails) throw new Error(r.result.exceptionDetails.exception?.description ?? JSON.stringify(r.result.exceptionDetails));
    return r.result?.result?.value;
  };
  const state = (expr) => ev(`(() => { const s = __kulor.store.getState(); const p = s.project; return ${expr}; })()`);
  const shot = async (name) => {
    const r = await send('Page.captureScreenshot', { format: 'png' });
    fs.writeFileSync(path.join(work, `${name}.png`), Buffer.from(r.result.data, 'base64'));
  };
  const until = async (test, ms = 20000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if (await ev(test)) return true;
      await sleep(150);
    }
    return false;
  };
  const page = async (label) => {
    await ev(`[...document.querySelectorAll('.pagebar button')].find(b => b.textContent === '${label}').click()`);
    await sleep(350);
  };
  const rect = (selector) => ev(`(() => { const b = document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width, h: b.height }; })()`);
  const mouse = (type, x, y, buttons = 1) =>
    send('Input.dispatchMouseEvent', { type, x, y, button: type === 'mouseMoved' && !buttons ? 'none' : 'left', buttons, clickCount: 1 });
  const dragFrom = async (x0, y0, x1, y1) => {
    await mouse('mouseMoved', x0, y0, 0);
    await mouse('mousePressed', x0, y0);
    for (let i = 1; i <= 6; i++) await mouse('mouseMoved', x0 + ((x1 - x0) * i) / 6, y0 + ((y1 - y0) * i) / 6);
    await mouse('mouseReleased', x1, y1, 0);
    await sleep(120);
  };
  const key = async (k, code, modifiers = 0) => {
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: k, code, modifiers, windowsVirtualKeyCode: k === 'Backspace' ? 8 : k.length === 1 ? k.toUpperCase().charCodeAt(0) : undefined });
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: k, code, modifiers });
    await sleep(80);
  };

  // CDP connects as soon as the page exists, which is before its module has run.
  if (!(await until(`typeof __kulor !== 'undefined'`, 15000))) {
    await shot('0-startup-failed');
    throw new Error(`Appen startade aldrig: ${logs.join(' | ')}`);
  }

  console.log('\nImport');
  await ev(`__kulor.actions.importPaths(${JSON.stringify([media.a, media.b, media.still, media.music])})`);
  check('fyra filer importerade', (await state('p.media.length')) === 4);
  check('projektet tar format från första klippet', (await state('`${p.width}x${p.height}@${p.fps}`')) === '1920x1080@30');
  check('HEVC i MKV flaggas för proxy', await state(`p.media.find(m => m.name === 'beta.mkv').needsProxy`));
  check('H.264 i MP4 behöver ingen proxy', !(await state(`p.media.find(m => m.name === 'alfa.mp4').needsProxy`)));
  check('PNG tolkas som bild', (await state(`p.media.find(m => m.name === 'bild.png').kind`)) === 'image');
  check('miniatyrer skapas', await until(`__kulor.store.getState().project.media.filter(m => m.kind !== 'audio').every(m => m.thumb)`));
  check('proxy blir klar', await until(`__kulor.store.getState().project.media.find(m => m.name === 'beta.mkv').proxyState === 'ready'`, 40000));
  await shot('1-media');

  console.log('\nTidslinje');
  await page('Klipp');
  const place = (name) => `__kulor.actions.placeOnTimeline(__kulor.store.getState().project.media.find(m => m.name === '${name}'))`;
  await ev(place('alfa.mp4'));
  await ev(place('beta.mkv'));
  await ev(place('bild.png'));
  await sleep(300);
  const placed = await state(`p.clips.map(c => [c.name, c.start, c.duration])`);
  check('klipp ligger efter varandra', placed.some((c) => c[0] === 'beta.mkv' && c[1] === 180) && placed.some((c) => c[0] === 'bild.png' && c[1] === 300), JSON.stringify(placed));

  await ev(`__kulor.store.getState().setZoom(2)`);
  await sleep(200);

  // Room behind beta, so that the drag below is not refused as a collision.
  await ev(`(() => { const s = __kulor.store.getState(); const id = s.project.clips.find(c => c.name === 'bild.png').id;
    s.commit(p => ({ ...p, clips: p.clips.map(c => c.id === id ? { ...c, start: 400 } : c) })); })()`);

  // A real drag of the beta clip along its track, 40 px at 2 px per frame.
  const betaId = await state(`p.clips.find(c => c.name === 'beta.mkv' && p.tracks.find(t => t.id === c.trackId).kind === 'video').id`);
  await ev(`__kulor.store.getState().toggleSnapping()`); // off: this drag must land exactly where the mouse goes
  const bb = await rect(`[data-clip="${betaId}"]`);
  await dragFrom(bb.x + 100, bb.y + 20, bb.x + 140, bb.y + 20);
  check('dra klipp med musen', (await state(`p.clips.find(c => c.id === '${betaId}').start`)) === 200, `start=${await state(`p.clips.find(c => c.id === '${betaId}').start`)}`);
  check('länkat ljud följer med', (await state(`p.clips.find(c => c.name === 'beta.mkv' && c.id !== '${betaId}').start`)) === 200);

  await key('z', 'KeyZ', 2);
  check('Ctrl+Z ångrar', (await state(`p.clips.find(c => c.id === '${betaId}').start`)) === 180);
  await key('y', 'KeyY', 2);
  check('Ctrl+Y gör om', (await state(`p.clips.find(c => c.id === '${betaId}').start`)) === 200);
  await key('z', 'KeyZ', 2);

  // Trim the end of alfa with its real handle.
  const alfaId = await state(`p.clips.find(c => c.name === 'alfa.mp4' && p.tracks.find(t => t.id === c.trackId).kind === 'video').id`);
  const ab = await rect(`[data-clip="${alfaId}"]`);
  await dragFrom(ab.x + ab.w - 2, ab.y + 20, ab.x + ab.w - 42, ab.y + 20);
  check('trimma slutet med handtaget', (await state(`p.clips.find(c => c.id === '${alfaId}').duration`)) === 160, `dur=${await state(`p.clips.find(c => c.id === '${alfaId}').duration`)}`);
  await key('z', 'KeyZ', 2);

  await ev(`__kulor.player().seek(90)`);
  await ev(`__kulor.store.getState().setSelection(['${alfaId}'])`);
  await key('b', 'KeyB', 2);
  check('Ctrl+B delar klipp och länkat ljud', (await state(`p.clips.filter(c => c.name === 'alfa.mp4').length`)) === 4);
  await sleep(600);
  await shot('2-edit');

  console.log('\nFörhandsvisning');
  const canvasStats = `(() => {
    const c = __kulor.player().compositor; const n = 320 * 180 * 4; const px = new Uint8Array(n); c.readScope(px);
    let sum = 0; for (let i = 0; i < n; i += 4) sum += px[i] + px[i + 1] + px[i + 2];
    return Math.round(sum / (n / 4) / 3);
  })()`;
  check('video syns i förhandsvisningen', await until(`${canvasStats} > 20`), `medel ${await ev(canvasStats)}`);

  // Playback: the playhead must run in real time and the picture must change.
  await ev(`__kulor.player().seek(0)`);
  await sleep(500);
  const before = await state('s.playhead');
  await key(' ', 'Space');
  await sleep(2000);
  const during = await state('s.playhead');
  const playing = await state('s.playing');
  await key(' ', 'Space');
  check('uppspelning går i realtid', playing && during - before > 50 && during - before < 70, `${during - before} bilder på 2 s`);
  const decoded = await ev(`(() => { const v = document.createElement('video'); return v.canPlayType('video/mp4; codecs="avc1.640028"'); })()`);
  check('Chromium avkodar H.264', decoded !== '', decoded);

  // Across a cut: from alfa into the proxied beta clip.
  await ev(`__kulor.player().seek(170)`);
  await sleep(400);
  await key(' ', 'Space');
  await sleep(1200);
  await key(' ', 'Space');
  await sleep(500);
  check('uppspelning över klipp till proxy', (await ev(canvasStats)) > 30 && (await state('s.playhead')) > 190, `spelhuvud ${await state('s.playhead')}, medel ${await ev(canvasStats)}`);
  await shot('3-proxy-preview');

  console.log('\nFärg');
  await page('Färg');
  await ev(`__kulor.store.getState().setSelection([]); __kulor.player().seek(60)`);
  await until(`${canvasStats} > 20`);
  await sleep(500);
  const beforeGrade = await ev(canvasStats);
  const grade = `(() => {
    const s = __kulor.store.getState();
    const id = s.project.clips.find(c => c.start === 0 && s.project.tracks.find(t => t.id === c.trackId).kind === 'video').id;
    s.commit(p => ({ ...p, clips: p.clips.map(c => {
      if (c.id !== id) return c;
      const n = structuredClone(c.grade.nodes[0]);
      n.gain = { r: 0.25, g: -0.1, b: -0.35, m: 0 };
      n.lift = { r: 0, g: 0, b: 0.05, m: 0 };
      n.gamma = { r: 0, g: 0, b: 0, m: 0.2 };
      n.saturation = 1.3;
      n.curves.m = [{ x: 0, y: 0.03 }, { x: 0.5, y: 0.6 }, { x: 1, y: 0.97 }];
      return { ...c, grade: { ...c.grade, nodes: [n] } };
    })}));
  })()`;
  await ev(grade);
  await sleep(500);
  const afterGrade = await ev(canvasStats);
  check('gradering ändrar bilden', Math.abs(afterGrade - beforeGrade) > 5, `${beforeGrade} -> ${afterGrade}`);
  await shot('4-color');

  // A real drag on the Gain wheel.
  const wheels = await ev(`[...document.querySelectorAll('.wheel canvas')].map(c => { const b = c.getBoundingClientRect(); return { x: b.x, y: b.y, w: b.width }; })`);
  const gainWheel = wheels[2];
  await dragFrom(gainWheel.x + gainWheel.w / 2, gainWheel.y + gainWheel.w / 2, gainWheel.x + 30, gainWheel.y + 30);
  const dragged = await state(`p.clips.find(c => c.start === 0 && p.tracks.find(t => t.id === c.trackId).kind === 'video').grade.nodes[0].gain`);
  check('dra i Gain-hjulet ändrar färgen', dragged.r !== 0.25 || dragged.b !== -0.35, JSON.stringify(dragged));
  const steps = await state('s.undoStack.length');
  await key('z', 'KeyZ', 2);
  check('hela hjuldraget är ett enda ångra-steg', (await state('s.undoStack.length')) === steps - 1 && (await state(`p.clips.find(c => c.start === 0 && p.tracks.find(t => t.id === c.trackId).kind === 'video').grade.nodes[0].gain.r`)) === 0.25);

  for (const label of ['RGB-parad', 'Vektorskop', 'Histogram']) {
    await ev(`[...document.querySelectorAll('.scope-tabs button')].find(b => b.textContent === '${label}').click()`);
    await sleep(250);
    const painted = await ev(`(() => { const c = document.querySelector('.scopes canvas'); const d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let lit = 0; for (let i = 0; i < d.length; i += 4) if (d[i] + d[i+1] + d[i+2] > 90) lit++; return lit; })()`);
    check(`${label} ritar något`, painted > 100, `${painted} tända pixlar`);
    if (label === 'Vektorskop') await shot('5-vectorscope');
  }
  await ev(`[...document.querySelectorAll('.tool-tabs button')].find(b => b.textContent === 'Kurvor').click()`);
  await sleep(200);
  await shot('6-curves');
  await ev(`[...document.querySelectorAll('.tool-tabs button')].find(b => b.textContent === 'Sekundär').click()`);
  await sleep(200);
  await shot('7-secondary');

  console.log('\nLjud');
  await page('Ljud');
  await ev(`__kulor.player().seek(0)`);
  await sleep(300);
  await key(' ', 'Space');
  await sleep(1200);
  const level = await ev(`__kulor.player().level()`);
  await shot('8-audio');
  await key(' ', 'Space');
  check('ljud når master', level > 0.01, `topp ${level.toFixed(3)}`);

  console.log('\nExport, och att den matchar förhandsvisningen');
  await page('Leverera');
  const out = path.join(work, 'export.mp4');
  fs.rmSync(out, { force: true });
  const started = Date.now();
  const result = await ev(`(async () => {
    const s = __kulor.store.getState();
    const p = s.project;
    const end = Math.max(...p.clips.map(c => c.start + c.duration));
    return __kulor.renderProject(p, { outputPath: ${JSON.stringify(out)}, format: 'h264', width: p.width, height: p.height, quality: 1, from: 0, to: end }, () => {}, new AbortController().signal);
  })()`);
  const seconds = (Date.now() - started) / 1000;
  const totalFrames = await state('Math.max(...p.clips.map(c => c.start + c.duration))');
  check('export ger en fil', !!result?.bytes, JSON.stringify(result));
  console.log(`       ${totalFrames} bilder på ${seconds.toFixed(1)} s = ${(totalFrames / seconds).toFixed(1)} fps`);

  const info = probe(out, 'stream=codec_type,codec_name,width,height,nb_read_frames,pix_fmt,color_space:format=duration');
  const video = info.streams.find((s) => s.codec_type === 'video');
  const audio = info.streams.find((s) => s.codec_type === 'audio');
  check('rätt antal bilder', Number(video.nb_read_frames) === totalFrames, `${video.nb_read_frames}`);
  check('video är H.264 1080p BT.709', video.codec_name === 'h264' && video.height === 1080 && video.color_space === 'bt709', JSON.stringify(video));
  check('ljud finns', !!audio);
  check('längden stämmer', Math.abs(Number(info.format.duration) - totalFrames / 30) < 0.1, info.format.duration);

  // Same frame through both paths. The preview is read from the compositor at frame 60.
  await ev(`__kulor.player().seek(60)`);
  await sleep(900);
  const previewPng = await ev(`(async () => {
    const c = __kulor.player().compositor;
    const w = c.width, h = c.height, px = new Uint8Array(w * h * 4);
    c.readPixels(px);
    const canvas = new OffscreenCanvas(w, h);
    canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
    const blob = await canvas.convertToBlob({ type: 'image/png' });
    const b = new Uint8Array(await blob.arrayBuffer());
    let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
    return btoa(s);
  })()`);
  const previewFile = path.join(work, 'preview-60.png');
  fs.writeFileSync(previewFile, Buffer.from(previewPng, 'base64'));
  const exportFile = path.join(work, 'export-60.png');
  ffmpeg('-i', out, '-vf', 'select=eq(n\\,60),scale=in_color_matrix=bt709:in_range=tv,format=rgb24', '-frames:v', '1', exportFile);
  const psnr = spawnSync('ffmpeg', ['-hide_banner', '-i', exportFile, '-i', previewFile, '-lavfi', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
  const match = /average:([\d.]+|inf)/.exec(psnr.stderr);
  const db = match?.[1] === 'inf' ? 99 : Number(match?.[1]);
  check('export matchar förhandsvisningen', db > 30, `PSNR ${db} dB`);

  console.log('\nAnimation, övergångar och fler format');
  // Keyframed scale and position on the first clip, a dissolve into beta, a fade on the last clip.
  await ev(`(() => {
    const s = __kulor.store.getState();
    const vid = (name) => s.project.clips.filter(c => c.name === name && s.project.tracks.find(t => t.id === c.trackId).kind === 'video').sort((a, b) => a.start - b.start);
    const [a1, a2] = vid('alfa.mp4');
    const [beta] = vid('beta.mkv');
    const [bild] = vid('bild.png');
    s.commit(p => ({ ...p, clips: p.clips.map(c => {
      if (c.id === a1.id) return { ...c, keyframes: { scale: [{ frame: 0, value: 1 }, { frame: 80, value: 0.5 }], x: [{ frame: 0, value: 0 }, { frame: 80, value: 0.2 }] } };
      if (c.id === a2.id) return { ...c, transform: { ...c.transform, opacity: 0.8, rotation: 12 } };
      if (c.id === beta.id) return { ...c, dissolveIn: 29 };
      if (c.id === bild.id) return { ...c, fadeIn: 30 };
      return c;
    })}));
  })()`);

  const previewFrame = async (frame, file) => {
    await ev(`__kulor.player().seek(${frame})`);
    await sleep(1100);
    const data = await ev(`(async () => {
      const c = __kulor.player().compositor;
      const w = c.width, h = c.height, px = new Uint8Array(w * h * 4);
      c.readPixels(px);
      const canvas = new OffscreenCanvas(w, h);
      canvas.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(px), w, h), 0, 0);
      const b = new Uint8Array(await (await canvas.convertToBlob({ type: 'image/png' })).arrayBuffer());
      let s = ''; for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768));
      return btoa(s);
    })()`);
    fs.writeFileSync(file, Buffer.from(data, 'base64'));
  };
  const compare = (videoFile, n, png, matrix = 'bt709') => {
    const extracted = path.join(work, 'cmp.png');
    ffmpeg('-i', videoFile, '-vf', `select=eq(n\\,${n}),scale=in_color_matrix=${matrix}:in_range=tv,format=rgb24`, '-frames:v', '1', extracted);
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', extracted, '-i', png, '-lavfi', '[0:v]format=rgb24[a];[1:v]format=rgb24[b];[a][b]psnr', '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /average:([\d.]+|inf)/.exec(r.stderr);
    return m?.[1] === 'inf' ? 99 : Number(m?.[1]);
  };
  const renderTo = (file, format, from, to) => ev(`__kulor.renderProject(__kulor.store.getState().project,
    { outputPath: ${JSON.stringify(file)}, format: '${format}', width: 1920, height: 1080, quality: 2, from: ${from}, to: ${to} }, () => {}, new AbortController().signal)`);

  const animated = path.join(work, 'animerad.mp4');
  const rangeFrom = 30;
  await renderTo(animated, 'h264', rangeFrom, 240);
  const rangeInfo = probe(animated, 'stream=codec_type,nb_read_frames:format=duration');
  check('intervall ger rätt längd', Number(rangeInfo.streams.find((s) => s.codec_type === 'video').nb_read_frames) === 210, rangeInfo.format.duration);

  const samples = [[60, 'nyckelbild'], [120, 'rotation + opacitet'], [195, 'korstoning']];
  for (const [frame, label] of samples) {
    const png = path.join(work, `preview-${frame}.png`);
    await previewFrame(frame, png);
    const db = compare(animated, frame - rangeFrom, png);
    check(`export matchar: ${label}`, db > 26, `bild ${frame}, PSNR ${db.toFixed(1)} dB`);
  }

  const midPng = path.join(work, 'preview-120.png');
  for (const [format, file, codec, pix] of [
    ['hevc', 'x.mp4', 'hevc', 'yuv420p'],
    ['prores', 'x-prores.mov', 'prores', 'yuv422p10le'],
    ['dnxhr', 'x-dnxhr.mov', 'dnxh', 'yuv422p'],
  ]) {
    const target = path.join(work, file);
    await renderTo(target, format, 110, 130);
    const s = probe(target, 'stream=codec_type,codec_name,pix_fmt,nb_read_frames').streams;
    const v = s.find((x) => x.codec_type === 'video');
    check(`${format}: rätt kodek och pixelformat`, v.codec_name.startsWith(codec) && v.pix_fmt === pix && Number(v.nb_read_frames) === 20, `${v.codec_name} ${v.pix_fmt} ${v.nb_read_frames}`);
    const db = compare(target, 10, midPng);
    check(`${format}: matchar förhandsvisningen`, db > 26, `PSNR ${db.toFixed(1)} dB`);
    check(`${format}: har ljud`, s.some((x) => x.codec_type === 'audio'));
  }

  // Cancelling part way must leave nothing behind and the app ready for the next export.
  const cancelled = path.join(work, 'avbruten.mp4');
  const outcome = await ev(`(async () => {
    const c = new AbortController();
    setTimeout(() => c.abort(), 900);
    try {
      await __kulor.renderProject(__kulor.store.getState().project,
        { outputPath: ${JSON.stringify(cancelled)}, format: 'h264', width: 1920, height: 1080, quality: 2, from: 0, to: 300 }, () => {}, c.signal);
      return 'klar';
    } catch (e) { return e.name; }
  })()`);
  const leftovers = fs.readdirSync(work).filter((f) => f.startsWith('avbruten'));
  check('avbruten export lämnar inga filer', outcome.startsWith('ExportCancelled') && leftovers.length === 0, `${outcome} ${leftovers}`);
  await renderTo(path.join(work, 'efter.mp4'), 'h264', 0, 15);
  check('export går att köra igen efter avbrott', fs.existsSync(path.join(work, 'efter.mp4')));

  // A file dropped outside the pool must not navigate the page away.
  const urlBefore = await ev('location.href');
  await ev(`(() => {
    const data = new DataTransfer();
    data.items.add(new File(['x'], 'x.txt'));
    for (const type of ['dragover', 'drop']) document.querySelector('.topbar').dispatchEvent(new DragEvent(type, { bubbles: true, cancelable: true, dataTransfer: data }));
  })()`);
  await sleep(300);
  check('fil släppt utanför biblioteket navigerar inte bort', (await ev('location.href')) === urlBefore && (await state('p.clips.length')) > 0);

  console.log('\nTitlar');
  await page('Klipp');
  await ev(`__kulor.store.getState().setSelection([])`);
  await ev(`__kulor.player().seek(60)`);
  await sleep(600);
  const clipsBefore = await state('p.clips.length');
  await ev(`[...document.querySelectorAll('.timeline-tools button')].find(b => b.textContent === '+ Titel').click()`);
  await sleep(300);
  check('+ Titel lägger till ett klipp', (await state('p.clips.length')) === clipsBefore + 1);
  const titleId = await state(`p.clips.find(c => c.title).id`);
  check('titeln väljs och hamnar över videon', (await state(`s.selection[0]`)) === titleId && (await state(`p.tracks.find(t => t.id === p.clips.find(c => c.id === '${titleId}').trackId).name`)) === 'V2');

  // Real typing into the text box.
  await ev(`(() => { const t = document.querySelector('.title-text'); t.focus(); t.select(); })()`);
  await send('Input.insertText', { text: 'Hej Kulör' });
  await sleep(250);
  check('skriva text uppdaterar titeln och klippnamnet', (await state(`p.clips.find(c => c.id === '${titleId}').title.text`)) === 'Hej Kulör' && (await state(`p.clips.find(c => c.id === '${titleId}').name`)) === 'Hej Kulör');
  await key('Backspace', 'Backspace');
  check('radera i textrutan tar inte bort klippet', (await state(`p.clips.some(c => c.id === '${titleId}')`)) && (await state(`p.clips.find(c => c.id === '${titleId}').title.text`)) === 'Hej Kulö');
  await send('Input.insertText', { text: 'r' });
  await ev(`document.activeElement.blur()`);
  await sleep(500);
  await shot('9-titel');

  const titled = path.join(work, 'preview-titel.png');
  await previewFrame(60, titled);
  const cropped = (a, b, filter) => {
    const r = spawnSync('ffmpeg', ['-hide_banner', '-i', a, '-i', b, '-lavfi', `[0:v]${filter},format=rgb24[a];[1:v]${filter},format=rgb24[b];[a][b]psnr`, '-f', 'null', '-'], { encoding: 'utf8' });
    const m = /average:([\d.]+|inf)/.exec(r.stderr);
    return m?.[1] === 'inf' ? 99 : Number(m?.[1]);
  };
  const noTitle = path.join(work, 'preview-60.png');
  check('texten syns mitt i bilden', cropped(titled, noTitle, 'crop=800:200:560:440') < 30);
  check('bilden syns genom titeln utanför texten', cropped(titled, noTitle, 'crop=300:200:0:0') > 40);

  // Drag the text with the mouse in the picture.
  const stage = await rect('.viewer-canvas');
  const beforeX = await state(`p.clips.find(c => c.id === '${titleId}').title.posX`);
  await dragFrom(stage.x + stage.w / 2, stage.y + stage.h / 2, stage.x + stage.w / 2 + 60, stage.y + stage.h / 2 + 30);
  const moved = await state(`p.clips.find(c => c.id === '${titleId}').title`);
  check('dra titeln i bilden', moved.posX > beforeX + 0.02 && moved.posY > 0.51, `x=${moved.posX.toFixed(3)} y=${moved.posY.toFixed(3)}`);
  await key('z', 'KeyZ', 2);
  check('hela draget är ett ångra-steg', (await state(`p.clips.find(c => c.id === '${titleId}').title.posX`)) === beforeX);

  // A preset with outline and background, added by double click in the panel.
  await ev(`[...document.querySelectorAll('.pool-tabs button')].find(b => b.textContent === 'Titlar').click()`);
  await sleep(250);
  await ev(`__kulor.player().seek(250)`);
  await sleep(300);
  await ev(`document.querySelector('[data-preset="lower-third"]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))`);
  await sleep(300);
  check('förval med dubbelklick', (await state(`p.clips.some(c => c.title?.backgroundEnabled)`)));

  // Export: same picture as the preview, at full size and at half size.
  const titlePng = path.join(work, 'preview-titel-120.png');
  await ev(`__kulor.store.getState().setSelection([])`);
  await previewFrame(120, titlePng);
  const titleOut = path.join(work, 'titel.mp4');
  await renderTo(titleOut, 'h264', 110, 130);
  const fullDb = compare(titleOut, 10, titlePng);
  check('export matchar förhandsvisningen med titel', fullDb > 30, `PSNR ${fullDb.toFixed(1)} dB`);

  const halfOut = path.join(work, 'titel-halv.mp4');
  await ev(`__kulor.renderProject(__kulor.store.getState().project,
    { outputPath: ${JSON.stringify(halfOut)}, format: 'h264', width: 960, height: 540, quality: 1, from: 118, to: 122 }, () => {}, new AbortController().signal)`);
  const scaledPng = path.join(work, 'preview-titel-halv.png');
  ffmpeg('-i', titlePng, '-vf', 'scale=960:540:flags=area', scaledPng);
  const halfDb = compare(halfOut, 2, scaledPng);
  check('titeln hamnar rätt vid halv upplösning', halfDb > 28, `PSNR ${halfDb.toFixed(1)} dB`);

  console.log('\nÖvrigt');
  const projectFile = path.join(work, 'test.kulor');
  const saved = await ev(`(async () => { const s = __kulor.store.getState(); return window.kulor.saveProject(s.project, ${JSON.stringify(projectFile)}); })()`);
  check('projekt sparas', saved === projectFile && fs.existsSync(projectFile));
  const loaded = await ev(`window.kulor.loadProject(${JSON.stringify(projectFile)}).then(r => r.project.clips.length)`);
  check('projekt läses tillbaka', loaded === (await state('p.clips.length')));
  check('titlar sparas i projektet', await ev(`window.kulor.loadProject(${JSON.stringify(projectFile)}).then(r => r.project.clips.some(c => c.title?.text === 'Hej Kulör'))`));

  check('inga fel i konsolen', logs.length === 0, logs.slice(0, 5).join(' | ').slice(0, 600));

  close();
  app.kill();
  console.log(failures === 0 ? '\nAllt gick igenom.' : `\n${failures} kontroll(er) misslyckades.`);
  console.log(`Filer: ${work}`);
  process.exit(failures ? 1 : 0);
}

main().catch((e) => {
  console.error(e);
  process.exit(2);
});
