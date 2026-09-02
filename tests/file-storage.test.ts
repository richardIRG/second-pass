import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  clearDraft,
  createBackup,
  isFrameworkHtmlShell,
  listRecentFiles,
  listHistory,
  loadCodexBinding,
  loadDraft,
  loadHistory,
  readHtmlDocument,
  saveHtmlFile,
  saveCodexBinding,
  saveDraft,
  touchRecentFile,
} from '../src/lib/file-storage';
import { parseEditableNodes } from '../src/lib/html-document';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), 'codex-html-editor-'));
  temporaryDirectories.push(directory);
  return directory;
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('file storage', () => {
  it('distinguishes framework entrypoints from standalone HTML documents', () => {
    expect(isFrameworkHtmlShell('<div id="root"></div><script type="module" src="/src/main.tsx"></script>')).toBe(true);
    expect(isFrameworkHtmlShell('<main id="app"><h1>Editable report</h1></main><script src="report.js"></script>')).toBe(false);
  });

  it('backs up the original and writes a source-range edit', async () => {
    const directory = await createTemporaryDirectory();
    const historyRoot = join(directory, 'history');
    const path = join(directory, 'mockup.html');
    const source = '<!doctype html>\n<html><body>\n  <h1>Hello</h1>\n  <script>keep()</script>\n</body></html>\n';
    await writeFile(path, source, 'utf8');
    const document = await readHtmlDocument(path);
    const [heading] = parseEditableNodes(source);

    const result = await saveHtmlFile(
      {
        path,
        expectedVersion: document.version,
        operations: [
          {
            nodeId: heading.id,
            startOffset: heading.startOffset,
            endOffset: heading.endOffset,
            replacementOuterHtml: '<h1>Hello <strong>there</strong></h1>',
            timestamp: Date.now(),
          },
        ],
      },
      historyRoot,
    );

    expect(result.status).toBe('saved');
    expect(await readFile(path, 'utf8')).toBe(source.replace('<h1>Hello</h1>', '<h1>Hello <strong>there</strong></h1>'));
    const history = await listHistory(historyRoot, path);
    expect(history).toHaveLength(1);
    expect(await loadHistory(historyRoot, path, history[0].id)).toBe(source);
  });

  it('refuses to overwrite a file changed after it was opened', async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, 'mockup.html');
    await writeFile(path, '<p>Original</p>', 'utf8');
    const document = await readHtmlDocument(path);
    await writeFile(path, '<p>Changed by Codex</p>', 'utf8');

    const result = await saveHtmlFile(
      { path, expectedVersion: document.version, operations: [], fullSource: '<p>Editor version</p>' },
      join(directory, 'history'),
    );

    expect(result.status).toBe('conflict');
    expect(await readFile(path, 'utf8')).toBe('<p>Changed by Codex</p>');
    expect(await listHistory(join(directory, 'history'), path)).toEqual([]);
  });

  it('retains only the configured number of backups', async () => {
    const directory = await createTemporaryDirectory();
    const historyRoot = join(directory, 'history');
    const path = join(directory, 'mockup.html');
    let now = 1_700_000_000_000;
    vi.spyOn(Date, 'now').mockImplementation(() => now++);

    for (let index = 0; index < 5; index += 1) {
      await createBackup(historyRoot, path, `<p>Version ${index}</p>`, 3);
    }

    const history = await listHistory(historyRoot, path);
    expect(history).toHaveLength(3);
    expect(await loadHistory(historyRoot, path, history[0].id)).toBe('<p>Version 4</p>');
  });

  it('rejects arbitrary history paths', async () => {
    const directory = await createTemporaryDirectory();
    await expect(loadHistory(directory, '/tmp/mockup.html', '../../secret')).rejects.toThrow(/invalid/i);
  });

  it('stores recent files and removes missing entries from the list', async () => {
    const directory = await createTemporaryDirectory();
    const first = join(directory, 'first.html');
    const second = join(directory, 'second.html');
    await writeFile(first, '<p>First</p>', 'utf8');
    await writeFile(second, '<p>Second</p>', 'utf8');
    await touchRecentFile(directory, first);
    await touchRecentFile(directory, second);
    await rm(first);
    expect(await listRecentFiles(directory)).toEqual([
      expect.objectContaining({ path: second, fileName: 'second.html' }),
    ]);
  });

  it('round-trips and clears an autosaved draft', async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, 'draft.html');
    await writeFile(path, '<p>Original</p>', 'utf8');
    const document = await readHtmlDocument(path);
    const draft = { path, baseVersion: document.version, source: '<p>Recovered</p>', updatedAt: 123 };
    await saveDraft(join(directory, 'drafts'), draft);
    expect(await loadDraft(join(directory, 'drafts'), path)).toEqual(draft);
    await clearDraft(join(directory, 'drafts'), path);
    expect(await loadDraft(join(directory, 'drafts'), path)).toBeNull();
  });

  it('persists a Codex thread binding for each document path', async () => {
    const directory = await createTemporaryDirectory();
    const path = join(directory, 'connected.html');
    await saveCodexBinding(directory, path, '0198e998-7b74-7a80-8b0f-a334bd81d30f');
    expect(await loadCodexBinding(directory, path)).toBe('0198e998-7b74-7a80-8b0f-a334bd81d30f');
    expect(await loadCodexBinding(directory, join(directory, 'other.html'))).toBeNull();
  });
});
