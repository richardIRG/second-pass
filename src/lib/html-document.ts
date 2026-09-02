import { parse } from 'parse5';

import type { EditableKind, EditableNode, EditOperation } from '../shared/types';
import { PREVIEW_BRIDGE_SOURCE } from './preview-bridge-source';

interface SourceLocation {
  startOffset: number;
  endOffset: number;
  startTag?: { startOffset: number; endOffset: number };
  endTag?: { startOffset: number; endOffset: number };
}

interface ParsedNode {
  nodeName: string;
  tagName?: string;
  attrs?: Array<{ name: string; value: string }>;
  childNodes?: ParsedNode[];
  sourceCodeLocation?: SourceLocation;
}

interface StringEdit {
  startOffset: number;
  endOffset: number;
  value: string;
}

const PRIMARY_EDITABLE_TAGS = new Set([
  'h1',
  'h2',
  'h3',
  'h4',
  'h5',
  'h6',
  'p',
  'li',
  'blockquote',
  'figcaption',
  'button',
  'label',
  'a',
  'td',
  'th',
  'caption',
  'ul',
  'ol',
]);

const GENERIC_EDITABLE_TAGS = new Set(['div', 'span', 'small']);
const DELETE_ONLY_TAGS = new Set(['hr']);
const DIVIDER_NAME_PATTERN = /(?:^|[-_\s])(divider|separator|rule)(?:$|[-_\s])/i;
const EXCLUDED_TAGS = new Set([
  'html',
  'head',
  'body',
  'script',
  'style',
  'template',
  'noscript',
  'code',
  'pre',
  'textarea',
  'input',
  'select',
  'option',
  'svg',
  'math',
]);

const PREVIEW_STYLE = `
<style data-cx-editor-style>
  body[data-cx-mode="edit"] [data-cx-edit-id] { cursor: text; }
  body[data-cx-mode="edit"] img[data-cx-edit-id],
  body[data-cx-mode="edit"] [data-cx-edit-kind="element"],
  body[data-cx-mode="edit"] [data-cx-edit-id] img { cursor: pointer; }
  body[data-cx-mode="edit"] [data-cx-edit-id]:hover:not([data-cx-active]) {
    outline: 1px dashed rgba(53, 97, 143, 0.76) !important;
    outline-offset: 3px !important;
  }
  [data-cx-active] {
    outline: 2px solid #35618f !important;
    outline-offset: 3px !important;
  }
  [data-cx-edit-id][contenteditable="true"] { caret-color: #35618f; }
</style>`;

function getAttribute(node: ParsedNode, name: string): string | undefined {
  return node.attrs?.find((attribute) => attribute.name.toLowerCase() === name)?.value;
}

function getSourceLabel(node: ParsedNode): string {
  const tagName = node.tagName?.toLowerCase() ?? 'element';
  const id = getAttribute(node, 'id');
  const className = getAttribute(node, 'class')?.trim().split(/\s+/).filter(Boolean).slice(0, 2).join('.');
  return `${tagName}${id ? `#${id}` : ''}${className ? `.${className}` : ''}`;
}

function isScriptCoupled(node: ParsedNode, inlineScripts: string): boolean {
  const id = getAttribute(node, 'id');
  if (!id || !inlineScripts) return false;
  const escapedId = id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return [
    new RegExp(`getElementById\\(\\s*['\"]${escapedId}['\"]\\s*\\)`),
    new RegExp(`querySelector(?:All)?\\(\\s*['\"]#${escapedId}['\"]\\s*\\)`),
    new RegExp(`['\"]#${escapedId}['\"]`),
  ].some((pattern) => pattern.test(inlineScripts));
}

function hasMeaningfulText(node: ParsedNode): boolean {
  if (node.nodeName === '#text') {
    const value = (node as ParsedNode & { value?: string }).value ?? '';
    return value.trim().length > 0;
  }
  return node.childNodes?.some(hasMeaningfulText) ?? false;
}

function hasPrimaryEditableDescendant(node: ParsedNode): boolean {
  return (
    node.childNodes?.some((child) => {
      const tagName = child.tagName?.toLowerCase();
      return Boolean(tagName && PRIMARY_EDITABLE_TAGS.has(tagName)) || hasPrimaryEditableDescendant(child);
    }) ?? false
  );
}

