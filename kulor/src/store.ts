import { create } from 'zustand';
import type { Clip, Id, MediaItem, Project } from './core/types';
import { newProject } from './core/timeline';

export type Page = 'media' | 'edit' | 'color' | 'audio' | 'deliver';
export type Tool = 'select' | 'blade';

const HISTORY_LIMIT = 200;
const COALESCE_MS = 700;

interface Store {
  project: Project;
  projectPath: string | null;
  dirty: boolean;
  page: Page;
  tool: Tool;
  snapping: boolean;
  selection: Id[];
  playhead: number;
  playing: boolean;
  pixelsPerFrame: number;
  undoStack: Project[];
  redoStack: Project[];
  lastCommitKey: string | null;
  lastCommitAt: number;
  activeNodeId: Id | null;
  proxyProgress: Record<Id, number>;
  useProxies: boolean;
  status: string;

  /**
   * Applies an edit with undo. Calls sharing a coalesce key within a short time window become one
   * undo step, so dragging a colour wheel does not leave hundreds of them.
   */
  commit(edit: (p: Project) => Project, coalesceKey?: string): void;
  undo(): void;
  redo(): void;
  loadProject(project: Project, path: string | null): void;
  patchMedia(id: Id, change: Partial<MediaItem>): void;
  setPage(page: Page): void;
  setTool(tool: Tool): void;
  setSelection(ids: Id[]): void;
  setPlayhead(frame: number): void;
  setPlaying(playing: boolean): void;
  setZoom(pixelsPerFrame: number): void;
  toggleSnapping(): void;
  setActiveNode(id: Id | null): void;
  setProxyProgress(id: Id, value: number): void;
  setUseProxies(value: boolean): void;
  setStatus(text: string): void;
  markSaved(path: string): void;
}

export const useStore = create<Store>((set, get) => ({
  project: newProject(),
  projectPath: null,
  dirty: false,
  page: 'media',
  tool: 'select',
  snapping: true,
  selection: [],
  playhead: 0,
  playing: false,
  pixelsPerFrame: 2,
  undoStack: [],
  redoStack: [],
  lastCommitKey: null,
  lastCommitAt: 0,
  activeNodeId: null,
  proxyProgress: {},
  useProxies: true,
  status: '',

  commit(edit, coalesceKey) {
    const state = get();
    const next = edit(state.project);
    if (next === state.project) return;
    const now = performance.now();
    const coalesce = !!coalesceKey && coalesceKey === state.lastCommitKey && now - state.lastCommitAt < COALESCE_MS;
    set({
      project: next,
      dirty: true,
      undoStack: coalesce ? state.undoStack : [...state.undoStack.slice(-HISTORY_LIMIT + 1), state.project],
      redoStack: [],
      lastCommitKey: coalesceKey ?? null,
      lastCommitAt: now,
    });
  },

  undo() {
    const { undoStack, redoStack, project } = get();
    const previous = undoStack.at(-1);
    if (!previous) return;
    set({
      project: previous,
      undoStack: undoStack.slice(0, -1),
      redoStack: [...redoStack, project],
      lastCommitKey: null,
      dirty: true,
    });
  },

  redo() {
    const { undoStack, redoStack, project } = get();
    const next = redoStack.at(-1);
    if (!next) return;
    set({
      project: next,
      redoStack: redoStack.slice(0, -1),
      undoStack: [...undoStack, project],
      lastCommitKey: null,
      dirty: true,
    });
  },

  loadProject(project, path) {
    set({
      project,
      projectPath: path,
      dirty: false,
      undoStack: [],
      redoStack: [],
      selection: [],
      playhead: 0,
      activeNodeId: null,
    });
  },

  // Media facts arriving from background jobs are not edits, so they stay out of the undo history.
  // They are written through the stacks too: undoing must not bring an old "no thumbnail" back.
  patchMedia(id, change) {
    const patch = (p: Project): Project => ({
      ...p,
      media: p.media.map((m) => (m.id === id ? { ...m, ...change } : m)),
    });
    set((s) => ({
      project: patch(s.project),
      undoStack: s.undoStack.map(patch),
      redoStack: s.redoStack.map(patch),
    }));
  },

  setPage: (page) => set({ page }),
  setTool: (tool) => set({ tool }),
  setSelection: (selection) => set({ selection }),
  setPlayhead: (playhead) => set({ playhead: Math.max(0, Math.round(playhead)) }),
  setPlaying: (playing) => set({ playing }),
  setZoom: (pixelsPerFrame) => set({ pixelsPerFrame: Math.min(40, Math.max(0.02, pixelsPerFrame)) }),
  toggleSnapping: () => set((s) => ({ snapping: !s.snapping })),
  setActiveNode: (activeNodeId) => set({ activeNodeId }),
  setProxyProgress: (id, value) => set((s) => ({ proxyProgress: { ...s.proxyProgress, [id]: value } })),
  setUseProxies: (useProxies) => set({ useProxies }),
  setStatus: (status) => set({ status }),
  markSaved: (projectPath) => set({ projectPath, dirty: false }),
}));

/** The clip the Color page and the inspector act on. */
export function currentVideoClip(project: Project, selection: Id[], playhead: number): Clip | null {
  const selected = project.clips.find((c) => selection.includes(c.id) && trackKind(project, c) === 'video');
  if (selected) return selected;
  for (const t of [...project.tracks].reverse()) {
    if (t.kind !== 'video') continue;
    const c = project.clips.find((x) => x.trackId === t.id && playhead >= x.start && playhead < x.start + x.duration);
    if (c) return c;
  }
  return null;
}

export function trackKind(project: Project, clip: Clip) {
  return project.tracks.find((t) => t.id === clip.trackId)?.kind;
}

export function mediaUrl(media: MediaItem, useProxies: boolean): string {
  const file = media.proxyState === 'ready' && media.proxyPath && (useProxies || media.needsProxy) ? media.proxyPath : media.path;
  return fileUrl(file);
}

export const fileUrl = (file: string): string => `kulor-media://local/${encodeURIComponent(file)}`;
