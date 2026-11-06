// Export: originals decoded by ffmpeg, composited with the same code as the preview, then encoded.
// Every clip is decoded once in order, which is exact and far quicker than seeking a media element
// for each frame.

import type { Clip, Id, MediaItem, Project } from '../core/types';
import { usesNv12, type ExportSettings } from '../core/ipc';
import { layersAt } from '../core/timeline';
import { Compositor } from './compositor';
import { uploadTitle } from './titles';

interface OpenSource {
  decoder: string;
  width: number;
  height: number;
  still: boolean;
  /** True once a frame is on the texture. */
  shown: boolean;
  /** The frame after the one being drawn, already on its way. */
  next: Promise<Uint8Array | null> | null;
}

export interface RenderProgress {
  frame: number;
  total: number;
  fps: number;
}

export class ExportCancelled extends Error {
  override name = 'ExportCancelled';
}

/** Native size, unless the clip is only ever shown smaller, which saves a lot of pixels per frame. */
function decodeSize(media: MediaItem, clip: Clip, target: ExportSettings) {
  const largestScale = Math.max(clip.transform.scale, ...(clip.keyframes.scale ?? []).map((k) => k.value), 0.01);
  const fit = Math.min(target.width / media.width, target.height / media.height);
  const scale = Math.min(1, Math.max(0.05, fit * largestScale));
  const even = (n: number) => Math.max(2, Math.round(n / 2) * 2);
  return { width: even(media.width * scale), height: even(media.height * scale) };
}

export async function renderProject(
  project: Project,
  settings: ExportSettings,
  onProgress: (p: RenderProgress) => void,
  signal: AbortSignal,
): Promise<{ path: string; bytes: number }> {
  const api = window.kulor;
  const total = settings.to - settings.from;
  const canvas = new OffscreenCanvas(settings.width, settings.height);
  const compositor = new Compositor(canvas, settings.width, settings.height);
  const nv12 = usesNv12(settings.format);
  const pixels = new Uint8Array(settings.width * settings.height * (nv12 ? 1.5 : 4));
  const open = new Map<Id, OpenSource>();

  const closeSource = async (id: Id) => {
    const source = open.get(id);
    if (!source) return;
    open.delete(id);
    compositor.releaseImage(id);
    await source.next?.catch(() => null);
    await api.decoderClose(source.decoder);
  };

  try {
    await api.exportBegin(project, settings);
    const started = performance.now();
    let writing: Promise<void> = Promise.resolve();

    for (let frame = settings.from; frame < settings.to; frame++) {
      if (signal.aborted) throw new ExportCancelled();

      const layers = layersAt(project, frame);
      const inUse = new Set(layers.map((l) => l.clip.id));
      for (const id of [...open.keys()]) if (!inUse.has(id)) await closeSource(id);

      compositor.begin();
      for (const layer of layers) {
        const { clip, media } = layer;
        if (clip.title) {
          uploadTitle(compositor, clip.id, clip.title);
          compositor.drawImage(clip.id, settings.width, settings.height, { ...layer, grade: clip.grade, premultiplied: true });
          continue;
        }
        if (!media || media.offline) continue;

        let source = open.get(clip.id);
        if (!source) {
          const size = decodeSize(media, clip, settings);
          const still = media.kind === 'image';
          const decoder = await api.decoderOpen({
            path: media.path,
            still,
            seekSec: still ? 0 : layer.sourceFrame / project.fps,
            width: size.width,
            height: size.height,
            fps: project.fps,
            colorMatrix: media.colorMatrix,
          });
          source = { decoder, ...size, still, shown: false, next: null };
          open.set(clip.id, source);
        }

        if (!source.still || !source.shown) {
          // Reading one frame ahead lets the decoder work while this frame is rendered and encoded.
          // Past the end of the file there is nothing more, and the last frame holds.
          const next = await (source.next ?? api.decoderRead(source.decoder));
          source.next = source.still ? null : api.decoderRead(source.decoder);
          if (next) {
            if (source.still) compositor.uploadPixels(clip.id, next, source.width, source.height);
            else compositor.uploadYuv420(clip.id, next, source.width, source.height);
            source.shown = true;
          }
        }
        if (source.shown) {
          compositor.drawImage(clip.id, source.width, source.height, { ...layer, grade: clip.grade },
            source.still ? undefined : media.colorMatrix);
        }
      }

      if (nv12) compositor.readNv12(pixels);
      else compositor.readPixels(pixels);

      // The frame is copied as soon as it is sent, so the buffer can be refilled at once. Holding
      // back only for the previous write gives the encoder a frame to work on during the next render.
      await writing;
      writing = api.exportFrame(pixels);

      const done = frame - settings.from + 1;
      if (done % 5 === 0 || done === total) {
        onProgress({ frame: done, total, fps: (done * 1000) / (performance.now() - started) });
      }
    }

    await writing;
    for (const id of [...open.keys()]) await closeSource(id);
    return await api.exportFinish();
  } catch (e) {
    for (const id of [...open.keys()]) await closeSource(id);
    await api.exportCancel();
    throw e;
  } finally {
    compositor.dispose();
  }
}
