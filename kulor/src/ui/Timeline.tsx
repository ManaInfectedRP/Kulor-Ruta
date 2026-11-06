import { useEffect, useMemo, useRef, useState } from 'react';
import type { Clip, Id, MediaItem, Project, Track } from '../core/types';
import {
  addClipFromMedia, addTrack, moveClips, nearestSnap, removeTrack, snapPoints, splitClips, timelineEnd, trimClip,
  updateTrack, withLinked,
} from '../core/timeline';
import { player } from '../engine/player';
import { fileUrl, useStore } from '../store';
import { addTitle, deleteSelection, formatTimecode, splitAtPlayhead } from './actions';
import { MEDIA_DRAG_TYPE } from './MediaPool';
import { TITLE_DRAG_TYPE } from './TitlesPanel';

const HEADER_WIDTH = 132;
const RULER_HEIGHT = 26;
const SNAP_PIXELS = 8;

const waveforms = new Map<Id, Promise<Float32Array | null>>();

function waveformFor(id: Id): Promise<Float32Array | null> {
  let w = waveforms.get(id);
  if (!w) {
    w = window.kulor.waveform(id);
    waveforms.set(id, w);
  }
  return w;
}

function Waveform({ clip, fps, pixelsPerFrame }: { clip: Clip; fps: number; pixelsPerFrame: number }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const [peaks, setPeaks] = useState<Float32Array | null>(null);

  useEffect(() => {
    let alive = true;
    void waveformFor(clip.mediaId).then((w) => {
      if (alive) setPeaks(w);
    });
    return () => {
      alive = false;
    };
  }, [clip.mediaId]);

  // Canvases cannot be arbitrarily wide, so the drawn width is capped and CSS stretches it.
  const width = Math.max(1, Math.min(4000, Math.round(clip.duration * pixelsPerFrame)));
  useEffect(() => {
    const canvas = ref.current;
    const ctx = canvas?.getContext('2d');
    if (!canvas || !ctx || !peaks) return;
    const h = canvas.height;
    canvas.width = width;
    ctx.fillStyle = 'rgba(160, 235, 190, 0.85)';
    const peaksPerFrame = 100 / fps;
    const framesPerPixel = clip.duration / width;
    for (let x = 0; x < width; x++) {
      const from = Math.floor((clip.sourceIn + x * framesPerPixel) * peaksPerFrame);
      const to = Math.max(from + 1, Math.floor((clip.sourceIn + (x + 1) * framesPerPixel) * peaksPerFrame));
      let peak = 0;
      for (let i = from; i < to && i < peaks.length; i++) peak = Math.max(peak, peaks[i]);
      const bar = Math.max(0.5, peak * h * 0.96);
      ctx.fillRect(x, (h - bar) / 2, 1, bar);
    }
  }, [peaks, width, clip.sourceIn, clip.duration, fps]);

  return <canvas ref={ref} className="clip-wave" width={width} height={64} />;
}

interface Drag {
  mode: 'move' | 'start' | 'end';
  clipId: Id;
  x: number;
  y: number;
  frames: number;
  tracks: number;
  ids: Set<Id>;
}

