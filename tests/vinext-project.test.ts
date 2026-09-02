import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import type { VinextEditOperation } from '../src/shared/types';
import {
  applyVinextSourceOperations,
  detectVinextProject,
  injectVinextPreviewBridge,
  instrumentVinextSource,
  type VinextSourceNode,
} from '../src/lib/vinext-project';

describe('Vinext project support', () => {
  it('injects the editor bridge into server-rendered HTML exactly once', () => {
    const html = '<!doctype html><html><body><main>Page</main></body></html>';
    const injected = injectVinextPreviewBridge(html);
    expect(injected).toContain('<script data-second-pass-vinext>');
    expect(injectVinextPreviewBridge(injected).match(/data-second-pass-vinext/g)).toHaveLength(2);
  });

  it('detects App Router pages and derives routes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'second-pass-vinext-'));
    await mkdir(join(root, 'app', 'about'), { recursive: true });
    await mkdir(join(root, 'app', '(marketing)', 'pricing'), { recursive: true });
    await writeFile(join(root, 'package.json'), JSON.stringify({ name: 'sample-app', scripts: { dev: 'vinext dev' }, dependencies: { vinext: '^1.0.0' } }), 'utf8');
    await writeFile(join(root, 'app', 'page.tsx'), 'export default function Page(){return <h1>Home</h1>}', 'utf8');
    await writeFile(join(root, 'app', 'about', 'page.tsx'), 'export default function Page(){return <h1>About</h1>}', 'utf8');
    await writeFile(join(root, 'app', '(marketing)', 'pricing', 'page.tsx'), 'export default function Page(){return <h1>Pricing</h1>}', 'utf8');
    try {
      const canonicalRoot = await realpath(root);
      await expect(detectVinextProject(root)).resolves.toMatchObject({
        root: canonicalRoot,
        name: 'sample-app',
        initialRoute: '/',
        routes: ['/', '/about', '/pricing'],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('instruments static intrinsic JSX without tagging dynamic or custom components', () => {
    const source = `export default function Page({ title }: { title: string }) {
  return <main><h1>Hello world</h1><p>{title}</p><Card>Static</Card><img src="/hero.png" alt="Hero" /></main>;
}`;
    const registry = new Map<string, VinextSourceNode>();
    const transformed = instrumentVinextSource(source, '/tmp/project/app/page.tsx', '/tmp/project', registry) ?? '';
    expect(transformed).toContain('data-cx-react-kind="text"');
    expect(transformed).toContain('data-cx-react-kind="image"');
    expect(transformed.match(/data-cx-react-id=/g)).toHaveLength(2);
    expect([...registry.values()].map((node) => node.tagName)).toEqual(['h1', 'img']);
  });

  it('injects the editing runtime into an App Router root layout', () => {
    const source = `export default function Layout({ children }: { children: React.ReactNode }) {
  return <html><body>{children}</body></html>;
}`;
    const transformed = instrumentVinextSource(source, '/tmp/project/app/layout.tsx', '/tmp/project', new Map()) ?? '';
    expect(transformed).toContain('<style data-second-pass-vinext');
    expect(transformed).toContain('<script data-second-pass-vinext');
    expect(transformed).toContain('</body>');
  });

  it('writes text and attributes back to exact JSX ranges and safely deletes child elements', () => {
    const source = `export default function Page() {
  return <main><h1>Hello world</h1><a href='/about'>About</a><img src="/hero.png" /></main>;
}`;
    const registry = new Map<string, VinextSourceNode>();
    instrumentVinextSource(source, '/tmp/project/app/page.tsx', '/tmp/project', registry);
    const byTag = new Map([...registry.values()].map((node) => [node.tagName, node]));
    const operations: VinextEditOperation[] = [
      { id: 'heading:text', nodeId: byTag.get('h1')!.id, action: 'text', value: 'A {better} headline', before: 'Hello world', sourceLabel: 'app/page.tsx:2', timestamp: 1 },
      { id: 'link:href', nodeId: byTag.get('a')!.id, action: 'attribute', attribute: 'href', value: '/work?from=second-pass', before: '/about', sourceLabel: 'app/page.tsx:2', timestamp: 2 },
      { id: 'image:alt', nodeId: byTag.get('img')!.id, action: 'attribute', attribute: 'alt', value: 'Hero portrait', before: '', sourceLabel: 'app/page.tsx:2', timestamp: 3 },
      { id: 'image:src', nodeId: byTag.get('img')!.id, action: 'attribute', attribute: 'src', value: '/second-pass-assets/new-hero.png', before: '/hero.png', sourceLabel: 'app/page.tsx:2', timestamp: 4 },
    ];
    const updated = applyVinextSourceOperations(source, operations, registry);
    expect(updated).toContain('<h1>A &#123;better} headline</h1>');
    expect(updated).toContain("<a href='/work?from=second-pass'>About</a>");
    expect(updated).toContain('<img src="/second-pass-assets/new-hero.png"  alt="Hero portrait"/>');

    const deleted = applyVinextSourceOperations(source, [{
      id: 'image:delete',
      nodeId: byTag.get('img')!.id,
      action: 'delete',
      before: '<img src="/hero.png" />',
      sourceLabel: 'app/page.tsx:2',
      timestamp: 5,
    }], registry);
    expect(deleted).not.toContain('<img');
    expect(deleted).toContain('<a href');
  });

  it('blocks image replacement when JSX uses a dynamic source expression', () => {
    const source = `export default function Page({ hero }: { hero: string }) {
  return <main><img src={hero} alt="Hero" /></main>;
}`;
    const registry = new Map<string, VinextSourceNode>();
    const transformed = instrumentVinextSource(source, '/tmp/project/app/page.tsx', '/tmp/project', registry) ?? '';
    const image = [...registry.values()].find((node) => node.tagName === 'img')!;
    expect(transformed).toContain('data-cx-react-image-replaceable="false"');
    expect(() => applyVinextSourceOperations(source, [{
      id: 'image:src',
      nodeId: image.id,
      action: 'attribute',
      attribute: 'src',
      value: '/second-pass-assets/hero.png',
      before: '',
      sourceLabel: image.sourceLabel,
      timestamp: 1,
    }], registry)).toThrow(/dynamic src expression/);
  });
});
