import { useEffect, useRef, useState } from 'react';
import type { EncoderChoice, ExportSettings, VideoFormat } from '../core/ipc';
import { timelineEnd } from '../core/timeline';
import { ExportCancelled, renderProject, type RenderProgress } from '../engine/render';
import { useStore } from '../store';
import { formatTimecode } from './actions';
import { Viewer } from './Viewer';

const FORMATS: { id: VideoFormat; label: string }[] = [
  { id: 'h264', label: 'H.264 MP4' },
  { id: 'hevc', label: 'H.265 MP4' },
  { id: 'prores', label: 'ProRes 422 HQ MOV' },
  { id: 'dnxhr', label: 'DNxHR HQ MOV' },
];

interface Result {
  path: string;
  bytes: number;
  seconds: number;
  frames: number;
}

/** Runs one export. Lives outside the component so the test driver and the button share it. */
export function startExport(settings: ExportSettings, onProgress: (p: RenderProgress) => void, signal: AbortSignal) {
  return renderProject(useStore.getState().project, settings, onProgress, signal);
}

export function DeliverPage() {
  const project = useStore((s) => s.project);
  const [format, setFormat] = useState<VideoFormat>('h264');
  const [scale, setScale] = useState(1);
  const [quality, setQuality] = useState(2);
  const [range, setRange] = useState<'all' | 'marks'>('all');
  const [encoders, setEncoders] = useState<EncoderChoice | null>(null);
  const [progress, setProgress] = useState<RenderProgress | null>(null);
  const [result, setResult] = useState<Result | null>(null);
  const [error, setError] = useState('');
  const abort = useRef<AbortController | null>(null);

  useEffect(() => {
    void window.kulor.exportEncoders().then(setEncoders);
  }, []);

  const end = timelineEnd(project);
  const hasMarks = project.markIn !== null || project.markOut !== null;
  const from = range === 'marks' ? (project.markIn ?? 0) : 0;
  const to = range === 'marks' ? Math.min(project.markOut ?? end, end) : end;
  const frames = Math.max(0, to - from);
  const even = (n: number) => Math.round(n / 2) * 2;
  const width = even(project.width * scale);
  const height = even(project.height * scale);
  const busy = progress !== null;
  const lossy = format === 'h264' || format === 'hevc';

  const run = async () => {
    const outputPath = await window.kulor.pickExportPath(project.name, format);
    if (!outputPath) return;
    const controller = new AbortController();
    abort.current = controller;
    setResult(null);
    setError('');
    setProgress({ frame: 0, total: frames, fps: 0 });
    const started = performance.now();
    try {
      const done = await startExport(
        { outputPath, format, width, height, quality, from, to },
        setProgress,
        controller.signal,
      );
      setResult({ ...done, seconds: (performance.now() - started) / 1000, frames });
    } catch (e) {
      if (!(e instanceof ExportCancelled)) setError(e instanceof Error ? e.message : String(e));
    } finally {
      setProgress(null);
      abort.current = null;
    }
  };

  const percent = progress && progress.total > 0 ? (progress.frame / progress.total) * 100 : 0;
  const remaining = progress && progress.fps > 0 ? (progress.total - progress.frame) / progress.fps : 0;

  return (
    <div className="deliver-page">
      <section className="panel settings deliver-settings">
        <div className="panel-title">Leverera</div>
        <label>
          Format
          <select value={format} disabled={busy} onChange={(e) => setFormat(e.target.value as VideoFormat)}>
            {FORMATS.map((f) => <option key={f.id} value={f.id}>{f.label}</option>)}
          </select>
        </label>
        <label>
          Upplösning
          <select value={scale} disabled={busy} onChange={(e) => setScale(Number(e.target.value))}>
            <option value={1}>{`Projektets (${project.width}×${project.height})`}</option>
            <option value={0.75}>75 %</option>
            <option value={0.5}>50 %</option>
          </select>
        </label>
        {lossy && (
          <label>
            Kvalitet
            <select value={quality} disabled={busy} onChange={(e) => setQuality(Number(e.target.value))}>
              <option value={1}>Hög</option>
              <option value={2}>Normal</option>
              <option value={3}>Liten fil</option>
            </select>
          </label>
        )}
        <label>
          Omfång
          <select value={range} disabled={busy} onChange={(e) => setRange(e.target.value as 'all' | 'marks')}>
            <option value="all">Hela tidslinjen</option>
            <option value="marks" disabled={!hasMarks}>In- till utpunkt (I/O)</option>
          </select>
        </label>

        <dl className="deliver-summary">
          <dt>Längd</dt>
          <dd>{formatTimecode(frames, project.fps)} ({frames} bilder)</dd>
          <dt>Storlek</dt>
          <dd>{width} × {height} @ {project.fps} fps</dd>
          {lossy && encoders && (
            <>
              <dt>Encoder</dt>
              <dd>{format === 'h264' ? encoders.h264 : encoders.hevc}</dd>
            </>
          )}
        </dl>

        {!busy ? (
          <button className="primary" disabled={frames === 0} onClick={() => void run()}>Rendera…</button>
        ) : (
          <button onClick={() => abort.current?.abort()}>Avbryt</button>
        )}

        {busy && (
          <div className="progress">
            <div className="progress-bar"><div style={{ width: `${percent}%` }} /></div>
            <div className="progress-text">
              {progress.frame} / {progress.total} bilder · {progress.fps.toFixed(1)} fps · {Math.ceil(remaining)} s kvar
            </div>
          </div>
        )}
        {result && (
          <div className="result">
            <b>Klart</b> {result.frames} bilder på {result.seconds.toFixed(1)} s, {(result.bytes / 1048576).toFixed(1)} MB
            <button className="small" onClick={() => void window.kulor.showInFolder(result.path)}>Visa filen</button>
          </div>
        )}
        {error && <div className="error">{error}</div>}
      </section>
      <section className="panel grow"><Viewer /></section>
    </div>
  );
}
