import { createHash, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir, readFile, readdir, realpath, stat, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';

import { parse } from '@babel/parser';
import MagicString from 'magic-string';
import type { Plugin, ViteDevServer } from 'vite';

import type {
  DiskVersion,
  VinextEditOperation,
  VinextProjectSession,
  VinextSaveResult,
} from '../shared/types';
import { atomicWrite, getDiskVersion, hashSource } from './file-storage';
import { VINEXT_PREVIEW_BRIDGE_SOURCE, VINEXT_PREVIEW_STYLE } from './vinext-preview-bridge-source';

interface PackageManifest {
  name?: string;
  scripts?: Record<string, string>;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface VinextProjectDescriptor {
  root: string;
  name: string;
  entryPath: string;
  routes: string[];
  initialRoute: string;
}

interface AttributeRange {
  start: number;
  end: number;
  quote: '"' | "'";
}

export interface VinextSourceNode {
  id: string;
  filePath: string;
  sourceHash: string;
  sourceLabel: string;
  tagName: string;
  elementStart: number;
  elementEnd: number;
  textRange?: { start: number; end: number };
  attributes: Partial<Record<'href' | 'alt' | 'src', AttributeRange>>;
  attributeInsertOffset: number;
  canDelete: boolean;
  canEditImageSource: boolean;
}

interface AstNode {
  type: string;
  start?: number | null;
  end?: number | null;
  loc?: { start?: { line?: number } } | null;
  [key: string]: unknown;
}

const PAGE_FILE_PATTERN = /^page\.(?:tsx|jsx)$/i;
const SOURCE_FILE_PATTERN = /\.(?:tsx|jsx)$/i;
const EDITABLE_TEXT_TAGS = new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'li', 'blockquote', 'figcaption', 'button', 'label', 'a', 'td', 'th', 'caption', 'small', 'span', 'div']);
const NEVER_INSTRUMENT_TAGS = new Set(['html', 'head', 'body', 'script', 'style', 'template', 'svg', 'path', 'defs', 'math']);
const DIVIDER_PATTERN = /(?:^|[-_\s])(divider|separator|rule)(?:$|[-_\s])/i;
const CONFIG_NAMES = ['vite.config.ts', 'vite.config.mts', 'vite.config.js', 'vite.config.mjs'];

function isInside(candidate: string, root: string): boolean {
  const child = relative(root, candidate);
  return child === '' || (!child.startsWith('..') && !isAbsolute(child));
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function readManifest(root: string): Promise<PackageManifest | null> {
  try {
    return JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as PackageManifest;
  } catch {
    return null;
  }
}

function usesVinext(manifest: PackageManifest): boolean {
  return Boolean(
    manifest.dependencies?.vinext
      || manifest.devDependencies?.vinext
      || Object.values(manifest.scripts ?? {}).some((script) => /(?:^|\s)vinext(?:\s|$)/.test(script)),
  );
}

function routeFromPage(appDirectory: string, pagePath: string): string {
  const directory = relative(appDirectory, dirname(pagePath));
  const segments = directory.split(sep)
    .filter((segment) => segment && !/^\(.+\)$/.test(segment) && !segment.startsWith('@'));
  return `/${segments.join('/')}`;
}

async function findAppPages(appDirectory: string): Promise<string[]> {
  const pages: string[] = [];
  const queue: Array<{ path: string; depth: number }> = [{ path: appDirectory, depth: 0 }];
  while (queue.length > 0) {
    const current = queue.shift();
    if (!current || current.depth > 8) continue;
    let entries;
    try {
      entries = await readdir(current.path, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const path = join(current.path, entry.name);
      if (entry.isDirectory()) queue.push({ path, depth: current.depth + 1 });
      else if (entry.isFile() && PAGE_FILE_PATTERN.test(entry.name)) pages.push(path);
    }
  }
  return pages;
}

async function projectAt(root: string): Promise<VinextProjectDescriptor | null> {
  const canonicalRoot = await realpath(root).catch(() => resolve(root));
  const manifest = await readManifest(canonicalRoot);
  if (!manifest || !usesVinext(manifest)) return null;
  const appDirectory = (await fileExists(join(canonicalRoot, 'app', 'page.tsx')) || await fileExists(join(canonicalRoot, 'app', 'page.jsx')))
    ? join(canonicalRoot, 'app')
    : (await fileExists(join(canonicalRoot, 'src', 'app', 'page.tsx')) || await fileExists(join(canonicalRoot, 'src', 'app', 'page.jsx')))
      ? join(canonicalRoot, 'src', 'app')
      : null;
  if (!appDirectory) return null;
  const pages = await findAppPages(appDirectory);
  if (pages.length === 0) return null;
  const routePairs = pages.map((path) => ({ path, route: routeFromPage(appDirectory, path) }));
  routePairs.sort((left, right) => left.route === '/' ? -1 : right.route === '/' ? 1 : left.route.localeCompare(right.route));
  const initial = routePairs.find(({ route }) => !route.includes('[')) ?? routePairs[0];
  return {
    root: canonicalRoot,
    name: manifest.name?.trim() || basename(canonicalRoot),
    entryPath: initial.path,
    routes: routePairs.map(({ route }) => route),
    initialRoute: initial.route,
  };
}

export async function detectVinextProject(workspaceRoot: string): Promise<VinextProjectDescriptor | null> {
  const root = resolve(workspaceRoot);
  const direct = await projectAt(root);
  if (direct) return direct;
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || entry.name.startsWith('.') || ['node_modules', 'out', 'dist', 'build'].includes(entry.name)) continue;
    const nested = await projectAt(join(root, entry.name));
    if (nested) return nested;
  }
  return null;
}

