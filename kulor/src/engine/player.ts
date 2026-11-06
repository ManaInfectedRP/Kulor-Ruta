// Live preview. HTML media elements decode, the compositor draws, and Web Audio is the master clock:
// picture follows sound, because a late frame is forgiven and a late sample is not.

import type { Clip, Id, MediaItem, Project, Track } from '../core/types';
import { audibleTracks, dbToGain, fadeGain, layersAt, mediaOf, timelineEnd } from '../core/timeline';
import { Compositor } from './compositor';
import { pruneTitles, uploadTitle } from './titles';
import { mediaUrl, useStore } from '../store';

const MAX_ELEMENTS = 12;
const DRIFT_LIMIT_SEC = 0.12;
const PREROLL_FRAMES = 45;

interface Pooled {
  clipId: Id;
  url: string;
  element: HTMLVideoElement | HTMLAudioElement | HTMLImageElement;
  lastUsed: number;
  gain?: GainNode;
  ready: boolean;
}

interface TrackBus {
  gain: GainNode;
  pan: StereoPannerNode;
  analyser: AnalyserNode;
}

export class Player {
  readonly canvas: HTMLCanvasElement;
  readonly compositor: Compositor;
  private readonly pool = new Map<Id, Pooled>();
  private audio: AudioContext | null = null;
  private master: GainNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private readonly buses = new Map<Id, TrackBus>();
  private raf = 0;
  private dirty = true;
  private clockStart = 0;
  private frameAtStart = 0;
  private speed = 1;
  private tickCounter = 0;
  /** Set by the Color page; called after each drawn frame. */
  onFrame: (() => void) | null = null;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.className = 'viewer-canvas';
    const { project } = useStore.getState();
    this.compositor = new Compositor(this.canvas, project.width, project.height);

    useStore.subscribe((state, previous) => {
      if (state.project !== previous.project) {
        if (state.project.width !== previous.project.width || state.project.height !== previous.project.height)
          this.compositor.resize(state.project.width, state.project.height);
        if (state.project.clips !== previous.project.clips)
          pruneTitles(this.compositor, new Set(state.project.clips.filter((c) => c.title).map((c) => c.id)));
        this.syncBuses(state.project);
        this.invalidate();
      }
      if (state.playhead !== previous.playhead && !state.playing) this.invalidate();
      if (state.useProxies !== previous.useProxies) this.invalidate();
    });

