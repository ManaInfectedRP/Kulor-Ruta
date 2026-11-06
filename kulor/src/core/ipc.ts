// The contract between the renderer and the main process.

import type { MediaItem, Project } from './types';

export type VideoFormat = 'h264' | 'hevc' | 'prores' | 'dnxhr';

/** Delivery codecs take NV12 straight from the GPU. The 4:2:2 mastering codecs need full chroma. */
export const usesNv12 = (format: VideoFormat): boolean => format === 'h264' || format === 'hevc';

export interface ExportSettings {
  outputPath: string;
  format: VideoFormat;
  width: number;
  height: number;
  /** 1 (largest) .. 3 (smallest), ignored by the intermediate codecs. */
  quality: number;
  from: number;
  to: number;
}

export interface DecoderRequest {
  path: string;
  still: boolean;
  seekSec: number;
  width: number;
  height: number;
  fps: number;
  colorMatrix: string;
}

export interface MediaEvent {
  id: string;
  thumb?: string;
  proxyState?: MediaItem['proxyState'];
  proxyPath?: string;
  proxyProgress?: number;
}

export interface EncoderChoice {
  h264: string;
  hevc: string;
}

export interface KulorApi {
  pickFiles(): Promise<string[]>;
  pathForFile(file: File): string;
  importMedia(paths: string[]): Promise<MediaItem[]>;
  prepareMedia(ids: string[]): Promise<void>;
  onMediaEvent(handler: (e: MediaEvent) => void): () => void;
  waveform(mediaId: string): Promise<Float32Array | null>;
  saveProject(project: Project, path: string | null): Promise<string | null>;
  openProject(): Promise<{ project: Project; path: string } | null>;
  /** Opens a project by path, without a dialog. */
  loadProject(path: string): Promise<{ project: Project; path: string } | null>;
  pickExportPath(suggestedName: string, format: VideoFormat): Promise<string | null>;
  exportEncoders(): Promise<EncoderChoice>;
  exportBegin(project: Project, settings: ExportSettings): Promise<void>;
  exportFrame(rgba: Uint8Array): Promise<void>;
  exportFinish(): Promise<{ path: string; bytes: number }>;
  exportCancel(): Promise<void>;
  decoderOpen(request: DecoderRequest): Promise<string>;
  decoderRead(id: string): Promise<Uint8Array | null>;
  decoderClose(id: string): Promise<void>;
  showInFolder(path: string): Promise<void>;
}

declare global {
  interface Window {
    kulor: KulorApi;
  }
}
