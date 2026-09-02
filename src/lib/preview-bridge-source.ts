export const PREVIEW_BRIDGE_SOURCE = String.raw`(() => {
  const HOST_CHANNEL = 'codex-html-editor-host';
  const PREVIEW_CHANNEL = 'codex-html-editor';
  const SAFE_PROTOCOLS = new Set(['http:', 'https:', 'mailto:', 'tel:']);
  const ALLOWED_PASTE_TAGS = new Set(['STRONG', 'EM', 'B', 'I', 'A', 'UL', 'OL', 'LI', 'BR', 'P']);
  let mode = 'edit';
  let activeRoot = null;
  let activeLeaf = null;

  const post = (message) => window.parent.postMessage({ channel: PREVIEW_CHANNEL, ...message }, '*');

  const isSafeUrl = (value) => {
    const trimmed = String(value || '').trim();
    if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('/') || trimmed.startsWith('./') || trimmed.startsWith('../')) return true;
    try {
      return SAFE_PROTOCOLS.has(new URL(trimmed, document.baseURI).protocol);
    } catch {
      return false;
    }
  };

  const cleanClone = (root) => {
    const clone = root.cloneNode(true);
    for (const element of [clone, ...clone.querySelectorAll('*')]) {
      element.removeAttribute('data-cx-edit-id');
      element.removeAttribute('data-cx-edit-kind');
      element.removeAttribute('data-cx-active');
      element.removeAttribute('data-cx-source-label');
      element.removeAttribute('data-cx-script-coupled');
      if (element.hasAttribute('data-cx-owned-contenteditable')) {
        element.removeAttribute('contenteditable');
        element.removeAttribute('spellcheck');
        element.removeAttribute('data-cx-owned-contenteditable');
      }
      if (element.tagName === 'B') replaceTag(element, 'strong');
      if (element.tagName === 'I') replaceTag(element, 'em');
    }
    return clone.outerHTML;
  };

  const replaceTag = (element, tagName) => {
    const replacement = document.createElement(tagName);
    for (const attribute of [...element.attributes]) replacement.setAttribute(attribute.name, attribute.value);
    while (element.firstChild) replacement.appendChild(element.firstChild);
    element.replaceWith(replacement);
    return replacement;
  };

  const emitEdit = () => {
    if (!activeRoot) return;
    post({
      type: 'edit',
      nodeId: activeRoot.dataset.cxEditId,
      replacementOuterHtml: cleanClone(activeRoot),
      timestamp: Date.now(),
    });
  };

  const getSelectionPayload = () => {
    if (!activeRoot || !document.contains(activeRoot)) return null;
    const rect = activeLeaf?.getBoundingClientRect() || activeRoot.getBoundingClientRect();
    const selection = window.getSelection();
    const selectionElement = selection?.anchorNode instanceof Element ? selection.anchorNode : selection?.anchorNode?.parentElement;
    const link = activeLeaf?.closest?.('a') || selectionElement?.closest?.('a') || null;
    const image = activeLeaf?.tagName === 'IMG' ? activeLeaf : null;
    const list = selectionElement?.closest?.('ol, ul') || activeLeaf?.closest?.('ol, ul') || activeRoot.closest?.('ol, ul');
    const queryState = (command) => {
      try { return document.queryCommandState(command); } catch { return false; }
    };
    const editKind = activeRoot.dataset.cxEditKind;
    return {
      nodeId: activeRoot.dataset.cxEditId,
      kind: image ? 'image' : link ? 'link' : editKind === 'element' ? 'element' : 'rich-text',
      tagName: (activeLeaf || activeRoot).tagName.toLowerCase(),
      rect: {
        top: rect.top,
        left: rect.left,
        right: rect.right,
        bottom: rect.bottom,
        width: rect.width,
        height: rect.height,
      },
      linkUrl: link?.getAttribute('href') || undefined,
      imageAlt: image?.getAttribute('alt') || '',
      imageSrc: image?.getAttribute('src') || undefined,
      hasTextSelection: Boolean(selection && !selection.isCollapsed),
      sourceLabel: activeRoot.dataset.cxSourceLabel || activeRoot.tagName.toLowerCase(),
      scriptCoupled: activeRoot.dataset.cxScriptCoupled === 'true',
      canReplaceImage: Boolean(image),
      formatting: {
        bold: queryState('bold') || Boolean(selectionElement?.closest?.('strong, b')),
        italic: queryState('italic') || Boolean(selectionElement?.closest?.('em, i')),
        orderedList: list?.tagName === 'OL',
        unorderedList: list?.tagName === 'UL',
        linked: Boolean(link),
      },
    };
  };

  const emitSelection = () => post({ type: 'selection', selection: getSelectionPayload() });

  const deactivate = () => {
    if (activeRoot) {
      activeRoot.removeAttribute('data-cx-active');
      if (activeRoot.hasAttribute('data-cx-owned-contenteditable')) {
        activeRoot.removeAttribute('contenteditable');
        activeRoot.removeAttribute('spellcheck');
        activeRoot.removeAttribute('data-cx-owned-contenteditable');
      }
    }
    activeRoot = null;
    activeLeaf = null;
    emitSelection();
  };

  const activate = (root, target) => {
    if (activeRoot !== root) deactivate();
    activeRoot = root;
    activeLeaf = target.tagName === 'IMG' ? target : target.closest('a') || target;
    root.setAttribute('data-cx-active', 'true');
    if (root.dataset.cxEditKind === 'rich-text' && !root.hasAttribute('contenteditable')) {
      root.setAttribute('contenteditable', 'true');
      root.setAttribute('spellcheck', 'true');
      root.setAttribute('data-cx-owned-contenteditable', 'true');
    }
    if (root.tagName !== 'IMG') root.focus({ preventScroll: true });
    emitSelection();
  };

  const sanitizePastedHtml = (html) => {
    const parsed = new DOMParser().parseFromString(html, 'text/html');
    const clean = (node) => {
      for (const child of [...node.childNodes]) {
        if (child.nodeType === Node.COMMENT_NODE) {
          child.remove();
          continue;
        }
        if (child.nodeType !== Node.ELEMENT_NODE) continue;
        clean(child);
        if (!ALLOWED_PASTE_TAGS.has(child.tagName)) {
          child.replaceWith(...child.childNodes);
          continue;
        }
        if (child.tagName === 'B') replaceTag(child, 'strong');
        if (child.tagName === 'I') replaceTag(child, 'em');
        for (const attribute of [...child.attributes]) {
          if (child.tagName !== 'A' || attribute.name.toLowerCase() !== 'href') child.removeAttribute(attribute.name);
        }
        if (child.tagName === 'A' && !isSafeUrl(child.getAttribute('href'))) child.removeAttribute('href');
      }
    };
    clean(parsed.body);
    return parsed.body.innerHTML;
  };

  const runFormat = (command) => {
    if (!activeRoot || mode !== 'edit') return;
    activeRoot.focus({ preventScroll: true });
    if (command === 'ordered-list' || command === 'unordered-list') {
      const desiredTag = command === 'ordered-list' ? 'ol' : 'ul';
      const currentTag = activeRoot.tagName.toLowerCase();
      if (currentTag === 'ul' || currentTag === 'ol') {
        if (currentTag === desiredTag) {
          const paragraph = document.createElement('p');
          for (const attribute of [...activeRoot.attributes]) paragraph.setAttribute(attribute.name, attribute.value);
          const items = [...activeRoot.children];
          items.forEach((item, index) => {
            if (index > 0) paragraph.appendChild(document.createElement('br'));
            while (item.firstChild) paragraph.appendChild(item.firstChild);
          });
          activeRoot.replaceWith(paragraph);
          activeRoot = paragraph;
        } else {
          activeRoot = replaceTag(activeRoot, desiredTag);
        }
      } else {
        const list = document.createElement(desiredTag);
        for (const attribute of [...activeRoot.attributes]) list.setAttribute(attribute.name, attribute.value);
        const item = document.createElement('li');
        while (activeRoot.firstChild) item.appendChild(activeRoot.firstChild);
        list.appendChild(item);
        activeRoot.replaceWith(list);
        activeRoot = list;
      }
      activeLeaf = activeRoot;
      activeRoot.focus({ preventScroll: true });
      emitEdit();
      emitSelection();
      return;
    }
    const commands = {
      bold: 'bold',
      italic: 'italic',
      unlink: 'unlink',
      'line-break': 'insertLineBreak',
    };
    document.execCommand(commands[command], false);
    emitEdit();
    emitSelection();
  };

  const setLink = (url) => {
    if (!activeRoot) return;
    if (!isSafeUrl(url)) {
      post({ type: 'notice', message: 'Use an HTTP, HTTPS, email, phone, anchor, or relative link.' });
      return;
    }
    activeRoot.focus({ preventScroll: true });
    const selection = window.getSelection();
    const existing = activeLeaf?.closest?.('a') || selection?.anchorNode?.parentElement?.closest?.('a');
    if (existing && activeRoot.contains(existing)) existing.setAttribute('href', url);
    else if (selection && !selection.isCollapsed) document.execCommand('createLink', false, url);
    emitEdit();
    emitSelection();
  };

  const setImageAlt = (alt) => {
    if (!activeRoot || activeLeaf?.tagName !== 'IMG') return;
    activeLeaf.setAttribute('alt', String(alt));
    emitEdit();
    emitSelection();
  };

  const setImageSrc = (src) => {
    if (!activeRoot || activeLeaf?.tagName !== 'IMG') return;
    activeLeaf.setAttribute('src', String(src));
    emitEdit();
    emitSelection();
  };

  const deleteActiveRoot = () => {
    if (!activeRoot || mode !== 'edit') return;
    const root = activeRoot;
    const nodeId = root.dataset.cxEditId;
    activeRoot = null;
    activeLeaf = null;
    post({ type: 'edit', nodeId, replacementOuterHtml: '', timestamp: Date.now() });
    root.remove();
    emitSelection();
  };

  document.addEventListener('pointerdown', (event) => {
    if (mode !== 'edit') return;
    const target = event.target instanceof Element ? event.target : null;
    const root = target?.closest('[data-cx-edit-id]');
    if (!root) {
      deactivate();
      return;
    }
    event.stopPropagation();
    activate(root, target);
  }, true);

  document.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (mode === 'edit' && target?.closest('[data-cx-edit-id]')) {
      event.preventDefault();
      event.stopPropagation();
      return;
    }
    if (mode === 'preview') {
      const anchor = target?.closest('a[href]');
      const href = anchor?.getAttribute('href')?.trim();
      if (!href || href.startsWith('#')) return;
      event.preventDefault();
      event.stopPropagation();
      try {
        post({ type: 'open-link', url: new URL(href, document.baseURI).href });
      } catch {
        post({ type: 'open-link', url: href });
      }
    }
  }, true);

  document.addEventListener('input', () => {
    if (mode === 'edit' && activeRoot) {
      emitEdit();
      emitSelection();
    }
  }, true);

  document.addEventListener('selectionchange', () => {
    if (mode === 'edit' && activeRoot) emitSelection();
  });

  document.addEventListener('scroll', () => {
    if (mode === 'edit' && activeRoot) emitSelection();
  }, true);
  window.addEventListener('resize', () => {
    if (mode === 'edit' && activeRoot) emitSelection();
  });

  document.addEventListener('paste', (event) => {
    if (mode !== 'edit' || !activeRoot) return;
    event.preventDefault();
    const html = event.clipboardData?.getData('text/html');
    const text = event.clipboardData?.getData('text/plain') || '';
    const value = html ? sanitizePastedHtml(html) : text.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('\n', '<br>');
    document.execCommand('insertHTML', false, value);
    emitEdit();
  }, true);

  document.addEventListener('keydown', (event) => {
    if (!(event.metaKey || event.ctrlKey)) return;
    const key = event.key.toLowerCase();
    if (key === 's') {
      event.preventDefault();
      post({ type: 'save-request' });
    } else if (key === 'z') {
      event.preventDefault();
      post({ type: event.shiftKey ? 'redo-request' : 'undo-request' });
    }
  }, true);

  window.addEventListener('message', (event) => {
    if (event.source !== window.parent) return;
    const message = event.data;
    if (!message || message.channel !== HOST_CHANNEL) return;
    if (message.type === 'set-mode') {
      mode = message.mode;
      document.body.dataset.cxMode = mode;
      if (mode !== 'edit') deactivate();
    } else if (message.type === 'focus-node') {
      if (mode !== 'edit') return;
      const root = document.querySelector('[data-cx-edit-id="' + CSS.escape(String(message.nodeId)) + '"]');
      if (!root) return;
      root.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' });
      activate(root, root);
    } else if (message.type === 'format') {
      runFormat(message.command);
    } else if (message.type === 'set-link') {
      setLink(message.url);
    } else if (message.type === 'set-image-alt') {
      setImageAlt(message.alt);
    } else if (message.type === 'set-image-src') {
      setImageSrc(message.src);
    } else if (message.type === 'delete-node') {
      deleteActiveRoot();
    }
  });

  document.body.dataset.cxMode = mode;
  post({ type: 'ready' });
})();`;
