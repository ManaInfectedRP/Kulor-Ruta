import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type { Project } from '../src/core/types';
import { usesNv12, type DecoderRequest, type EncoderChoice, type ExportSettings } from '../src/core/ipc';
import { buildAudioMix } from '../src/core/audioMix';
import { newId } from '../src/core/id';
import { run } from './ffmpeg';

// ---- decoders: original media to raw RGBA, one process per clip in use --------------------------

class Decoder {
  private readonly child;
  private readonly frameBytes: number;
  private ended = false;
  private waiting: (() => void) | null = null;

  constructor(request: DecoderRequest) {
    // Video stays planar YUV all the way into the shader. Stills are RGB to begin with.
    this.frameBytes = (request.width * request.height * (request.still ? 8 : 3)) / 2;
    const filters = (request.still
      ? [`scale=${request.width}:${request.height}:flags=bicubic`, 'format=rgba']
      : [`fps=${request.fps}`, `scale=${request.width}:${request.height}:flags=bicubic:out_range=tv`, 'format=yuv420p']
    ).join(',');
    const args = ['-hide_banner', '-loglevel', 'error'];
    if (request.seekSec > 0) args.push('-ss', request.seekSec.toFixed(6));
    args.push('-i', request.path, '-map', '0:v:0', '-vf', filters);
    if (request.still) args.push('-frames:v', '1');
    args.push('-f', 'rawvideo', 'pipe:1');

    this.child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    this.child.stdout.on('readable', () => this.wake());
    this.child.stdout.on('end', () => {
      this.ended = true;
      this.wake();
    });
    this.child.on('error', () => {
      this.ended = true;
      this.wake();
    });
  }

  private wake(): void {
    const resume = this.waiting;
    this.waiting = null;
    resume?.();
  }

  /** The next frame, or null at the end of the source. */
  async read(): Promise<Uint8Array | null> {
    for (;;) {
      const chunk = this.child.stdout.read(this.frameBytes) as Buffer | null;
      if (chunk) return new Uint8Array(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      if (this.ended) return null;
      await new Promise<void>((resolve) => {
        this.waiting = resolve;
      });
    }
  }

  close(): void {
    this.child.stdout.destroy();
    this.child.kill();
    this.wake();
  }
}

const decoders = new Map<string, Decoder>();

export function decoderOpen(request: DecoderRequest): string {
  const id = newId();
  decoders.set(id, new Decoder(request));
  return id;
}

export const decoderRead = (id: string): Promise<Uint8Array | null> =>
  decoders.get(id)?.read() ?? Promise.resolve(null);

export function decoderClose(id: string): void {
  decoders.get(id)?.close();
  decoders.delete(id);
}

// ---- encoder: raw RGBA from the compositor plus the audio mix into the final file ---------------

let hardware: Promise<EncoderChoice> | null = null;

async function works(encoder: string): Promise<boolean> {
  const { code } = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'color=black:s=1280x720:r=30:d=0.1',
    '-c:v', encoder, '-f', 'null', '-',
  ]);
  return code === 0;
}

/** The fastest encoder that really runs here: ffmpeg lists NVENC even on machines without NVIDIA. */
export function pickEncoders(): Promise<EncoderChoice> {
  hardware ??= (async () => ({
    h264: (await works('h264_nvenc')) ? 'h264_nvenc' : 'libx264',
    hevc: (await works('hevc_nvenc')) ? 'hevc_nvenc' : 'libx265',
  }))();
  return hardware;
}

const CRF = [18, 21, 26];

const COLOR_TAGS = ['-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv'];

