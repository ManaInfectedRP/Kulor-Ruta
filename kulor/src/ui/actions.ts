import { addClipFromMedia, addTitleClip, deleteClips, splitClips, timelineEnd } from '../core/timeline';
import { TITLE_PRESETS } from '../core/title';
import type { Id, MediaItem } from '../core/types';
import { player } from '../engine/player';
import { useStore } from '../store';

export async function importPaths(paths: string[]): Promise<void> {
  const { setStatus, commit } = useStore.getState();
  if (paths.length === 0) return;
  setStatus(`Importerar ${paths.length} fil(er)…`);
  try {
    const items = await window.kulor.importMedia(paths);
    commit((p) => {
      const first = p.media.length === 0 && p.clips.length === 0 ? items.find((m) => m.kind === 'video') : undefined;
      return {
        ...p,
        media: [...p.media, ...items],
        // The first clip decides the project format, which is nearly always what one wants.
        ...(first ? { width: first.width & ~1, height: first.height & ~1, fps: Math.round(first.fps * 1000) / 1000 || p.fps } : {}),
      };
    });
    await window.kulor.prepareMedia(items.map((m) => m.id));
    setStatus(`${items.length} fil(er) importerade`);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

export async function importDialog(): Promise<void> {
  await importPaths(await window.kulor.pickFiles());
}

export function placeOnTimeline(media: MediaItem, trackId?: Id, frame?: number): void {
  const { commit, project } = useStore.getState();
  commit((p) => addClipFromMedia(p, media, trackId, frame ?? timelineEnd(project)));
}

/** Adds a title from a preset and selects it, so its text can be edited right away. */
export function addTitle(presetId: string, trackId?: Id, frame?: number): void {
  const preset = TITLE_PRESETS.find((p) => p.id === presetId);
  if (!preset) return;
  const { commit, project, playhead, setSelection } = useStore.getState();
  const known = new Set(project.clips.map((c) => c.id));
  commit((p) => addTitleClip(p, structuredClone(preset.title), trackId, frame ?? playhead));
  const added = useStore.getState().project.clips.find((c) => !known.has(c.id));
  if (added) setSelection([added.id]);
}

export function splitAtPlayhead(): void {
  const { selection, playhead, project, commit } = useStore.getState();
  const targets = selection.length > 0 ? selection : project.clips.map((c) => c.id);
  commit((p) => splitClips(p, targets, playhead));
}

export function deleteSelection(ripple: boolean): void {
  const { selection, commit, setSelection } = useStore.getState();
  if (selection.length === 0) return;
  commit((p) => deleteClips(p, selection, ripple));
  setSelection([]);
}

export async function saveProject(saveAs = false): Promise<void> {
  const { project, projectPath, markSaved, setStatus } = useStore.getState();
  const path = await window.kulor.saveProject(project, saveAs ? null : projectPath);
  if (path) {
    markSaved(path);
    setStatus(`Sparat: ${path}`);
  }
}

export async function openProject(): Promise<void> {
  const { loadProject, setStatus } = useStore.getState();
  try {
    const opened = await window.kulor.openProject();
    if (!opened) return;
    loadProject(opened.project, opened.path);
    await window.kulor.prepareMedia(opened.project.media.map((m) => m.id));
    const missing = opened.project.media.filter((m) => m.offline).length;
    setStatus(missing ? `${missing} mediefil(er) saknas på disken` : `Öppnade ${opened.project.name}`);
  } catch (e) {
    setStatus(e instanceof Error ? e.message : String(e));
  }
}

export function formatTimecode(frame: number, fps: number): string {
  const rounded = Math.round(fps);
  const f = Math.floor(frame);
  const ff = f % rounded;
  const total = Math.floor(f / rounded);
  const ss = total % 60;
  const mm = Math.floor(total / 60) % 60;
  const hh = Math.floor(total / 3600);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${pad(hh)}:${pad(mm)}:${pad(ss)}:${pad(ff)}`;
}

export function installShortcuts(): () => void {
  const onKey = (e: KeyboardEvent) => {
    const target = e.target as HTMLElement;
    if (target.matches('input:not([type=range]), textarea, select')) return;

    const s = useStore.getState();
    const p = player();
    const ctrl = e.ctrlKey || e.metaKey;
    const key = e.key.toLowerCase();

    if (ctrl && key === 'z') s.undo();
    else if (ctrl && key === 'y') s.redo();
    else if (ctrl && key === 's') void saveProject(e.shiftKey);
    else if (ctrl && key === 'o') void openProject();
    else if (ctrl && key === 'i') void importDialog();
    else if (ctrl && key === 'b') splitAtPlayhead();
    else if (ctrl) return;
    else if (key === ' ') p.togglePlay();
    else if (key === 'k') p.pause();
    else if (key === 'l') p.shuttle(1);
    else if (key === 'j') p.shuttle(-1);
    else if (key === 'arrowleft') p.seek(s.playhead - (e.shiftKey ? 10 : 1));
    else if (key === 'arrowright') p.seek(s.playhead + (e.shiftKey ? 10 : 1));
    else if (key === 'home') p.seek(0);
    else if (key === 'end') p.seek(timelineEnd(s.project));
    else if (key === 'i') s.commit((x) => ({ ...x, markIn: s.playhead }));
    else if (key === 'o') s.commit((x) => ({ ...x, markOut: s.playhead }));
    else if (key === 'x') s.commit((x) => ({ ...x, markIn: null, markOut: null }));
    else if (key === 'a') s.setTool('select');
    else if (key === 'b') s.setTool('blade');
    else if (key === 'n') s.toggleSnapping();
    else if (key === 'delete' || key === 'backspace') deleteSelection(e.shiftKey);
    else if (key === '+' || key === '=') s.setZoom(s.pixelsPerFrame * 1.25);
    else if (key === '-') s.setZoom(s.pixelsPerFrame / 1.25);
    else return;
    e.preventDefault();
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
