import {
  type CSSProperties,
  type DragEvent as ReactDragEvent,
  type FormEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import secondPassMark from '../assets/second-pass-mark.svg';
import { applyEditOperations, buildInstrumentedHtml, rebaseEditedSource } from './lib/html-document';
import type {
  AppCommand,
  CodexApprovalRequest,
  CodexEvent,
  CodexMessage,
  CodexSession,
  CodexStatus,
  DraftSnapshot,
  EditOperation,
  EditableNode,
  ExternalFileChange,
  HistoryEntry,
  HostToPreviewMessage,
  HtmlDocument,
  PreviewSelection,
  PreviewToHostMessage,
  RecentFile,
  VinextEditOperation,
  VinextProjectSession,
} from './shared/types';

type EditMap = Record<string, string>;
type EditorMode = 'edit' | 'preview' | 'review';
type Viewport = 'responsive' | 'tablet' | 'mobile';
type DraftStatus = 'idle' | 'saving' | 'saved';

interface Timeline { entries: EditMap[]; index: number }
interface ProjectTimeline { entries: Array<Record<string, VinextEditOperation>>; index: number }
interface ConflictState { removed: boolean }

const EMPTY_TIMELINE: Timeline = { entries: [{}], index: 0 };
const EMPTY_PROJECT_TIMELINE: ProjectTimeline = { entries: [{}], index: 0 };
const MODIFIER_LABEL = navigator.platform.includes('Mac') ? '⌘' : 'Ctrl+';

type UiIconName =
  | 'codex'
  | 'close'
  | 'document'
  | 'image'
  | 'inspector'
  | 'line-break'
  | 'list'
  | 'mobile'
  | 'numbered-list'
  | 'redo'
  | 'responsive'
  | 'send'
  | 'stop'
  | 'tablet'
  | 'trash'
  | 'undo'
  | 'unlink'
  | 'unordered-list';

type FormatIconName = 'bold' | 'italic' | 'unordered-list' | 'ordered-list' | 'line-break' | 'unlink';

const UI_ICON_PATHS: Record<UiIconName, React.ReactNode> = {
  codex: <><rect x="3" y="3.5" width="14" height="12" rx="3" /><path d="M6.5 7.5h7M6.5 11h4.5M7 15.5v2l3-2" /></>,
  close: <path d="M5 5l10 10M15 5 5 15" />,
  document: <><path d="M5.5 2.8h6l3 3v11.4h-9z" /><path d="M11.5 2.8v3h3M8 10h4M8 13h4" /></>,
  image: <><rect x="2.8" y="3.5" width="14.4" height="13" rx="2" /><circle cx="7" cy="8" r="1.4" /><path d="m4.5 14 3.6-3.8 2.4 2.3 2-2 3 3.5" /></>,
  inspector: <><rect x="3" y="3.5" width="14" height="13" rx="2" /><path d="M12 3.5v13M14.5 7h.01M14.5 10h.01" /></>,
  'line-break': <path d="M4 6v3.5h9M10 6.5l3 3-3 3M4 14h5" />,
  list: <><path d="M4 5h12M4 10h12M4 15h12" /><path d="M7 3.5v3M11 8.5v3M8.5 13.5v3" /></>,
  mobile: <><rect x="6.5" y="2.5" width="7" height="15" rx="1.8" /><path d="M9 14.8h2" /></>,
  'numbered-list': <><path d="M8 5h8M8 10h8M8 15h8" /><path d="M3.7 4h1v3M3.4 11c.2-.7 1.8-1 1.8.2 0 .7-1.7 1.4-1.7 2.8h2M3.5 16h1.2c.8 0 .9-1.2 0-1.2h-.8" /></>,
  redo: <><path d="M13 6l3.5 3.5L13 13" /><path d="M16 9.5h-6a5 5 0 0 0-5 5" /></>,
  responsive: <><rect x="2.8" y="4.2" width="14.4" height="10.2" rx="1.7" /><path d="M7.5 17h5" /></>,
  send: <><path d="m3 9 14-6-5.5 14-2-6z" /><path d="m9.5 11 3-3" /></>,
  stop: <rect x="5" y="5" width="10" height="10" rx="1.5" fill="currentColor" stroke="none" />,
  tablet: <><rect x="4.5" y="2.8" width="11" height="14.4" rx="1.8" /><path d="M9 14.8h2" /></>,
  trash: <><path d="M4.5 6h11M7 6V3.5h6V6M6 6l.7 11h6.6L14 6" /><path d="M9 9v5M11 9v5" /></>,
  undo: <><path d="M7 6 3.5 9.5 7 13" /><path d="M4 9.5h6a5 5 0 0 1 5 5" /></>,
  unlink: <><path d="M7.4 12.6 5.8 14.2a2.8 2.8 0 0 1-4-4l2.4-2.4a2.8 2.8 0 0 1 3.8-.1M12.6 7.4l1.6-1.6a2.8 2.8 0 0 1 4 4l-2.4 2.4a2.8 2.8 0 0 1-3.8.1M6 6l8 8" /></>,
  'unordered-list': <><path d="M8 5h8M8 10h8M8 15h8" /><circle cx="4" cy="5" r=".8" fill="currentColor" stroke="none" /><circle cx="4" cy="10" r=".8" fill="currentColor" stroke="none" /><circle cx="4" cy="15" r=".8" fill="currentColor" stroke="none" /></>,
};

const FORMAT_ICON_PATHS: Record<FormatIconName, React.ReactNode> = {
  bold: <><path d="M6 4v16" /><path d="M6 4h7a4 4 0 0 1 0 8H6" /><path d="M6 12h8a4 4 0 0 1 0 8H6" /></>,
  italic: <><path d="M10 4h7M7 20h7M14 4 10 20" /></>,
  'unordered-list': <><path d="M10 6h11M10 12h11M10 18h11" /><circle cx="4" cy="6" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="12" r="1" fill="currentColor" stroke="none" /><circle cx="4" cy="18" r="1" fill="currentColor" stroke="none" /></>,
  'ordered-list': <><path d="M10 6h11M10 12h11M10 18h11" /><g fill="currentColor" stroke="none" fontFamily="-apple-system, BlinkMacSystemFont, sans-serif" fontSize="6.2" fontWeight="700" textAnchor="middle"><text x="4.5" y="8.1">1</text><text x="4.5" y="14.1">2</text><text x="4.5" y="20.1">3</text></g></>,
  'line-break': <><path d="M20 5v6a4 4 0 0 1-4 4H5" /><path d="m9 11-4 4 4 4" /></>,
  unlink: <><path d="M9 17H7a5 5 0 0 1 0-10h2M15 7h2a5 5 0 0 1 4 4.7M8 12h4" /><path d="m4 4 16 16" /></>,
};

function UiIcon({ name }: { name: UiIconName }) {
  return <svg className="ui-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.55" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{UI_ICON_PATHS[name]}</svg>;
}

function FormatIcon({ name }: { name: FormatIconName }) {
  return <svg className="format-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">{FORMAT_ICON_PATHS[name]}</svg>;
}

function BrandMark() {
  return <img className="brand-mark-image" src={secondPassMark} alt="" />;
}

function IconButton({ label, children, disabled, active, onClick }: {
  label: string;
  children: React.ReactNode;
  disabled?: boolean;
  active?: boolean;
  onClick: (event: ReactMouseEvent<HTMLButtonElement>) => void;
}) {
  return (
    <button
      type="button"
      className={`icon-button${active ? ' is-active' : ''}`}
      aria-label={label}
      title={label}
      disabled={disabled}
      onMouseDown={(event) => event.preventDefault()}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

function EmptyState({ recentFiles, codexStatus, codexError, onConnectCodex, onOpen, onOpenRecent }: {
  recentFiles: RecentFile[];
  codexStatus: CodexStatus;
  codexError: string | null;
  onConnectCodex: (reference: string) => Promise<void>;
  onOpen: () => void;
  onOpenRecent: (path: string) => void;
}) {
  const [reference, setReference] = useState('');
  const connecting = codexStatus === 'starting';

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const value = reference.trim();
    if (!value || connecting) return;
    await onConnectCodex(value);
  };

  return (
    <main className="empty-state">
      <section className="empty-card" aria-labelledby="empty-heading">
        <div className="empty-mark" aria-hidden="true"><BrandMark /></div>
        <div className="empty-copy">
          <span>Continue from Codex</span>
          <h1 id="empty-heading">Pick up where Codex left off</h1>
          <p>Paste a Codex task link or thread ID. Second Pass finds the rendered HTML or Vinext project, opens it, and keeps it in sync while you work together.</p>
        </div>
        <form className="empty-connect-form" onSubmit={submit}>
          <label htmlFor="empty-codex-reference">Codex task link or thread ID</label>
          <div>
            <input
              id="empty-codex-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="https://chatgpt.com/codex/tasks/…"
              disabled={connecting}
              autoFocus
            />
            <button type="submit" className="primary-button" disabled={!reference.trim() || connecting}>{connecting ? 'Connecting…' : 'Connect task'}</button>
          </div>
          <small>Uses your existing local Codex sign-in. Nothing is uploaded by Second Pass.</small>
        </form>
        {codexError ? <div className="empty-connect-error" role="alert">{codexError}</div> : null}
        <div className="empty-divider"><span>or</span></div>
        <button type="button" className="secondary-button empty-open-button" onClick={onOpen}>Open HTML file</button>
        <span className="empty-open-hint">Choose a file directly, press {MODIFIER_LABEL}O, or drop one anywhere</span>
        {recentFiles.length > 0 ? (
          <section className="recent-files" aria-label="Recent files">
            <strong>Recent documents</strong>
            {recentFiles.slice(0, 5).map((file) => (
              <button type="button" key={file.path} onClick={() => onOpenRecent(file.path)}>
                <span>{file.fileName}</span>
                <small>{file.path}</small>
              </button>
            ))}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function HistoryPanel({ entries, onLoad, onClose }: {
  entries: HistoryEntry[];
  onLoad: (entry: HistoryEntry) => void;
  onClose: () => void;
}) {
  return (
    <aside className="side-panel history-panel" aria-label="File history">
      <header>
        <div><strong>History</strong><span>Automatic backups from before each save</span></div>
        <button type="button" className="text-button" onClick={onClose}>Close</button>
      </header>
      <div className="history-list">
        {entries.length === 0 ? <p className="muted">No saved versions yet.</p> : null}
        {entries.map((entry) => (
          <button type="button" key={entry.id} onClick={() => onLoad(entry)}>
            <span>{new Date(entry.createdAt).toLocaleString()}</span>
            <small>{Math.max(1, Math.round(entry.size / 1024))} KB</small>
          </button>
        ))}
      </div>
    </aside>
  );
}

function upsertCodexMessage(messages: CodexMessage[], next: CodexMessage): CodexMessage[] {
  const index = messages.findIndex((message) => message.id === next.id);
  if (index === -1) return [...messages, next];
  const updated = [...messages];
  updated[index] = next;
  return updated;
}

function cleanIpcError(error: unknown, fallback: string): string {
  if (!(error instanceof Error)) return fallback;
  return error.message.replace(/^Error invoking remote method '[^']+': Error: /, '') || fallback;
}

function CodexPanel({
  session,
  status,
  error,
  approval,
  visualEditsPending,
  onConnect,
  onStartNew,
  onSend,
  onInterrupt,
  onApproval,
  onClose,
}: {
  session: CodexSession | null;
  status: CodexStatus;
  error: string | null;
  approval: CodexApprovalRequest | null;
  visualEditsPending: boolean;
  onConnect: (reference: string) => Promise<void>;
  onStartNew: () => Promise<void>;
  onSend: (text: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onApproval: (requestId: string, decision: 'accept' | 'decline') => Promise<void>;
  onClose: () => void;
}) {
  const [reference, setReference] = useState('');
  const [draft, setDraft] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const messagesRef = useRef<HTMLDivElement>(null);
  const working = status === 'working';
  const watching = session?.connectionMode === 'watching';

  useEffect(() => {
    const element = messagesRef.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [session?.messages, approval, status]);

  const submitConnection = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    try {
      await onConnect(reference);
      setReference('');
    } finally {
      setSubmitting(false);
    }
  };

  const sendDraft = async () => {
    const text = draft.trim();
    if (!text || working || visualEditsPending) return;
    setDraft('');
    try {
      await onSend(text);
    } catch {
      setDraft(text);
    }
  };

  const handleComposerKeyDown = (event: ReactKeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      void sendDraft();
    }
  };

  return (
    <aside className="workspace-panel codex-panel" aria-label="Codex workspace">
      <header>
        <div>
          <strong>Codex</strong>
          <span className={`codex-status codex-status-${status}`}><i aria-hidden="true" />{status === 'starting' ? 'Connecting' : status === 'working' ? 'Working on the page' : watching ? 'Watching active task' : session ? session.accountLabel : 'Not connected'}</span>
        </div>
        <div className="panel-header-actions">
          {session && !working ? <button type="button" className="text-button" onClick={() => void onStartNew()}>New</button> : null}
          <IconButton label="Close Codex" onClick={onClose}><UiIcon name="close" /></IconButton>
        </div>
      </header>

      {!session ? (
        <div className="codex-connect">
          <span className="codex-connect-icon" aria-hidden="true"><UiIcon name="codex" /></span>
          <h2>Build and refine in one place</h2>
          <p>Connect a Codex conversation to this workspace. File changes will appear in the preview as soon as Codex writes them.</p>
          <form onSubmit={submitConnection}>
            <label htmlFor="codex-thread-reference">Existing task, optional</label>
            <input
              id="codex-thread-reference"
              value={reference}
              onChange={(event) => setReference(event.target.value)}
              placeholder="Paste a Codex task link or thread ID"
              disabled={submitting}
            />
            <button type="submit" className="primary-button" disabled={submitting}>{submitting ? 'Connecting…' : reference.trim() ? 'Connect task' : 'Connect Codex'}</button>
          </form>
          <small>Uses your existing local Codex sign-in. Leave the field empty to resume this workspace’s last conversation or start a new one.</small>
          {error ? <div className="codex-error" role="alert">{error}</div> : null}
        </div>
      ) : (
        <>
          <div className="codex-thread-meta" title={session.threadId}>
            <span>{watching ? 'Watching' : 'Connected to'} {session.threadId.slice(0, 8)}</span>
            <small>{session.cwd}</small>
          </div>
          <div ref={messagesRef} className="codex-messages" aria-live="polite">
            {session.messages.length === 0 ? (
              <div className="codex-empty-thread">
                <strong>What should change?</strong>
                <p>Ask for layout, styling, or larger copy changes. Then make the final small edits directly on the page.</p>
              </div>
            ) : null}
            {session.messages.map((message) => (
              <article key={message.id} className={`codex-message codex-message-${message.role}`}>
                {message.role === 'activity' ? <span className="codex-activity-dot" aria-hidden="true" /> : null}
                <div>
                  {message.role === 'user' || message.role === 'assistant' ? <strong>{message.role === 'user' ? 'You' : 'Codex'}</strong> : null}
                  <p>{message.text}</p>
                </div>
              </article>
            ))}
            {working ? <div className="codex-working"><span /><span /><span /><small>Codex is working</small></div> : null}
            {approval ? (
              <section className="codex-approval" aria-label="Codex approval request">
                <strong>{approval.title}</strong>
                <p>{approval.detail}</p>
                <div>
                  <button type="button" className="secondary-button" onClick={() => void onApproval(approval.id, 'decline')}>Deny</button>
                  <button type="button" className="primary-button" onClick={() => void onApproval(approval.id, 'accept')}>Allow once</button>
                </div>
              </section>
            ) : null}
          </div>
          {watching ? (
            <div className="codex-watching-note" role="status">
              <strong>Continue in Codex</strong>
              <p>This task is already open there. Second Pass will watch the workspace and refresh the page whenever Codex saves a change.</p>
              <small>Select <b>New</b> above if you want a separate writable task inside Second Pass.</small>
            </div>
          ) : (
            <div className="codex-composer-wrap">
              {visualEditsPending ? <div className="codex-handoff-note">Save or discard your visual edits before handing the workspace to Codex.</div> : null}
              {error ? <div className="codex-error" role="alert">{error}</div> : null}
              <div className="codex-composer">
                <textarea
                  aria-label="Message Codex"
                  value={draft}
                  rows={3}
                  placeholder="Ask Codex to change this page…"
                  disabled={working || visualEditsPending}
                  onChange={(event) => setDraft(event.target.value)}
                  onKeyDown={handleComposerKeyDown}
                />
                {working ? (
                  <IconButton label="Stop Codex" onClick={() => void onInterrupt()}><UiIcon name="stop" /></IconButton>
                ) : (
                  <IconButton label="Send to Codex" disabled={!draft.trim() || visualEditsPending} onClick={() => void sendDraft()}><UiIcon name="send" /></IconButton>
                )}
              </div>
              <small>{MODIFIER_LABEL}Enter to send</small>
            </div>
          )}
        </>
      )}
    </aside>
  );
}

function summarizeEditableNode(node: EditableNode, replacement?: string): string {
  const html = replacement ?? node.originalOuterHtml;
  if (node.kind === 'image') {
    const alt = html.match(/\balt\s*=\s*["']([^"']*)["']/i)?.[1];
    return alt ? `Image: ${alt}` : 'Image without alt text';
  }
  return html
    .replace(/<br\s*\/?\s*>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 74) || 'Empty text region';
}

function OutlinePanel({ nodes, replacements, activeNodeId, onSelect, onClose }: {
  nodes: EditableNode[];
  replacements: EditMap;
  activeNodeId?: string;
  onSelect: (nodeId: string) => void;
  onClose: () => void;
}) {
  const scriptControlled = nodes.filter((node) => node.scriptCoupled).length;
  return (
    <aside className="workspace-panel outline-panel" aria-label="Document outline">
      <header>
        <div><strong>Outline</strong><span>{nodes.length} editable regions</span></div>
        <IconButton label="Close outline" onClick={onClose}><UiIcon name="close" /></IconButton>
      </header>
      <div className="outline-list">
        {nodes.map((node) => (
          <button
            type="button"
            key={node.id}
            className={activeNodeId === node.id ? 'is-active' : ''}
            onClick={() => onSelect(node.id)}
          >
            <code>{node.sourceLabel}</code>
            <span>{summarizeEditableNode(node, replacements[node.id])}</span>
            {node.scriptCoupled ? <small>Script controlled</small> : null}
          </button>
        ))}
      </div>
      <footer>
        <span>{nodes.length - scriptControlled} source regions</span>
        {scriptControlled ? <span>{scriptControlled} script controlled</span> : null}
      </footer>
    </aside>
  );
}

function InspectorPropertyEditor({ selection, onSetLink, onSetImageAlt }: {
  selection: PreviewSelection;
  onSetLink: (url: string) => void;
  onSetImageAlt: (alt: string) => void;
}) {
  const [value, setValue] = useState(selection.kind === 'image' ? selection.imageAlt ?? '' : selection.linkUrl ?? '');

  return (
    <form className="inspector-property-form" onSubmit={(event) => {
      event.preventDefault();
      if (selection.kind === 'image') onSetImageAlt(value);
      else onSetLink(value);
    }}>
      <label htmlFor="inspector-property">{selection.kind === 'image' ? 'Alt text' : 'Link destination'}</label>
      <input
        id="inspector-property"
        value={value}
        placeholder={selection.kind === 'image' ? 'Describe this image' : 'https://…'}
        onChange={(event) => setValue(event.target.value)}
      />
      <button type="submit">Apply</button>
    </form>
  );
}

function InspectorPanel({ selection, node, onFormat, onSetLink, onSetImageAlt, onReplaceImage, onDelete, onClose }: {
  selection: PreviewSelection | null;
  node?: EditableNode;
  onFormat: (command: Extract<HostToPreviewMessage, { type: 'format' }>['command']) => void;
  onSetLink: (url: string) => void;
  onSetImageAlt: (alt: string) => void;
  onReplaceImage: () => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  return (
    <aside className="workspace-panel inspector-panel" aria-label="Selection inspector">
      <header>
        <div><strong>Inspector</strong><span>{selection ? selection.sourceLabel : 'Nothing selected'}</span></div>
        <IconButton label="Close inspector" onClick={onClose}><UiIcon name="close" /></IconButton>
      </header>
      {selection ? (
        <div className="inspector-content">
          <section>
            <h2>Selection</h2>
            <code>{selection.sourceLabel}</code>
            <dl>
              <div><dt>Element</dt><dd>{selection.tagName}</dd></div>
              {node ? <div><dt>Source</dt><dd>{node.startOffset}-{node.endOffset}</dd></div> : null}
            </dl>
          </section>
          {selection.sourceMode !== 'jsx' && selection.kind !== 'image' && selection.kind !== 'element' ? (
            <section>
              <h2>Formatting</h2>
              <div className="inspector-formatting" role="toolbar" aria-label="Inspector formatting">
                <IconButton label="Bold" active={selection.formatting.bold} onClick={() => onFormat('bold')}><FormatIcon name="bold" /></IconButton>
                <IconButton label="Italic" active={selection.formatting.italic} onClick={() => onFormat('italic')}><FormatIcon name="italic" /></IconButton>
                <IconButton label="Bulleted list" active={selection.formatting.unorderedList} onClick={() => onFormat('unordered-list')}><FormatIcon name="unordered-list" /></IconButton>
                <IconButton label="Numbered list" active={selection.formatting.orderedList} onClick={() => onFormat('ordered-list')}><FormatIcon name="ordered-list" /></IconButton>
                <IconButton label="Line break" onClick={() => onFormat('line-break')}><FormatIcon name="line-break" /></IconButton>
                <IconButton label="Remove link" disabled={!selection.formatting.linked} onClick={() => onFormat('unlink')}><FormatIcon name="unlink" /></IconButton>
              </div>
            </section>
          ) : null}
          {selection.kind === 'image' ? (
            <section className="inspector-image-section">
              <h2>Image file</h2>
              <button
                type="button"
                className="replace-image-button"
                disabled={selection.canReplaceImage === false}
                onClick={onReplaceImage}
              >
                <UiIcon name="image" />Choose replacement
              </button>
              {selection.imageSrc ? <small title={selection.imageSrc}>{selection.imageSrc}</small> : null}
              {selection.canReplaceImage === false ? <p>This image uses a dynamic JSX source. Change the expression in code to replace it safely.</p> : null}
            </section>
          ) : null}
          {selection.kind === 'image' || selection.kind === 'link' || selection.hasTextSelection ? (
            <section>
              <h2>{selection.kind === 'image' ? 'Accessibility' : 'Link'}</h2>
              <InspectorPropertyEditor
                key={`${selection.nodeId}:${selection.kind}:${selection.linkUrl ?? ''}:${selection.imageAlt ?? ''}`}
                selection={selection}
                onSetLink={onSetLink}
                onSetImageAlt={onSetImageAlt}
              />
            </section>
          ) : null}
          {selection.scriptCoupled ? <div className="inspector-warning">A page script references this element. Runtime text may replace your edit.</div> : null}
          {selection.canDelete !== false ? (
            <section className="inspector-delete-section">
              <button type="button" className="delete-element-button" onClick={onDelete}><UiIcon name="trash" />Delete element</button>
              <p>Removes this source element when you save. Undo remains available.</p>
            </section>
          ) : selection.sourceMode === 'jsx' ? <div className="inspector-warning">This element is the root of an expression and cannot be deleted safely.</div> : null}
        </div>
      ) : (
        <div className="inspector-empty">
          <span aria-hidden="true"><UiIcon name="inspector" /></span>
          <strong>Select something on the page</strong>
          <p>Its formatting, properties, and source location will appear here.</p>
        </div>
      )}
    </aside>
  );
}

function ReviewPanel({ changes, busy, onSave }: {
  changes: Array<{ id: string; label: string; before: string; after: string }>;
  busy: boolean;
  onSave: () => void;
}) {
  return (
    <aside className="workspace-panel review-panel" aria-label="Review changes">
      <header>
        <div><strong>Review changes</strong><span>{changes.length} {changes.length === 1 ? 'region' : 'regions'} will be replaced</span></div>
        <span className="review-ready">Ready to save</span>
      </header>
      <div className="review-list">
        {changes.map((change) => (
          <article key={change.id}>
            <code>{change.label}</code>
            <div><span>Before</span><pre>{change.before}</pre></div>
            <div><span>After</span><pre>{change.after}</pre></div>
          </article>
        ))}
      </div>
      <footer>
        <span>Everything outside these regions stays byte-for-byte identical.</span>
        <button type="button" className="primary-button" disabled={busy} onClick={onSave}>{busy ? 'Saving…' : 'Save changes'}</button>
      </footer>
    </aside>
  );
}

function FormattingToolbar({ selection, style, onFormat, onSetLink, onSetImageAlt, onReplaceImage, onDelete }: {
  selection: PreviewSelection;
  style: CSSProperties;
  onFormat: (command: Extract<HostToPreviewMessage, { type: 'format' }>['command']) => void;
  onSetLink: (url: string) => void;
  onSetImageAlt: (alt: string) => void;
  onReplaceImage: () => void;
  onDelete: () => void;
}) {
  const [value, setValue] = useState(selection.kind === 'image' ? selection.imageAlt ?? '' : selection.linkUrl ?? '');

  useEffect(() => {
    setValue(selection.kind === 'image' ? selection.imageAlt ?? '' : selection.linkUrl ?? '');
  }, [selection.imageAlt, selection.kind, selection.linkUrl, selection.nodeId]);

  return (
    <div className="format-toolbar" style={style} role="toolbar" aria-label="Text formatting">
      {selection.sourceMode === 'jsx' ? <span className="jsx-source-badge">JSX · type to edit</span> : null}
      {selection.sourceMode !== 'jsx' && selection.kind !== 'image' && selection.kind !== 'element' ? (
        <>
          <IconButton label="Bold" active={selection.formatting.bold} onClick={() => onFormat('bold')}><FormatIcon name="bold" /></IconButton>
          <IconButton label="Italic" active={selection.formatting.italic} onClick={() => onFormat('italic')}><FormatIcon name="italic" /></IconButton>
          <IconButton label="Bulleted list" active={selection.formatting.unorderedList} onClick={() => onFormat('unordered-list')}><FormatIcon name="unordered-list" /></IconButton>
          <IconButton label="Numbered list" active={selection.formatting.orderedList} onClick={() => onFormat('ordered-list')}><FormatIcon name="ordered-list" /></IconButton>
          <IconButton label="Line break" onClick={() => onFormat('line-break')}><FormatIcon name="line-break" /></IconButton>
          <IconButton label="Remove link" disabled={!selection.formatting.linked} onClick={() => onFormat('unlink')}><FormatIcon name="unlink" /></IconButton>
        </>
      ) : null}
      {selection.kind === 'image' ? (
        <button
          type="button"
          className="toolbar-replace-image"
          disabled={selection.canReplaceImage === false}
          title={selection.canReplaceImage === false ? 'Dynamic JSX image sources must be changed in code' : 'Choose a replacement image'}
          onMouseDown={(event) => event.preventDefault()}
          onClick={onReplaceImage}
        >
          <UiIcon name="image" />Replace
        </button>
      ) : null}
      {selection.kind === 'image' || selection.kind === 'link' || selection.hasTextSelection ? (
        <form className="property-form" onSubmit={(event) => {
          event.preventDefault();
          if (selection.kind === 'image') onSetImageAlt(value);
          else onSetLink(value);
        }}>
          <label htmlFor="selection-property">{selection.kind === 'image' ? 'Alt text' : 'Link'}</label>
          <input id="selection-property" value={value} placeholder={selection.kind === 'image' ? 'Describe image' : 'https://…'} onChange={(event) => setValue(event.target.value)} />
          <button type="submit">Apply</button>
        </form>
      ) : null}
      {selection.canDelete !== false ? <span className="format-delete"><IconButton label="Delete element" onClick={onDelete}><UiIcon name="trash" /></IconButton></span> : null}
    </div>
  );
}

export function App() {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const nodesRef = useRef<Map<string, EditableNode>>(new Map());
  const dirtyRef = useRef(false);
  const documentPathRef = useRef<string | null>(null);
  const lastEditRef = useRef<{ nodeId: string; timestamp: number; index: number } | null>(null);
  const lastProjectEditRef = useRef<{ operationId: string; timestamp: number; index: number } | null>(null);
  const [document, setDocument] = useState<HtmlDocument | null>(null);
  const [project, setProject] = useState<VinextProjectSession | null>(null);
  const [projectRoute, setProjectRoute] = useState('/');
  const [editorBaseSource, setEditorBaseSource] = useState('');
  const [previewHtml, setPreviewHtml] = useState('');
  const [previewUrl, setPreviewUrl] = useState('');
  const [previewRevision, setPreviewRevision] = useState(0);
  const [timeline, setTimeline] = useState<Timeline>(EMPTY_TIMELINE);
  const [projectTimeline, setProjectTimeline] = useState<ProjectTimeline>(EMPTY_PROJECT_TIMELINE);
  const [mode, setMode] = useState<EditorMode>('edit');
  const [viewport, setViewport] = useState<Viewport>('responsive');
  const [selection, setSelection] = useState<PreviewSelection | null>(null);
  const [editableNodes, setEditableNodes] = useState<EditableNode[]>([]);
  const [outlineOpen, setOutlineOpen] = useState(false);
  const [inspectorOpen, setInspectorOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyEntries, setHistoryEntries] = useState<HistoryEntry[]>([]);
  const [recentFiles, setRecentFiles] = useState<RecentFile[]>([]);
  const [recoveryDraft, setRecoveryDraft] = useState<DraftSnapshot | null>(null);
  const [draftStatus, setDraftStatus] = useState<DraftStatus>('idle');
  const [conflict, setConflict] = useState<ConflictState | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dragActive, setDragActive] = useState(false);
  const [codexOpen, setCodexOpen] = useState(false);
  const [codexSession, setCodexSession] = useState<CodexSession | null>(null);
  const [codexStatus, setCodexStatus] = useState<CodexStatus>('disconnected');
  const [codexError, setCodexError] = useState<string | null>(null);
  const [codexApproval, setCodexApproval] = useState<CodexApprovalRequest | null>(null);

  const activeEdits = timeline.entries[timeline.index] ?? {};
  const activeProjectEdits = projectTimeline.entries[projectTimeline.index] ?? {};
  const projectOperations = useMemo(() => Object.values(activeProjectEdits), [activeProjectEdits]);
  const operations = useMemo(() => Object.entries(activeEdits).flatMap(([nodeId, replacementOuterHtml]) => {
    const node = nodesRef.current.get(nodeId);
    return node ? [{ nodeId, startOffset: node.startOffset, endOffset: node.endOffset, replacementOuterHtml, timestamp: 0 } satisfies EditOperation] : [];
  }), [activeEdits]);
  const currentSource = useMemo(() => editorBaseSource ? applyEditOperations(editorBaseSource, operations) : '', [editorBaseSource, operations]);
  const dirty = project
    ? projectOperations.length > 0
    : Boolean(document && (operations.length > 0 || editorBaseSource !== document.source));
  const workspaceOpen = Boolean(document || project);
  const postToPreview = useCallback((message: HostToPreviewMessage) => { iframeRef.current?.contentWindow?.postMessage(message, '*'); }, []);

  const showNotice = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice((current) => current === message ? null : current), 3200);
  }, []);

  const replaceSelectedImage = useCallback(async () => {
    if (!selection || selection.kind !== 'image') return;
    if (selection.canReplaceImage === false) {
      showNotice('This image uses a dynamic JSX source. Change it in code to replace it safely.');
      return;
    }
    const nodeId = selection.nodeId;
    const result = await window.codexEditor.chooseImageAsset();
    if (result.status === 'cancelled') return;
    if (result.status === 'error') {
      showNotice(result.message);
      return;
    }
    postToPreview({ channel: 'codex-html-editor-host', type: 'focus-node', nodeId });
    postToPreview({ channel: 'codex-html-editor-host', type: 'set-image-src', src: result.src });
    showNotice(`Replaced with ${result.fileName}. Save to update the source.`);
  }, [postToPreview, selection, showNotice]);

  const refreshRecentFiles = useCallback(() => { void window.codexEditor.getRecentFiles().then(setRecentFiles); }, []);

  const loadDocument = useCallback((nextDocument: HtmlDocument, source = nextDocument.source) => {
    const changedDocument = documentPathRef.current !== null && documentPathRef.current !== nextDocument.path;
    documentPathRef.current = nextDocument.path;
    const instrumented = buildInstrumentedHtml(source);
    nodesRef.current = new Map(instrumented.nodes.map((node) => [node.id, node]));
    setEditableNodes(instrumented.nodes);
    setProject(null);
    setDocument(nextDocument);
    setEditorBaseSource(source);
    setPreviewHtml(instrumented.html);
    setPreviewRevision((revision) => revision + 1);
    setTimeline(EMPTY_TIMELINE);
    setProjectTimeline(EMPTY_PROJECT_TIMELINE);
    setMode((current) => changedDocument || current === 'review' ? 'edit' : current);
    setSelection(null);
    setConflict(null);
    setHistoryOpen(false);
    setRecoveryDraft(null);
    setDraftStatus('idle');
    if (changedDocument) {
      setCodexSession(null);
      setCodexStatus('disconnected');
      setCodexError(null);
      setCodexApproval(null);
    }
    lastEditRef.current = null;
    lastProjectEditRef.current = null;
    refreshRecentFiles();
  }, [refreshRecentFiles]);

  const loadProject = useCallback((nextProject: VinextProjectSession) => {
    const changedProject = documentPathRef.current !== null && documentPathRef.current !== nextProject.entryPath;
    documentPathRef.current = nextProject.entryPath;
    nodesRef.current.clear();
    setEditableNodes([]);
    setDocument(null);
    setProject(nextProject);
    setProjectRoute(nextProject.route);
    setEditorBaseSource('');
    setPreviewHtml('');
    setPreviewUrl(nextProject.previewUrl);
    setPreviewRevision((revision) => revision + 1);
    setTimeline(EMPTY_TIMELINE);
    setProjectTimeline(EMPTY_PROJECT_TIMELINE);
    setMode((current) => changedProject || current === 'review' ? 'edit' : current);
    setSelection(null);
    setConflict(null);
    setHistoryOpen(false);
    setRecoveryDraft(null);
    setDraftStatus('idle');
    lastEditRef.current = null;
    lastProjectEditRef.current = null;
  }, []);

  const connectCodex = useCallback(async (threadReference = '', forceNew = false) => {
    setCodexOpen(true);
    setCodexStatus('starting');
    setCodexError(null);
    setCodexApproval(null);
    try {
      const result = await window.codexEditor.connectCodex({
        documentPath: document?.path ?? project?.entryPath,
        projectRoot: project?.root,
        threadReference: threadReference.trim() || undefined,
        forceNew,
      });
      if (result.document) loadDocument(result.document);
      if (result.project) loadProject(result.project);
      setCodexSession(result.session);
      setCodexStatus(result.session.status);
    } catch (error) {
      const message = cleanIpcError(error, 'Unable to connect to Codex.');
      setCodexSession(null);
      setCodexStatus('error');
      setCodexError(message);
    }
  }, [document, loadDocument, loadProject, project]);

  const sendCodexTurn = useCallback(async (text: string) => {
    if (!codexSession) throw new Error('Connect Codex first.');
    if (dirtyRef.current) throw new Error('Save your visual edits before handing the document to Codex.');
    setCodexError(null);
    setMode('preview');
    try {
      await window.codexEditor.startCodexTurn({ threadId: codexSession.threadId, text });
    } catch (error) {
      const message = cleanIpcError(error, 'Codex could not start this request.');
      setCodexError(message);
      showNotice(message);
      throw error;
    }
  }, [codexSession, showNotice]);

  const interruptCodex = useCallback(async () => {
    if (!codexSession) return;
    try {
      await window.codexEditor.interruptCodex(codexSession.threadId);
    } catch (error) {
      const message = cleanIpcError(error, 'Unable to stop Codex.');
      setCodexError(message);
      showNotice(message);
    }
  }, [codexSession, showNotice]);

  const respondToCodexApproval = useCallback(async (requestId: string, decision: 'accept' | 'decline') => {
    try {
      await window.codexEditor.respondToCodexApproval(requestId, decision);
      setCodexApproval((current) => current?.id === requestId ? null : current);
    } catch (error) {
      const message = cleanIpcError(error, 'Unable to answer the approval request.');
      setCodexError(message);
      showNotice(message);
    }
  }, [showNotice]);

  useEffect(() => window.codexEditor.onCodexEvent((event: CodexEvent) => {
    if (event.type === 'status') {
      setCodexStatus(event.status);
      if (event.message) setCodexError(event.message);
      setCodexSession((current) => {
        if (!current || (event.threadId && current.threadId !== event.threadId)) return current;
        return { ...current, status: event.status };
      });
      return;
    }
    setCodexSession((current) => {
      if (!current || current.threadId !== event.threadId) return current;
      if (event.type === 'message') {
        return { ...current, messages: upsertCodexMessage(current.messages, event.message) };
      }
      if (event.type === 'assistant-delta') {
        const existing = current.messages.find((message) => message.id === event.itemId);
        const message: CodexMessage = {
          id: event.itemId,
          role: 'assistant',
          text: `${existing?.text ?? ''}${event.delta}`,
          timestamp: existing?.timestamp ?? Date.now(),
        };
        return { ...current, messages: upsertCodexMessage(current.messages, message) };
      }
      return current;
    });
    if (event.type === 'approval') setCodexApproval(event.approval);
    if (event.type === 'turn-completed') setCodexApproval(null);
  }), []);

  useEffect(() => {
    if (codexStatus === 'working' && mode === 'edit') setMode('preview');
  }, [codexStatus, mode]);

  useEffect(() => {
    dirtyRef.current = dirty;
    window.codexEditor.setDirty(dirty);
  }, [dirty]);

  useEffect(() => {
    if (!document || editorBaseSource !== document.source) return;
    let cancelled = false;
    void window.codexEditor.loadDraft(document.path).then((draft) => {
      if (cancelled || !draft) return;
      if (draft.baseVersion.sha256 === document.version.sha256 && draft.source !== document.source) setRecoveryDraft(draft);
      else void window.codexEditor.clearDraft(document.path);
    });
    return () => { cancelled = true; };
  }, [document, editorBaseSource]);

  useEffect(() => {
    if (!document || !dirty || conflict) return;
    let cancelled = false;
    const timer = window.setTimeout(() => {
      setDraftStatus('saving');
      void window.codexEditor
        .saveDraft({ path: document.path, baseVersion: document.version, source: currentSource, updatedAt: Date.now() })
        .then(() => { if (!cancelled) setDraftStatus('saved'); })
        .catch(() => { if (!cancelled) setDraftStatus('idle'); });
    }, 650);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [conflict, currentSource, dirty, document]);

  const refreshPreviewForTimeline = useCallback((nextTimeline: Timeline) => {
    const replacements = nextTimeline.entries[nextTimeline.index] ?? {};
    const nextOperations = Object.entries(replacements).flatMap(([nodeId, replacementOuterHtml]) => {
      const node = nodesRef.current.get(nodeId);
      return node ? [{ nodeId, startOffset: node.startOffset, endOffset: node.endOffset, replacementOuterHtml, timestamp: Date.now() }] : [];
    });
    setPreviewHtml(buildInstrumentedHtml(applyEditOperations(editorBaseSource, nextOperations)).html);
    setPreviewRevision((revision) => revision + 1);
    setSelection(null);
  }, [editorBaseSource]);

  const refreshProjectPreviewForTimeline = useCallback((nextTimeline: ProjectTimeline) => {
    const replacements = nextTimeline.entries[nextTimeline.index] ?? {};
    postToPreview({ channel: 'codex-html-editor-host', type: 'apply-project-operations', operations: Object.values(replacements) });
    setSelection(null);
  }, [postToPreview]);

  const undo = useCallback(() => {
    if (project) {
      if (projectTimeline.index === 0) return;
      const next = { ...projectTimeline, index: projectTimeline.index - 1 };
      setProjectTimeline(next);
      refreshProjectPreviewForTimeline(next);
      lastProjectEditRef.current = null;
      return;
    }
    if (timeline.index === 0) return;
    const next = { ...timeline, index: timeline.index - 1 };
    setTimeline(next);
    refreshPreviewForTimeline(next);
    setDraftStatus('idle');
    lastEditRef.current = null;
  }, [project, projectTimeline, refreshPreviewForTimeline, refreshProjectPreviewForTimeline, timeline]);

  const redo = useCallback(() => {
    if (project) {
      if (projectTimeline.index >= projectTimeline.entries.length - 1) return;
      const next = { ...projectTimeline, index: projectTimeline.index + 1 };
      setProjectTimeline(next);
      refreshProjectPreviewForTimeline(next);
      lastProjectEditRef.current = null;
      return;
    }
    if (timeline.index >= timeline.entries.length - 1) return;
    const next = { ...timeline, index: timeline.index + 1 };
    setTimeline(next);
    refreshPreviewForTimeline(next);
    setDraftStatus('idle');
    lastEditRef.current = null;
  }, [project, projectTimeline, refreshPreviewForTimeline, refreshProjectPreviewForTimeline, timeline]);

  const commitEdit = useCallback((nodeId: string, replacementOuterHtml: string, timestamp: number) => {
    setDraftStatus('idle');
    setTimeline((current) => {
      const node = nodesRef.current.get(nodeId);
      if (!node) return current;
      const base = { ...(current.entries[current.index] ?? {}) };
      if (replacementOuterHtml === node.originalOuterHtml) delete base[nodeId];
      else base[nodeId] = replacementOuterHtml;
      const lastEdit = lastEditRef.current;
      const shouldCoalesce = lastEdit?.nodeId === nodeId && lastEdit.index === current.index && timestamp - lastEdit.timestamp < 700;
      if (shouldCoalesce && current.index > 0) {
        const entries = current.entries.slice(0, current.index + 1);
        entries[current.index] = base;
        lastEditRef.current = { nodeId, timestamp, index: current.index };
        return { entries, index: current.index };
      }
      const entries = [...current.entries.slice(0, current.index + 1), base];
      const index = entries.length - 1;
      lastEditRef.current = { nodeId, timestamp, index };
      return { entries, index };
    });
  }, []);

  const commitProjectEdit = useCallback((operation: VinextEditOperation) => {
    setProjectTimeline((current) => {
      const base = { ...(current.entries[current.index] ?? {}) };
      if (operation.action === 'delete') {
        for (const [id, existing] of Object.entries(base)) {
          if (existing.nodeId === operation.nodeId) delete base[id];
        }
      }
      if (operation.action !== 'delete' && (operation.value ?? '') === operation.before) delete base[operation.id];
      else base[operation.id] = operation;
      const last = lastProjectEditRef.current;
      const coalesce = last?.operationId === operation.id && last.index === current.index && operation.timestamp - last.timestamp < 700;
      if (coalesce && current.index > 0) {
        const entries = current.entries.slice(0, current.index + 1);
        entries[current.index] = base;
        lastProjectEditRef.current = { operationId: operation.id, timestamp: operation.timestamp, index: current.index };
        return { entries, index: current.index };
      }
      const entries = [...current.entries.slice(0, current.index + 1), base];
      const index = entries.length - 1;
      lastProjectEditRef.current = { operationId: operation.id, timestamp: operation.timestamp, index };
      return { entries, index };
    });
  }, []);

  useEffect(() => {
    postToPreview({ channel: 'codex-html-editor-host', type: 'set-mode', mode: mode === 'edit' ? 'edit' : 'preview' });
  }, [mode, postToPreview, previewHtml, project?.previewUrl]);

  useEffect(() => {
    if (mode === 'review' && !dirty) setMode('edit');
  }, [dirty, mode]);

  useEffect(() => {
    if (project || !previewHtml) return;
    let cancelled = false;
    void window.codexEditor.setPreviewContent(previewHtml).then((url) => { if (!cancelled) setPreviewUrl(url); });
    return () => { cancelled = true; };
  }, [previewHtml, project]);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!dirty || conflict) return !dirty;
    setBusy(true);
    try {
      if (project) {
        const result = await window.codexEditor.saveVinextProject(projectOperations);
        if (result.status === 'saved') {
          setProjectTimeline(EMPTY_PROJECT_TIMELINE);
          lastProjectEditRef.current = null;
          setSelection(null);
          showNotice(`Saved ${result.changedFiles.length} ${result.changedFiles.length === 1 ? 'file' : 'files'}`);
          return true;
        }
        showNotice(result.message);
        return false;
      }
      if (!document) return false;
      const result = await window.codexEditor.saveFile({
        path: document.path,
        expectedVersion: document.version,
        operations,
        fullSource: editorBaseSource === document.source ? undefined : currentSource,
      });
      if (result.status === 'saved') {
        loadDocument(result.document);
        showNotice('Saved');
        return true;
      }
      if (result.status === 'conflict') {
        setConflict({ removed: false });
        showNotice('The file changed on disk. Resolve the conflict before saving.');
        return false;
      }
      showNotice(result.message);
      return false;
    } finally {
      setBusy(false);
    }
  }, [conflict, currentSource, dirty, document, editorBaseSource, loadDocument, operations, project, projectOperations, showNotice]);

  const prepareToLeave = useCallback(async (): Promise<boolean> => {
    if (!dirtyRef.current) return true;
    const decision = await window.codexEditor.confirmUnsaved('open');
    if (decision === 'cancel') return false;
    if (decision === 'save') return handleSave();
    if (document) await window.codexEditor.clearDraft(document.path);
    return true;
  }, [document, handleSave]);

  const handleOpenPath = useCallback(async (path: string) => {
    if (!(await prepareToLeave())) return;
    try {
      const result = await window.codexEditor.openPath(path);
      if (result.status === 'opened' && result.document) loadDocument(result.document);
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Unable to open the file.');
    }
  }, [loadDocument, prepareToLeave, showNotice]);

  const handleOpen = useCallback(async () => {
    if (!(await prepareToLeave())) return;
    const result = await window.codexEditor.openFile();
    if (result.status === 'opened' && result.document) loadDocument(result.document);
  }, [loadDocument, prepareToLeave]);

  const openProjectRoute = useCallback((value: string) => {
    if (!project) return;
    const route = `/${value.trim().replace(/^\/+/, '')}`;
    const previewUrl = new URL(route, `${new URL(project.previewUrl).origin}/`).href;
    setProjectRoute(route);
    setProject((current) => current ? { ...current, route, previewUrl } : current);
    setPreviewUrl(previewUrl);
    setSelection(null);
  }, [project]);

  const handleExternalChange = useCallback(async (change: ExternalFileChange) => {
    if (!document || change.path !== document.path) return;
    if (dirtyRef.current) {
      if (!change.removed && operations.length > 0 && editorBaseSource === document.source) {
        const originalNodes = [...nodesRef.current.values()];
        try {
          const reloaded = await window.codexEditor.reloadFile(document.path);
          const rebased = rebaseEditedSource(reloaded.source, originalNodes, activeEdits);
          if (rebased !== null) {
            loadDocument(reloaded, rebased);
            showNotice('Merged external changes with your edits');
            return;
          }
        } catch {
          // Fall through to a recoverable conflict.
        }
      }
      setConflict({ removed: change.removed });
      return;
    }
    if (change.removed) {
      setConflict({ removed: true });
      return;
    }
    try {
      const reloaded = await window.codexEditor.reloadFile(document.path);
      loadDocument(reloaded);
      showNotice('Reloaded changes from disk');
    } catch (error) {
      showNotice(error instanceof Error ? error.message : 'Unable to reload the file.');
    }
  }, [activeEdits, document, editorBaseSource, loadDocument, operations.length, showNotice]);

  useEffect(() => window.codexEditor.onExternalChange(handleExternalChange), [handleExternalChange]);

  useEffect(() => {
    const listener = (event: MessageEvent<PreviewToHostMessage>) => {
      if (event.source !== iframeRef.current?.contentWindow || event.data?.channel !== 'codex-html-editor') return;
      const message = event.data;
      if (message.type === 'ready') postToPreview({ channel: 'codex-html-editor-host', type: 'set-mode', mode: mode === 'edit' ? 'edit' : 'preview' });
      else if (message.type === 'selection') setSelection(message.selection);
      else if (message.type === 'edit') commitEdit(message.nodeId, message.replacementOuterHtml, message.timestamp);
      else if (message.type === 'project-edit') commitProjectEdit(message.operation);
      else if (message.type === 'undo-request') undo();
      else if (message.type === 'redo-request') redo();
      else if (message.type === 'save-request') void handleSave();
      else if (message.type === 'open-link') void window.codexEditor.openLink(message.url).then((result) => {
        showNotice(result.status === 'opened' ? 'Opened link in your default browser' : result.message);
      });
      else if (message.type === 'notice') showNotice(message.message);
    };
    window.addEventListener('message', listener);
    return () => window.removeEventListener('message', listener);
  }, [commitEdit, commitProjectEdit, handleSave, mode, postToPreview, redo, showNotice, undo]);

  useEffect(() => {
    const handleCommand = (command: AppCommand) => {
      if (command === 'open') void handleOpen();
      if (command === 'save') void handleSave();
      if (command === 'undo') undo();
      if (command === 'redo') redo();
      if (command === 'save-and-close') void handleSave().then((saved) => { if (saved) window.codexEditor.closeAfterSave(); });
    };
    return window.codexEditor.onCommand(handleCommand);
  }, [handleOpen, handleSave, redo, undo]);

  useEffect(() => {
    refreshRecentFiles();
    void window.codexEditor.getLaunchDocument().then((launchDocument) => { if (launchDocument) loadDocument(launchDocument); });
  }, [loadDocument, refreshRecentFiles]);

  const openHistory = async () => {
    if (!document) return;
    setHistoryEntries(await window.codexEditor.listHistory(document.path));
    setHistoryOpen(true);
  };

  const loadHistoryEntry = async (entry: HistoryEntry) => {
    if (!document) return;
    let diskDocument = document;
    if (dirtyRef.current) {
      const decision = await window.codexEditor.confirmUnsaved('history');
      if (decision === 'cancel') return;
      if (decision === 'save') {
        if (!(await handleSave())) return;
        diskDocument = await window.codexEditor.reloadFile(document.path);
      }
    }
    const source = await window.codexEditor.loadHistory(diskDocument.path, entry.id);
    loadDocument(diskDocument, source);
    setHistoryOpen(false);
    showNotice('Loaded backup. Save to restore it.');
  };

  const saveConflictCopy = async () => {
    if (!document) return;
    const name = `${document.fileName.replace(/\.html?$/i, '')}-editor-copy.html`;
    const result = await window.codexEditor.saveCopy({ source: currentSource, suggestedName: name });
    if (result.status === 'saved') {
      showNotice('Saved editor copy');
      if (!conflict?.removed) loadDocument(await window.codexEditor.reloadFile(document.path));
    } else if (result.status === 'error') showNotice(result.message);
  };

  const discardAndReload = async () => {
    if (!document || conflict?.removed) return;
    await window.codexEditor.clearDraft(document.path);
    loadDocument(await window.codexEditor.reloadFile(document.path));
    showNotice('Reloaded disk version');
  };

  const restoreDraft = () => {
    if (!document || !recoveryDraft) return;
    loadDocument(document, recoveryDraft.source);
    showNotice('Recovered unsaved work');
  };

  const discardDraft = async () => {
    if (!document) return;
    await window.codexEditor.clearDraft(document.path);
    setRecoveryDraft(null);
  };

  const reviewChanges = useMemo(() => {
    if (project) {
      return projectOperations.map((operation) => ({
        id: operation.id,
        label: operation.sourceLabel,
        before: operation.before,
        after: operation.action === 'delete'
          ? '(element deleted)'
          : operation.action === 'attribute'
            ? `${operation.attribute}="${operation.value ?? ''}"`
            : operation.value ?? '',
      }));
    }
    if (!document || !dirty) return [];
    if (editorBaseSource !== document.source) return [{ id: 'full-document', label: 'Recovered or historical document', before: document.source.slice(0, 800), after: currentSource.slice(0, 800) }];
    return operations.map((operation) => {
      const node = nodesRef.current.get(operation.nodeId);
      return { id: operation.nodeId, label: node?.sourceLabel ?? operation.nodeId, before: node?.originalOuterHtml ?? '', after: operation.replacementOuterHtml };
    });
  }, [currentSource, dirty, document, editorBaseSource, operations, project, projectOperations]);

  const toolbarStyle = useMemo<CSSProperties>(() => {
    if (!selection || !iframeRef.current) return { display: 'none' };
    const frameRect = iframeRef.current.getBoundingClientRect();
    const left = Math.max(18, Math.min(frameRect.left + selection.rect.left, window.innerWidth - 510));
    const above = frameRect.top + selection.rect.top - 54;
    return { left, top: above > 82 ? above : frameRect.top + selection.rect.bottom + 10 };
  }, [selection]);

  const selectedNode = !project && selection ? editableNodes.find((node) => node.id === selection.nodeId) : undefined;
  const saveStateLabel = !dirty
    ? 'Saved'
    : draftStatus === 'saving'
      ? 'Autosaving…'
      : draftStatus === 'saved'
        ? 'Autosaved just now'
        : 'Changes pending autosave';

  const selectOutlineNode = (nodeId: string) => {
    postToPreview({ channel: 'codex-html-editor-host', type: 'focus-node', nodeId });
  };

  const deleteSelection = () => {
    if (!selection) return;
    postToPreview({ channel: 'codex-html-editor-host', type: 'delete-node' });
  };

  const handleDragOver = (event: ReactDragEvent) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'copy';
    setDragActive(true);
  };

  const handleDrop = (event: ReactDragEvent) => {
    event.preventDefault();
    setDragActive(false);
    const file = event.dataTransfer.files[0];
    if (!file) return;
    try {
      const path = window.codexEditor.getDroppedFilePath(file);
      if (!/\.html?$/i.test(path)) showNotice('Drop an HTML or HTM file.');
      else void handleOpenPath(path);
    } catch {
      showNotice('Unable to read the dropped file.');
    }
  };

  return (
    <div
      className={`app-shell${dragActive ? ' is-dragging' : ''}`}
      onDragEnter={handleDragOver}
      onDragOver={handleDragOver}
      onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragActive(false); }}
      onDrop={handleDrop}
    >
      <header className="app-toolbar">
        <div className="toolbar-left">
          <div className="document-title">
            <strong>{document?.fileName ?? project?.name ?? 'Second Pass'}</strong>
            {workspaceOpen
              ? <span>{dirty ? `${reviewChanges.length} unsaved ${reviewChanges.length === 1 ? 'change' : 'changes'}` : project ? 'Vinext project' : 'Saved'}</span>
              : <span>Connect a Codex task</span>}
          </div>
        </div>
        {workspaceOpen ? (
          <>
            <div className="mode-switch" aria-label="Editor mode">
              <button type="button" className={mode === 'edit' ? 'is-active' : ''} disabled={codexStatus === 'working'} onClick={() => setMode('edit')}>Edit</button>
              <button type="button" className={mode === 'preview' ? 'is-active' : ''} onClick={() => setMode('preview')}>Preview</button>
              <button type="button" className={mode === 'review' ? 'is-active' : ''} disabled={!dirty || Boolean(conflict)} onClick={() => { setHistoryOpen(false); setMode('review'); }}>Review</button>
            </div>
            <div className="toolbar-actions">
              {project ? (
                <label className="project-route-field">
                  <span>Route</span>
                  <input
                    aria-label="Vinext preview route"
                    list="vinext-project-routes"
                    value={projectRoute}
                    onChange={(event) => setProjectRoute(event.target.value)}
                    onBlur={(event) => openProjectRoute(event.target.value)}
                    onKeyDown={(event) => { if (event.key === 'Enter') openProjectRoute(event.currentTarget.value); }}
                  />
                  <datalist id="vinext-project-routes">{project.routes.map((route) => <option key={route} value={route} />)}</datalist>
                </label>
              ) : null}
              <div className="workspace-toggles" aria-label="Workspace panels">
                <button type="button" className={`panel-toggle${codexOpen ? ' is-active' : ''}`} aria-label="Codex" title="Codex" aria-pressed={codexOpen} onClick={() => setCodexOpen((open) => !open)}>
                  <UiIcon name="codex" /><span>Codex</span>{codexStatus === 'working' ? <i className="toolbar-working-dot" aria-label="Codex is working" /> : null}
                </button>
                <button type="button" className={`panel-toggle${outlineOpen ? ' is-active' : ''}`} aria-label="Outline" title="Outline" aria-pressed={outlineOpen} disabled={mode !== 'edit' || Boolean(project)} onClick={() => setOutlineOpen((open) => !open)}>
                  <UiIcon name="list" /><span>Outline</span>
                </button>
                <button type="button" className={`panel-toggle${inspectorOpen ? ' is-active' : ''}`} aria-label="Inspector" title="Inspector" aria-pressed={inspectorOpen} disabled={mode !== 'edit'} onClick={() => setInspectorOpen((open) => !open)}>
                  <UiIcon name="inspector" /><span>Inspector</span>
                </button>
              </div>
              <div className="viewport-switch" aria-label="Preview size">
                <IconButton label="Responsive preview" active={viewport === 'responsive'} onClick={() => setViewport('responsive')}><UiIcon name="responsive" /></IconButton>
                <IconButton label="Tablet preview" active={viewport === 'tablet'} onClick={() => setViewport('tablet')}><UiIcon name="tablet" /></IconButton>
                <IconButton label="Mobile preview" active={viewport === 'mobile'} onClick={() => setViewport('mobile')}><UiIcon name="mobile" /></IconButton>
              </div>
              <IconButton label="Undo" disabled={project ? projectTimeline.index === 0 : timeline.index === 0} onClick={undo}><UiIcon name="undo" /></IconButton>
              <IconButton label="Redo" disabled={project ? projectTimeline.index >= projectTimeline.entries.length - 1 : timeline.index >= timeline.entries.length - 1} onClick={redo}><UiIcon name="redo" /></IconButton>
              <IconButton label="Open another HTML file" onClick={() => void handleOpen()}><UiIcon name="document" /></IconButton>
              {document ? <button type="button" className="secondary-button" onClick={openHistory}>History</button> : null}
              <button type="button" className="primary-button compact" disabled={!dirty || busy || Boolean(conflict)} onClick={handleSave}>{busy ? 'Saving…' : 'Save'}</button>
            </div>
          </>
        ) : null}
      </header>

      {recoveryDraft ? (
        <div className="recovery-banner" role="alert">
          <div><strong>Unsaved work found</strong><span>Autosaved {new Date(recoveryDraft.updatedAt).toLocaleString()}</span></div>
          <div><button type="button" onClick={restoreDraft}>Restore</button><button type="button" onClick={discardDraft}>Discard</button></div>
        </div>
      ) : null}

      {conflict ? (
        <div className="conflict-banner" role="alert">
          <div><strong>{conflict.removed ? 'The source file was removed.' : 'The same edited region changed on disk.'}</strong><span>Save your edits as a copy or discard them and load the disk version.</span></div>
          <div><button type="button" onClick={saveConflictCopy}>Save a copy</button>{!conflict.removed ? <button type="button" onClick={discardAndReload}>Discard and reload</button> : null}</div>
        </div>
      ) : null}

      {workspaceOpen ? (
        <>
          <div className={`editor-workspace mode-${mode}`}>
            {codexOpen ? (
              <CodexPanel
                session={codexSession}
                status={codexStatus}
                error={codexError}
                approval={codexApproval}
                visualEditsPending={dirty}
                onConnect={(reference) => connectCodex(reference)}
                onStartNew={() => connectCodex('', true)}
                onSend={sendCodexTurn}
                onInterrupt={interruptCodex}
                onApproval={respondToCodexApproval}
                onClose={() => setCodexOpen(false)}
              />
            ) : null}
            {document && mode === 'edit' && outlineOpen ? (
              <OutlinePanel
                nodes={editableNodes}
                replacements={activeEdits}
                activeNodeId={selection?.nodeId}
                onSelect={selectOutlineNode}
                onClose={() => setOutlineOpen(false)}
              />
            ) : null}
            <main className="canvas-wrap">
              <div className={`preview-stage viewport-${viewport}`}>
                <iframe
                  key={`${document?.path ?? project?.root}:${previewRevision}:${previewUrl}`}
                  ref={iframeRef}
                  className="preview-frame"
                  title={`Preview of ${document?.fileName ?? project?.name ?? 'workspace'}`}
                  src={previewUrl || 'about:blank'}
                  sandbox={project ? 'allow-scripts allow-same-origin allow-forms' : 'allow-scripts'}
                />
              </div>
              {selection && mode === 'edit' && !inspectorOpen ? (
                <FormattingToolbar
                  selection={selection}
                  style={toolbarStyle}
                  onFormat={(command) => postToPreview({ channel: 'codex-html-editor-host', type: 'format', command })}
                  onSetLink={(url) => postToPreview({ channel: 'codex-html-editor-host', type: 'set-link', url })}
                  onSetImageAlt={(alt) => postToPreview({ channel: 'codex-html-editor-host', type: 'set-image-alt', alt })}
                  onReplaceImage={() => void replaceSelectedImage()}
                  onDelete={deleteSelection}
                />
              ) : null}
              {historyOpen ? <HistoryPanel entries={historyEntries} onLoad={loadHistoryEntry} onClose={() => setHistoryOpen(false)} /> : null}
            </main>
            {mode === 'edit' && inspectorOpen ? (
              <InspectorPanel
                selection={selection}
                node={selectedNode}
                onFormat={(command) => postToPreview({ channel: 'codex-html-editor-host', type: 'format', command })}
                onSetLink={(url) => postToPreview({ channel: 'codex-html-editor-host', type: 'set-link', url })}
                onSetImageAlt={(alt) => postToPreview({ channel: 'codex-html-editor-host', type: 'set-image-alt', alt })}
                onReplaceImage={() => void replaceSelectedImage()}
                onDelete={deleteSelection}
                onClose={() => setInspectorOpen(false)}
              />
            ) : null}
            {mode === 'review' ? <ReviewPanel changes={reviewChanges} busy={busy} onSave={() => void handleSave()} /> : null}
          </div>
          <footer className="status-bar">
            <span>{selection && mode === 'edit' ? selection.sourceLabel : project ? `${project.route} · Vinext` : `${nodesRef.current.size} editable regions`}</span>
            {selection?.scriptCoupled && mode === 'edit' ? <strong>Script-controlled text may change when the page runs.</strong> : null}
            <span>{saveStateLabel}</span>
            <span>{codexStatus === 'working' ? 'Codex is updating the connected workspace' : mode === 'edit' ? 'Click source-authored text to edit' : mode === 'preview' ? 'Links and page interactions are active' : 'Confirm each changed source region, then save'}</span>
          </footer>
        </>
      ) : (
        <EmptyState
          recentFiles={recentFiles}
          codexStatus={codexStatus}
          codexError={codexError}
          onConnectCodex={(reference) => connectCodex(reference)}
          onOpen={handleOpen}
          onOpenRecent={(path) => void handleOpenPath(path)}
        />
      )}

      {dragActive ? <div className="drop-overlay"><strong>Drop HTML to open</strong></div> : null}
      {notice ? <div className="toast" role="status">{notice}</div> : null}
    </div>
  );
}