function intrinsicTagName(opening: AstNode): string | null {
  const name = opening.name as AstNode | undefined;
  if (name?.type !== 'JSXIdentifier') return null;
  const value = typeof name.name === 'string' ? name.name : '';
  return /^[a-z]/.test(value) ? value : null;
}

function staticAttribute(opening: AstNode, name: string, source: string): { value: string; range?: AttributeRange } | null {
  const attributes = Array.isArray(opening.attributes) ? opening.attributes as AstNode[] : [];
  const attribute = attributes.find((candidate) => {
    const candidateName = candidate.name as AstNode | undefined;
    return candidate.type === 'JSXAttribute' && candidateName?.type === 'JSXIdentifier' && candidateName.name === name;
  });
  if (!attribute) return null;
  const value = attribute.value as AstNode | null | undefined;
  if (!value || value.type !== 'StringLiteral' || typeof value.start !== 'number' || typeof value.end !== 'number') return null;
  const token = source.slice(value.start, value.end);
  const quote = token.startsWith("'") ? "'" : '"';
  return {
    value: typeof value.value === 'string' ? value.value : token.slice(1, -1),
    range: { start: value.start, end: value.end, quote },
  };
}

function hasAttribute(opening: AstNode, name: string): boolean {
  const attributes = Array.isArray(opening.attributes) ? opening.attributes as AstNode[] : [];
  return attributes.some((candidate) => {
    const candidateName = candidate.name as AstNode | undefined;
    return candidate.type === 'JSXAttribute' && candidateName?.type === 'JSXIdentifier' && candidateName.name === name;
  });
}

function staticClassName(opening: AstNode, source: string): string {
  return staticAttribute(opening, 'className', source)?.value ?? staticAttribute(opening, 'class', source)?.value ?? '';
}

function walkAst(value: unknown, parent: AstNode | null, visit: (node: AstNode, parent: AstNode | null) => void): void {
  if (Array.isArray(value)) {
    value.forEach((child) => walkAst(child, parent, visit));
    return;
  }
  if (!value || typeof value !== 'object') return;
  const node = value as AstNode;
  const nextParent = typeof node.type === 'string' ? node : parent;
  if (typeof node.type === 'string') visit(node, parent);
  for (const [key, child] of Object.entries(node)) {
    if (['loc', 'start', 'end', 'extra', 'errors'].includes(key)) continue;
    walkAst(child, nextParent, visit);
  }
}

function canDeleteFromParent(parent: AstNode | null): boolean {
  return parent?.type === 'JSXElement' || parent?.type === 'JSXFragment';
}

