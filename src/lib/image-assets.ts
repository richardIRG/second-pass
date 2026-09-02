import { createHash, randomUUID } from 'node:crypto';
import { copyFile, mkdir, readFile, rename, stat, unlink } from 'node:fs/promises';
import { basename, extname, join, resolve } from 'node:path';

export type ImageAssetTarget =
  | { kind: 'html'; root: string }
  | { kind: 'vinext'; root: string };

export interface ImportedImageAsset {
  path: string;
  src: string;
  fileName: string;
}

const IMAGE_EXTENSIONS = new Set(['.avif', '.gif', '.jpeg', '.jpg', '.png', '.svg', '.webp']);

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function hashFile(path: string): Promise<string> {
  return createHash('sha256').update(await readFile(path)).digest('hex');
}

function safeImageName(path: string): { stem: string; extension: string } {
  const extension = extname(path).toLowerCase();
  if (!IMAGE_EXTENSIONS.has(extension)) throw new Error('Choose a PNG, JPEG, GIF, WebP, AVIF, or SVG image.');
  const rawStem = basename(path, extname(path)).normalize('NFKD').replace(/[\u0300-\u036f]/g, '');
  const stem = rawStem
    .replace(/[^a-zA-Z0-9.-]+/g, '-')
    .replace(/^[.-]+|[.-]+$/g, '')
    .slice(0, 96) || 'image';
  return { stem, extension };
}

export async function importImageAsset(sourcePath: string, target: ImageAssetTarget): Promise<ImportedImageAsset> {
  const source = resolve(sourcePath);
  if (!(await fileExists(source))) throw new Error('The selected image is no longer available.');
  const { stem, extension } = safeImageName(source);
  const assetDirectoryName = target.kind === 'html' ? 'assets' : 'second-pass-assets';
  const assetDirectory = join(resolve(target.root), target.kind === 'html' ? assetDirectoryName : 'public', target.kind === 'html' ? '' : assetDirectoryName);
  await mkdir(assetDirectory, { recursive: true });

  const sourceHash = await hashFile(source);
  let index = 1;
  let fileName = `${stem}${extension}`;
  let destination = join(assetDirectory, fileName);
  while (await fileExists(destination)) {
    if (resolve(destination) === source || await hashFile(destination) === sourceHash) {
      return {
        path: destination,
        fileName,
        src: target.kind === 'html' ? `${assetDirectoryName}/${fileName}` : `/${assetDirectoryName}/${fileName}`,
      };
    }
    index += 1;
    fileName = `${stem}-${index}${extension}`;
    destination = join(assetDirectory, fileName);
  }

  const temporaryPath = join(assetDirectory, `.${fileName}.${randomUUID()}.tmp`);
  try {
    await copyFile(source, temporaryPath);
    await rename(temporaryPath, destination);
  } finally {
    await unlink(temporaryPath).catch(() => undefined);
  }
  return {
    path: destination,
    fileName,
    src: target.kind === 'html' ? `${assetDirectoryName}/${fileName}` : `/${assetDirectoryName}/${fileName}`,
  };
}