function ClipView({
  clip, media, ppf, fps, selected, offset, onDown,
}: {
  clip: Clip;
  media: MediaItem | undefined;
  ppf: number;
  fps: number;
  selected: boolean;
  offset: { x: number; w: number; tracks: number };
  onDown(e: React.PointerEvent, clip: Clip, mode: Drag['mode']): void;
}) {
  const left = clip.start * ppf + offset.x;
  const width = Math.max(2, clip.duration * ppf + offset.w);
  const kind = media?.kind === 'audio' ? 'audio' : '';
  const thumb = media?.thumb && width > 60 ? { backgroundImage: `url("${fileUrl(media.thumb)}")` } : undefined;
  return (
    <div
      className={`clip ${selected ? 'selected' : ''} ${kind} ${clip.title ? 'title' : ''} ${media?.offline ? 'offline' : ''}`}
      style={{ left, width, transform: offset.tracks ? `translateY(${offset.tracks * 100}%)` : undefined }}
      onPointerDown={(e) => onDown(e, clip, 'move')}
      data-clip={clip.id}
    >
      {thumb && <div className="clip-thumb" style={thumb} />}
      <span className="clip-name">{clip.name}</span>
      <span className="clip-handle left" onPointerDown={(e) => onDown(e, clip, 'start')} />
      <span className="clip-handle right" onPointerDown={(e) => onDown(e, clip, 'end')} />
      {clip.fadeIn > 0 && <span className="clip-fade in" style={{ width: clip.fadeIn * ppf }} />}
      {clip.fadeOut > 0 && <span className="clip-fade out" style={{ width: clip.fadeOut * ppf }} />}
      {clip.dissolveIn > 0 && <span className="clip-dissolve" style={{ width: clip.dissolveIn * ppf }} />}
      {Object.keys(clip.keyframes).length > 0 && <span className="clip-keyed">◆</span>}
      <ClipBody clip={clip} media={media} fps={fps} ppf={ppf} />
    </div>
  );
}

function ClipBody({ clip, media, fps, ppf }: { clip: Clip; media: MediaItem | undefined; fps: number; ppf: number }) {
  const project = useStore((s) => s.project);
  const isAudioTrack = project.tracks.find((t) => t.id === clip.trackId)?.kind === 'audio';
  if (!isAudioTrack || !media?.hasAudio) return null;
  return <Waveform clip={clip} fps={fps} pixelsPerFrame={ppf} />;
}

function TrackHeader({ track, project }: { track: Track; project: Project }) {
  const commit = useStore((s) => s.commit);
  const set = (change: Partial<Track>) => commit((p) => updateTrack(p, track.id, change));
  const removable =
    !project.clips.some((c) => c.trackId === track.id) &&
    project.tracks.filter((t) => t.kind === track.kind).length > 1;
  return (
    <div className="track-header">
      <span className="track-name">{track.name}</span>
      {track.kind === 'video' ? (
        <button className={track.hidden ? 'toggle on' : 'toggle'} onClick={() => set({ hidden: !track.hidden })} title="Dölj spåret">Dölj</button>
      ) : (
        <>
          <button className={track.muted ? 'toggle on' : 'toggle'} onClick={() => set({ muted: !track.muted })} title="Tysta">M</button>
          <button className={track.solo ? 'toggle on' : 'toggle'} onClick={() => set({ solo: !track.solo })} title="Solo">S</button>
        </>
      )}
      <button className={track.locked ? 'toggle on' : 'toggle'} onClick={() => set({ locked: !track.locked })} title="Lås spåret">🔒︎</button>
      {removable && <button className="toggle" onClick={() => commit((p) => removeTrack(p, track.id))} title="Ta bort spåret">×</button>}
    </div>
  );
}

