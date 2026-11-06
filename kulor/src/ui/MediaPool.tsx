import { useState } from 'react';
import type { MediaItem } from '../core/types';
import { fileUrl, useStore } from '../store';
import { importDialog, importPaths, placeOnTimeline } from './actions';

export const MEDIA_DRAG_TYPE = 'application/x-kulor-media';

function formatDuration(sec: number): string {
  const m = Math.floor(sec / 60);
  const s = Math.floor(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

function proxyLabel(m: MediaItem, progress: number | undefined): string | null {
  if (m.proxyState === 'working') return `Proxy ${Math.round((progress ?? 0) * 100)} %`;
  if (m.proxyState === 'failed') return 'Proxy misslyckades';
  if (m.needsProxy && m.proxyState === 'ready') return 'Proxy';
  return null;
}

export function MediaPool({ onSelect, selected }: { onSelect?: (m: MediaItem) => void; selected?: string | null }) {
  const media = useStore((s) => s.project.media);
  const progress = useStore((s) => s.proxyProgress);
  const [over, setOver] = useState(false);

  return (
    <div
      className={`pool ${over ? 'over' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setOver(true);
        }
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setOver(false);
        void importPaths([...e.dataTransfer.files].map((f) => window.kulor.pathForFile(f)));
      }}
    >
      <div className="panel-title">
        Mediebibliotek
        <button className="small" onClick={() => void importDialog()}>+ Importera</button>
      </div>
      {media.length === 0 ? (
        <div className="empty">Dra in filer hit eller tryck Ctrl+I</div>
      ) : (
        <div className="pool-grid">
          {media.map((m) => {
            const label = proxyLabel(m, progress[m.id]);
            return (
              <div
                key={m.id}
                className={`pool-item ${selected === m.id ? 'selected' : ''} ${m.offline ? 'offline' : ''}`}
                draggable={!m.offline}
                onDragStart={(e) => e.dataTransfer.setData(MEDIA_DRAG_TYPE, m.id)}
                onClick={() => onSelect?.(m)}
                onDoubleClick={() => !m.offline && placeOnTimeline(m)}
                title={m.path}
              >
                <div className="pool-thumb" style={m.thumb ? { backgroundImage: `url("${fileUrl(m.thumb)}")` } : undefined}>
                  {m.kind === 'audio' && <span className="pool-glyph">♪</span>}
                  {label && <span className="pool-badge">{label}</span>}
                  {m.offline && <span className="pool-badge bad">Saknas</span>}
                  {m.kind !== 'image' && <span className="pool-duration">{formatDuration(m.durationSec)}</span>}
                </div>
                <div className="pool-name">{m.name}</div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
