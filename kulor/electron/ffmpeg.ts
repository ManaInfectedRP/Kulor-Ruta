import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import type { MediaItem, MediaKind } from '../src/core/types';
import { newId } from '../src/core/id';

interface ProbeStream {
  codec_type?: string;
  codec_name?: string;
  width?: number;
  height?: number;
  r_frame_rate?: string;
  avg_frame_rate?: string;
  duration?: string;
  color_space?: string;
  disposition?: { attached_pic?: number };
}

interface ProbeResult {
  streams?: ProbeStream[];
  format?: { duration?: string; format_name?: string; size?: string };
}

const STILL_CODECS = new Set(['png', 'mjpeg', 'bmp', 'webp', 'tiff', 'gif', 'targa']);
const PLAYABLE_VIDEO = new Set(['h264', 'vp8', 'vp9', 'av1']);
const PLAYABLE_AUDIO = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac', 'pcm_s16le', 'pcm_s24le', 'pcm_f32le']);
const PLAYABLE_CONTAINERS = /mp4|mov|webm|ogg|mp3|wav|flac|aac/;

export function run(command: string, args: string[]): Promise<{ code: number; stdout: Buffer; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true });
    const out: Buffer[] = [];
    let stderr = '';
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d: Buffer) => {
      stderr += d.toString();
      if (stderr.length > 16384) stderr = stderr.slice(-8192);
    });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code: code ?? -1, stdout: Buffer.concat(out), stderr }));
  });
}

function parseRate(rate: string | undefined): number {
  if (!rate) return 0;
  const [n, d] = rate.split('/').map(Number);
  return d ? n / d : n || 0;
}

/**
 * Untagged HD material is BT.709 in practice, and this is also what Chromium assumes. ffmpeg
 * would pick BT.601, so export has to be told, or graded colours would differ from the preview.
 */
function colorMatrixFor(tag: string | undefined, height: number): string {
  if (tag === 'bt709') return 'bt709';
  if (tag === 'smpte170m' || tag === 'bt470bg') return 'smpte170m';
  if (tag === 'bt2020nc' || tag === 'bt2020ncl') return 'bt2020';
  return height >= 720 ? 'bt709' : 'smpte170m';
}

export async function probe(filePath: string): Promise<MediaItem> {
  const result = await run('ffprobe', [
    '-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', filePath,
  ]);
  if (result.code !== 0) throw new Error(`Kan inte läsa ${path.basename(filePath)}: ${result.stderr.trim()}`);

  const info = JSON.parse(result.stdout.toString()) as ProbeResult;
  const streams = info.streams ?? [];
  const video = streams.find((s) => s.codec_type === 'video' && !s.disposition?.attached_pic);
  const audio = streams.find((s) => s.codec_type === 'audio');
  if (!video && !audio) throw new Error(`${path.basename(filePath)} innehåller varken bild eller ljud.`);

  const container = info.format?.format_name ?? '';
  const isStill = !!video && STILL_CODECS.has(video.codec_name ?? '') && /image2|_pipe|gif/.test(container);
  const kind: MediaKind = !video ? 'audio' : isStill ? 'image' : 'video';
  const durationSec = Number(info.format?.duration ?? video?.duration ?? audio?.duration ?? 0) || 0;
  const height = video?.height ?? 0;

  const needsProxy =
    kind !== 'image' &&
    (!PLAYABLE_CONTAINERS.test(container) ||
      (!!video && kind === 'video' && !PLAYABLE_VIDEO.has(video.codec_name ?? '')) ||
      (!!audio && !PLAYABLE_AUDIO.has(audio.codec_name ?? '')));

  return {
    id: newId(),
    path: filePath,
    name: path.basename(filePath),
    kind,
    durationSec,
    width: video?.width ?? 0,
    height,
    fps: parseRate(video?.avg_frame_rate) || parseRate(video?.r_frame_rate),
    hasAudio: !!audio,
    videoCodec: video?.codec_name ?? '',
    audioCodec: audio?.codec_name ?? '',
    container,
    sizeBytes: Number(info.format?.size ?? 0),
    colorMatrix: colorMatrixFor(video?.color_space, height),
    needsProxy,
    proxyState: 'none',
  };
}