function videoArgs(settings: ExportSettings, encoders: EncoderChoice): string[] {
  const q = String(CRF[Math.min(2, Math.max(0, settings.quality - 1))]);
  const fromRgb = (fmt: string) => ['-vf', `scale=out_color_matrix=bt709:out_range=tv:flags=bicubic,format=${fmt}`];
  switch (settings.format) {
    case 'prores':
      return [...fromRgb('yuv422p10le'), '-c:v', 'prores_ks', '-profile:v', '3', '-vendor', 'apl0'];
    case 'dnxhr':
      return [...fromRgb('yuv422p'), '-c:v', 'dnxhd', '-profile:v', 'dnxhr_hq'];
    case 'hevc':
      return encoders.hevc === 'hevc_nvenc'
        ? ['-c:v', 'hevc_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q, '-b:v', '0', '-tag:v', 'hvc1']
        : ['-c:v', 'libx265', '-preset', 'medium', '-crf', q, '-tag:v', 'hvc1'];
    default:
      return encoders.h264 === 'h264_nvenc'
        ? ['-c:v', 'h264_nvenc', '-preset', 'p5', '-rc', 'vbr', '-cq', q, '-b:v', '0']
        : ['-c:v', 'libx264', '-preset', 'medium', '-crf', q];
  }
}

interface Job {
  child: ChildProcessWithoutNullStreams;
  settings: ExportSettings;
  stderr: string;
  finished: Promise<number>;
  workDir: string;
  /** Written beside the target so a cancelled or failed export never touches an existing file. */
  partial: string;
}

let job: Job | null = null;

export async function exportBegin(project: Project, settings: ExportSettings): Promise<void> {
  if (job) throw new Error('En export pågår redan.');
  const workDir = await fs.mkdtemp(path.join(os.tmpdir(), 'kulor-export-'));
  const mixPath = path.join(workDir, 'mix.wav');
  const seconds = (settings.to - settings.from) / project.fps;

  const mix = buildAudioMix(project, settings.from, settings.to, mixPath);
  if (mix.args) {
    const result = await run('ffmpeg', mix.args);
    if (result.code !== 0) {
      await fs.rm(workDir, { recursive: true, force: true });
      throw new Error(`Ljudmixen misslyckades: ${result.stderr.trim()}`);
    }
  }

  const encoders = await pickEncoders();
  const extension = path.extname(settings.outputPath);
  const partial = `${settings.outputPath.slice(0, -extension.length)}.part${extension}`;
  const intermediate = settings.format === 'prores' || settings.format === 'dnxhr';

  const args = [
    '-hide_banner', '-loglevel', 'error', '-y',
    '-f', 'rawvideo', '-pix_fmt', usesNv12(settings.format) ? 'nv12' : 'rgba',
    '-video_size', `${settings.width}x${settings.height}`, '-framerate', String(project.fps),
    ...(usesNv12(settings.format) ? COLOR_TAGS : []),
    '-i', 'pipe:0',
  ];
  if (mix.args) args.push('-i', mixPath);
  args.push('-map', '0:v');
  if (mix.args) args.push('-map', '1:a');
  args.push(...videoArgs(settings, encoders), ...COLOR_TAGS);
  if (mix.args) args.push('-c:a', intermediate ? 'pcm_s24le' : 'aac', ...(intermediate ? [] : ['-b:a', '256k']));
  args.push('-t', seconds.toFixed(6));
  if (!intermediate) args.push('-movflags', '+faststart');
  args.push(partial);

  const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  const created: Job = {
    child,
    settings,
    stderr: '',
    workDir,
    partial,
    finished: new Promise((resolve) => child.on('close', (code) => resolve(code ?? -1))),
  };
  child.stderr.on('data', (d: Buffer) => {
    created.stderr = (created.stderr + d.toString()).slice(-4096);
  });
  child.stdin.on('error', () => {
    // A broken pipe surfaces through the exit code in exportFinish.
  });
  job = created;
}

export async function exportFrame(rgba: Uint8Array): Promise<void> {
  const current = job;
  if (!current) throw new Error('Ingen export pågår.');
  if (current.child.exitCode !== null) throw new Error(`Encodern stannade: ${current.stderr.trim()}`);
  const room = current.child.stdin.write(rgba);
  if (!room) {
    await new Promise<void>((resolve) => {
      const done = () => {
        current.child.stdin.off('drain', done);
        current.child.off('close', done);
        resolve();
      };
      current.child.stdin.on('drain', done);
      current.child.on('close', done);
    });
  }
}

async function cleanup(current: Job): Promise<void> {
  job = null;
  await fs.rm(current.workDir, { recursive: true, force: true });
}

export async function exportFinish(): Promise<{ path: string; bytes: number }> {
  const current = job;
  if (!current) throw new Error('Ingen export pågår.');
  current.child.stdin.end();
  const code = await current.finished;
  await cleanup(current);
  if (code !== 0) {
    await fs.rm(current.partial, { force: true });
    throw new Error(`Exporten misslyckades: ${current.stderr.trim()}`);
  }
  await fs.rename(current.partial, current.settings.outputPath);
  const stat = await fs.stat(current.settings.outputPath);
  return { path: current.settings.outputPath, bytes: stat.size };
}

export async function exportCancel(): Promise<void> {
  const current = job;
  if (!current) return;
  current.child.kill();
  await current.finished;
  await cleanup(current);
  await fs.rm(current.partial, { force: true });
}
