import { copyFile, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';
import { firstEditorWindow } from './editor-window';

test('creates lists and updates existing links', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-html-editor-rich-text-'));
  const editablePath = join(directory, 'mockup.html');
  await writeFile(editablePath, await readFile(resolve('tests/fixtures/mockup.html'), 'utf8'), 'utf8');
  await copyFile(resolve('tests/fixtures/accent.css'), join(directory, 'accent.css'));
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js', editablePath],
  });

  try {
    const page = await firstEditorWindow(electronApp);
    const preview = page.frameLocator('iframe');
    const intro = preview.locator('#intro');
    await intro.click();
    await page.getByRole('button', { name: 'Bulleted list' }).click();
    await expect(preview.locator('ul#intro > li')).toHaveText('Edit this copy directly, then save it back to HTML.');

    const link = preview.getByRole('link', { name: 'Read the original brief' });
    await link.click();
    await page.getByRole('textbox', { name: 'Link' }).fill('javascript:alert(1)');
    await page.getByRole('button', { name: 'Apply' }).click();
    await expect(link).toHaveAttribute('href', 'https://example.com');
    await page.getByRole('textbox', { name: 'Link' }).fill('/updated-brief');
    await page.getByRole('button', { name: 'Apply' }).click();
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');

    const saved = await readFile(editablePath, 'utf8');
    expect(saved).toContain('<ul id="intro"><li>Edit this copy directly, then save it back to HTML.</li></ul>');
    expect(saved).toContain('href="/updated-brief"');
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('deletes a selected source element and saves the removal', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-html-editor-delete-'));
  const editablePath = join(directory, 'delete.html');
  await writeFile(editablePath, '<!doctype html><main><h1>Keep me</h1><hr id="remove-me"><p>Keep this too</p></main>', 'utf8');
  const electronApp = await electron.launch({ args: ['.vite/build/main.js', editablePath] });

  try {
    const page = await firstEditorWindow(electronApp);
    const preview = page.frameLocator('iframe');
    await preview.locator('#remove-me').click();
    await page.getByRole('button', { name: 'Delete element' }).click();
    await expect(preview.locator('#remove-me')).toHaveCount(0);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');

    const saved = await readFile(editablePath, 'utf8');
    expect(saved).toBe('<!doctype html><main><h1>Keep me</h1><p>Keep this too</p></main>');
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('replaces an image through the file picker and saves a portable source path', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-replace-image-'));
  const editablePath = join(directory, 'mockup.html');
  const replacementPath = join(directory, 'Replacement Portrait.svg');
  await writeFile(editablePath, await readFile(resolve('tests/fixtures/mockup.html'), 'utf8'), 'utf8');
  await copyFile(resolve('tests/fixtures/accent.css'), join(directory, 'accent.css'));
  await writeFile(replacementPath, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><circle cx="40" cy="40" r="40" fill="#35618f"/></svg>', 'utf8');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js', editablePath],
    env: { ...process.env, SECOND_PASS_TEST_IMAGE_PATH: replacementPath },
  });

  try {
    const page = await firstEditorWindow(electronApp);
    const portrait = page.frameLocator('iframe').locator('#portrait');
    await portrait.click();
    await page.getByRole('button', { name: 'Replace' }).click();
    await expect(portrait).toHaveAttribute('src', 'assets/Replacement-Portrait.svg');
    await expect(page.getByRole('status')).toContainText('Save to update the source');
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');

    const saved = await readFile(editablePath, 'utf8');
    expect(saved).toContain('src="assets/Replacement-Portrait.svg"');
    expect(saved).toContain('alt="Original portrait"');
    await expect(readFile(join(directory, 'assets', 'Replacement-Portrait.svg'), 'utf8')).resolves.toContain('#35618f');
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