function isNamedEmptyDivider(node: ParsedNode, tagName: string): boolean {
  if (tagName !== 'div' && tagName !== 'span') return false;
  const name = `${getAttribute(node, 'id') ?? ''} ${getAttribute(node, 'class') ?? ''}`;
  const hasElementChild = node.childNodes?.some((child) => Boolean(child.tagName)) ?? false;
  return !hasMeaningfulText(node) && !hasElementChild && DIVIDER_NAME_PATTERN.test(name);
}

function isEditableRoot(node: ParsedNode): { kind: EditableKind; tagName: string } | null {
  const tagName = node.tagName?.toLowerCase();
  const location = node.sourceCodeLocation;
  if (!tagName || !location?.startTag || EXCLUDED_TAGS.has(tagName)) return null;
  if (getAttribute(node, 'contenteditable') !== undefined) return null;

  if (tagName === 'img') return { kind: 'image', tagName };
  if (DELETE_ONLY_TAGS.has(tagName) || isNamedEmptyDivider(node, tagName)) return { kind: 'element', tagName };
  if (tagName === 'button' && !hasMeaningfulText(node)) return { kind: 'element', tagName };
  if (!hasMeaningfulText(node)) return null;
  if (PRIMARY_EDITABLE_TAGS.has(tagName)) return { kind: 'rich-text', tagName };
  if (GENERIC_EDITABLE_TAGS.has(tagName) && !hasPrimaryEditableDescendant(node)) {
    return { kind: 'rich-text', tagName };
  }
  return null;
}

function walkForEditableNodes(node: ParsedNode, source: string, inlineScripts: string, output: EditableNode[]): void {
  const editable = isEditableRoot(node);
  const location = node.sourceCodeLocation;

  if (editable && location) {
    output.push({
      id: `cx-${output.length}`,
      kind: editable.kind,
      tagName: editable.tagName,
      sourceLabel: getSourceLabel(node),
      scriptCoupled: isScriptCoupled(node, inlineScripts),
      startOffset: location.startOffset,
      endOffset: location.endOffset,
      originalOuterHtml: source.slice(location.startOffset, location.endOffset),
    });
    return;
  }

  node.childNodes?.forEach((child) => walkForEditableNodes(child, source, inlineScripts, output));
}

function walk(node: ParsedNode, visit: (node: ParsedNode) => void): void {
  visit(node);
  node.childNodes?.forEach((child) => walk(child, visit));
}

function applyStringEdits(source: string, edits: StringEdit[]): string {
  const sorted = edits.toSorted((a, b) => b.startOffset - a.startOffset);
  let result = source;
  let previousStart = source.length + 1;

  for (const edit of sorted) {
    if (
      edit.startOffset < 0 ||
      edit.endOffset < edit.startOffset ||
      edit.endOffset > source.length ||
      edit.endOffset > previousStart
    ) {
      throw new Error('Cannot apply overlapping or invalid source edits.');
    }
    result = `${result.slice(0, edit.startOffset)}${edit.value}${result.slice(edit.endOffset)}`;
    previousStart = edit.startOffset;
  }
  return result;
}

function escapeAttribute(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('"', '&quot;');
}

