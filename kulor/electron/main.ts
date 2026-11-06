import { app, BrowserWindow, dialog, ipcMain, protocol, shell } from 'electron';
import { createReadStream } from 'node:fs';
import fs from 'node:fs/promises';
import path from 'node:path';
import { Readable } from 'node:stream';
import type { MediaItem, Project } from '../src/core/types';
import type { DecoderRequest, ExportSettings, MediaEvent, VideoFormat } from '../src/core/ipc';
import { makeProxy, makeThumbnail, probe, waveform } from './ffmpeg';
import {
  decoderClose, decoderOpen, decoderRead, exportBegin, exportCancel, exportFinish, exportFrame, pickEncoders,
} from './exporter';

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'kulor-media',
    privileges: { standard: true, secure: true, stream: true, supportFetchAPI: true, corsEnabled: true, bypassCSP: true },
  },
]);

// Timeline playback starts without a click on the page, for instance from the keyboard.
app.commandLine.appendSwitch('autoplay-policy', 'no-user-gesture-required');

let window: BrowserWindow | null = null;
let cacheDir = '';

/** The media protocol only serves files the user has actually brought into a project. */
const allowed = new Set<string>();
const knownMedia = new Map<string, MediaItem>();

const MIME: Record<string, string> = {
  '.mp4': 'video/mp4', '.m4v': 'video/mp4', '.mov': 'video/mp4', '.webm': 'video/webm', '.mkv': 'video/x-matroska',
  '.mp3': 'audio/mpeg', '.wav': 'audio/wav', '.flac': 'audio/flac', '.ogg': 'audio/ogg', '.m4a': 'audio/mp4',
  '.aac': 'audio/aac', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp',
  '.bmp': 'image/bmp', '.gif': 'image/gif',
};

async function serveMedia(request: Request): Promise<Response> {
  const url = new URL(request.url);
  const file = decodeURIComponent(url.pathname.slice(1));
  if (!allowed.has(file)) return new Response('Inte tillåten', { status: 403 });

  let size: number;
  try {
    size = (await fs.stat(file)).size;
  } catch {
    return new Response('Saknas', { status: 404 });
  }

  const headers: Record<string, string> = {
    'Content-Type': MIME[path.extname(file).toLowerCase()] ?? 'application/octet-stream',
    'Accept-Ranges': 'bytes',
    'Access-Control-Allow-Origin': '*',
  };

  // Video seeking lives on range requests.
  const range = /bytes=(\d+)-(\d*)/.exec(request.headers.get('range') ?? '');
  if (range) {
    const start = Number(range[1]);
    const end = range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (start >= size) return new Response(null, { status: 416, headers: { 'Content-Range': `bytes */${size}` } });
    const stream = createReadStream(file, { start, end, highWaterMark: 1 << 20 });
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 206,
      headers: { ...headers, 'Content-Length': String(end - start + 1), 'Content-Range': `bytes ${start}-${end}/${size}` },
    });
  }
  const stream = createReadStream(file, { highWaterMark: 1 << 20 });
  return new Response(Readable.toWeb(stream) as ReadableStream, {
    headers: { ...headers, 'Content-Length': String(size) },
  });
}

function emit(event: MediaEvent): void {
  window?.webContents.send('media-event', event);
}

/** Background work per media item. The import itself returns as soon as the file is probed. */
async function prepareMedia(media: MediaItem): Promise<void> {
  try {
    const thumb = await makeThumbnail(media, cacheDir);
    if (thumb) {
      allowed.add(thumb);
      emit({ id: media.id, thumb });
    }
  } catch (e) {
    console.error('Miniatyr misslyckades', e);
  }

  if (media.needsProxy && media.proxyState !== 'ready') {
    emit({ id: media.id, proxyState: 'working', proxyProgress: 0 });
    try {
      const proxyPath = await makeProxy(media, cacheDir, (proxyProgress) => emit({ id: media.id, proxyProgress }));
      allowed.add(proxyPath);
      emit({ id: media.id, proxyState: 'ready', proxyPath, proxyProgress: 1 });
    } catch (e) {
      console.error('Proxy misslyckades', e);
      emit({ id: media.id, proxyState: 'failed' });
    }
  }
}

function registerMedia(media: MediaItem): void {
  knownMedia.set(media.id, media);
  allowed.add(media.path);
  if (media.proxyPath) allowed.add(media.proxyPath);
  if (media.thumb) allowed.add(media.thumb);
}

async function readProject(filePath: string): Promise<{ project: Project; path: string }> {
  const project = JSON.parse(await fs.readFile(filePath, 'utf8')) as Project;
  if (project.version !== 1) throw new Error('Projektfilen har en okänd version.');
  await Promise.all(
    project.media.map(async (m) => {
      m.offline = await fs.access(m.path).then(() => false, () => true);
      registerMedia(m);
    }),
  );
  return { project, path: filePath };
}

