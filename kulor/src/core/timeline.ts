// Pure edit operations. Every function takes a project and returns a new one, or the same object
// when the edit is not possible, which makes undo a matter of keeping old references.

import type { AnimatedProperty, Clip, Id, Keyframe, MediaItem, Project, Title, Track, TrackKind } from './types';
import { defaultGrade } from './grade';
import { newId } from './id';
import { titleName } from './title';

const IMAGE_DEFAULT_SECONDS = 5;
const TITLE_DEFAULT_SECONDS = 5;

function track(kind: TrackKind, name: string): Track {
  return { id: newId(), kind, name, hidden: false, locked: false, muted: false, solo: false, gainDb: 0, pan: 0 };
}

export function newProject(name = 'Nytt projekt'): Project {
  return {
    version: 1,
    name,
    width: 1920,
    height: 1080,
    fps: 30,
    media: [],
    tracks: [track('video', 'V1'), track('video', 'V2'), track('audio', 'A1'), track('audio', 'A2')],
    clips: [],
    markIn: null,
    markOut: null,
  };
}

export function addTrack(p: Project, kind: TrackKind): Project {
  const count = p.tracks.filter((t) => t.kind === kind).length;
  const added = track(kind, `${kind === 'video' ? 'V' : 'A'}${count + 1}`);
  const video = p.tracks.filter((t) => t.kind === 'video');
  const audio = p.tracks.filter((t) => t.kind === 'audio');
  return { ...p, tracks: kind === 'video' ? [...video, added, ...audio] : [...video, ...audio, added] };
}

export function removeTrack(p: Project, trackId: Id): Project {
  if (p.clips.some((c) => c.trackId === trackId)) return p;
  const remaining = p.tracks.filter((t) => t.id !== trackId);
  const removed = p.tracks.find((t) => t.id === trackId);
  if (!removed || remaining.filter((t) => t.kind === removed.kind).length === 0) return p;
  return { ...p, tracks: remaining };
}

export function timelineEnd(p: Project): number {
  return p.clips.reduce((end, c) => Math.max(end, c.start + c.duration), 0);
}

export function mediaOf(p: Project, clip: Clip): MediaItem | undefined {
  return p.media.find((m) => m.id === clip.mediaId);
}

/** Frames the source file provides from frame zero, Infinity for still images. */
export function mediaFrames(media: MediaItem, fps: number): number {
  return media.kind === 'image' ? Infinity : Math.max(1, Math.floor(media.durationSec * fps + 1e-6));
}

/** How many frames a clip's source can supply: Infinity for stills and titles, 0 if it is missing. */
export function sourceFrames(p: Project, clip: Clip): number {
  if (clip.title) return Infinity;
  const media = mediaOf(p, clip);
  return media ? mediaFrames(media, p.fps) : 0;
}

function overlaps(p: Project, trackId: Id, start: number, end: number, ignore: ReadonlySet<Id>): boolean {
  return p.clips.some(
    (c) => c.trackId === trackId && !ignore.has(c.id) && c.start < end && start < c.start + c.duration,
  );
}

function baseClip(source: { id: Id; name: string }, trackId: Id, start: number, duration: number, linkId?: Id): Clip {
  return {
    id: newId(),
    mediaId: source.id,
    trackId,
    name: source.name,
    start,
    duration,
    sourceIn: 0,
    linkId,
    transform: { x: 0, y: 0, scale: 1, rotation: 0, opacity: 1 },
    keyframes: {},
    fadeIn: 0,
    fadeOut: 0,
    dissolveIn: 0,
    gainDb: 0,
    grade: defaultGrade(),
  };
}

function trackFor(p: Project, kind: TrackKind, preferred: Id | undefined, start: number, end: number): Track | undefined {
  const candidates = p.tracks.filter((t) => t.kind === kind && !t.locked);
  const first = candidates.find((t) => t.id === preferred);
  const ordered = first ? [first, ...candidates.filter((t) => t !== first)] : candidates;
  return ordered.find((t) => !overlaps(p, t.id, start, end, new Set()));
}

