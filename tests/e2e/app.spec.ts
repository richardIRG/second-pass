import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { _electron as electron, expect, test } from '@playwright/test';

const fixturePath = resolve('tests/fixtures/mockup.html');
const fixtureStylesheetPath = resolve('tests/fixtures/accent.css');

test('edits rich text, saves source, and runs sandboxed interactions', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-html-editor-e2e-'));
  const editablePath = join(directory, 'mockup.html');
  await writeFile(editablePath, await readFile(fixturePath, 'utf8'), 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));

  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      HTML_DOCUMENT_EDITOR_OPEN_FILE: editablePath,
      HTML_DOCUMENT_EDITOR_DISABLE_EXTERNAL_OPEN: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    // Keep panel controls accessible when the compact toolbar hides their text.
    await page.setViewportSize({ width: 1100, height: 800 });
    await expect(page.locator('.document-title strong')).toHaveText('mockup.html');
    const preview = page.frameLocator('iframe');
    const headline = preview.locator('#headline');
    await expect(headline).toHaveCSS('color', 'rgb(74, 62, 180)');
    await page.getByRole('button', { name: 'Outline' }).click();
    const outline = page.getByRole('complementary', { name: 'Document outline' });
    await expect(outline).toContainText('editable regions');
    await outline.getByRole('button', { name: /h1#headline/ }).click();
    await page.getByRole('button', { name: 'Inspector' }).click();
    await expect(page.getByRole('complementary', { name: 'Selection inspector' })).toContainText('h1#headline');
    await headline.click();
    await headline.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await headline.pressSequentially('A headline edited visually');
    await page.getByRole('button', { name: 'Undo' }).click();
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Build the page you meant');
    await page.getByRole('button', { name: 'Redo' }).click();
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('A headline edited visually');

    const intro = preview.locator('#intro');
    await intro.click();
    await intro.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await page.getByRole('button', { name: 'Bold' }).click();

    await preview.locator('#portrait').click();
    await page.getByLabel('Alt text').fill('Updated portrait');
    await page.getByRole('button', { name: 'Apply' }).click();
    await preview.locator('#counter').click();
    await expect(page.getByText('Script-controlled text may change when the page runs.')).toBeVisible();

    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Review', exact: true }).click();
    await expect(page.getByRole('complementary', { name: 'Review changes' })).toContainText('Everything outside these regions');
    await expect(page.getByRole('complementary', { name: 'Review changes' })).toContainText('h1#headline');
    await page.getByRole('complementary', { name: 'Review changes' }).getByRole('button', { name: 'Save changes' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');

    const saved = await readFile(editablePath, 'utf8');
    expect(saved).toContain('<h1 id="headline">A headline edited visually</h1>');
    expect(saved).toContain('<p id="intro"><strong>Edit this copy directly, then save it back to HTML.</strong></p>');
    expect(saved).toContain('alt="Updated portrait"');
    expect(saved).toContain("counter.addEventListener('click'");

    await page.getByRole('button', { name: 'History' }).click();
    await expect(page.getByText('Automatic backups from before each save')).toBeVisible();
    await page.getByRole('complementary', { name: 'File history' }).getByRole('button', { name: 'Close' }).click();

    await page.getByRole('button', { name: 'Preview', exact: true }).click();
    await preview.getByRole('link', { name: 'Read the original brief' }).click();
    await expect(page.getByRole('status')).toHaveText('Opened link in your default browser');
    await preview.locator('#counter').click();
    await expect(preview.locator('#counter')).toHaveText('Interactions: 1');
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('detects an external change while visual edits are unsaved', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'codex-html-editor-conflict-'));
  const editablePath = join(directory, 'mockup.html');
  const source = await readFile(fixturePath, 'utf8');
  await writeFile(editablePath, source, 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));

  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: { ...process.env, HTML_DOCUMENT_EDITOR_OPEN_FILE: editablePath },
  });

  try {
    const page = await electronApp.firstWindow();
    const headline = page.frameLocator('iframe').locator('#headline');
    await headline.click();
    await headline.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await headline.pressSequentially('Unsaved editor version');
    await expect(page.getByText('1 unsaved change')).toBeVisible();

    await writeFile(editablePath, source.replace('Build the page you meant', 'Changed by Codex'), 'utf8');
    await expect(page.getByText('The same edited region changed on disk.')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Save', exact: true })).toBeDisabled();

    await page.getByRole('button', { name: 'Discard and reload' }).click();
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Changed by Codex');
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('merges a non-overlapping external change and supports responsive preview sizes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'html-document-editor-rebase-'));
  const editablePath = join(directory, 'mockup.html');
  const source = await readFile(fixturePath, 'utf8');
  await writeFile(editablePath, source, 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: { ...process.env, HTML_DOCUMENT_EDITOR_OPEN_FILE: editablePath },
  });

  try {
    const page = await electronApp.firstWindow();
    const preview = page.frameLocator('iframe');
    const headline = preview.locator('#headline');
    await headline.click();
    await headline.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await headline.pressSequentially('Editor headline');
    await writeFile(editablePath, source.replace('Edit this copy directly', 'Changed outside the editor'), 'utf8');
    await expect(page.getByRole('status')).toHaveText('Merged external changes with your edits');
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Editor headline');
    await expect(page.frameLocator('iframe').locator('#intro')).toContainText('Changed outside the editor');

    await page.getByRole('button', { name: 'Mobile preview' }).click();
    await expect.poll(() => page.locator('iframe').evaluate((element) => Math.round(element.getBoundingClientRect().width))).toBe(390);
    await page.getByRole('button', { name: 'Save' }).click();
    await expect(page.getByRole('status')).toHaveText('Saved');
    const saved = await readFile(editablePath, 'utf8');
    expect(saved).toContain('Editor headline');
    expect(saved).toContain('Changed outside the editor');
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('recovers an autosaved draft after an interrupted session', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'html-document-editor-recovery-'));
  const editablePath = join(directory, 'mockup.html');
  await writeFile(editablePath, await readFile(fixturePath, 'utf8'), 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));

  const launch = () => electron.launch({
    args: ['.vite/build/main.js'],
    env: { ...process.env, HTML_DOCUMENT_EDITOR_OPEN_FILE: editablePath },
  });
  let electronApp = await launch();
  try {
    let page = await electronApp.firstWindow();
    const headline = page.frameLocator('iframe').locator('#headline');
    await headline.click();
    await headline.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await headline.pressSequentially('Recovered draft headline');
    await page.waitForTimeout(900);
    await electronApp.evaluate(({ app }) => app.exit(0));

    electronApp = await launch();
    page = await electronApp.firstWindow();
    await expect(page.getByText('Unsaved work found')).toBeVisible();
    await page.getByRole('button', { name: 'Restore' }).click();
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Recovered draft headline');
    await expect(page.getByText('1 unsaved change')).toBeVisible();
  } finally {
    await electronApp.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('opens the task HTML and refreshes it after an approved Codex change', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-codex-e2e-'));
  const editablePath = join(directory, 'mockup.html');
  await writeFile(editablePath, await readFile(fixturePath, 'utf8'), 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_DOCUMENT_PATH: editablePath,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await expect(page.getByRole('heading', { name: 'Pick up where Codex left off' })).toBeVisible();
    await page.screenshot({ path: 'output/playwright/260825 RJM Second Pass Task First Onboarding v0.png' });
    await page.getByLabel('Codex task link or thread ID').fill('https://chatgpt.com/codex/tasks/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.locator('.document-title strong')).toHaveText('mockup.html');
    const codexPanel = page.getByRole('complementary', { name: 'Codex workspace' });
    await expect(codexPanel).toContainText('test@example.com');
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Build the page you meant');
    await page.screenshot({ path: 'output/playwright/260825 RJM Second Pass Task First Workspace v0.png' });

    await codexPanel.getByLabel('Message Codex').fill('Change the headline.');
    await codexPanel.getByRole('button', { name: 'Send to Codex' }).click();
    await expect(page.getByRole('button', { name: 'Preview', exact: true })).toHaveClass(/is-active/);
    await expect(codexPanel.getByRole('region', { name: 'Codex approval request' })).toContainText('Update the HTML headline');
    await codexPanel.getByRole('button', { name: 'Allow once' }).click();

    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Changed live by Codex');
    await expect(codexPanel).toContainText('I updated the headline in the connected document.');
    await expect(codexPanel).toContainText('Updated mockup.html');
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('watches an HTML file when the Codex task already has an active writer', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-active-task-e2e-'));
  const editablePath = join(directory, 'mockup.html');
  const source = await readFile(fixturePath, 'utf8');
  await writeFile(editablePath, source, 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_DOCUMENT_PATH: editablePath,
      SECOND_PASS_FAKE_ACTIVE_WRITER: '1',
      SECOND_PASS_FAKE_WATCH_MESSAGES: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.getByLabel('Codex task link or thread ID').fill('codex://threads/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.locator('.document-title strong')).toHaveText('mockup.html');
    const codexPanel = page.getByRole('complementary', { name: 'Codex workspace' });
    await expect(codexPanel).toContainText('Watching active task');
    await expect(codexPanel).toContainText('Continue in Codex');
    await expect(codexPanel.getByLabel('Message Codex')).toHaveCount(0);
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Build the page you meant');
    await expect(codexPanel).toContainText('Make the button quieter.');
    await expect(codexPanel).toContainText('Updated the button styling.');

    await writeFile(editablePath, source.replace('Build the page you meant', 'Changed by the active Codex task'), 'utf8');
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Changed by the active Codex task');
    await page.screenshot({ path: 'output/playwright/260825 RJM Second Pass Active Task Watch Mode v0.png' });
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('reads the requested task when resume reports a stale rollout ID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-stale-rollout-e2e-'));
  const editablePath = join(directory, 'mockup.html');
  const source = await readFile(fixturePath, 'utf8');
  await writeFile(editablePath, source, 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_DOCUMENT_PATH: editablePath,
      SECOND_PASS_FAKE_STALE_ROLLOUT: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.getByLabel('Codex task link or thread ID').fill('codex://threads/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.locator('.document-title strong')).toHaveText('mockup.html');
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Build the page you meant');
    await expect(page.getByRole('complementary', { name: 'Codex workspace' })).toContainText('Watching active task');
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('rejects a framework mount shell discovered from a task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-framework-shell-e2e-'));
  const entrypointPath = join(directory, 'index.html');
  await writeFile(entrypointPath, '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>', 'utf8');
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_DOCUMENT_PATH: entrypointPath,
      SECOND_PASS_FAKE_ACTIVE_WRITER: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.getByLabel('Codex task link or thread ID').fill('codex://threads/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.getByRole('alert')).toContainText('React or app entrypoint');
    await expect(page.getByRole('heading', { name: 'Pick up where Codex left off' })).toBeVisible();
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('skips a framework entrypoint when the task also contains standalone HTML', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-framework-and-page-e2e-'));
  const entrypointPath = join(directory, 'index.html');
  const editablePath = join(directory, 'rendered-page.html');
  await writeFile(entrypointPath, '<!doctype html><div id="root"></div><script type="module" src="/src/main.tsx"></script>', 'utf8');
  await writeFile(editablePath, await readFile(fixturePath, 'utf8'), 'utf8');
  await copyFile(fixtureStylesheetPath, join(directory, 'accent.css'));
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_DOCUMENT_PATH: entrypointPath,
      SECOND_PASS_FAKE_DOCUMENT_PATHS: JSON.stringify([editablePath, entrypointPath]),
      SECOND_PASS_FAKE_ACTIVE_WRITER: '1',
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.getByLabel('Codex task link or thread ID').fill('codex://threads/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.locator('.document-title strong')).toHaveText('rendered-page.html');
    await expect(page.frameLocator('iframe').locator('#headline')).toHaveText('Build the page you meant');
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});

test('opens, edits, and saves a Vinext App Router page', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'second-pass-vinext-e2e-'));
  await mkdir(join(directory, 'app'), { recursive: true });
  await mkdir(join(directory, 'src'), { recursive: true });
  await symlink(resolve('node_modules'), join(directory, 'node_modules'), 'dir');
  await writeFile(join(directory, 'package.json'), JSON.stringify({
    name: 'vinext-test-project',
    scripts: { dev: 'vinext dev' },
    dependencies: { react: '^19.0.0', 'react-dom': '^19.0.0', vinext: '^1.0.0', vite: '^8.0.0' },
  }), 'utf8');
  await writeFile(join(directory, 'vite.config.ts'), `import { defineConfig } from 'vite';
// vinext() is supplied by the real project. This fixture exercises the Second Pass Vite adapter.
export default defineConfig({});
`, 'utf8');
  await writeFile(join(directory, 'index.html'), '<!doctype html><html><body><div id="root"></div><script type="module" src="/src/main.tsx"></script></body></html>', 'utf8');
  const pagePath = join(directory, 'app', 'page.tsx');
  await writeFile(pagePath, `import React from 'react';
export default function Page() {
  return <main><h1>Editable Vinext heading</h1><a href="/about">Learn more</a><img src="/mark.svg" alt="Mark" /></main>;
}
`, 'utf8');
  await writeFile(join(directory, 'src', 'main.tsx'), `import React from 'react';
import { createRoot } from 'react-dom/client';
import Page from '../app/page';
createRoot(document.getElementById('root')!).render(<Page />);
`, 'utf8');
  const replacementImagePath = join(directory, 'Replacement Mark.svg');
  await writeFile(replacementImagePath, '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80"><rect width="80" height="80" fill="#35618f"/></svg>', 'utf8');
  const fakeServerPath = resolve('tests/fixtures/fake-codex-app-server.mjs');
  const electronApp = await electron.launch({
    args: ['.vite/build/main.js'],
    env: {
      ...process.env,
      SECOND_PASS_CODEX_EXECUTABLE: 'node',
      SECOND_PASS_CODEX_ARGS: JSON.stringify([fakeServerPath]),
      SECOND_PASS_FAKE_PROJECT_ROOT: directory,
      SECOND_PASS_FAKE_ACTIVE_WRITER: '1',
      SECOND_PASS_TEST_IMAGE_PATH: replacementImagePath,
    },
  });

  try {
    const page = await electronApp.firstWindow();
    await page.getByLabel('Codex task link or thread ID').fill('codex://threads/0198e998-7b74-7a80-8b0f-a334bd81d30f');
    await page.getByRole('button', { name: 'Connect task' }).click();
    await expect(page.locator('.document-title strong')).toHaveText('vinext-test-project');
    await expect(page.getByLabel('Vinext preview route')).toHaveValue('/');
    const preview = page.frameLocator('iframe');
    const heading = preview.getByRole('heading', { name: 'Editable Vinext heading' });
    await expect(heading).toBeVisible();
    await expect(preview.locator('script[data-second-pass-vinext]')).toHaveCount(1);
    await expect(preview.locator('body')).toHaveAttribute('data-cx-mode', 'edit');
    const transformedModule = await preview.locator('body').evaluate(() => fetch('/app/page.tsx').then((response) => response.text()));
    expect(transformedModule).toContain('data-cx-react-id');
    await expect(heading).toHaveAttribute('data-cx-react-id', /.+/);
    await heading.click();
    await expect(heading).toHaveAttribute('contenteditable', 'true');
    await heading.press(process.platform === 'darwin' ? 'Meta+A' : 'Control+A');
    await heading.pressSequentially('Edited through Second Pass');
    await expect(page.getByText('1 unsaved change')).toBeVisible();
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => readFile(pagePath, 'utf8')).toContain('<h1>Edited through Second Pass</h1>');
    await expect(page.getByText('Vinext project')).toBeVisible();

    const image = preview.getByRole('img', { name: 'Mark' });
    await image.click();
    await page.getByRole('button', { name: 'Replace' }).click();
    await expect(image).toHaveAttribute('src', '/second-pass-assets/Replacement-Mark.svg');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect.poll(async () => readFile(pagePath, 'utf8')).toContain('src="/second-pass-assets/Replacement-Mark.svg"');
    await expect(readFile(join(directory, 'public', 'second-pass-assets', 'Replacement-Mark.svg'), 'utf8')).resolves.toContain('#35618f');
  } finally {
    await electronApp.close().catch(() => undefined);
    await rm(directory, { recursive: true, force: true });
  }
});
