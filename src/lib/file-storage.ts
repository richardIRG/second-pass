import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join, resolve } from 'node:path';

import type {
  DraftSnapshot,
  DiskVersion,
  HistoryEntry,
  HtmlDocument,
  RecentFile,
  SaveFileRequest,
  SaveFileResult,
} from '../shared/types';
import { applyEditOperations } from './html-document';

export function hashSource(source: string): string {
  return createHash('sha256').update(source).digest('hex');
}

export function isFrameworkHtmlShell(source: string): boolean {
  const hasEmptyMount = /<([a-z][\w:-]*)\b[^>]*\bid=["'](?:root|app|__next)["'][^>]*>\s*<\/\1>/i.test(source);
  const loadsSourceModule = /<script\b[^>]*\btype=["']module["'][^>]*\bsrc=["'][^"']+\.(?:tsx?|jsx?)(?:\?[^"']*)?["'][^>]*>/i.test(source)
    || /<script\b[^>]*\bsrc=["'][^"']+\.(?:tsx?|jsx?)(?:\?[^"']*)?["'][^>]*\btype=["']module["'][^>]*>/i.test(source);
  return hasEmptyMount && loadsSourceModule;
}

export async function getDiskVersion(path: string, source?: string): Promise<DiskVersion> {
  const info = await stat(path);
  const content = source ?? (await readFile(path, 'utf8'));
  return { sha256: hashSource(content), mtimeMs: info.mtimeMs, size: info.size };
}

export async function readHtmlDocument(path: string): Promise<HtmlDocument> {
  const canonicalPath = resolve(path);
  const extension = extname(canonicalPath).toLowerCase();
  if (extension !== '.html' && extension !== '.htm') throw new Error('Choose an HTML file.');
  const source = await readFile(canonicalPath, 'utf8');
  const version = await getDiskVersion(canonicalPath, source);
  return {
    path: canonicalPath,
    fileName: basename(canonicalPath),
    baseDirectory: dirname(canonicalPath),
    source,
    version,
  };
}

export function getHistoryDirectory(historyRoot: string, path: string): string {
  const key = createHash('sha256').update(resolve(path)).digest('hex');
  return join(historyRoot, key);
}

function getPathKey(path: string): string {
  return createHash('sha256').update(resolve(path)).digest('hex');
}

async function writeJsonFile(path: string, value: unknown): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  const temporaryPath = `${path}.${process.pid}-${randomUUID()}.tmp`;
  await writeFile(temporaryPath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
  await rename(temporaryPath, path);
}

export async function listRecentFiles(userDataRoot: string): Promise<RecentFile[]> {
  try {
    const parsed = JSON.parse(await readFile(join(userDataRoot, 'recent-files.json'), 'utf8')) as RecentFile[];
    const existing = await Promise.all(
      parsed.slice(0, 10).map(async (entry) => {
        try {
          await stat(entry.path);
          return { ...entry, path: resolve(entry.path), fileName: basename(entry.path) };
        } catch {
          return null;
        }
      }),
    );
    return existing.filter((entry): entry is RecentFile => Boolean(entry));
  } catch {
    return [];
  }
}

export async function touchRecentFile(userDataRoot: string, path: string): Promise<void> {
  const canonicalPath = resolve(path);
  const recent = await listRecentFiles(userDataRoot);
  const next = [
    { path: canonicalPath, fileName: basename(canonicalPath), lastOpenedAt: Date.now() },
    ...recent.filter((entry) => entry.path !== canonicalPath),
  ].slice(0, 10);
  await writeJsonFile(join(userDataRoot, 'recent-files.json'), next);
}

function getDraftPath(draftRoot: string, path: string): string {
  return join(draftRoot, `${getPathKey(path)}.json`);
}

function getCodexBindingPath(userDataRoot: string, path: string): string {
  return join(userDataRoot, 'codex-bindings', `${getPathKey(path)}.json`);
}

export async function saveDraft(draftRoot: string, draft: DraftSnapshot): Promise<void> {
  await writeJsonFile(getDraftPath(draftRoot, draft.path), { ...draft, path: resolve(draft.path) });
}