function sourceNodeForElement(node: AstNode, parent: AstNode | null, filePath: string, root: string, source: string, sourceHash: string): VinextSourceNode | null {
  const opening = node.openingElement as AstNode | undefined;
  if (!opening || typeof node.start !== 'number' || typeof node.end !== 'number' || typeof opening.end !== 'number') return null;
  const tagName = intrinsicTagName(opening);
  if (!tagName || NEVER_INSTRUMENT_TAGS.has(tagName)) return null;
  const children = Array.isArray(node.children) ? node.children as AstNode[] : [];
  const textChildren = children.filter((child) => child.type === 'JSXText');
  const hasOnlyText = children.length > 0 && textChildren.length === children.length;
  const textStart = hasOnlyText && typeof textChildren[0]?.start === 'number' ? textChildren[0].start : null;
  const textEnd = hasOnlyText && typeof textChildren.at(-1)?.end === 'number' ? textChildren.at(-1)!.end! : null;
  const hasText = textStart !== null && textEnd !== null && source.slice(textStart, textEnd).trim().length > 0;
  const className = staticClassName(opening, source);
  const isDivider = tagName === 'hr' || ((tagName === 'div' || tagName === 'span') && DIVIDER_PATTERN.test(className) && !hasText);
  const canDelete = canDeleteFromParent(parent);
  const kind = tagName === 'img'
    ? 'image'
    : tagName === 'a' && hasText
      ? 'link'
      : hasText && EDITABLE_TEXT_TAGS.has(tagName)
        ? 'text'
        : (isDivider || tagName === 'button') && canDelete
          ? 'element'
          : null;
  if (!kind) return null;
  const openingToken = source.slice(opening.start ?? node.start, opening.end);
  const selfClosing = /\/\>\s*$/.test(openingToken);
  const attributeInsertOffset = opening.end - (selfClosing ? 2 : 1);
  const href = staticAttribute(opening, 'href', source)?.range;
  const alt = staticAttribute(opening, 'alt', source)?.range;
  const src = staticAttribute(opening, 'src', source)?.range;
  const id = createHash('sha256').update(`${filePath}:${node.start}:${tagName}:${sourceHash}`).digest('hex').slice(0, 20);
  const line = node.loc?.start?.line ?? 1;
  return {
    id,
    filePath,
    sourceHash,
    sourceLabel: `${relative(root, filePath)}:${line}`,
    tagName,
    elementStart: node.start,
    elementEnd: node.end,
    textRange: hasText && textStart !== null && textEnd !== null ? { start: textStart, end: textEnd } : undefined,
    attributes: { href, alt, src },
    attributeInsertOffset,
    canDelete,
    canEditImageSource: tagName === 'img' && (!hasAttribute(opening, 'src') || Boolean(src)),
  };
}

export function instrumentVinextSource(source: string, filePath: string, projectRoot: string, registry: Map<string, VinextSourceNode>): string | null {
  let ast;
  try {
    ast = parse(source, {
      sourceType: 'unambiguous',
      errorRecovery: false,
      plugins: ['jsx', 'typescript', 'decorators-legacy'],
    });
  } catch {
    return null;
  }
  const sourceHash = hashSource(source);
  const magic = new MagicString(source);
  let count = 0;
  let bridgeInjected = false;
  walkAst(ast, null, (node, parent) => {
    if (node.type !== 'JSXElement') return;
    const opening = node.openingElement as AstNode | undefined;
    const closing = node.closingElement as AstNode | undefined;
    if (!bridgeInjected && opening && closing && intrinsicTagName(opening) === 'body' && typeof closing.start === 'number') {
      const bridgeElements = `<style data-second-pass-vinext dangerouslySetInnerHTML={{ __html: ${JSON.stringify(VINEXT_PREVIEW_STYLE)} }} /><script data-second-pass-vinext dangerouslySetInnerHTML={{ __html: ${JSON.stringify(VINEXT_PREVIEW_BRIDGE_SOURCE)} }} />`;
      magic.appendLeft(closing.start, bridgeElements);
      bridgeInjected = true;
      count += 1;
    }
    const sourceNode = sourceNodeForElement(node, parent, filePath, projectRoot, source, sourceHash);
    if (!sourceNode) return;
    registry.set(sourceNode.id, sourceNode);
    const kind = sourceNode.tagName === 'a' ? 'link' : sourceNode.tagName === 'img' ? 'image' : sourceNode.textRange ? 'text' : 'element';
    magic.appendLeft(
      sourceNode.attributeInsertOffset,
      ` data-cx-react-id="${sourceNode.id}" data-cx-react-kind="${kind}" data-cx-react-source="${sourceNode.sourceLabel}" data-cx-react-deletable="${sourceNode.canDelete}"${kind === 'image' ? ` data-cx-react-image-replaceable="${sourceNode.canEditImageSource}"` : ''}`,
    );
    count += 1;
  });
  return count > 0 ? magic.toString() : null;
}

