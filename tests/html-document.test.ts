import { describe, expect, it } from 'vitest';

import { applyEditOperations, buildInstrumentedHtml, parseEditableNodes, rebaseEditedSource } from '../src/lib/html-document';

const SOURCE = `<!doctype html>
<html>
  <head><meta charset="utf-8"><style>.hero { color: red; }</style></head>
  <body>
    <!-- preserve me -->
    <main>
      <div class="hero">
        <h1>Hello <strong>world</strong></h1>
        <p>Intro with <a href="/about">a link</a>.</p>
        <button data-action="go">Continue</button>
      </div>
      <div class="leaf">Standalone copy</div>
      <img src="portrait.jpg" alt="Portrait">
    </main>
    <script>document.body.dataset.ready = 'yes';</script>
  </body>
</html>`;

describe('HTML document editing', () => {
  it('selects non-overlapping, source-authored edit roots', () => {
    const nodes = parseEditableNodes(SOURCE);
    expect(nodes.map((node) => node.tagName)).toEqual(['h1', 'p', 'button', 'div', 'img']);
    expect(nodes.map((node) => node.id)).toEqual(['cx-0', 'cx-1', 'cx-2', 'cx-3', 'cx-4']);
    for (let index = 1; index < nodes.length; index += 1) {
      expect(nodes[index - 1].endOffset).toBeLessThanOrEqual(nodes[index].startOffset);
    }
    expect(nodes[1].originalOuterHtml).toBe('<p>Intro with <a href="/about">a link</a>.</p>');
  });

  it('instruments only the in-memory preview', () => {
    const { html, nodes } = buildInstrumentedHtml(SOURCE, 'codex-asset://local/');
    expect(SOURCE).not.toContain('data-cx-edit-id');
    expect(html).toContain('<base href="codex-asset://local/">');
    expect(html).toContain('data-cx-edit-id="cx-0"');
    expect(html).toContain('data-cx-source-label="h1"');
    expect(html).toContain('data-cx-editor-bridge');
    expect(html).toContain('<script>document.body.dataset.ready = \'yes\';</script>');
    expect(nodes).toHaveLength(5);
  });

  it('flags source elements referenced by inline scripts', () => {
    const source = '<button id="counter">0</button><p id="copy">Text</p><script>document.querySelector("#counter").textContent = "1"</script>';
    const nodes = parseEditableNodes(source);
    expect(nodes.find((node) => node.sourceLabel === 'button#counter')?.scriptCoupled).toBe(true);
    expect(nodes.find((node) => node.sourceLabel === 'p#copy')?.scriptCoupled).toBe(false);
  });

  it('selects source-authored dividers and icon-only buttons for deletion', () => {
    const nodes = parseEditableNodes('<main><hr id="rule"><div class="section-divider"></div><button aria-label="Close"><svg></svg></button></main>');
    expect(nodes.map(({ kind, tagName }) => ({ kind, tagName }))).toEqual([
      { kind: 'element', tagName: 'hr' },
      { kind: 'element', tagName: 'div' },
      { kind: 'element', tagName: 'button' },
    ]);
  });

  it('neutralizes a page CSP in the preview without touching source', () => {
    const source = '<html><head><meta http-equiv="content-security-policy" content="script-src \'none\'"></head><body><p>Hello</p></body></html>';
    const { html } = buildInstrumentedHtml(source);
    expect(html).toContain('data-cx-http-equiv="content-security-policy"');
    expect(source).toContain('http-equiv="content-security-policy"');
  });

  it('changes only requested source ranges', () => {
    const [heading, paragraph] = parseEditableNodes(SOURCE);
    const updated = applyEditOperations(SOURCE, [
      {
        nodeId: heading.id,
        startOffset: heading.startOffset,
        endOffset: heading.endOffset,
        replacementOuterHtml: '<h1>Revised <em>headline</em></h1>',
        timestamp: 1,
      },
      {
        nodeId: paragraph.id,
        startOffset: paragraph.startOffset,
        endOffset: paragraph.endOffset,
        replacementOuterHtml: '<p>Revised paragraph.</p>',
        timestamp: 2,
      },
    ]);
    expect(updated).toContain('<h1>Revised <em>headline</em></h1>');
    expect(updated).toContain('<p>Revised paragraph.</p>');
    expect(updated).toContain('<!-- preserve me -->');
    expect(updated).toContain('<style>.hero { color: red; }</style>');
    expect(updated).toContain("<script>document.body.dataset.ready = 'yes';</script>");
  });

  it('handles malformed HTML and Unicode copy', () => {
    const source = '<!doctype html><body><h1>Zócalo 🟣<p>Unclosed paragraph';
    const nodes = parseEditableNodes(source);
    expect(nodes.map((node) => node.originalOuterHtml)).toEqual(['<h1>Zócalo 🟣<p>Unclosed paragraph']);
  });

  it('rejects overlapping replacements', () => {
    expect(() =>
      applyEditOperations('0123456789', [
        { nodeId: 'a', startOffset: 2, endOffset: 7, replacementOuterHtml: 'a', timestamp: 1 },
        { nodeId: 'b', startOffset: 5, endOffset: 9, replacementOuterHtml: 'b', timestamp: 2 },
      ]),
    ).toThrow(/overlapping/i);
  });

  it('rebases visual edits when external changes do not touch the edited region', () => {
    const nodes = parseEditableNodes('<h1>Title</h1><p>Copy</p>');
    const rebased = rebaseEditedSource(
      '<header>New</header><h1>Title</h1><p>Copy changed elsewhere</p>',
      nodes,
      { [nodes[0].id]: '<h1>Edited title</h1>' },
    );
    expect(rebased).toBe('<header>New</header><h1>Edited title</h1><p>Copy changed elsewhere</p>');
  });

  it('refuses to rebase when the edited source region also changed', () => {
    const nodes = parseEditableNodes('<h1>Title</h1>');
    expect(rebaseEditedSource('<h1>Changed outside</h1>', nodes, { [nodes[0].id]: '<h1>Edited title</h1>' })).toBeNull();
  });
});