function Ruler({ width, ppf, fps, scroll, viewport, onSeek }: {
  width: number; ppf: number; fps: number; scroll: number; viewport: number; onSeek(frame: number): void;
}) {
  const ref = useRef<HTMLCanvasElement>(null);
  const markIn = useStore((s) => s.project.markIn);
  const markOut = useStore((s) => s.project.markOut);

  useEffect(() => {
    const c = ref.current;
    const ctx = c?.getContext('2d');
    if (!c || !ctx) return;
    c.width = viewport;
    c.height = RULER_HEIGHT;
    ctx.clearRect(0, 0, viewport, RULER_HEIGHT);

    const candidates = [1, 5, 10, Math.round(fps), Math.round(fps) * 2, Math.round(fps) * 5, Math.round(fps) * 10,
      Math.round(fps) * 30, Math.round(fps) * 60, Math.round(fps) * 300, Math.round(fps) * 600];
    const step = candidates.find((s) => s * ppf >= 70) ?? candidates[candidates.length - 1];
    const first = Math.floor(scroll / ppf / step) * step;

    ctx.fillStyle = '#9aa0ac';
    ctx.strokeStyle = '#4a4e57';
    ctx.font = '10px system-ui';
    ctx.beginPath();
    for (let f = first; f * ppf - scroll < viewport; f += step) {
      const x = Math.round(f * ppf - scroll) + 0.5;
      ctx.moveTo(x, RULER_HEIGHT - 9);
      ctx.lineTo(x, RULER_HEIGHT);
      ctx.fillText(formatTimecode(f, fps), x + 3, 12);
      const minor = (step * ppf) / 5;
      if (minor > 8) {
        for (let i = 1; i < 5; i++) {
          const mx = Math.round(x + i * minor) + 0.5;
          ctx.moveTo(mx, RULER_HEIGHT - 4);
          ctx.lineTo(mx, RULER_HEIGHT);
        }
      }
    }
    ctx.stroke();

    if (markIn !== null || markOut !== null) {
      const from = (markIn ?? 0) * ppf - scroll;
      const to = markOut !== null ? markOut * ppf - scroll : viewport;
      ctx.fillStyle = 'rgba(244, 196, 80, 0.3)';
      ctx.fillRect(from, RULER_HEIGHT - 6, to - from, 6);
    }
  }, [ppf, fps, scroll, viewport, width, markIn, markOut]);

  const seekAt = (e: React.PointerEvent) => {
    const bounds = e.currentTarget.getBoundingClientRect();
    onSeek(Math.max(0, Math.round((e.clientX - bounds.left + scroll) / ppf)));
  };

  return (
    <canvas
      ref={ref}
      className="ruler"
      onPointerDown={(e) => {
        e.currentTarget.setPointerCapture(e.pointerId);
        seekAt(e);
      }}
      onPointerMove={(e) => {
        if (e.currentTarget.hasPointerCapture(e.pointerId)) seekAt(e);
      }}
    />
  );
}

