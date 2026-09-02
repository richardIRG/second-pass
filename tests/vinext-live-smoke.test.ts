import { afterEach, describe, expect, it } from 'vitest';

import { detectVinextProject, VinextPreviewManager } from '../src/lib/vinext-project';

const projectRoot = process.env.SECOND_PASS_REAL_VINEXT_ROOT;
const manager = new VinextPreviewManager();

describe.skipIf(!projectRoot)('real Vinext runtime smoke test', () => {
  afterEach(() => manager.stop());

  it('renders and instruments an App Router server component', async () => {
    const descriptor = await detectVinextProject(projectRoot!);
    expect(descriptor).not.toBeNull();
    const session = await manager.start(descriptor!);
    const html = await fetch(session.previewUrl, { headers: { Accept: 'text/html' } }).then((response) => response.text());
    expect(html).toContain('Real Vinext smoke test');
    expect(html).toContain('data-cx-react-id');
    expect(html).toContain('data-second-pass-vinext');
  }, 30_000);
});