/**
 * Adds a media item to the timeline at the given frame. Video with sound becomes a linked pair of
 * one video clip and one audio clip. Tracks that are occupied there fall through to the next free one.
 */
export function addClipFromMedia(p: Project, media: MediaItem, preferredTrack: Id | undefined, startFrame: number): Project {
  const start = Math.max(0, Math.round(startFrame));
  const duration =
    media.kind === 'image' ? Math.round(IMAGE_DEFAULT_SECONDS * p.fps) : mediaFrames(media, p.fps);
  const end = start + duration;

  const clips: Clip[] = [];
  const wantsAudio = media.kind === 'audio' || media.hasAudio;
  const wantsVideo = media.kind !== 'audio';
  const linkId = wantsAudio && wantsVideo ? newId() : undefined;

  if (wantsVideo) {
    const t = trackFor(p, 'video', preferredTrack, start, end);
    if (!t) return p;
    clips.push(baseClip(media, t.id, start, duration, linkId));
  }
  if (wantsAudio) {
    const t = trackFor(p, 'audio', preferredTrack, start, end);
    if (!t) {
      if (!wantsVideo) return p;
      clips[0].linkId = undefined; // the picture is still worth placing
    } else {
      clips.push(baseClip(media, t.id, start, duration, linkId));
    }
  }
  return { ...p, clips: [...p.clips, ...clips] };
}

/**
 * Adds a title at a frame. Text belongs on top, so without a preferred track it takes the highest
 * free video track, and a new track is added when every one is occupied there.
 */
export function addTitleClip(p: Project, title: Title, preferredTrack: Id | undefined, startFrame: number): Project {
  const start = Math.max(0, Math.round(startFrame));
  const duration = Math.round(TITLE_DEFAULT_SECONDS * p.fps);
  const end = start + duration;
  const free = (q: Project, t: Track) => t.kind === 'video' && !t.locked && !overlaps(q, t.id, start, end, new Set());

  let project = p;
  const preferred = p.tracks.find((t) => t.id === preferredTrack && free(p, t));
  let target = preferred ?? [...p.tracks].reverse().find((t) => free(p, t));
  if (!target) {
    project = addTrack(p, 'video');
    target = project.tracks.filter((t) => t.kind === 'video').at(-1)!;
  }
  const clip: Clip = { ...baseClip({ id: '', name: titleName(title) }, target.id, start, duration), title };
  return { ...project, clips: [...project.clips, clip] };
}

/** The ids plus every clip linked to them. */
export function withLinked(p: Project, ids: readonly Id[]): Set<Id> {
  const links = new Set(p.clips.filter((c) => ids.includes(c.id) && c.linkId).map((c) => c.linkId));
  return new Set(p.clips.filter((c) => ids.includes(c.id) || (c.linkId && links.has(c.linkId))).map((c) => c.id));
}

/**
 * Moves clips and their linked partners. trackDelta shifts within the same kind of track, so the
 * audio half of a pair stays on audio tracks. The whole move is refused if any clip would collide.
 */
export function moveClips(p: Project, ids: readonly Id[], frameDelta: number, trackDelta = 0): Project {
  const moving = withLinked(p, ids);
  const primary = new Set(ids);
  const kindTracks = (kind: TrackKind) => p.tracks.filter((t) => t.kind === kind);
  const placed: Clip[] = [];

  for (const c of p.clips) {
    if (!moving.has(c.id)) continue;
    const start = c.start + frameDelta;
    if (start < 0) return p;
    let trackId = c.trackId;
    if (trackDelta !== 0 && primary.has(c.id)) {
      const current = p.tracks.find((t) => t.id === c.trackId)!;
      const list = kindTracks(current.kind);
      const target = list[list.indexOf(current) + trackDelta];
      if (!target) return p;
      trackId = target.id;
    }
    if (p.tracks.find((t) => t.id === trackId)?.locked) return p;
    if (overlaps(p, trackId, start, start + c.duration, moving)) return p;
    if (placed.some((o) => o.trackId === trackId && o.start < start + c.duration && start < o.start + o.duration)) return p;
    placed.push({ ...c, start, trackId });
  }
  const byId = new Map(placed.map((c) => [c.id, c]));
  return { ...p, clips: p.clips.map((c) => byId.get(c.id) ?? c) };
}

