import { contextBridge, ipcRenderer, webUtils } from 'electron';
import type { KulorApi, MediaEvent } from '../src/core/ipc';

const invoke = ipcRenderer.invoke.bind(ipcRenderer);

const api: KulorApi = {
  pickFiles: () => invoke('pick-files'),
  pathForFile: (file) => webUtils.getPathForFile(file),
  importMedia: (paths) => invoke('import-media', paths),
  prepareMedia: (ids) => invoke('prepare-media', ids),
  onMediaEvent(handler) {
    const listener = (_: unknown, event: MediaEvent) => handler(event);
    ipcRenderer.on('media-event', listener);
    return () => ipcRenderer.off('media-event', listener);
  },
  waveform: (mediaId) => invoke('waveform', mediaId),
  saveProject: (project, path) => invoke('save-project', project, path),
  openProject: () => invoke('open-project'),
  loadProject: (path) => invoke('load-project', path),
  pickExportPath: (suggested, format) => invoke('pick-export-path', suggested, format),
  exportEncoders: () => invoke('export-encoders'),
  exportBegin: (project, settings) => invoke('export-begin', project, settings),
  exportFrame: (rgba) => invoke('export-frame', rgba),
  exportFinish: () => invoke('export-finish'),
  exportCancel: () => invoke('export-cancel'),
  decoderOpen: (request) => invoke('decoder-open', request),
  decoderRead: (id) => invoke('decoder-read', id),
  decoderClose: (id) => invoke('decoder-close', id),
  showInFolder: (path) => invoke('show-in-folder', path),
};

contextBridge.exposeInMainWorld('kulor', api);
