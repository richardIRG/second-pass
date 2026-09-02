import { contextBridge, ipcRenderer, webUtils } from 'electron';

import type {
  AppCommand,
  CodexConnectRequest,
  CodexEvent,
  CodexTurnRequest,
  EditorApi,
  ExternalFileChange,
  SaveCopyRequest,
  SaveFileRequest,
} from './shared/types';

const api: EditorApi = {
  openFile: () => ipcRenderer.invoke('file:open'),
  openPath: (path) => ipcRenderer.invoke('file:open-path', path),
  getDroppedFilePath: (file) => webUtils.getPathForFile(file),
  getLaunchDocument: () => ipcRenderer.invoke('file:get-launch-document'),
  getRecentFiles: () => ipcRenderer.invoke('file:recent'),
  reloadFile: (path) => ipcRenderer.invoke('file:reload', path),
  saveFile: (request: SaveFileRequest) => ipcRenderer.invoke('file:save', request),
  saveCopy: (request: SaveCopyRequest) => ipcRenderer.invoke('file:save-copy', request),
  chooseImageAsset: () => ipcRenderer.invoke('image:choose'),
  listHistory: (path) => ipcRenderer.invoke('history:list', path),
  loadHistory: (path, id) => ipcRenderer.invoke('history:load', path, id),
  loadDraft: (path) => ipcRenderer.invoke('draft:load', path),
  saveDraft: (draft) => ipcRenderer.invoke('draft:save', draft),
  clearDraft: (path) => ipcRenderer.invoke('draft:clear', path),
  openLink: (url) => ipcRenderer.invoke('link:open', url),
  setPreviewContent: (html) => ipcRenderer.invoke('preview:set-content', html),
  saveVinextProject: (operations) => ipcRenderer.invoke('vinext:save', operations),
  stopVinextProject: () => ipcRenderer.invoke('vinext:stop'),
  confirmUnsaved: (reason) => ipcRenderer.invoke('app:confirm-unsaved', reason),
  connectCodex: (request: CodexConnectRequest) => ipcRenderer.invoke('codex:connect', request),
  startCodexTurn: (request: CodexTurnRequest) => ipcRenderer.invoke('codex:start-turn', request),
  interruptCodex: (threadId) => ipcRenderer.invoke('codex:interrupt', threadId),
  respondToCodexApproval: (requestId, decision) => ipcRenderer.invoke('codex:respond-approval', requestId, decision),
  setDirty: (dirty) => ipcRenderer.send('app:set-dirty', dirty),
  closeAfterSave: () => ipcRenderer.send('app:close-after-save'),
  onExternalChange: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, change: ExternalFileChange) => callback(change);
    ipcRenderer.on('file:external-change', listener);
    return () => ipcRenderer.removeListener('file:external-change', listener);
  },
  onCommand: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, command: AppCommand) => callback(command);
    ipcRenderer.on('app:command', listener);
    return () => ipcRenderer.removeListener('app:command', listener);
  },
  onCodexEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, codexEvent: CodexEvent) => callback(codexEvent);
    ipcRenderer.on('codex:event', listener);
    return () => ipcRenderer.removeListener('codex:event', listener);
  },
};

contextBridge.exposeInMainWorld('codexEditor', api);