function neighbourLimits(p: Project, c: Clip): { before: number; after: number } {
  let before = 0;
  let after = Infinity;
  for (const o of p.clips) {
    if (o.id === c.id || o.trackId !== c.trackId) continue;
    if (o.start + o.duration <= c.start) before = Math.max(before, o.start + o.duration);
    if (o.start >= c.start + c.duration) after = Math.min(after, o.start);
  }
  return { before, after };
}

function shiftKeyframes(c: Clip, delta: number): Clip['keyframes'] {
  if (delta === 0) return c.keyframes;
  const out: Clip['keyframes'] = {};
  for (const [prop, list] of Object.entries(c.keyframes) as [AnimatedProperty, Keyframe[]][]) {
    out[prop] = list.map((k) => ({ ...k, frame: k.frame + delta }));
  }
  return out;
}

/** Trims one edge by a frame delta, clamped to the source length and to the neighbouring clips. */
export function trimClip(p: Project, clipId: Id, edge: 'start' | 'end', delta: number): Project {
  const trim = (c: Clip, wanted: number): Clip | null => {
    const available = sourceFrames(p, c);
    if (available === 0) return null;
    const endless = available === Infinity;
    const { before, after } = neighbourLimits(p, c);
    if (edge === 'start') {
      const min = endless ? before - c.start : Math.max(-c.sourceIn, before - c.start);
      const d = Math.min(Math.max(wanted, min), c.duration - 1);
      if (d === 0) return c;
      return {
        ...c,
        start: c.start + d,
        sourceIn: endless ? 0 : c.sourceIn + d,
        duration: c.duration - d,
        keyframes: shiftKeyframes(c, -d),
      };
    }
    const maxEnd = Math.min(available - c.sourceIn, after - c.start);
    const duration = Math.max(1, Math.min(c.duration + wanted, maxEnd));
    return { ...c, duration };
  };

  const main = p.clips.find((c) => c.id === clipId);
  if (!main) return p;
  const ids = withLinked(p, [clipId]);
  // A linked partner has to take the same delta or the pair falls out of sync, so the tightest clamp wins.
  let applied = delta;
  for (const c of p.clips) {
    if (!ids.has(c.id)) continue;
    const t = trim(c, delta);
    if (!t) return p;
    const achieved = edge === 'start' ? t.start - c.start : t.duration - c.duration;
    if (Math.abs(achieved) < Math.abs(applied)) applied = achieved;
  }
  return {
    ...p,
    clips: p.clips.map((c) => (ids.has(c.id) ? (trim(c, applied) ?? c) : c)),
  };
}

function splitOne(c: Clip, frame: number): [Clip, Clip] {
  const leftLength = frame - c.start;
  const keep = (at: (k: Keyframe) => boolean, shift: number): Clip['keyframes'] => {
    const out: Clip['keyframes'] = {};
    for (const [prop, list] of Object.entries(c.keyframes) as [AnimatedProperty, Keyframe[]][]) {
      const kept = list.filter(at).map((k) => ({ ...k, frame: k.frame - shift }));
      if (kept.length) out[prop] = kept;
    }
    return out;
  };
  const left: Clip = {
    ...c,
    duration: leftLength,
    fadeOut: 0,
    keyframes: keep((k) => k.frame < leftLength, 0),
  };
  const right: Clip = {
    ...c,
    id: newId(),
    start: frame,
    sourceIn: c.sourceIn + leftLength,
    duration: c.duration - leftLength,
    fadeIn: 0,
    dissolveIn: 0,
    keyframes: keep((k) => k.frame >= leftLength, leftLength),
    grade: structuredClone(c.grade),
  };
  return [left, right];
}

