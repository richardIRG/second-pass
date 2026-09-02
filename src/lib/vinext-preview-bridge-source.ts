export const VINEXT_PREVIEW_STYLE = `
  body[data-cx-mode="edit"] [data-cx-react-id] { cursor: text; }
  body[data-cx-mode="edit"] [data-cx-react-kind="image"],
  body[data-cx-mode="edit"] [data-cx-react-kind="element"] { cursor: pointer; }
  body[data-cx-mode="edit"] [data-cx-react-id]:hover:not([data-cx-active]) {
    outline: 1px dashed rgba(53, 97, 143, 0.76) !important;
    outline-offset: 3px !important;
  }
  [data-cx-active] {
    outline: 2px solid #35618f !important;
    outline-offset: 3px !important;
  }
  [data-cx-react-id][contenteditable="true"] { caret-color: #35618f; }
`;

export const VINEXT_PREVIEW_BRIDGE_SOURCE = String.raw`(() => {
  if (window.__SECOND_PASS_VINEXT_BRIDGE__) return;
  window.__SECOND_PASS_VINEXT_BRIDGE__ = true;
  const HOST_CHANNEL = 'codex-html-editor-host';
  const PREVIEW_CHANNEL = 'codex-html-editor';
  let mode = 'edit';
  let activeRoot = null;
  const originals = new Map();

  const post = (message) => window.parent.postMessage({ channel: PREVIEW_CHANNEL, ...message }, '*');
  const remember = (root) => {
    const id = root.dataset.cxReactId;
    if (!id || originals.has(id)) return;
    originals.set(id, {
      text: root.textContent || '',
      href: root.getAttribute('href'),
      alt: root.getAttribute('alt'),
      src: root.getAttribute('src'),
      display: root.style.display,
    });
  };
  const selectionPayload = () => {
    if (!activeRoot || !document.contains(activeRoot)) return null;
    const rect = activeRoot.getBoundingClientRect();
    const kind = activeRoot.dataset.cxReactKind || 'element';
    return {
      nodeId: activeRoot.dataset.cxReactId,
      sourceMode: 'jsx',
      canDelete: activeRoot.dataset.cxReactDeletable === 'true',
      kind: kind === 'text' ? 'rich-text' : kind,
      tagName: activeRoot.tagName.toLowerCase(),
      rect: { top: rect.top, left: rect.left, right: rect.right, bottom: rect.bottom, width: rect.width, height: rect.height },
      linkUrl: activeRoot.getAttribute('href') || undefined,
      imageAlt: activeRoot.getAttribute('alt') || '',
      imageSrc: activeRoot.getAttribute('src') || undefined,
      hasTextSelection: false,
      sourceLabel: activeRoot.dataset.cxReactSource || activeRoot.tagName.toLowerCase(),
      scriptCoupled: false,
      canReplaceImage: kind === 'image' && activeRoot.dataset.cxReactImageReplaceable === 'true',
      formatting: { bold: false, italic: false, orderedList: false, unorderedList: false, linked: kind === 'link' },
    };
  };
  const emitSelection = () => post({ type: 'selection', selection: selectionPayload() });
  const deactivate = () => {
    if (activeRoot) {
      activeRoot.removeAttribute('data-cx-active');
      if (activeRoot.dataset.cxOwnedContenteditable === 'true') {
        activeRoot.removeAttribute('contenteditable');
        activeRoot.removeAttribute('spellcheck');
        delete activeRoot.dataset.cxOwnedContenteditable;
      }
    }
    activeRoot = null;
    emitSelection();
  };
  const activate = (root) => {
    if (activeRoot !== root) deactivate();
    activeRoot = root;
    remember(root);
    root.setAttribute('data-cx-active', 'true');
    const kind = root.dataset.cxReactKind;
    if ((kind === 'text' || kind === 'link') && !root.hasAttribute('contenteditable')) {
      root.setAttribute('contenteditable', 'true');
      root.setAttribute('spellcheck', 'true');
      root.dataset.cxOwnedContenteditable = 'true';
      root.focus({ preventScroll: true });
    }
    emitSelection();
  };
  const emitOperation = (root, action, value, attribute) => {
    const nodeId = root.dataset.cxReactId;
    if (!nodeId) return;
    remember(root);
    const original = originals.get(nodeId);
    const before = action === 'text' ? original.text : action === 'attribute' ? (original[attribute] || '') : root.outerHTML;
    post({
      type: 'project-edit',
      operation: {
        id: nodeId + ':' + action + (attribute ? ':' + attribute : ''),
        nodeId,
        action,
        attribute,
        value,
        before,
        sourceLabel: root.dataset.cxReactSource || root.tagName.toLowerCase(),
        timestamp: Date.now(),
      },
    });
  };
  const applyOperations = (operations) => {
    for (const [nodeId, original] of originals) {
      const root = document.querySelector('[data-cx-react-id="' + CSS.escape(nodeId) + '"]');
      if (!root) continue;
      root.textContent = original.text;
      if (original.href === null) root.removeAttribute('href'); else root.setAttribute('href', original.href);
      if (original.alt === null) root.removeAttribute('alt'); else root.setAttribute('alt', original.alt);
      if (original.src === null) root.removeAttribute('src'); else root.setAttribute('src', original.src);
      root.style.display = original.display;
    }
    for (const operation of operations || []) {
      const root = document.querySelector('[data-cx-react-id="' + CSS.escape(String(operation.nodeId)) + '"]');
      if (!root) continue;
      remember(root);
      if (operation.action === 'text') root.textContent = operation.value || '';
      if (operation.action === 'attribute' && operation.attribute) root.setAttribute(operation.attribute, operation.value || '');
      if (operation.action === 'delete') root.style.display = 'none';
    }
    emitSelection();
  };

  document.addEventListener('pointerdown', (event) => {
    if (mode !== 'edit') return;
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest('[data-cx-react-id]');
    if (!root) return deactivate();
    event.stopPropagation();
    activate(root);
  }, true);
  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (mode === 'edit') {
      if (!target?.closest('[data-cx-react-id]')) return;
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    const anchor = target?.closest('a[href]');
    if (!anchor) return;
    const rawHref = anchor.getAttribute('href');
    if (!rawHref || rawHref.startsWith('#')) return;
    try {
      const url = new URL(rawHref, document.baseURI);
      if (url.origin === location.origin && (url.protocol === 'http:' || url.protocol === 'https:')) return;
      event.preventDefault();
      event.stopPropagation();
      post({ type: 'open-link', url: url.href });
    } catch {}
  }, true);
  document.addEventListener('input', () => {
    if (mode !== 'edit' || !activeRoot) return;
    const kind = activeRoot.dataset.cxReactKind;
    if (kind === 'text' || kind === 'link') emitOperation(activeRoot, 'text', activeRoot.textContent || '');
    emitSelection();
  }, true);
  document.addEventListener('scroll', () => { if (mode === 'edit' && activeRoot) emitSelection(); }, true);
  window.addEventListener('resize', () => { if (mode === 'edit' && activeRoot) emitSelection(); });
  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 's') { event.preventDefault(); post({ type: 'save-request' }); }
    if (key === 'z') { event.preventDefault(); post({ type: event.shiftKey ? 'redo-request' : 'undo-request' }); }
  }, true);
  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.channel !== HOST_CHANNEL) return;
    if (message.type === 'set-mode') {
      mode = message.mode;
      if (document.body) document.body.dataset.cxMode = mode;
      if (mode !== 'edit') deactivate();
    } else if (message.type === 'focus-node') {
      const root = document.querySelector('[data-cx-react-id="' + CSS.escape(String(message.nodeId)) + '"]');
      if (root) { root.scrollIntoView({ behavior: 'smooth', block: 'center' }); activate(root); }
    } else if (message.type === 'set-link' && activeRoot) {
      activeRoot.setAttribute('href', String(message.url || ''));
      emitOperation(activeRoot, 'attribute', String(message.url || ''), 'href');
      emitSelection();
    } else if (message.type === 'set-image-alt' && activeRoot) {
      activeRoot.setAttribute('alt', String(message.alt || ''));
      emitOperation(activeRoot, 'attribute', String(message.alt || ''), 'alt');
      emitSelection();
    } else if (message.type === 'set-image-src' && activeRoot && activeRoot.dataset.cxReactImageReplaceable === 'true') {
      activeRoot.setAttribute('src', String(message.src || ''));
      emitOperation(activeRoot, 'attribute', String(message.src || ''), 'src');
      emitSelection();
    } else if (message.type === 'delete-node' && activeRoot && activeRoot.dataset.cxReactDeletable === 'true') {
      const root = activeRoot;
      emitOperation(root, 'delete', '');
      root.style.display = 'none';
      deactivate();
    } else if (message.type === 'apply-project-operations') {
      applyOperations(message.operations);
    }
  });
  const ready = () => {
    if (document.body) document.body.dataset.cxMode = mode;
    post({ type: 'ready' });
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', ready, { once: true });
  else ready();
})();`;
