import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import type { FSWatcher } from 'chokidar';
import chokidar from 'chokidar';
import squirrelStartup from 'electron-squirrel-startup';
import {
  app,
  BrowserWindow,
  dialog,
  ipcMain,
  Menu,
  net,
  protocol,
  shell,
  type MenuItemConstructorOptions,
} from 'electron';

import {
  clearDraft,
  getDiskVersion,
  isFrameworkHtmlShell,
  listHistory,
  listRecentFiles,
  loadCodexBinding,
  loadDraft,
  loadHistory,
  readHtmlDocument,
  saveCodexBinding,
  saveDraft,
  saveHtmlFile,
  touchRecentFile,
} from './lib/file-storage';
import { CodexWorkspaceBridge } from './lib/codex-app-server';
import { detectVinextProject, VinextPreviewManager } from './lib/vinext-project';
import { importImageAsset } from './lib/image-assets';
import type {
  AppCommand,
  CodexConnectRequest,
  CodexTurnRequest,
  DraftSnapshot,
  ExternalFileChange,
  HtmlDocument,
  SaveCopyRequest,
  SaveFileRequest,
  VinextEditOperation,
  VinextProjectSession,
} from './shared/types';

if (squirrelStartup) app.quit();
if (process.platform === 'win32') app.setAppUserModelId('com.squirrel.SecondPass.SecondPass');

protocol.registerSchemesAsPrivileged([
  {
    scheme: 'codex-asset',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
    },
  },
  {
    scheme: 'document-preview',
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: false,
      corsEnabled: false,
    },
  },
]);

let mainWindow: BrowserWindow | null = null;
let currentWatcher: FSWatcher | null = null;
let currentPath: string | null = null;
let currentAssetRoot: string | null = null;
let lastKnownHash: string | null = null;
let rendererDirty = false;
let forceClose = false;
let launchDocumentConsumed = false;
let codexBridge: CodexWorkspaceBridge | null = null;
let vinextPreviewManager: VinextPreviewManager | null = null;
let currentVinextProject: VinextProjectSession | null = null;
const previewDocuments = new Map<string, string>();

async function setCurrentDocument(document: HtmlDocument): Promise<void> {
  await vinextPreviewManager?.stop();
  currentVinextProject = null;
  if (currentPath && resolve(currentPath) !== resolve(document.path)) await codexBridge?.detach();
  currentPath = document.path;
  currentAssetRoot = document.baseDirectory;
  lastKnownHash = document.version.sha256;
  await touchRecentFile(app.getPath('userData'), document.path);
  await currentWatcher?.close();
  currentWatcher = chokidar.watch(document.path, {
    ignoreInitial: true,
    awaitWriteFinish: { stabilityThreshold: 150, pollInterval: 40 },
  });

  currentWatcher.on('change', async () => {
    if (!currentPath || !mainWindow) return;
    try {
      const version = await getDiskVersion(currentPath);
      if (version.sha256 === lastKnownHash) return;
      const change: ExternalFileChange = { path: currentPath, version, removed: false };
      mainWindow.webContents.send('file:external-change', change);
    } catch {
      const change: ExternalFileChange = { path: currentPath, version: null, removed: true };
      mainWindow.webContents.send('file:external-change', change);
    }
  });
  currentWatcher.on('unlink', () => {
    if (!currentPath || !mainWindow) return;
    const change: ExternalFileChange = { path: currentPath, version: null, removed: true };
    mainWindow.webContents.send('file:external-change', change);
  });
}

