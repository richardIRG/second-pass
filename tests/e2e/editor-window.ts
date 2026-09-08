import type { ElectronApplication } from '@playwright/test';

export async function firstEditorWindow(electronApp: ElectronApplication) {
  const page = await electronApp.firstWindow();
  // On macOS, a click can activate a newly launched app without reaching its page.
  // Establish native focus before sending the first editing interaction.
  await electronApp.evaluate(({ app, BrowserWindow }) => {
    app.focus({ steal: true });
    const window = BrowserWindow.getAllWindows()[0];
    window.show();
    window.focus();
  });
  await page.bringToFront();
  await page.waitForFunction(() => document.hasFocus());
  return page;
}
