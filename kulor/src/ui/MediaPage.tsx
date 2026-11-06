import { useState } from 'react';
import type { MediaItem } from '../core/types';
import { useStore } from '../store';
import { MediaPool } from './MediaPool';
import { Viewer } from './Viewer';

const RESOLUTIONS = [
  [1280, 720], [1920, 1080], [2560, 1440], [3840, 2160], [1080, 1920], [1080, 1080],
];
const RATES = [23.976, 24, 25, 29.97, 30, 50, 59.94, 60];

function megabytes(bytes: number): string {
  return `${(bytes / 1048576).toFixed(1)} MB`;
}

function Details({ media }: { media: MediaItem }) {
  const rows: [string, string][] = [
    ['Fil', media.name],
    ['Typ', media.kind === 'video' ? 'Video' : media.kind === 'audio' ? 'Ljud' : 'Bild'],
    ['Längd', media.kind === 'image' ? '–' : `${media.durationSec.toFixed(2)} s`],
    ['Storlek', megabytes(media.sizeBytes)],
  ];
  if (media.kind !== 'audio') {
    rows.push(['Upplösning', `${media.width} × ${media.height}`]);
    rows.push(['Färgmatris', media.colorMatrix]);
  }
  if (media.kind === 'video') rows.push(['Bildfrekvens', `${media.fps.toFixed(3)} fps`], ['Videokodek', media.videoCodec]);
  if (media.hasAudio) rows.push(['Ljudkodek', media.audioCodec]);
  rows.push(['Behållare', media.container.split(',')[0]]);
  rows.push(['Förhandsvisning', media.needsProxy ? 'Via proxy' : 'Originalfil']);
  return (
    <table className="details">
      <tbody>
        {rows.map(([k, v]) => (
          <tr key={k}>
            <th>{k}</th>
            <td>{v}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function MediaPage() {
  const [selected, setSelected] = useState<string | null>(null);
  const media = useStore((s) => s.project.media.find((m) => m.id === selected));
  const name = useStore((s) => s.project.name);
  const width = useStore((s) => s.project.width);
  const height = useStore((s) => s.project.height);
  const fps = useStore((s) => s.project.fps);
  const commit = useStore((s) => s.commit);
  const hasClips = useStore((s) => s.project.clips.length > 0);

  return (
    <div className="media-page">
      <section className="panel grow">
        <MediaPool selected={selected} onSelect={(m) => setSelected(m.id)} />
      </section>
      <aside className="media-side">
        <section className="panel">
          <Viewer compact />
        </section>
        <section className="panel settings">
          <div className="panel-title">Projekt</div>
          <label>
            Namn
            <input value={name} onChange={(e) => commit((p) => ({ ...p, name: e.target.value }), 'project-name')} />
          </label>
          <label>
            Upplösning
            <select
              value={`${width}x${height}`}
              onChange={(e) => {
                const [w, h] = e.target.value.split('x').map(Number);
                commit((p) => ({ ...p, width: w, height: h }));
              }}
            >
              {!RESOLUTIONS.some(([w, h]) => w === width && h === height) && <option>{`${width}x${height}`}</option>}
              {RESOLUTIONS.map(([w, h]) => (
                <option key={`${w}x${h}`}>{`${w}x${h}`}</option>
              ))}
            </select>
          </label>
          <label>
            Bildfrekvens
            <select
              value={fps}
              disabled={hasClips}
              title={hasClips ? 'Tidslinjen räknar i bildrutor, så frekvensen låses när det finns klipp' : undefined}
              onChange={(e) => commit((p) => ({ ...p, fps: Number(e.target.value) }))}
            >
              {!RATES.includes(fps) && <option>{fps}</option>}
              {RATES.map((r) => (
                <option key={r}>{r}</option>
              ))}
            </select>
          </label>
        </section>
        {media && (
          <section className="panel settings">
            <div className="panel-title">Metadata</div>
            <Details media={media} />
          </section>
        )}
      </aside>
    </div>
  );
}