function isInsideRoot(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function openWithDialog(): Promise<{ status: 'opened'; document: HtmlDocument } | { status: 'cancelled' }> {
  const result = await dialog.showOpenDialog(mainWindow!, {
    title: 'Open an HTML document',
    properties: ['openFile'],
    filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
  });
  if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' };
  const document = await readHtmlDocument(result.filePaths[0]);
  await setCurrentDocument(document);
  return { status: 'opened', document };
}

async function openPath(path: string): Promise<{ status: 'opened'; document: HtmlDocument }> {
  const document = await readHtmlDocument(path);
  await setCurrentDocument(document);
  return { status: 'opened', document };
}

async function chooseImageAsset() {
  const target = currentVinextProject
    ? { kind: 'vinext' as const, root: currentVinextProject.root }
    : currentAssetRoot
      ? { kind: 'html' as const, root: currentAssetRoot }
      : null;
  if (!target) return { status: 'error' as const, message: 'Open an HTML document or Vinext project before choosing an image.' };
  try {
    let sourcePath = process.env.SECOND_PASS_TEST_IMAGE_PATH;
    if (!sourcePath) {
      const result = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose a replacement image',
        buttonLabel: 'Use Image',
        properties: ['openFile'],
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif', 'svg'] }],
      });
      if (result.canceled || !result.filePaths[0]) return { status: 'cancelled' as const };
      sourcePath = result.filePaths[0];
    }
    const imported = await importImageAsset(sourcePath, target);
    return { status: 'selected' as const, src: imported.src, fileName: imported.fileName };
  } catch (error) {
    return { status: 'error' as const, message: error instanceof Error ? error.message : 'Unable to import the selected image.' };
  }
}

function isFileAccessError(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? (error as NodeJS.ErrnoException).code : undefined;
  return code === 'EPERM' || code === 'EACCES';
}

async function readSelectedDetectedDocument(path: string): Promise<HtmlDocument> {
  const document = await readHtmlDocument(path);
  if (isFrameworkHtmlShell(document.source)) {
    throw new Error(`${basename(document.path)} is a React or app entrypoint. Choose a standalone HTML document that contains the rendered page.`);
  }
  return document;
}

async function chooseDetectedHtmlDocument(paths: string[], workspaceRoot: string): Promise<HtmlDocument> {
  const documents: HtmlDocument[] = [];
  const inaccessiblePaths: string[] = [];
  let frameworkShellCount = 0;
  for (const path of [...new Set(paths.map((candidate) => resolve(candidate)))]) {
    try {
      const document = await readHtmlDocument(path);
      if (isFrameworkHtmlShell(document.source)) frameworkShellCount += 1;
      else documents.push(document);
    } catch (error) {
      if (isFileAccessError(error)) inaccessiblePaths.push(path);
      else throw error;
    }
  }

  if (documents.length === 1 && inaccessiblePaths.length === 0) return documents[0];

  if (documents.length > 1) {
    app.focus({ steal: true });
    mainWindow?.show();
    mainWindow?.focus();
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose the page from this Codex task',
      message: 'This task contains more than one editable HTML document. Choose the rendered page you want to open.',
      buttonLabel: 'Open in Second Pass',
      defaultPath: documents[0].baseDirectory,
      properties: ['openFile'],
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      throw new Error('No HTML document was selected. Connect the task again when you are ready to choose one.');
    }
    return readSelectedDetectedDocument(result.filePaths[0]);
  }

  if (inaccessiblePaths.length > 0) {
    app.focus({ steal: true });
    mainWindow?.show();
    mainWindow?.focus();
    const result = await dialog.showOpenDialog(mainWindow!, {
      title: 'Open the page from this Codex task',
      message: 'Second Pass found HTML documents in this task. Choose the rendered standalone page once so macOS can grant access.',
      buttonLabel: 'Allow and Open',
      defaultPath: inaccessiblePaths.length === 1 ? inaccessiblePaths[0] : workspaceRoot,
      properties: ['openFile'],
      filters: [{ name: 'HTML', extensions: ['html', 'htm'] }],
    });
    if (result.canceled || !result.filePaths[0]) {
      throw new Error('Access was not granted. Connect the task again to reopen the macOS approval sheet.');
    }
    try {
      return await readSelectedDetectedDocument(result.filePaths[0]);
    } catch (retryError) {
      if (isFileAccessError(retryError)) {
        throw new Error('macOS did not grant access to that document. Check Privacy & Security settings, then open the file manually.');
      }
      throw retryError;
    }
  }

  if (frameworkShellCount > 0) {
    throw new Error('The task contains React or app entrypoints, but no standalone HTML document with the rendered page.');
  }
  throw new Error('Connected to the task, but could not find a readable standalone HTML document in its workspace.');
}