function registerIpc(): void {
  ipcMain.handle('pick-files', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Importera media',
      properties: ['openFile', 'multiSelections'],
      filters: [
        { name: 'Media', extensions: ['mp4', 'mov', 'mkv', 'webm', 'avi', 'm4v', 'mxf', 'mp3', 'wav', 'flac', 'aac', 'm4a', 'ogg', 'png', 'jpg', 'jpeg', 'bmp', 'webp'] },
        { name: 'Alla filer', extensions: ['*'] },
      ],
    });
    return result.canceled ? [] : result.filePaths;
  });

  ipcMain.handle('import-media', async (_e, paths: string[]) => {
    const items: MediaItem[] = [];
    for (const p of paths) {
      const media = await probe(p);
      registerMedia(media);
      items.push(media);
    }
    return items;
  });

  // Called by the renderer once it holds the items. Started any earlier, a cached thumbnail could
  // announce itself for a media id the renderer has not heard of yet, and be lost.
  ipcMain.handle('prepare-media', (_e, ids: string[]) => {
    for (const id of ids) {
      const media = knownMedia.get(id);
      if (media && !media.offline) void prepareMedia(media);
    }
  });

  ipcMain.handle('waveform', async (_e, mediaId: string) => {
    const media = knownMedia.get(mediaId);
    return media ? waveform(media, cacheDir) : null;
  });

  ipcMain.handle('save-project', async (_e, project: Project, target: string | null) => {
    let file = target;
    if (!file) {
      const result = await dialog.showSaveDialog(window!, {
        title: 'Spara projekt',
        defaultPath: `${project.name}.kulor`,
        filters: [{ name: 'Kulör-projekt', extensions: ['kulor'] }],
      });
      if (result.canceled || !result.filePath) return null;
      file = result.filePath;
    }
    // Written beside the target and swapped in, so a crash mid-write cannot eat the project.
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(project, null, 1));
    await fs.rename(temp, file);
    return file;
  });

  ipcMain.handle('open-project', async () => {
    const result = await dialog.showOpenDialog(window!, {
      title: 'Öppna projekt',
      properties: ['openFile'],
      filters: [{ name: 'Kulör-projekt', extensions: ['kulor'] }],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return readProject(result.filePaths[0]);
  });

  ipcMain.handle('load-project', (_e, file: string) => readProject(file));

  ipcMain.handle('pick-export-path', async (_e, suggested: string, format: VideoFormat) => {
    const extension = format === 'prores' || format === 'dnxhr' ? 'mov' : 'mp4';
    const result = await dialog.showSaveDialog(window!, {
      title: 'Exportera video',
      defaultPath: path.join(app.getPath('videos'), `${suggested}.${extension}`),
      filters: [{ name: 'Video', extensions: [extension] }],
    });
    return result.canceled ? null : (result.filePath ?? null);
  });

  ipcMain.handle('export-encoders', () => pickEncoders());
  ipcMain.handle('export-begin', (_e, project: Project, settings: ExportSettings) => exportBegin(project, settings));
  ipcMain.handle('export-frame', (_e, rgba: Uint8Array) => exportFrame(rgba));
  ipcMain.handle('export-finish', () => exportFinish());
  ipcMain.handle('export-cancel', () => exportCancel());
  ipcMain.handle('decoder-open', (_e, request: DecoderRequest) => decoderOpen(request));
  ipcMain.handle('decoder-read', (_e, id: string) => decoderRead(id));
  ipcMain.handle('decoder-close', (_e, id: string) => decoderClose(id));
  ipcMain.handle('show-in-folder', (_e, file: string) => shell.showItemInFolder(file));
}

async function createWindow(): Promise<void> {
  window = new BrowserWindow({
    width: 1600,
    height: 950,
    minWidth: 1100,
    minHeight: 700,
    backgroundColor: '#17181b',
    title: 'Kulör',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  window.on('closed', () => {
    window = null;
  });

  // The app is a single page, so anything that would navigate it would throw the project away.
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (e) => e.preventDefault());

  // Electron shows no dialog of its own for beforeunload: without this the window just stays open.
  window.webContents.on('will-prevent-unload', (e) => {
    const choice = dialog.showMessageBoxSync(window!, {
      type: 'question',
      title: 'Osparade ändringar',
      message: 'Projektet har osparade ändringar.',
      detail: 'Vill du stänga ändå? Ändringarna går förlorade.',
      buttons: ['Stäng utan att spara', 'Avbryt'],
      defaultId: 1,
      cancelId: 1,
    });
    if (choice === 0) e.preventDefault();
  });

  const devUrl = process.env.KULOR_DEV_URL;
  if (devUrl) await window.loadURL(devUrl);
  else await window.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
}

void app.whenReady().then(async () => {
  cacheDir = path.join(app.getPath('userData'), 'media-cache');
  await fs.mkdir(cacheDir, { recursive: true });
  protocol.handle('kulor-media', serveMedia);
  registerIpc();
  await createWindow();
});

app.on('window-all-closed', () => {
  void exportCancel().finally(() => app.quit());
});