    this.raf = requestAnimationFrame(this.tick);
  }

  invalidate = (): void => {
    this.dirty = true;
  };

  private ensureAudio(): AudioContext {
    if (!this.audio) {
      this.audio = new AudioContext({ latencyHint: 'playback' });
      this.master = this.audio.createGain();
      this.masterAnalyser = this.audio.createAnalyser();
      this.masterAnalyser.fftSize = 2048;
      this.master.connect(this.masterAnalyser).connect(this.audio.destination);
      this.syncBuses(useStore.getState().project);
    }
    return this.audio;
  }

  private bus(track: Track): TrackBus {
    const ctx = this.ensureAudio();
    let bus = this.buses.get(track.id);
    if (!bus) {
      const gain = ctx.createGain();
      const pan = ctx.createStereoPanner();
      const analyser = ctx.createAnalyser();
      analyser.fftSize = 1024;
      gain.connect(pan).connect(analyser).connect(this.master!);
      bus = { gain, pan, analyser };
      this.buses.set(track.id, bus);
    }
    return bus;
  }

  private syncBuses(project: Project): void {
    if (!this.audio) return;
    const audible = new Set(audibleTracks(project).map((t) => t.id));
    for (const t of project.tracks) {
      if (t.kind !== 'audio') continue;
      const bus = this.bus(t);
      bus.gain.gain.value = audible.has(t.id) ? dbToGain(t.gainDb) : 0;
      bus.pan.pan.value = t.pan;
    }
  }

  /** Peak level 0..1 on a track, or the master when no id is given. */
  level(trackId?: Id): number {
    const analyser = trackId ? this.buses.get(trackId)?.analyser : this.masterAnalyser;
    if (!analyser) return 0;
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    let peak = 0;
    for (const v of data) peak = Math.max(peak, Math.abs(v));
    return peak;
  }

  play(speed = 1): void {
    const ctx = this.ensureAudio();
    void ctx.resume();
    const state = useStore.getState();
    this.speed = speed;
    this.frameAtStart = state.playhead >= timelineEnd(state.project) ? 0 : state.playhead;
    this.clockStart = ctx.currentTime;
    useStore.getState().setPlaying(true);
  }

  pause(): void {
    useStore.getState().setPlaying(false);
    for (const p of this.pool.values()) {
      if (p.element instanceof HTMLMediaElement) p.element.pause();
    }
    this.invalidate();
  }

  togglePlay(): void {
    if (useStore.getState().playing) this.pause();
    else this.play();
  }

  /** Forward 1x/2x/4x from repeated presses, like a shuttle control. */
  shuttle(direction: 1 | -1): void {
    const state = useStore.getState();
    const next = state.playing && Math.sign(this.speed) === direction ? Math.min(4, Math.abs(this.speed) * 2) : 1;
    if (direction < 0) {
      for (const p of this.pool.values()) if (p.element instanceof HTMLMediaElement) p.element.pause();
    }
    this.play(next * direction);
  }

  seek(frame: number): void {
    const state = useStore.getState();
    if (state.playing) {
      this.frameAtStart = Math.max(0, frame);
      this.clockStart = this.ensureAudio().currentTime;
    }
    state.setPlayhead(frame);
    this.invalidate();
  }

  private acquire(clip: Clip, media: MediaItem): Pooled {
    const url = mediaUrl(media, useStore.getState().useProxies);
    const existing = this.pool.get(clip.id);
    if (existing && existing.url === url) {
      existing.lastUsed = performance.now();
      return existing;
    }
    if (existing) this.release(clip.id);
    this.evict();

    let element: Pooled['element'];
    const isAudioClip = useStore.getState().project.tracks.find((t) => t.id === clip.trackId)?.kind === 'audio';
    if (media.kind === 'image' && !isAudioClip) {
      element = new Image();
      element.crossOrigin = 'anonymous';
      element.onload = () => {
        const p = this.pool.get(clip.id);
        if (p) p.ready = true;
        this.invalidate();
      };
      element.src = url;
    } else {
      const media_ = isAudioClip ? new Audio() : document.createElement('video');
      media_.crossOrigin = 'anonymous';
      media_.preload = 'auto';
      media_.muted = !isAudioClip;
      if (media_ instanceof HTMLVideoElement) media_.playsInline = true;
      media_.src = url;
      media_.addEventListener('loadeddata', this.invalidate);
      media_.addEventListener('seeked', this.invalidate);
      element = media_;
    }
    const pooled: Pooled = { clipId: clip.id, url, element, lastUsed: performance.now(), ready: false };
    this.pool.set(clip.id, pooled);
    return pooled;
  }

  private release(id: Id): void {
    const p = this.pool.get(id);
    if (!p) return;
    if (p.element instanceof HTMLMediaElement) {
      p.element.pause();
      p.element.removeAttribute('src');
      p.element.load();
    }
    p.gain?.disconnect();
    this.pool.delete(id);
    this.compositor.releaseImage(id);
  }

  private evict(): void {
    if (this.pool.size < MAX_ELEMENTS) return;
    const oldest = [...this.pool.values()].sort((a, b) => a.lastUsed - b.lastUsed)[0];
    this.release(oldest.clipId);
  }

  private currentFrame(): number {
    const state = useStore.getState();
    if (!state.playing || !this.audio) return state.playhead;
    const elapsed = this.audio.currentTime - this.clockStart;
    return this.frameAtStart + elapsed * state.project.fps * this.speed;
  }

  private drive(el: HTMLMediaElement, targetSec: number, playing: boolean): void {
    if (playing) {
      el.playbackRate = Math.abs(this.speed);
      if (el.paused) {
        el.currentTime = targetSec;
        void el.play().catch(() => undefined);
      } else if (Math.abs(el.currentTime - targetSec) > DRIFT_LIMIT_SEC * Math.abs(this.speed)) {
        el.currentTime = targetSec;
      }
    } else {
      if (!el.paused) el.pause();
      if (Math.abs(el.currentTime - targetSec) > 0.25 / useStore.getState().project.fps) el.currentTime = targetSec;
    }
  }

  private syncAudio(project: Project, frame: number, playing: boolean): void {
    const fps = project.fps;
    for (const clip of project.clips) {
      const t = project.tracks.find((x) => x.id === clip.trackId);
      if (t?.kind !== 'audio') continue;
      const media = mediaOf(project, clip);
      if (!media || media.offline) continue;

      const active = frame >= clip.start && frame < clip.start + clip.duration;
      const soon = frame >= clip.start - PREROLL_FRAMES && frame < clip.start;
      if (!active && !soon) {
        const p = this.pool.get(clip.id);
        if (p?.element instanceof HTMLMediaElement && !p.element.paused) p.element.pause();
        continue;
      }

      const pooled = this.acquire(clip, media);
      const el = pooled.element as HTMLMediaElement;
      if (!pooled.gain) {
        const ctx = this.ensureAudio();
        pooled.gain = ctx.createGain();
        ctx.createMediaElementSource(el).connect(pooled.gain).connect(this.bus(t).gain);
      }
      if (active) {
        pooled.gain.gain.value = dbToGain(clip.gainDb) * fadeGain(clip, frame);
        this.drive(el, (clip.sourceIn + frame - clip.start) / fps, playing && this.speed > 0);
      } else if (el.paused && Math.abs(el.currentTime - clip.sourceIn / fps) > 0.05) {
        el.currentTime = clip.sourceIn / fps;
      }
    }
  }

  private render(project: Project, frame: number, playing: boolean): void {
    const whole = Math.floor(frame);
    const layers = layersAt(project, whole);
    const forward = playing && this.speed > 0;

    // Elements for what comes next are opened early, so a cut shows no black gap.
    if (forward) {
      for (const clip of project.clips) {
        if (clip.start > whole && clip.start - whole < PREROLL_FRAMES) {
          const t = project.tracks.find((x) => x.id === clip.trackId);
          const media = mediaOf(project, clip);
          if (t?.kind !== 'video' || !media || media.offline) continue;
          const pooled = this.acquire(clip, media);
          const el = pooled.element;
          if (el instanceof HTMLVideoElement && el.paused) {
            const at = (clip.sourceIn + 0.5) / project.fps;
            if (Math.abs(el.currentTime - at) > 0.05) el.currentTime = at;
          }
        }
      }
    }

    const c = this.compositor;
    c.begin();
    const showing = new Set<Id>();
    for (const layer of layers) {
      const { clip, media } = layer;
      if (clip.title) {
        uploadTitle(c, clip.id, clip.title);
        c.drawImage(clip.id, c.width, c.height, { ...layer, grade: clip.grade, premultiplied: true });
        continue;
      }
      if (!media || media.offline) continue;
      showing.add(clip.id);
      const pooled = this.acquire(clip, media);
      const el = pooled.element;
      let w = media.width;
      let h = media.height;

      if (el instanceof HTMLImageElement) {
        if (!pooled.ready) continue;
        if (!c.hasImage(clip.id)) c.uploadElement(clip.id, el);
      } else {
        const video = el as HTMLVideoElement;
        // Middle of the frame: a seek aimed at its exact start can land on the frame before.
        this.drive(video, (layer.sourceFrame + 0.5) / project.fps, forward);
        if (video.readyState < 2) continue;
        w = video.videoWidth || w;
        h = video.videoHeight || h;
        c.uploadElement(clip.id, video);
      }
      c.drawImage(clip.id, w, h, { ...layer, grade: clip.grade });
    }
    c.present();

    for (const p of this.pool.values()) {
      if (showing.has(p.clipId) || !(p.element instanceof HTMLVideoElement)) continue;
      const clip = project.clips.find((x) => x.id === p.clipId);
      const upcoming = clip && clip.start > whole && clip.start - whole < PREROLL_FRAMES;
      if (!upcoming && !p.element.paused) p.element.pause();
    }
  }

  private tick = (): void => {
    this.raf = requestAnimationFrame(this.tick);
    const state = useStore.getState();
    const { project, playing } = state;

    if (playing) {
      const end = timelineEnd(project);
      let frame = this.currentFrame();
      if (this.speed > 0 && frame >= end) {
        this.pause();
        state.setPlayhead(end);
        return;
      }
      if (frame < 0) {
        this.pause();
        state.setPlayhead(0);
        return;
      }
      frame = Math.max(0, frame);
      if (Math.floor(frame) !== state.playhead) state.setPlayhead(frame);
      this.render(project, frame, true);
      this.syncAudio(project, frame, true);
      if ((this.tickCounter = (this.tickCounter + 1) % 2) === 0) this.onFrame?.();
    } else if (this.dirty) {
      this.dirty = false;
      this.render(project, state.playhead, false);
      this.syncAudio(project, state.playhead, false);
      this.onFrame?.();
    }
  };

  dispose(): void {
    cancelAnimationFrame(this.raf);
    for (const id of [...this.pool.keys()]) this.release(id);
    this.compositor.dispose();
    void this.audio?.close();
  }
}

let instance: Player | null = null;

export function player(): Player {
  instance ??= new Player();
  return instance;
}