function normalizeModulePath(id: string): string {
  return id.replace(/[?#].*$/, '');
}

export function injectVinextPreviewBridge(html: string): string {
  if (html.includes('data-second-pass-vinext')) return html;
  const injection = `<style data-second-pass-vinext>${VINEXT_PREVIEW_STYLE}</style><script data-second-pass-vinext>${VINEXT_PREVIEW_BRIDGE_SOURCE}</script>`;
  if (/<\/body\s*>/i.test(html)) return html.replace(/<\/body\s*>/i, `${injection}</body>`);
  return `${html}${injection}`;
}

export function createSecondPassVinextPlugin(projectRoot: string, registry: Map<string, VinextSourceNode>): Plugin {
  return {
    name: 'second-pass-vinext-editor',
    enforce: 'pre',
    transform(source, id) {
      const path = normalizeModulePath(id);
      if (!SOURCE_FILE_PATTERN.test(path) || !isInside(path, projectRoot) || path.includes(`${sep}node_modules${sep}`)) return null;
      const transformed = instrumentVinextSource(source, path, projectRoot, registry);
      return transformed ? { code: transformed, map: null } : null;
    },
    transformIndexHtml: {
      order: 'post',
      handler() {
        return [
          { tag: 'style', attrs: { 'data-second-pass-vinext': '' }, children: VINEXT_PREVIEW_STYLE, injectTo: 'head' },
          { tag: 'script', attrs: { 'data-second-pass-vinext': '' }, children: VINEXT_PREVIEW_BRIDGE_SOURCE, injectTo: 'body' },
        ];
      },
    },
  };
}

function escapeJsxText(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('{', '&#123;');
}

function escapeJsxAttribute(value: string, quote: '"' | "'"): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll(quote, quote === '"' ? '&quot;' : '&#39;');
}

interface SourceEdit { start: number; end: number; value: string }

function sourceEditForOperation(operation: VinextEditOperation, node: VinextSourceNode): SourceEdit {
  if (operation.action === 'delete') {
    if (!node.canDelete) throw new Error('This JSX element cannot be safely deleted from its source position.');
    return { start: node.elementStart, end: node.elementEnd, value: '' };
  }
  if (operation.action === 'text') {
    if (!node.textRange) throw new Error('This element does not have directly authored JSX text.');
    return { start: node.textRange.start, end: node.textRange.end, value: escapeJsxText(operation.value ?? '') };
  }
  const attribute = operation.attribute;
  if (attribute !== 'href' && attribute !== 'alt' && attribute !== 'src') throw new Error('Only href, alt, and src attributes can be changed directly.');
  if (attribute === 'src' && !node.canEditImageSource) throw new Error('This image uses a dynamic src expression and cannot be replaced directly.');
  const value = operation.value ?? '';
  const range = node.attributes[attribute];
  if (range) return { start: range.start, end: range.end, value: `${range.quote}${escapeJsxAttribute(value, range.quote)}${range.quote}` };
  return { start: node.attributeInsertOffset, end: node.attributeInsertOffset, value: ` ${attribute}="${escapeJsxAttribute(value, '"')}"` };
}

function applySourceEdits(source: string, edits: SourceEdit[]): string {
  const sorted = edits.toSorted((left, right) => right.start - left.start || right.end - left.end);
  let next = source;
  let previousStart = source.length + 1;
  for (const edit of sorted) {
    if (edit.start < 0 || edit.end < edit.start || edit.end > source.length || edit.end > previousStart) {
      throw new Error('These JSX edits overlap and cannot be saved together.');
    }
    next = `${next.slice(0, edit.start)}${edit.value}${next.slice(edit.end)}`;
    previousStart = edit.start;
  }
  return next;
}

export function applyVinextSourceOperations(
  source: string,
  operations: VinextEditOperation[],
  registry: Map<string, VinextSourceNode>,
): string {
  const resolved = operations.map((operation) => {
    const node = registry.get(operation.nodeId);
    if (!node) throw new Error('The selected JSX source is no longer available.');
    return { operation, node };
  });
  const deletes = new Set(resolved.filter(({ operation }) => operation.action === 'delete').map(({ operation }) => operation.nodeId));
  return applySourceEdits(
    source,
    resolved
      .filter(({ operation }) => operation.action === 'delete' || !deletes.has(operation.nodeId))
      .map(({ operation, node }) => sourceEditForOperation(operation, node)),
  );
}

async function createProjectBackup(historyRoot: string, filePath: string, source: string): Promise<void> {
  const key = createHash('sha256').update(resolve(filePath)).digest('hex');
  const directory = join(historyRoot, 'vinext', key);
  await mkdir(directory, { recursive: true });
  const extension = extname(filePath) || '.tsx';
  const id = `${Date.now()}-${hashSource(source).slice(0, 12)}${extension}`;
  await writeFile(join(directory, id), source, 'utf8');
  const entries = (await readdir(directory)).toSorted().reverse();
  await Promise.all(entries.slice(20).map((entry) => unlink(join(directory, entry)).catch(() => undefined)));
}

export class VinextPreviewManager {
  private server: ViteDevServer | null = null;
  private descriptor: VinextProjectDescriptor | null = null;
  private readonly registry = new Map<string, VinextSourceNode>();

  async start(descriptor: VinextProjectDescriptor): Promise<VinextProjectSession> {
    await this.stop();
    this.descriptor = descriptor;
    this.registry.clear();
    const projectRequire = createRequire(join(descriptor.root, 'package.json'));
    let viteEntry: string;
    try {
      viteEntry = projectRequire.resolve('vite');
    } catch {
      throw new Error('Install this project’s dependencies before opening it in Second Pass. Vite was not found.');
    }
    const vite = await import(`${pathToFileURL(viteEntry).href}?second-pass=${randomUUID()}`) as typeof import('vite');
    const configPath = (await Promise.all(CONFIG_NAMES.map(async (name) => {
      const path = join(descriptor.root, name);
      return await fileExists(path) ? path : null;
    }))).find((path): path is string => Boolean(path));
    const plugins: Plugin[] = [];
    const configSource = configPath ? await readFile(configPath, 'utf8') : '';
    if (!/\bvinext\s*\(/.test(configSource)) {
      let vinextEntry: string;
      try {
        vinextEntry = projectRequire.resolve('vinext');
      } catch {
        throw new Error('Install this project’s dependencies before opening it in Second Pass. Vinext was not found.');
      }
      const vinextModule = await import(`${pathToFileURL(vinextEntry).href}?second-pass=${randomUUID()}`) as { default?: () => Plugin };
      if (typeof vinextModule.default !== 'function') throw new Error('This Vinext installation does not expose a Vite plugin.');
      plugins.push(vinextModule.default());
    }
    plugins.push(createSecondPassVinextPlugin(descriptor.root, this.registry));
    const previousWorkingDirectory = process.cwd();
    try {
      process.chdir(descriptor.root);
      this.server = await vite.createServer({
        root: descriptor.root,
        configFile: configPath ?? false,
        plugins,
        server: { host: '127.0.0.1', port: 0, strictPort: false },
        clearScreen: false,
        logLevel: 'warn',
      });
      await this.server.listen();
    } finally {
      process.chdir(previousWorkingDirectory);
    }
    const origin = this.server.resolvedUrls?.local[0];
    if (!origin) {
      await this.stop();
      throw new Error('Vinext started, but Second Pass could not determine its preview address.');
    }
    return {
      kind: 'vinext',
      root: descriptor.root,
      name: descriptor.name,
      entryPath: descriptor.entryPath,
      routes: descriptor.routes,
      route: descriptor.initialRoute,
      previewUrl: new URL(descriptor.initialRoute.replace(/^\//, ''), origin).href,
    };
  }

  async save(operations: VinextEditOperation[], historyRoot: string): Promise<VinextSaveResult> {
    if (!this.descriptor || !this.server) return { status: 'error', message: 'No Vinext project is open.' };
    try {
      const grouped = new Map<string, Array<{ operation: VinextEditOperation; node: VinextSourceNode }>>();
      for (const operation of operations) {
        const node = this.registry.get(operation.nodeId);
        if (!node) throw new Error('The selected JSX source is no longer available. Reload the page and try again.');
        const entries = grouped.get(node.filePath) ?? [];
        entries.push({ operation, node });
        grouped.set(node.filePath, entries);
      }
      const prepared: Array<{ path: string; source: string; nextSource: string; version: DiskVersion }> = [];
      for (const [path, entries] of grouped) {
        const source = await readFile(path, 'utf8');
        const version = await getDiskVersion(path, source);
        if (entries.some(({ node }) => node.sourceHash !== version.sha256)) {
          return { status: 'conflict', path, message: `${relative(this.descriptor.root, path)} changed after you began editing.` };
        }
        prepared.push({
          path,
          source,
          nextSource: applyVinextSourceOperations(source, entries.map(({ operation }) => operation), this.registry),
          version,
        });
      }
      for (const file of prepared) {
        await createProjectBackup(historyRoot, file.path, file.source);
        await atomicWrite(file.path, file.nextSource);
      }
      return { status: 'saved', changedFiles: prepared.map(({ path }) => path) };
    } catch (error) {
      return { status: 'error', message: error instanceof Error ? error.message : 'Unable to save JSX changes.' };
    }
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    this.descriptor = null;
    if (server) await server.close();
  }
}