export async function loadDraft(draftRoot: string, path: string): Promise<DraftSnapshot | null> {
  try {
    const draft = JSON.parse(await readFile(getDraftPath(draftRoot, path), 'utf8')) as DraftSnapshot;
    if (resolve(draft.path) !== resolve(path) || typeof draft.source !== 'string') return null;
    return draft;
  } catch {
    return null;
  }
}

export async function clearDraft(draftRoot: string, path: string): Promise<void> {
  await unlink(getDraftPath(draftRoot, path)).catch(() => undefined);
}

export async function loadCodexBinding(userDataRoot: string, path: string): Promise<string | null> {
  try {
    const binding = JSON.parse(await readFile(getCodexBindingPath(userDataRoot, path), 'utf8')) as {
      path?: string;
      threadId?: string;
    };
    if (resolve(binding.path ?? '') !== resolve(path) || typeof binding.threadId !== 'string') return null;
    return binding.threadId;
  } catch {
    return null;
  }
}

export async function saveCodexBinding(userDataRoot: string, path: string, threadId: string): Promise<void> {
  await writeJsonFile(getCodexBindingPath(userDataRoot, path), {
    path: resolve(path),
    threadId,
    updatedAt: Date.now(),
  });
}

export async function createBackup(
  historyRoot: string,
  path: string,
  source: string,
  retention = 20,
): Promise<void> {
  const directory = getHistoryDirectory(historyRoot, path);
  await mkdir(directory, { recursive: true });
  const id = `${Date.now()}-${hashSource(source).slice(0, 12)}.html`;
  await writeFile(join(directory, id), source, 'utf8');
  const entries = (await readdir(directory))
    .filter((entry) => /^\d+-[a-f0-9]{12}\.html$/.test(entry))
    .toSorted()
    .reverse();
  await Promise.all(entries.slice(retention).map((entry) => unlink(join(directory, entry))));
}

export async function listHistory(historyRoot: string, path: string): Promise<HistoryEntry[]> {
  const directory = getHistoryDirectory(historyRoot, path);
  try {
    const entries = await readdir(directory);
    const history = await Promise.all(
      entries
        .filter((id) => /^\d+-[a-f0-9]{12}\.html$/.test(id))
        .map(async (id) => {
          const info = await stat(join(directory, id));
          return { id, createdAt: Number(id.split('-')[0]), size: info.size } satisfies HistoryEntry;
        }),
    );
    return history.toSorted((a, b) => b.createdAt - a.createdAt);
  } catch {
    return [];
  }
}

export async function loadHistory(historyRoot: string, path: string, id: string): Promise<string> {
  if (!/^\d+-[a-f0-9]{12}\.html$/.test(id)) throw new Error('Invalid history entry.');
  return readFile(join(getHistoryDirectory(historyRoot, path), id), 'utf8');
}

export async function atomicWrite(path: string, source: string): Promise<void> {
  const existing = await stat(path);
  const temporaryPath = join(dirname(path), `.${basename(path)}.codex-editor-${process.pid}-${randomUUID()}.tmp`);
  const handle = await open(temporaryPath, 'wx', existing.mode);
  try {
    await handle.writeFile(source, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
  await handle.close();
  try {
    await rename(temporaryPath, path);
  } catch (error) {
    await unlink(temporaryPath).catch(() => undefined);
    throw error;
  }
}

export async function saveHtmlFile(request: SaveFileRequest, historyRoot: string): Promise<SaveFileResult> {
  try {
    const path = resolve(request.path);
    const currentSource = await readFile(path, 'utf8');
    const currentVersion = await getDiskVersion(path, currentSource);
    if (currentVersion.sha256 !== request.expectedVersion.sha256) {
      return { status: 'conflict', currentVersion };
    }

    const nextSource = request.fullSource ?? applyEditOperations(currentSource, request.operations);
    await createBackup(historyRoot, path, currentSource);
    await atomicWrite(path, nextSource);
    return { status: 'saved', document: await readHtmlDocument(path) };
  } catch (error) {
    return { status: 'error', message: error instanceof Error ? error.message : 'Unable to save the file.' };
  }
}