export async function cacheKey(filePath: string): Promise<string> {
  const stat = await fs.stat(filePath);
  return createHash('sha1').update(`${filePath}|${stat.size}|${stat.mtimeMs}`).digest('hex').slice(0, 20);
}

async function exists(p: string): Promise<boolean> {
  return fs.access(p).then(() => true, () => false);
}

export async function makeThumbnail(media: MediaItem, cacheDir: string): Promise<string | undefined> {
  if (media.kind === 'audio') return undefined;
  const out = path.join(cacheDir, `${await cacheKey(media.path)}.jpg`);
  if (await exists(out)) return out;
  const seek = media.kind === 'video' ? Math.min(1, media.durationSec / 3) : 0;
  const result = await run('ffmpeg', [
    '-hide_banner', '-loglevel', 'error', '-y', '-ss', String(seek), '-i', media.path,
    '-frames:v', '1', '-vf', 'scale=320:-2', '-q:v', '4', out,
  ]);
  return result.code === 0 ? out : undefined;
}

const PEAKS_PER_SECOND = 100;

/** Min/max style waveform: one absolute peak per 10 ms, as little endian floats on disk. */
export async function waveform(media: MediaItem, cacheDir: string): Promise<Float32Array | null> {
  if (media.kind === 'image' || !media.hasAudio) return null;
  const out = path.join(cacheDir, `${await cacheKey(media.path)}.peaks`);
  if (await exists(out)) {
    const data = await fs.readFile(out);
    return new Float32Array(data.buffer, data.byteOffset, data.byteLength >> 2).slice();
  }

  const sampleRate = 8000;
  const samplesPerPeak = sampleRate / PEAKS_PER_SECOND;
  const peaks: number[] = [];
  let peak = 0;
  let inBucket = 0;
  let carry: Buffer = Buffer.alloc(0);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', [
      '-hide_banner', '-loglevel', 'error', '-i', media.path, '-map', 'a:0', '-ac', '1', '-ar', String(sampleRate),
      '-f', 's16le', 'pipe:1',
    ], { windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] });
    child.stdout.on('data', (chunk: Buffer) => {
      const data = carry.length ? Buffer.concat([carry, chunk]) : chunk;
      const whole = data.length & ~1;
      for (let i = 0; i < whole; i += 2) {
        peak = Math.max(peak, Math.abs(data.readInt16LE(i)));
        if (++inBucket === samplesPerPeak) {
          peaks.push(peak / 32768);
          peak = 0;
          inBucket = 0;
        }
      }
      carry = data.subarray(whole);
    });
    child.on('error', reject);
    child.on('close', () => resolve());
  });

  const result = Float32Array.from(peaks);
  await fs.writeFile(out, Buffer.from(result.buffer));
  return result;
}

export async function makeProxy(
  media: MediaItem,
  cacheDir: string,
  onProgress: (fraction: number) => void,
): Promise<string> {
  const out = path.join(cacheDir, `${await cacheKey(media.path)}.proxy.mp4`);
  if (await exists(out)) return out;
  const partial = `${out}.part.mp4`;

  // A short keyframe interval is what keeps scrubbing the proxy snappy.
  const args = [
    '-hide_banner', '-loglevel', 'error', '-y', '-progress', 'pipe:1', '-nostats', '-i', media.path,
  ];
  if (media.kind === 'video') {
    args.push('-vf', 'scale=-2:min(720\\,ih),format=yuv420p', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '23', '-g', '15');
  } else {
    args.push('-vn');
  }
  if (media.hasAudio) args.push('-c:a', 'aac', '-b:a', '160k', '-ac', '2');
  args.push('-movflags', '+faststart', partial);

  await new Promise<void>((resolve, reject) => {
    const child = spawn('ffmpeg', args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let errors = '';
    child.stderr.on('data', (d: Buffer) => { errors += d.toString(); });
    child.stdout.on('data', (d: Buffer) => {
      const match = /out_time_us=(\d+)/.exec(d.toString());
      if (match && media.durationSec > 0) onProgress(Math.min(1, Number(match[1]) / 1e6 / media.durationSec));
    });
    child.on('error', reject);
    child.on('close', (code) => (code === 0 ? resolve() : reject(new Error(errors.trim() || `ffmpeg avslutade med ${code}`))));
  });
  await fs.rename(partial, out);
  return out;
}