/** Cuts every given clip that spans the frame. Linked partners are cut too and relinked pairwise. */
export function splitClips(p: Project, ids: readonly Id[], frame: number): Project {
  const targets = withLinked(p, ids);
  const newLinks = new Map<Id, Id>();
  const out: Clip[] = [];
  let changed = false;
  for (const c of p.clips) {
    if (!targets.has(c.id) || frame <= c.start || frame >= c.start + c.duration) {
      out.push(c);
      continue;
    }
    const [left, right] = splitOne(c, frame);
    if (c.linkId) {
      if (!newLinks.has(c.linkId)) newLinks.set(c.linkId, newId());
      right.linkId = newLinks.get(c.linkId);
    }
    out.push(left, right);
    changed = true;
  }
  return changed ? { ...p, clips: out } : p;
}

export function deleteClips(p: Project, ids: readonly Id[], ripple = false): Project {
  const doomed = withLinked(p, ids);
  const removed = p.clips.filter((c) => doomed.has(c.id));
  if (removed.length === 0) return p;
  const clips = p.clips.filter((c) => !doomed.has(c.id));
  if (!ripple) return { ...p, clips };

  // Ripple closes the gap on the affected tracks only.
  const shifted = clips.map((c) => {
    const gap = removed
      .filter((r) => r.trackId === c.trackId && r.start + r.duration <= c.start)
      .reduce((sum, r) => sum + r.duration, 0);
    return gap ? { ...c, start: c.start - gap } : c;
  });
  return { ...p, clips: shifted };
}

export function updateClip(p: Project, id: Id, change: (c: Clip) => Clip): Project {
  return { ...p, clips: p.clips.map((c) => (c.id === id ? change(c) : c)) };
}

export function updateTrack(p: Project, id: Id, change: Partial<Track>): Project {
  return { ...p, tracks: p.tracks.map((t) => (t.id === id ? { ...t, ...change } : t)) };
}

/** Edges worth snapping to: clip starts and ends plus any extra frames such as the playhead. */
export function snapPoints(p: Project, ignore: ReadonlySet<Id>, extra: readonly number[] = []): number[] {
  const set = new Set<number>([0, ...extra]);
  for (const c of p.clips) {
    if (ignore.has(c.id)) continue;
    set.add(c.start);
    set.add(c.start + c.duration);
  }
  return [...set].sort((a, b) => a - b);
}

export function nearestSnap(points: readonly number[], frame: number, tolerance: number): number | null {
  let best: number | null = null;
  let bestDistance = tolerance;
  for (const pt of points) {
    const d = Math.abs(pt - frame);
    if (d <= bestDistance) {
      best = pt;
      bestDistance = d;
    }
  }
  return best;
}

// ---- keyframes ------------------------------------------------------------------------------

export function evalProperty(c: Clip, prop: AnimatedProperty, localFrame: number): number {
  const list = c.keyframes[prop];
  if (!list || list.length === 0) return c.transform[prop];
  if (localFrame <= list[0].frame) return list[0].value;
  const last = list[list.length - 1];
  if (localFrame >= last.frame) return last.value;
  for (let i = 0; i < list.length - 1; i++) {
    const a = list[i];
    const b = list[i + 1];
    if (localFrame <= b.frame) return a.value + ((b.value - a.value) * (localFrame - a.frame)) / (b.frame - a.frame);
  }
  return last.value;
}

export function setKeyframe(c: Clip, prop: AnimatedProperty, frame: number, value: number): Clip {
  const list = (c.keyframes[prop] ?? []).filter((k) => k.frame !== frame);
  list.push({ frame, value });
  list.sort((a, b) => a.frame - b.frame);
  return { ...c, keyframes: { ...c.keyframes, [prop]: list } };
}

