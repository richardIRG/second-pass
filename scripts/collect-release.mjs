import { createHash } from 'node:crypto';
import { copyFile, mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const output = join(root, 'release-assets');
await mkdir(output, { recursive: true });
async function filesIn(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    files.push(...(entry.isDirectory() ? await filesIn(path) : [path]));
  }
  return files;
}
const files = await filesIn(join(root, 'out', 'make'));
const expected = process.platform === 'darwin' ? ['.dmg', '.zip'] : ['Setup.exe'];
const checksums = [];
for (const suffix of expected) {
  const matches = files.filter(file => file.endsWith(suffix));
  if (matches.length !== 1) throw new Error(`Expected one ${suffix} artifact, found ${matches.length}.`);
  const name = process.platform === 'darwin'
    ? `Second-Pass-Mac-${process.arch === 'arm64' ? 'Apple-Silicon' : 'Intel'}${suffix}`
    : 'Second-Pass-Windows-x64-Setup.exe';
  await copyFile(matches[0], join(output, name));
  checksums.push(`${createHash('sha256').update(await readFile(matches[0])).digest('hex')}  ${name}`);
}
await writeFile(join(output, `SHA256SUMS-${process.platform}-${process.arch}.txt`), checksums.join('\n') + '\n');
console.log(`Prepared ${expected.length} downloads in ${basename(output)}.`);
