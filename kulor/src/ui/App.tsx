import { useEffect } from 'react';
import { player } from '../engine/player';
import { useStore, type Page } from '../store';
import { importDialog, installShortcuts, openProject, saveProject } from './actions';
import { MediaPage } from './MediaPage';
import { EditPage } from './EditPage';
import { ColorPage } from './ColorPage';
import { AudioPage } from './AudioPage';
import { DeliverPage } from './DeliverPage';

const PAGES: { id: Page; label: string }[] = [
  { id: 'media', label: 'Media' },
  { id: 'edit', label: 'Klipp' },
  { id: 'color', label: 'Färg' },
  { id: 'audio', label: 'Ljud' },
  { id: 'deliver', label: 'Leverera' },
];

export function App() {
  const page = useStore((s) => s.page);
  const name = useStore((s) => s.project.name);
  const dirty = useStore((s) => s.dirty);
  const status = useStore((s) => s.status);
  const canUndo = useStore((s) => s.undoStack.length > 0);
  const canRedo = useStore((s) => s.redoStack.length > 0);
  const setPage = useStore((s) => s.setPage);

  useEffect(() => {
    player();
    return installShortcuts();
  }, []);

  useEffect(() => {
    return window.kulor.onMediaEvent((e) => {
      const s = useStore.getState();
      if (e.proxyProgress !== undefined) s.setProxyProgress(e.id, e.proxyProgress);
      const change = {
        ...(e.thumb ? { thumb: e.thumb } : {}),
        ...(e.proxyState ? { proxyState: e.proxyState } : {}),
        ...(e.proxyPath ? { proxyPath: e.proxyPath } : {}),
      };
      if (Object.keys(change).length > 0) s.patchMedia(e.id, change);
    });
  }, []);

  // A file dropped outside the media pool must do nothing, rather than make Chromium open it.
  useEffect(() => {
    const swallow = (e: DragEvent) => {
      if (e.dataTransfer?.types.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', swallow);
    window.addEventListener('drop', swallow);
    return () => {
      window.removeEventListener('dragover', swallow);
      window.removeEventListener('drop', swallow);
    };
  }, []);

  useEffect(() => {
    const warn = (e: BeforeUnloadEvent) => {
      if (useStore.getState().dirty) e.returnValue = false;
    };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, []);

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">Kulör</div>
        <button onClick={() => void importDialog()}>Importera</button>
        <button onClick={() => void openProject()}>Öppna</button>
        <button onClick={() => void saveProject()}>Spara</button>
        <span className="divider" />
        <button disabled={!canUndo} onClick={() => useStore.getState().undo()} title="Ctrl+Z">Ångra</button>
        <button disabled={!canRedo} onClick={() => useStore.getState().redo()} title="Ctrl+Y">Gör om</button>
        <div className="project-name">{name}{dirty ? ' *' : ''}</div>
        <div className="status">{status}</div>
      </header>

      <main className="page">
        {page === 'media' && <MediaPage />}
        {page === 'edit' && <EditPage />}
        {page === 'color' && <ColorPage />}
        {page === 'audio' && <AudioPage />}
        {page === 'deliver' && <DeliverPage />}
      </main>

      <nav className="pagebar">
        {PAGES.map((p) => (
          <button key={p.id} className={p.id === page ? 'active' : ''} onClick={() => setPage(p.id)}>
            {p.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
