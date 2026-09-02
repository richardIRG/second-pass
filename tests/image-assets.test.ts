import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { importImageAsset } from '../src/lib/image-assets';

describe('image asset import', () => {
  it('copies HTML images into a portable assets folder and avoids overwrites', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'second-pass-image-assets-'));
    const documentRoot = join(directory, 'document');
    const firstSource = join(directory, 'Hero Image.svg');
    const secondSource = join(directory, 'other', 'Hero Image.svg');
    await mkdir(join(directory, 'other'), { recursive: true });
    await writeFile(firstSource, '<svg><rect fill="red" /></svg>', 'utf8');
    await writeFile(secondSource, '<svg><rect fill="blue" /></svg>', 'utf8');
    try {
      const first = await importImageAsset(firstSource, { kind: 'html', root: documentRoot });
      const duplicate = await importImageAsset(firstSource, { kind: 'html', root: documentRoot });
      const collision = await importImageAsset(secondSource, { kind: 'html', root: documentRoot });
      expect(first.src).toBe('assets/Hero-Image.svg');
      expect(duplicate.path).toBe(first.path);
      expect(collision.src).toBe('assets/Hero-Image-2.svg');
      expect(await readFile(first.path, 'utf8')).toContain('red');
      expect(await readFile(collision.path, 'utf8')).toContain('blue');
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('copies Vinext images into public and returns a root-relative source', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'second-pass-vinext-image-'));
    const source = join(directory, 'portrait.png');
    const projectRoot = join(directory, 'project');
    await writeFile(source, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    try {
      const imported = await importImageAsset(source, { kind: 'vinext', root: projectRoot });
      expect(imported.src).toBe('/second-pass-assets/portrait.png');
      expect(imported.path).toBe(join(projectRoot, 'public', 'second-pass-assets', 'portrait.png'));
      expect(await readFile(imported.path)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
