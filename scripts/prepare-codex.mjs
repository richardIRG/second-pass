import { createHash } from 'node:crypto';
import { cp, mkdir, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const version = '0.153.4';
const target = `${process.platform}-${process.arch}`;
const triples = {
  'darwin-arm64': 'aarch64-apple-darwin',
  'darwin-x64': 'x86_64-apple-darwin',
  'win32-x64': 'x86_64-pc-windows-msvc',
};
if (!triples[target]) throw new Error(`No release runtime is configured for ${target}.`);
const downloadDirectory = join(root, 'build', 'codex-download');
const output = join(root, 'build', 'codex');
await mkdir(downloadDirectory, { recursive: true });
const metadataResponse = await fetch(`https://registry.npmjs.org/@openai%2fcodex/${version}-${target}`);
if (!metadataResponse.ok) throw new Error(`Codex metadata request failed: ${metadataResponse.status}`);
const metadata = await metadataResponse.json();
const tarball = new URL(metadata.dist.tarball);
if (tarball.protocol !== 'https:' || tarball.hostname !== 'registry.npmjs.org') throw new Error('Unexpected package host.');
const response = await fetch(tarball);
if (!response.ok) throw new Error(`Codex download failed: ${response.status}`);
const bytes = Buffer.from(await response.arrayBuffer());
const integrity = `sha512-${createHash('sha512').update(bytes).digest('base64')}`;
if (integrity !== metadata.dist.integrity) throw new Error('Codex package integrity verification failed.');
const archive = join(downloadDirectory, 'codex.tgz');
await writeFile(archive, bytes);
await rm(join(downloadDirectory, 'package'), { recursive: true, force: true });
const extraction = spawnSync('tar', ['-xzf', archive, '-C', downloadDirectory], { stdio: 'inherit' });
if (extraction.status !== 0) throw new Error('Could not extract the Codex package.');
await rm(output, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(join(downloadDirectory, 'package', 'vendor'), join(output, 'vendor'), { recursive: true });
const binary = join(output, 'vendor', triples[target], 'bin', process.platform === 'win32' ? 'codex.exe' : 'codex');
await readFile(binary);
if (process.platform !== 'win32') await chmod(binary, 0o755);
const licenseResponse = await fetch(`https://raw.githubusercontent.com/openai/codex/rust-v${version}/LICENSE`);
if (!licenseResponse.ok) throw new Error('Could not obtain the Codex license.');
await writeFile(join(output, 'LICENSE-Codex.txt'), await licenseResponse.text());
await writeFile(join(output, 'runtime.json'), JSON.stringify({ version, target, package: metadata.name, integrity }, null, 2) + '\n');
const check = spawnSync(binary, ['--version'], { encoding: 'utf8', timeout: 30_000 });
if (check.status !== 0 || !check.stdout.includes(version)) throw new Error(`Bundled Codex did not start: ${check.stderr}`);
console.log(`Prepared ${check.stdout.trim()} for ${target}. Package integrity verified.`);