function assertTrustedSender(event: Electron.IpcMainInvokeEvent | Electron.IpcMainEvent): void {
  if (!mainWindow || event.sender.id !== mainWindow.webContents.id) throw new Error('Untrusted application request.');
}

function getLaunchPath(): string | undefined {
  if (process.env.SECOND_PASS_OPEN_FILE) return process.env.SECOND_PASS_OPEN_FILE;
  if (process.env.HTML_DOCUMENT_EDITOR_OPEN_FILE) return process.env.HTML_DOCUMENT_EDITOR_OPEN_FILE;
  if (process.env.CODEX_HTML_EDITOR_OPEN_FILE) return process.env.CODEX_HTML_EDITOR_OPEN_FILE;
  return process.argv.find((argument) => /\.html?$/i.test(argument));
}

async function openPreviewLink(rawUrl: string): Promise<{ status: 'opened' } | { status: 'blocked' | 'error'; message: string }> {
  if (typeof rawUrl !== 'string' || rawUrl.length > 4096) return { status: 'blocked', message: 'This link is not valid.' };
  try {
    const url = new URL(rawUrl);
    if (['http:', 'https:', 'mailto:', 'tel:'].includes(url.protocol)) {
      if (process.env.SECOND_PASS_DISABLE_EXTERNAL_OPEN === '1') return { status: 'opened' };
      if (process.env.HTML_DOCUMENT_EDITOR_DISABLE_EXTERNAL_OPEN === '1') return { status: 'opened' };
      await shell.openExternal(url.href);
      return { status: 'opened' };
    }
    if (url.protocol === 'codex-asset:' && url.hostname === 'local' && currentAssetRoot) {
      const candidate = resolve(currentAssetRoot, decodeURIComponent(url.pathname).replace(/^\/+/, ''));
      if (!isInsideRoot(candidate, currentAssetRoot)) return { status: 'blocked', message: 'That local link is outside this document folder.' };
      const message = await shell.openPath(candidate);
      return message ? { status: 'error', message } : { status: 'opened' };
    }
    return { status: 'blocked', message: 'This link type is blocked for safety.' };
  } catch {
    return { status: 'blocked', message: 'This link is not valid.' };
  }
}

function sendCommand(command: AppCommand): void {
  mainWindow?.webContents.send('app:command', command);
}

function getCodexBridge(): CodexWorkspaceBridge {
  codexBridge ??= new CodexWorkspaceBridge(app.getVersion(), app.getPath('home'), (event) => {
    mainWindow?.webContents.send('codex:event', event);
  }, { resourcesPath: process.resourcesPath, openSignIn: (url) => shell.openExternal(url) });
  return codexBridge;
}

function getVinextPreviewManager(): VinextPreviewManager {
  vinextPreviewManager ??= new VinextPreviewManager();
  return vinextPreviewManager;
}

async function setCurrentVinextProject(project: VinextProjectSession): Promise<void> {
  await currentWatcher?.close();
  currentWatcher = null;
  currentPath = null;
  currentAssetRoot = null;
  lastKnownHash = null;
  currentVinextProject = project;
}