function neutralizeCspTag(source: string, node: ParsedNode): StringEdit | null {
  if (node.tagName?.toLowerCase() !== 'meta' || !node.sourceCodeLocation?.startTag) return null;
  const httpEquiv = getAttribute(node, 'http-equiv')?.toLowerCase();
  if (httpEquiv !== 'content-security-policy') return null;
  const { startOffset, endOffset } = node.sourceCodeLocation.startTag;
  const tag = source.slice(startOffset, endOffset);
  return {
    startOffset,
    endOffset,
    value: tag.replace(/http-equiv\s*=\s*(["'])content-security-policy\1/i, 'data-cx-http-equiv="content-security-policy"'),
  };
}

export function parseEditableNodes(source: string): EditableNode[] {
  const document = parse(source, { sourceCodeLocationInfo: true }) as ParsedNode;
  const nodes: EditableNode[] = [];
  const inlineScripts = collectInlineScripts(document, source);
  walkForEditableNodes(document, source, inlineScripts, nodes);
  return nodes;
}

function collectInlineScripts(document: ParsedNode, source: string): string {
  const scripts: string[] = [];
  walk(document, (node) => {
    if (node.tagName?.toLowerCase() !== 'script' || !node.sourceCodeLocation) return;
    scripts.push(source.slice(node.sourceCodeLocation.startOffset, node.sourceCodeLocation.endOffset));
  });
  return scripts.join('\n');
}

export function buildInstrumentedHtml(
  source: string,
  assetBaseUrl = 'codex-asset://local/',
): { html: string; nodes: EditableNode[] } {
  const document = parse(source, { sourceCodeLocationInfo: true }) as ParsedNode;
  const nodes: EditableNode[] = [];
  const inlineScripts = collectInlineScripts(document, source);
  walkForEditableNodes(document, source, inlineScripts, nodes);

  const edits: StringEdit[] = [];
  let headInsertionOffset: number | null = null;
  let bodyInsertionOffset: number | null = null;

  walk(document, (node) => {
    const location = node.sourceCodeLocation;
    const tagName = node.tagName?.toLowerCase();
    if (tagName === 'head' && location?.startTag) headInsertionOffset = location.startTag.endOffset;
    if (tagName === 'body' && location?.endTag) bodyInsertionOffset = location.endTag.startOffset;
    const cspEdit = neutralizeCspTag(source, node);
    if (cspEdit) edits.push(cspEdit);
  });

  for (const node of nodes) {
    const parsedNode = findNodeAtOffset(document, node.startOffset);
    const endOfStartTag = parsedNode?.sourceCodeLocation?.startTag?.endOffset;
    if (endOfStartTag === undefined) continue;
    const insertionOffset = source[endOfStartTag - 2] === '/' ? endOfStartTag - 2 : endOfStartTag - 1;
    edits.push({
      startOffset: insertionOffset,
      endOffset: insertionOffset,
      value: ` data-cx-edit-id="${node.id}" data-cx-edit-kind="${node.kind}" data-cx-source-label="${escapeAttribute(node.sourceLabel)}"${node.scriptCoupled ? ' data-cx-script-coupled="true"' : ''}`,
    });
  }

  const headMarkup = `<base href="${escapeAttribute(assetBaseUrl)}">`;
  if (headInsertionOffset !== null) {
    edits.push({ startOffset: headInsertionOffset, endOffset: headInsertionOffset, value: headMarkup });
  } else {
    edits.push({ startOffset: 0, endOffset: 0, value: headMarkup });
  }

  const bridgeMarkup = `${PREVIEW_STYLE}<script data-cx-editor-bridge>${PREVIEW_BRIDGE_SOURCE.replaceAll('</script>', '<\\/script>')}</script>`;
  const bridgeOffset = bodyInsertionOffset ?? source.length;
  edits.push({ startOffset: bridgeOffset, endOffset: bridgeOffset, value: bridgeMarkup });

  return { html: applyStringEdits(source, edits), nodes };
}

function findNodeAtOffset(node: ParsedNode, startOffset: number): ParsedNode | null {
  if (node.sourceCodeLocation?.startOffset === startOffset) return node;
  for (const child of node.childNodes ?? []) {
    const found = findNodeAtOffset(child, startOffset);
    if (found) return found;
  }
  return null;
}

export function applyEditOperations(source: string, operations: EditOperation[]): string {
  return applyStringEdits(
    source,
    operations.map((operation) => ({
      startOffset: operation.startOffset,
      endOffset: operation.endOffset,
      value: operation.replacementOuterHtml,
    })),
  );
}

export function rebaseEditedSource(
  nextSource: string,
  originalNodes: EditableNode[],
  replacements: Record<string, string>,
): string | null {
  const edits: StringEdit[] = [];
  const nodesById = new Map(originalNodes.map((node) => [node.id, node]));

  for (const [nodeId, value] of Object.entries(replacements)) {
    const node = nodesById.get(nodeId);
    if (!node) return null;
    const startOffset = nextSource.indexOf(node.originalOuterHtml);
    if (startOffset < 0 || nextSource.indexOf(node.originalOuterHtml, startOffset + 1) >= 0) return null;
    edits.push({ startOffset, endOffset: startOffset + node.originalOuterHtml.length, value });
  }

  return applyStringEdits(nextSource, edits);
}