export function removeKeyframe(c: Clip, prop: AnimatedProperty, frame: number): Clip {
  const list = (c.keyframes[prop] ?? []).filter((k) => k.frame !== frame);
  const keyframes = { ...c.keyframes };
  if (list.length) keyframes[prop] = list;
  else {
    delete keyframes[prop];
    return { ...c, keyframes, transform: { ...c.transform, [prop]: evalProperty(c, prop, frame) } };
  }
  return { ...c, keyframes };
}

export function hasKeyframeAt(c: Clip, prop: AnimatedProperty, frame: number): boolean {
  return (c.keyframes[prop] ?? []).some((k) => k.frame === frame);
}

// ---- what is on screen at a frame -----------------------------------------------------------

export interface Layer {
  clip: Clip;
  /** Null for titles. */
  media: MediaItem | null;
  /** Source frame, at project frame rate. */
  sourceFrame: number;
  x: number;
  y: number;
  scale: number;
  rotation: number;
  /** Final opacity including keyframes, fades and dissolves. */
  opacity: number;
}

function layerFor(p: Project, clip: Clip, media: MediaItem | null, frame: number, opacityFactor: number): Layer {
  const local = frame - clip.start;
  let opacity = evalProperty(clip, 'opacity', local) * opacityFactor;
  if (clip.fadeIn > 0 && local < clip.fadeIn) opacity *= (local + 1) / (clip.fadeIn + 1);
  const fromEnd = clip.start + clip.duration - frame;
  if (clip.fadeOut > 0 && fromEnd <= clip.fadeOut) opacity *= Math.max(0, fromEnd) / (clip.fadeOut + 1);
  return {
    clip,
    media,
    sourceFrame: media ? Math.min(clip.sourceIn + local, mediaFrames(media, p.fps) - 1) : 0,
    x: evalProperty(clip, 'x', local),
    y: evalProperty(clip, 'y', local),
    scale: evalProperty(clip, 'scale', local),
    rotation: evalProperty(clip, 'rotation', local),
    opacity,
  };
}

/** Video layers at a frame, bottom first. Preview and export both go through this function. */
export function layersAt(p: Project, frame: number): Layer[] {
  const layers: Layer[] = [];
  for (const t of p.tracks) {
    if (t.kind !== 'video' || t.hidden) continue;
    const trackClips = p.clips.filter((c) => c.trackId === t.id);
    const current = trackClips.find((c) => frame >= c.start && frame < c.start + c.duration);
    if (!current) continue;
    const media = mediaOf(p, current) ?? null;
    if (!media && !current.title) continue;

    const into = frame - current.start;
    if (current.dissolveIn > 0 && into < current.dissolveIn) {
      const previous = trackClips.find((c) => c.start + c.duration === current.start);
      const previousMedia = (previous && mediaOf(p, previous)) ?? null;
      if (previous && (previousMedia || previous.title)) {
        // The outgoing clip keeps running past its out point underneath the incoming one.
        layers.push(layerFor(p, previous, previousMedia, frame, 1));
        layers.push(layerFor(p, current, media, frame, (into + 1) / (current.dissolveIn + 1)));
        continue;
      }
    }
    layers.push(layerFor(p, current, media, frame, 1));
  }
  return layers;
}

export function audibleTracks(p: Project): Track[] {
  const audio = p.tracks.filter((t) => t.kind === 'audio');
  const soloed = audio.some((t) => t.solo);
  return audio.filter((t) => !t.muted && (!soloed || t.solo));
}

/** Gain from fades for an audio clip at a frame, 0..1. */
export function fadeGain(c: Clip, frame: number): number {
  const local = frame - c.start;
  let g = 1;
  if (c.fadeIn > 0 && local < c.fadeIn) g *= local / c.fadeIn;
  const fromEnd = c.start + c.duration - frame;
  if (c.fadeOut > 0 && fromEnd < c.fadeOut) g *= fromEnd / c.fadeOut;
  return g;
}

export const dbToGain = (db: number): number => (db <= -60 ? 0 : 10 ** (db / 20));