function installMenu(): void {
  const template: MenuItemConstructorOptions[] = [
    {
      label: 'File',
      submenu: [
        { label: 'Open…', accelerator: 'CmdOrCtrl+O', click: () => sendCommand('open') },
        { label: 'Save', accelerator: 'CmdOrCtrl+S', click: () => sendCommand('save') },
        { type: 'separator' },
        { role: 'close' },
      ],
    },
    {
      label: 'Edit',
      submenu: [
        { label: 'Undo', accelerator: 'CmdOrCtrl+Z', click: () => sendCommand('undo') },
        { label: 'Redo', accelerator: 'CmdOrCtrl+Shift+Z', click: () => sendCommand('redo') },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { role: 'selectAll' },
      ],
    },
    { role: 'viewMenu' },
    { role: 'windowMenu' },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

function registerIpc(): void {
  ipcMain.handle('file:open', (event) => {
    assertTrustedSender(event);
    return openWithDialog();
  });
  ipcMain.handle('file:open-path', (event, path: string) => {
    assertTrustedSender(event);
    return openPath(path);
  });
  ipcMain.handle('file:get-launch-document', async (event) => {
    assertTrustedSender(event);
    if (launchDocumentConsumed) return null;
    launchDocumentConsumed = true;
    const launchPath = getLaunchPath();
    if (!launchPath) return null;
    const document = await readHtmlDocument(launchPath);
    await setCurrentDocument(document);
    return document;
  });
  ipcMain.handle('file:recent', (event) => {
    assertTrustedSender(event);
    return listRecentFiles(app.getPath('userData'));
  });
  ipcMain.handle('file:reload', async (event, path: string) => {
    assertTrustedSender(event);
    if (resolve(path) !== currentPath) throw new Error('The requested file is not open.');
    const document = await readHtmlDocument(path);
    await setCurrentDocument(document);
    return document;
  });
  ipcMain.handle('file:save', async (event, request: SaveFileRequest) => {
    assertTrustedSender(event);
    if (resolve(request.path) !== currentPath) return { status: 'error', message: 'The requested file is not open.' };
    const result = await saveHtmlFile(request, join(app.getPath('userData'), 'history'));
    if (result.status === 'saved') {
      lastKnownHash = result.document.version.sha256;
      currentAssetRoot = result.document.baseDirectory;
      await clearDraft(join(app.getPath('userData'), 'drafts'), request.path);
    }
    return result;
  });
  ipcMain.handle('file:save-copy', async (event, request: SaveCopyRequest) => {
    assertTrustedSender(event);
    try {
      const result = await dialog.showSaveDialog(mainWindow!, {
        title: 'Save editor version as a copy',
        defaultPath: join(currentAssetRoot ?? app.getPath('documents'), request.suggestedName),
        filters: [{ name: 'HTML', extensions: ['html'] }],
      });
      if (result.canceled || !result.filePath) return { status: 'cancelled' };
      if (resolve(result.filePath) === currentPath) {
        return { status: 'error', message: 'Choose a different filename for the editor copy.' };
      }
      await writeFile(result.filePath, request.source, { encoding: 'utf8', flag: 'w' });
      return { status: 'saved', path: result.filePath };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Unable to save a copy.' };
    }
  });
  ipcMain.handle('image:choose', (event) => {
    assertTrustedSender(event);
    return chooseImageAsset();
  });
  ipcMain.handle('history:list', (event, path: string) => {
    assertTrustedSender(event);
    if (resolve(path) !== currentPath) throw new Error('The requested file is not open.');
    return listHistory(join(app.getPath('userData'), 'history'), path);
  });
  ipcMain.handle('history:load', (event, path: string, id: string) => {
    assertTrustedSender(event);
    if (resolve(path) !== currentPath) throw new Error('The requested file is not open.');
    return loadHistory(join(app.getPath('userData'), 'history'), path, id);
  });
  ipcMain.handle('draft:load', (event, path: string) => {
    assertTrustedSender(event);
    if (resolve(path) !== currentPath) throw new Error('The requested file is not open.');
    return loadDraft(join(app.getPath('userData'), 'drafts'), path);
  });
  ipcMain.handle('draft:save', (event, draft: DraftSnapshot) => {
    assertTrustedSender(event);
    if (resolve(draft.path) !== currentPath) throw new Error('The requested file is not open.');
    return saveDraft(join(app.getPath('userData'), 'drafts'), draft);
  });
  ipcMain.handle('draft:clear', (event, path: string) => {
    assertTrustedSender(event);
    if (resolve(path) !== currentPath) throw new Error('The requested file is not open.');
    return clearDraft(join(app.getPath('userData'), 'drafts'), path);
  });
  ipcMain.handle('link:open', (event, url: string) => {
    assertTrustedSender(event);
    return openPreviewLink(url);
  });
  ipcMain.handle('preview:set-content', (event, html: string) => {
    assertTrustedSender(event);
    if (typeof html !== 'string' || Buffer.byteLength(html, 'utf8') > 20 * 1024 * 1024) {
      throw new Error('The preview is too large to render safely.');
    }
    const id = randomUUID();
    previewDocuments.clear();
    previewDocuments.set(id, html);
    return `document-preview://local/${id}`;
  });
  ipcMain.handle('vinext:save', (event, operations: VinextEditOperation[]) => {
    assertTrustedSender(event);
    if (!currentVinextProject) return { status: 'error', message: 'No Vinext project is open.' };
    return getVinextPreviewManager().save(operations, join(app.getPath('userData'), 'history'));
  });
  ipcMain.handle('vinext:stop', async (event) => {
    assertTrustedSender(event);
    await vinextPreviewManager?.stop();
    currentVinextProject = null;
  });
  ipcMain.handle('codex:connect', async (event, request: CodexConnectRequest) => {
    assertTrustedSender(event);
    const requestedPath = request.documentPath ? resolve(request.documentPath) : null;
    const requestedProjectRoot = request.projectRoot ? resolve(request.projectRoot) : null;
    const validHtmlPath = Boolean(requestedPath && currentPath && requestedPath === currentPath);
    const validProjectPath = Boolean(
      requestedPath
      && requestedProjectRoot
      && currentVinextProject
      && requestedPath === resolve(currentVinextProject.entryPath)
      && requestedProjectRoot === resolve(currentVinextProject.root),
    );
    if (requestedPath && !validHtmlPath && !validProjectPath) throw new Error('The requested document or project is not open.');
    const documentPath = requestedPath ?? currentPath ?? currentVinextProject?.entryPath ?? null;
    const explicitReference = request.threadReference?.trim();
    if (!documentPath && !explicitReference) throw new Error('Paste a Codex task link or thread ID to connect.');
    const savedThreadId = documentPath && !explicitReference && !request.forceNew
      ? await loadCodexBinding(app.getPath('userData'), documentPath)
      : null;
    try {
      let session = await getCodexBridge().connect({
        ...request,
        documentPath: documentPath ?? undefined,
        threadReference: explicitReference || savedThreadId || undefined,
      });
      let openedDocument: HtmlDocument | undefined;
      let openedProject: VinextProjectSession | undefined;
      if (!documentPath) {
        try {
          if (session.workspaceKind === 'vinext' && session.projectRoot) {
            const descriptor = await detectVinextProject(session.projectRoot);
            if (!descriptor) throw new Error('The task no longer contains a detectable Vinext App Router project.');
            openedProject = await getVinextPreviewManager().start(descriptor);
            await setCurrentVinextProject(openedProject);
          } else {
            openedDocument = await chooseDetectedHtmlDocument(session.documentCandidates, session.cwd);
            if (openedDocument.path !== session.documentPath) session = getCodexBridge().attachDocument(openedDocument.path);
            await setCurrentDocument(openedDocument);
          }
        } catch (error) {
          await getCodexBridge().detach().catch(() => undefined);
          throw error;
        }
      }
      await saveCodexBinding(app.getPath('userData'), session.documentPath, session.threadId);
      return { session, document: openedDocument, project: openedProject };
    } catch (error) {
      if (!savedThreadId || explicitReference || request.forceNew || !documentPath) throw error;
      const session = await getCodexBridge().connect({
        documentPath,
        projectRoot: currentVinextProject?.root,
        forceNew: true,
      });
      await saveCodexBinding(app.getPath('userData'), documentPath, session.threadId);
      return { session };
    }
  });
  ipcMain.handle('codex:start-turn', (event, request: CodexTurnRequest) => {
    assertTrustedSender(event);
    return getCodexBridge().startTurn(request);
  });
  ipcMain.handle('codex:interrupt', (event, threadId: string) => {
    assertTrustedSender(event);
    return getCodexBridge().interrupt(threadId);
  });
  ipcMain.handle('codex:respond-approval', (event, requestId: string, decision: 'accept' | 'decline') => {
    assertTrustedSender(event);
    getCodexBridge().respondToApproval(requestId, decision);
  });
  ipcMain.handle('app:confirm-unsaved', async (event, reason: 'open' | 'history') => {
    assertTrustedSender(event);
    const response = await dialog.showMessageBox(mainWindow!, {
      type: 'warning',
      title: 'Unsaved changes',
      message: reason === 'history' ? 'Save changes before loading this version?' : 'Save changes before opening another file?',
      buttons: ['Save', 'Discard', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    return (['save', 'discard', 'cancel'] as const)[response.response] ?? 'cancel';
  });
  ipcMain.on('app:set-dirty', (event, dirty: boolean) => {
    assertTrustedSender(event);
    rendererDirty = dirty;
    mainWindow?.setDocumentEdited(dirty);
  });
  ipcMain.on('app:close-after-save', (event) => {
    assertTrustedSender(event);
    forceClose = true;
    mainWindow?.close();
  });
}

async function createWindow(): Promise<void> {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 900,
    minHeight: 640,
    ...(process.platform === 'darwin' ? {
      titleBarStyle: 'hiddenInset' as const,
      trafficLightPosition: { x: 17, y: 19 },
    } : {}),
    icon: join(__dirname, '../../assets/second-pass-mark.png'),
    backgroundColor: '#f4f3ef',
    webPreferences: {
      preload: join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  mainWindow.webContents.on('will-navigate', (event, url) => {
    const allowed = MAIN_WINDOW_VITE_DEV_SERVER_URL
      ? url.startsWith(MAIN_WINDOW_VITE_DEV_SERVER_URL)
      : url.startsWith('file:');
    if (!allowed) event.preventDefault();
  });
  mainWindow.on('close', (event) => {
    if (forceClose || !rendererDirty) return;
    const response = dialog.showMessageBoxSync(mainWindow!, {
      type: 'warning',
      title: 'Unsaved changes',
      message: 'Save changes before closing?',
      buttons: ['Save', 'Discard', 'Cancel'],
      defaultId: 0,
      cancelId: 2,
    });
    if (response === 1) {
      event.preventDefault();
      rendererDirty = false;
      const path = currentPath;
      const cleanup = path
        ? clearDraft(join(app.getPath('userData'), 'drafts'), path)
        : Promise.resolve();
      void cleanup.finally(() => {
        forceClose = true;
        mainWindow?.close();
      });
      return;
    }
    event.preventDefault();
    if (response === 0) sendCommand('save-and-close');
  });

  if (MAIN_WINDOW_VITE_DEV_SERVER_URL) {
    await mainWindow.loadURL(MAIN_WINDOW_VITE_DEV_SERVER_URL);
  } else {
    await mainWindow.loadFile(join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}/index.html`));
  }
}

if (!squirrelStartup) app.whenReady().then(async () => {
  protocol.handle('document-preview', async (request) => {
    const url = new URL(request.url);
    const id = url.pathname.replace(/^\/+/, '');
    const html = previewDocuments.get(id);
    if (!html || url.hostname !== 'local') return new Response('Preview not found.', { status: 404 });
    return new Response(html, {
      headers: {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
      },
    });
  });
  protocol.handle('codex-asset', async (request) => {
    if (!currentAssetRoot) return new Response('No document is open.', { status: 404 });
    const requestUrl = new URL(request.url);
    const relativePath = decodeURIComponent(requestUrl.pathname).replace(/^\/+/, '');
    const candidate = resolve(currentAssetRoot, relativePath);
    if (!isInsideRoot(candidate, currentAssetRoot)) return new Response('Forbidden', { status: 403 });
    return net.fetch(pathToFileURL(candidate).toString());
  });
  registerIpc();
  installMenu();
  await createWindow();

  app.on('activate', async () => {
    if (BrowserWindow.getAllWindows().length === 0) await createWindow();
  });
});

app.on('window-all-closed', async () => {
  await currentWatcher?.close();
  await vinextPreviewManager?.stop();
  codexBridge?.dispose();
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  codexBridge?.dispose();
  void vinextPreviewManager?.stop();
});