export function Timeline() {
  const project = useStore((s) => s.project);
  const selection = useStore((s) => s.selection);
  const ppf = useStore((s) => s.pixelsPerFrame);
  const playhead = useStore((s) => s.playhead);
  const tool = useStore((s) => s.tool);
  const snapping = useStore((s) => s.snapping);
  const { commit, setSelection, setZoom, setTool, toggleSnapping } = useStore.getState();

  const scroller = useRef<HTMLDivElement>(null);
  const [scroll, setScroll] = useState(0);
  const [viewport, setViewport] = useState(800);
  const [drag, setDrag] = useState<Drag | null>(null);
  const [snapLine, setSnapLine] = useState<number | null>(null);

  const end = timelineEnd(project);
  const contentWidth = Math.max(viewport, (end + project.fps * 30) * ppf);
  const mediaById = useMemo(() => new Map(project.media.map((m) => [m.id, m])), [project.media]);
  const videoTracks = project.tracks.filter((t) => t.kind === 'video').reverse();
  const audioTracks = project.tracks.filter((t) => t.kind === 'audio');

  useEffect(() => {
    const el = scroller.current;
    if (!el) return;
    const observer = new ResizeObserver(() => setViewport(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // While playing, keep the playhead on screen by paging.
  useEffect(() => {
    const el = scroller.current;
    if (!el || !useStore.getState().playing) return;
    const x = playhead * ppf;
    if (x > el.scrollLeft + el.clientWidth - 40 || x < el.scrollLeft) el.scrollLeft = x - 40;
  }, [playhead, ppf]);

  const beginDrag = (e: React.PointerEvent, clip: Clip, mode: Drag['mode']) => {
    e.stopPropagation();
    if (e.button !== 0) return;
    const track = project.tracks.find((t) => t.id === clip.trackId);
    const bounds = (e.currentTarget.closest('.track-lane') as HTMLElement).getBoundingClientRect();

    if (tool === 'blade') {
      const frame = Math.round((e.clientX - bounds.left) / ppf);
      commit((p) => splitClips(p, [clip.id], frame));
      return;
    }

    const already = selection.includes(clip.id);
    const next = e.ctrlKey || e.shiftKey
      ? already ? selection.filter((id) => id !== clip.id) : [...selection, clip.id]
      : already ? selection : [clip.id];
    setSelection(next);
    if (track?.locked) return;

    (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
    const ids = withLinked(project, mode === 'move' ? next : [clip.id]);
    setDrag({ mode, clipId: clip.id, x: e.clientX, y: e.clientY, frames: 0, tracks: 0, ids });
  };

  /** Where the pointer puts the drag right now, snapping included. */
  const measureDrag = (e: React.PointerEvent, current: Drag): Drag => {
    const drag = current;
    let frames = Math.round((e.clientX - drag.x) / ppf);
    const clip = project.clips.find((c) => c.id === drag.clipId)!;

    if (snapping) {
      const points = snapPoints(project, drag.ids, [playhead]);
      const edges = drag.mode === 'move'
        ? [clip.start + frames, clip.start + clip.duration + frames]
        : drag.mode === 'start' ? [clip.start + frames] : [clip.start + clip.duration + frames];
      const tolerance = SNAP_PIXELS / ppf;
      let best: { line: number; delta: number } | null = null;
      for (const edge of edges) {
        const s = nearestSnap(points, edge, tolerance);
        if (s !== null && (!best || Math.abs(s - edge) < Math.abs(best.delta))) best = { line: s, delta: s - edge };
      }
      setSnapLine(best ? best.line : null);
      if (best) frames += best.delta;
    }

    const laneHeight = 54;
    const tracks = drag.mode === 'move' ? Math.round((e.clientY - drag.y) / laneHeight) : 0;
    return { ...drag, frames, tracks };
  };

  const onPointerMove = (e: React.PointerEvent) => {
    if (drag) setDrag(measureDrag(e, drag));
  };

  const onPointerUp = (e: React.PointerEvent) => {
    if (!drag) return;
    // Measured here, as a quick release can arrive before the last move has rendered.
    const { mode, frames, tracks, clipId } = measureDrag(e, drag);
    setDrag(null);
    setSnapLine(null);
    if (frames === 0 && tracks === 0) return;
    if (mode === 'move') {
      const clip = project.clips.find((c) => c.id === clipId)!;
      const kind = project.tracks.find((t) => t.id === clip.trackId)?.kind;
      // Video tracks are listed bottom-up in the model but drawn top-down.
      const trackDelta = kind === 'video' ? -tracks : tracks;
      commit((p) => moveClips(p, selection, frames, trackDelta));
    } else {
      commit((p) => trimClip(p, clipId, mode, frames));
    }
  };

  const offsetFor = (clip: Clip) => {
    if (!drag || !drag.ids.has(clip.id)) return { x: 0, w: 0, tracks: 0 };
    if (drag.mode === 'move') return { x: drag.frames * ppf, w: 0, tracks: selection.includes(clip.id) ? drag.tracks : 0 };
    if (drag.mode === 'start') return { x: drag.frames * ppf, w: -drag.frames * ppf, tracks: 0 };
    return { x: 0, w: drag.frames * ppf, tracks: 0 };
  };

  const onDropMedia = (e: React.DragEvent, track: Track) => {
    const id = e.dataTransfer.getData(MEDIA_DRAG_TYPE);
    const media = project.media.find((m) => m.id === id);
    const preset = e.dataTransfer.getData(TITLE_DRAG_TYPE);
    if (!media && !preset) return;
    e.preventDefault();
    const bounds = e.currentTarget.getBoundingClientRect();
    const dropped = Math.max(0, Math.round((e.clientX - bounds.left) / ppf));
    const snapped = nearestSnap(snapPoints(project, new Set(), [playhead]), dropped, SNAP_PIXELS / ppf) ?? dropped;
    const frame = snapping ? snapped : dropped;
    if (media) commit((p) => addClipFromMedia(p, media, track.id, frame));
    else addTitle(preset, track.id, frame);
  };

  const lane = (track: Track) => (
    <div className="track-row" key={track.id}>
      <div
        className={`track-lane ${track.kind} ${track.locked ? 'locked' : ''}`}
        style={{ width: contentWidth }}
        onPointerDown={() => setSelection([])}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => onDropMedia(e, track)}
      >
        {project.clips.filter((c) => c.trackId === track.id).map((c) => (
          <ClipView
            key={c.id}
            clip={c}
            media={mediaById.get(c.mediaId)}
            ppf={ppf}
            fps={project.fps}
            selected={selection.includes(c.id)}
            offset={offsetFor(c)}
            onDown={beginDrag}
          />
        ))}
      </div>
    </div>
  );

  return (
    <div className="timeline" onPointerMove={onPointerMove} onPointerUp={onPointerUp} data-tool={tool}>
      <div className="timeline-tools">
        <button className={tool === 'select' ? 'toggle on' : 'toggle'} onClick={() => setTool('select')} title="Markera (A)">Markera</button>
        <button className={tool === 'blade' ? 'toggle on' : 'toggle'} onClick={() => setTool('blade')} title="Klippverktyg (B)">Klippa</button>
        <button className={snapping ? 'toggle on' : 'toggle'} onClick={toggleSnapping} title="Fäst mot kanter (N)">Fäst</button>
        <span className="divider" />
        <button onClick={splitAtPlayhead} title="Dela vid spelhuvudet (Ctrl+B)">Dela</button>
        <button onClick={() => deleteSelection(false)} title="Ta bort (Delete)">Ta bort</button>
        <button onClick={() => deleteSelection(true)} title="Ta bort och stäng luckan (Shift+Delete)">Stäng lucka</button>
        <span className="divider" />
        <button onClick={() => addTitle('title')} title="Lägg till en titel vid spelhuvudet">+ Titel</button>
        <button onClick={() => commit((p) => addTrack(p, 'video'))}>+ Videospår</button>
        <button onClick={() => commit((p) => addTrack(p, 'audio'))}>+ Ljudspår</button>
        <span className="spacer" />
        <button onClick={() => setZoom(ppf / 1.5)} title="Zooma ut (-)">−</button>
        <input type="range" min={-4} max={3.6} step={0.05} value={Math.log(ppf)} onChange={(e) => setZoom(Math.exp(Number(e.target.value)))} />
        <button onClick={() => setZoom(ppf * 1.5)} title="Zooma in (+)">+</button>
        <button onClick={() => end > 0 && setZoom((viewport - 40) / end)}>Passa</button>
      </div>

      <div className="timeline-body">
        <div className="timeline-headers" style={{ width: HEADER_WIDTH }}>
          <div className="ruler-corner">{formatTimecode(playhead, project.fps)}</div>
          {videoTracks.map((t) => <TrackHeader key={t.id} track={t} project={project} />)}
          <div className="track-separator" />
          {audioTracks.map((t) => <TrackHeader key={t.id} track={t} project={project} />)}
        </div>
        <div className="timeline-main">
          <Ruler width={contentWidth} ppf={ppf} fps={project.fps} scroll={scroll} viewport={viewport} onSeek={(f) => player().seek(f)} />
          <div
            className="timeline-scroll"
            ref={scroller}
            onScroll={(e) => setScroll(e.currentTarget.scrollLeft)}
            onWheel={(e) => {
              if (!e.ctrlKey) return;
              const el = e.currentTarget;
              const bounds = el.getBoundingClientRect();
              const frame = (e.clientX - bounds.left + el.scrollLeft) / ppf;
              const next = Math.min(40, Math.max(0.02, ppf * (e.deltaY < 0 ? 1.2 : 1 / 1.2)));
              setZoom(next);
              requestAnimationFrame(() => {
                el.scrollLeft = frame * next - (e.clientX - bounds.left);
              });
            }}
          >
            <div className="timeline-content" style={{ width: contentWidth }}>
              {videoTracks.map(lane)}
              <div className="track-separator" style={{ width: contentWidth }} />
              {audioTracks.map(lane)}
              <div className="playhead" style={{ transform: `translateX(${playhead * ppf}px)` }} />
              {snapLine !== null && <div className="snap-line" style={{ left: snapLine * ppf }} />}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
